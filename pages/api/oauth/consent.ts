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
import { withAuth, type CompanyAuthedRequest } from '@/lib/auth';
import { log } from '@/lib/logger';
import {
  createAuthorisationCode,
  getOauthAppByClientId,
  OAUTH_SCOPES,
} from '@/lib/auth/oauth';

const VALID_SCOPES = new Set<string>(OAUTH_SCOPES);

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

  const app = await getOauthAppByClientId(clientId);
  if (!app) return apiResponse.notFound(res, 'Unknown OAuth client');

  if (!app.redirectUris.includes(redirectUri)) {
    return apiResponse.badRequest(res, 'redirectUri is not registered for this app');
  }

  const scopes: string[] = [];
  for (const s of requestedScopes) {
    if (typeof s !== 'string') return apiResponse.badRequest(res, 'scopes must be an array of strings');
    if (!VALID_SCOPES.has(s)) return apiResponse.badRequest(res, `Unknown scope: ${s}`);
    if (!scopes.includes(s)) scopes.push(s);
  }
  if (scopes.length === 0) return apiResponse.badRequest(res, 'At least one scope must be requested');

  const code = await createAuthorisationCode({
    oauthAppId: app.id,
    userId: req.user.id,
    companyId: targetCompanyId,
    redirectUri,
    scopes,
    codeChallenge,
  });

  log.info('OAuth consent granted', {
    appId: app.id, clientId, userId: req.user.id, companyId: targetCompanyId, scopes,
  }, 'oauth');

  // Build redirect URL with code + state (state is opaque to us; the client
  // uses it to bind their own session to the redirect).
  const url = new URL(redirectUri);
  url.searchParams.set('code', code);
  if (state) url.searchParams.set('state', state);

  return apiResponse.success(res, { redirectTo: url.toString() });
}

export default withAuth(withErrorHandler(handler as Parameters<typeof withErrorHandler>[0]));
