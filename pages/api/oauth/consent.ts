/**
 * POST /api/oauth/consent — record an authorisation grant.
 *
 * Called by the consent screen submission. Validates the OAuth app, redirect
 * URI, and PKCE challenge, then mints a one-time authorisation code and
 * returns the redirect target with `?code=...&state=...`. The client app
 * exchanges the code at /api/oauth/token.
 *
 * Cookie-only — must run in the user's browser session so we know who is
 * granting consent.
 */
import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { ErrorCode } from '@/lib/apiResponse.types';
import { withAuth, type CompanyAuthedRequest } from '@/lib/auth';
import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import {
  createAuthorisationCode,
  getOauthAppByClientId,
  OAUTH_SCOPES,
} from '@/lib/auth/oauth';
import { partitionRequestedScopes, buildGrantedScopes } from '@/lib/auth/consentScopes';
import { checkResourceIndicator, oauthIssuer } from '@/lib/auth/oauthResource';
import { scopesRoleMayNotHold } from '@/lib/auth/writeRoles';

const VALID_SCOPES = new Set<string>(OAUTH_SCOPES);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function handler(req: CompanyAuthedRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return apiResponse.methodNotAllowed(res, req.method ?? '', ['POST']);
  }

  const body = (req.body ?? {}) as Record<string, unknown>;
  const clientId = typeof body.clientId === 'string' ? body.clientId : '';
  const redirectUri = typeof body.redirectUri === 'string' ? body.redirectUri : '';
  const state = typeof body.state === 'string' ? body.state : '';
  const codeChallenge = typeof body.codeChallenge === 'string' ? body.codeChallenge : '';
  const codeChallengeMethod = typeof body.codeChallengeMethod === 'string' ? body.codeChallengeMethod : 'S256';
  const requestedScopes = Array.isArray(body.scopes) ? body.scopes : [];
  const targetCompanyId = typeof body.companyId === 'string' && body.companyId ? body.companyId : req.companyId;

  if (!clientId) return apiResponse.badRequest(res, 'clientId is required');
  if (!redirectUri) return apiResponse.badRequest(res, 'redirectUri is required');
  if (!codeChallenge) return apiResponse.badRequest(res, 'codeChallenge is required (PKCE mandatory)');
  if (codeChallengeMethod !== 'S256') return apiResponse.badRequest(res, 'Only S256 PKCE is supported');
  if (typeof body.companyId === 'string' && body.companyId && !UUID_RE.test(body.companyId)) {
    return apiResponse.badRequest(res, 'companyId must be a UUID');
  }

  const app = await getOauthAppByClientId(clientId);
  if (!app) return apiResponse.notFound(res, 'Unknown OAuth client');

  if (!app.redirectUris.includes(redirectUri)) {
    return apiResponse.badRequest(res, 'redirectUri is not registered for this app');
  }

  // RFC 8707, re-checked here: /oauth/authorize validated it, but this body is
  // the client's to send (oauthResource.ts). Nothing is stored.
  if (!checkResourceIndicator(body.resource).ok) {
    return apiResponse.badRequest(res, 'invalid_target: resource must be this server\'s MCP endpoint');
  }

  const scopes: string[] = [];
  for (const s of requestedScopes) {
    if (typeof s !== 'string') return apiResponse.badRequest(res, 'scopes must be an array of strings');
    if (!VALID_SCOPES.has(s)) return apiResponse.badRequest(res, `Unknown scope: ${s}`);
    if (!scopes.includes(s)) scopes.push(s);
  }
  if (scopes.length === 0) return apiResponse.badRequest(res, 'At least one scope must be requested');

  // Server-authoritative opt-in gate for posting scopes (the Hein decision):
  // write:post is NOT granted merely because it appears in the requested set —
  // it requires an explicit, per-scope confirmation in optInConfirmed. This
  // makes the "granted only when actively ticked" invariant hold regardless of
  // the front-end (a UI regression or a hand-crafted POST cannot smuggle it in).
  const optInConfirmed = Array.isArray(body.optInConfirmed)
    ? body.optInConfirmed.filter((s): s is string => typeof s === 'string')
    : [];
  const { autoGranted, optIn } = partitionRequestedScopes(scopes);
  const checked: Record<string, boolean> = {};
  for (const s of optInConfirmed) checked[s] = true;
  const requestedGrant = buildGrantedScopes(autoGranted, optIn, checked);

  // Membership gate: never mint a code for a company the consenting user does
  // not belong to. body.companyId is client-supplied; withAuth only validated
  // req.companyId. (Defence-in-depth — the Bearer wrapper re-checks at use.)
  let targetRole: string | null | undefined = req.companyRole;
  if (targetCompanyId !== req.companyId) {
    const member = (await sql`
      SELECT role FROM company_users
      WHERE user_id = ${req.user.id}
        AND company_id = ${targetCompanyId}::uuid
      LIMIT 1
    `) as { role: string | null }[];
    if (member.length === 0) {
      log.warn('OAuth consent: companyId outside membership rejected', {
        userId: req.user.id, targetCompanyId,
      }, 'oauth');
      return apiResponse.error(res, ErrorCode.FORBIDDEN, 'Not a member of this company');
    }
    targetRole = member[0]!.role;
  }

  // Role gate (audit 2026-10-18 S-01): a role that cannot write in the target company is granted the
  // read scopes only. A client asks for everything, so dropping (not refusing) keeps a viewer able to
  // connect read-only; the MCP registry judges the role again on every call.
  const withheld = scopesRoleMayNotHold(targetRole, requestedGrant);
  const grantedScopes = requestedGrant.filter((s) => !withheld.includes(s));
  if (withheld.length > 0) {
    log.info('OAuth consent: write scopes withheld for role', { userId: req.user.id, targetCompanyId, role: targetRole, withheld }, 'oauth');
  }
  if (withheld.length > 0 && grantedScopes.length === 0) {
    return apiResponse.error(res, ErrorCode.FORBIDDEN, `Your role (${targetRole ?? 'unknown'}) in this company cannot grant ${withheld.join(', ')}.`);
  }

  const code = await createAuthorisationCode({
    oauthAppId: app.id,
    userId: req.user.id,
    companyId: targetCompanyId,
    redirectUri,
    scopes: grantedScopes,
    codeChallenge,
  });

  log.info('OAuth consent granted', {
    appId: app.id, clientId, userId: req.user.id, companyId: targetCompanyId, scopes: grantedScopes,
  }, 'oauth');

  // Build redirect URL with code + state (state is opaque to us; the client
  // uses it to bind their own session to the redirect).
  const url = new URL(redirectUri);
  url.searchParams.set('code', code);
  if (state) url.searchParams.set('state', state);
  // RFC 9207: the issuer, identical to the metadata document's, so a client
  // talking to several authorization servers can tell which one answered.
  url.searchParams.set('iss', oauthIssuer());

  return apiResponse.success(res, { redirectTo: url.toString() });
}

export default withAuth(withErrorHandler(handler as Parameters<typeof withErrorHandler>[0]));
