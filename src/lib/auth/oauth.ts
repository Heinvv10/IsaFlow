/**
 * OAuth 2.0 service — PRD-10 Layer 2 (with round-2 review fixes).
 *
 * Standard authorization-code flow with PKCE. Opaque access + refresh tokens
 * (instant revocation, mirrors PAT pattern from src/lib/auth/personalAccessTokens.ts).
 * Single-use refresh tokens via atomic UPDATE rotation; replaying a used
 * refresh token revokes the entire authorisation row (replay detection).
 *
 * Token formats:
 *   - Authorisation code:  oac_<32 base62>     (5-min TTL, single-use, PKCE-bound)
 *   - Access token:        oat_<32 base62>     (~1h TTL, opaque)
 *   - Refresh token:       ort_<32 base62>     (30d rolling, single-use)
 *   - Client secret:       cls_<32 base62>     (shown once at app registration)
 */

import { createHash, randomBytes, timingSafeEqual } from 'crypto';
import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';

type Row = Record<string, unknown>;

// Canonical list lives in the zero-import oauthScopes.ts (client-bundle safe);
// re-exported here for server-side consumers.
export { OAUTH_SCOPES, type OAuthScope } from './oauthScopes';

const ACCESS_TOKEN_TTL_SECS = 60 * 60;
const REFRESH_TOKEN_TTL_SECS = 60 * 60 * 24 * 30;
const CODE_TTL_SECS = 60 * 5;

function base62(n: number): string {
  let body = '';
  while (body.length < n) {
    body += randomBytes(48).toString('base64').replace(/[^A-Za-z0-9]/g, '');
  }
  return body.slice(0, n);
}

function sha256Hex(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

function generateToken(prefix: string, len = 32): { raw: string; hash: string; prefix12: string } {
  const raw = `${prefix}${base62(len)}`;
  return { raw, hash: sha256Hex(raw), prefix12: raw.slice(0, 12) };
}

// ── App registration ────────────────────────────────────────────────────────

export interface RegisterAppInput {
  /** null only for dynamic (RFC 7591) registrations — no authenticated owner. */
  ownerUserId: string | null;
  name: string;
  description?: string | null;
  logoUrl?: string | null;
  homepageUrl?: string | null;
  redirectUris: string[];
  /** RFC 7591 dynamic registration: PUBLIC client — no secret is ever minted,
   *  token_endpoint_auth_method 'none', PKCE enforced at consent + token time. */
  dynamic?: boolean;
}

export interface RegisteredApp {
  id: string;
  clientId: string;
  /** null for dynamic public clients (no secret exists). */
  clientSecret: string | null;
}

export async function registerOauthApp(input: RegisterAppInput): Promise<RegisteredApp> {
  if (input.redirectUris.length === 0) {
    throw new Error('registerOauthApp: at least one redirect URI required');
  }
  for (const uri of input.redirectUris) {
    try { new URL(uri); } catch { throw new Error(`registerOauthApp: invalid redirect URI: ${uri}`); }
  }
  const isDynamic = input.dynamic === true;
  if (!isDynamic && !input.ownerUserId) {
    throw new Error('registerOauthApp: ownerUserId required for non-dynamic apps');
  }

  const clientId = `client_${base62(24)}`;
  const secret = isDynamic ? null : generateToken('cls_', 32);

  const rows = (await sql`
    INSERT INTO oauth_apps (
      name, description, logo_url, homepage_url, redirect_uris,
      client_id, client_secret_hash, client_secret_prefix, owner_user_id,
      is_dynamic, token_endpoint_auth_method
    )
    VALUES (
      ${input.name},
      ${input.description ?? null},
      ${input.logoUrl ?? null},
      ${input.homepageUrl ?? null},
      ${input.redirectUris},
      ${clientId},
      ${secret?.hash ?? null},
      ${secret?.prefix12 ?? null},
      ${input.ownerUserId},
      ${isDynamic},
      ${isDynamic ? 'none' : 'client_secret_post'}
    )
    RETURNING id
  `) as Row[];

  if (!rows[0]) throw new Error('registerOauthApp: insert returned no row');

  log.info(
    'OAuth app registered',
    { appId: rows[0].id, ownerUserId: input.ownerUserId, name: input.name, isDynamic },
    'oauth',
  );
  return { id: rows[0].id as string, clientId, clientSecret: secret?.raw ?? null };
}

export interface OauthAppListItem {
  id: string;
  name: string;
  description: string | null;
  logoUrl: string | null;
  homepageUrl: string | null;
  redirectUris: string[];
  clientId: string;
  clientSecretPrefix: string;
  isVerified: boolean;
  isFirstParty: boolean;
  createdAt: string;
}

export async function listOauthApps(ownerUserId: string): Promise<OauthAppListItem[]> {
  const rows = (await sql`
    SELECT id, name, description, logo_url, homepage_url, redirect_uris,
           client_id, client_secret_prefix, is_verified, is_first_party, created_at
    FROM oauth_apps
    WHERE owner_user_id = ${ownerUserId}
      AND revoked_at IS NULL
    ORDER BY created_at DESC
  `) as Row[];

  return rows.map((r) => ({
    id: r.id as string,
    name: r.name as string,
    description: r.description as string | null,
    logoUrl: r.logo_url as string | null,
    homepageUrl: r.homepage_url as string | null,
    redirectUris: (r.redirect_uris as string[]) ?? [],
    clientId: r.client_id as string,
    clientSecretPrefix: r.client_secret_prefix as string,
    isVerified: Boolean(r.is_verified),
    isFirstParty: Boolean(r.is_first_party),
    createdAt: (r.created_at as Date).toISOString(),
  }));
}

export async function revokeOauthApp(appId: string, ownerUserId: string): Promise<boolean> {
  const rows = (await sql`
    UPDATE oauth_apps
    SET revoked_at = NOW()
    WHERE id = ${appId}::uuid
      AND owner_user_id = ${ownerUserId}
      AND revoked_at IS NULL
    RETURNING id
  `) as Row[];
  return rows.length > 0;
}

// ── App lookup (public flows) ───────────────────────────────────────────────

export interface PublicOauthApp {
  id: string;
  name: string;
  description: string | null;
  logoUrl: string | null;
  homepageUrl: string | null;
  redirectUris: string[];
  clientId: string;
  isVerified: boolean;
  isFirstParty: boolean;
  /** True when the app has a client_secret — confidential client. Used by the
   *  token endpoint to decide whether to require the secret on auth-code grant. */
  isConfidential: boolean;
}

export async function getOauthAppByClientId(clientId: string): Promise<PublicOauthApp | null> {
  const rows = (await sql`
    SELECT id, name, description, logo_url, homepage_url, redirect_uris,
           client_id, is_verified, is_first_party,
           (client_secret_hash IS NOT NULL) AS is_confidential
    FROM oauth_apps
    WHERE client_id = ${clientId}
      AND revoked_at IS NULL
    LIMIT 1
  `) as Row[];

  if (rows.length === 0) return null;
  const r = rows[0]!;
  return {
    id: r.id as string,
    name: r.name as string,
    description: r.description as string | null,
    logoUrl: r.logo_url as string | null,
    homepageUrl: r.homepage_url as string | null,
    redirectUris: (r.redirect_uris as string[]) ?? [],
    clientId: r.client_id as string,
    isVerified: Boolean(r.is_verified),
    isFirstParty: Boolean(r.is_first_party),
    isConfidential: Boolean(r.is_confidential),
  };
}

export async function verifyClientSecret(clientId: string, presentedSecret: string): Promise<boolean> {
  const rows = (await sql`
    SELECT client_secret_hash FROM oauth_apps
    WHERE client_id = ${clientId} AND revoked_at IS NULL
    LIMIT 1
  `) as Row[];
  if (rows.length === 0) return false;
  const stored = (rows[0]!.client_secret_hash as string) ?? '';
  const expected = sha256Hex(presentedSecret);
  if (stored.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(stored, 'hex'), Buffer.from(expected, 'hex'));
}

// ── Authorisation codes ─────────────────────────────────────────────────────

export interface CreateCodeInput {
  oauthAppId: string;
  userId: string;
  companyId: string;
  redirectUri: string;
  scopes: string[];
  codeChallenge: string;
}

export async function createAuthorisationCode(input: CreateCodeInput): Promise<string> {
  const code = `oac_${base62(32)}`;
  const codeHash = sha256Hex(code);
  await sql`
    INSERT INTO oauth_authorisation_codes (
      code_hash, oauth_app_id, user_id, company_id,
      redirect_uri, scopes, code_challenge, expires_at
    )
    VALUES (
      ${codeHash},
      ${input.oauthAppId}::uuid,
      ${input.userId},
      ${input.companyId}::uuid,
      ${input.redirectUri},
      ${input.scopes},
      ${input.codeChallenge},
      NOW() + (${CODE_TTL_SECS} || ' seconds')::interval
    )
  `;
  return code;
}

interface ExchangeResult {
  accessToken: string;
  refreshToken: string;
  accessTokenExpiresIn: number;
  scopes: string[];
}

export class OauthExchangeError extends Error {
  constructor(public code: string, message: string) {
    super(message);
    this.name = 'OauthExchangeError';
  }
}

/**
 * Exchange a code for fresh tokens. PKCE verifier is hashed (S256) and
 * compared against the stored challenge **inside the WHERE clause** so a
 * wrong verifier does not consume the code (HIGH-1 fix). Code is single-use:
 * the atomic UPDATE flips `used_at` only when verifier matches AND code is
 * unused AND not expired.
 */
export async function exchangeCode(args: {
  code: string;
  redirectUri: string;
  codeVerifier: string;
  oauthAppId: string;
}): Promise<ExchangeResult> {
  const codeHash = sha256Hex(args.code);
  const verifierChallenge = createHash('sha256').update(args.codeVerifier).digest('base64url');

  // Atomic: only mark the code used when verifier matches. Wrong verifier
  // returns 0 rows and the code remains usable for a legitimate retry.
  const rows = (await sql`
    UPDATE oauth_authorisation_codes
    SET used_at = NOW()
    WHERE code_hash = ${codeHash}
      AND used_at IS NULL
      AND expires_at > NOW()
      AND oauth_app_id = ${args.oauthAppId}::uuid
      AND redirect_uri = ${args.redirectUri}
      AND code_challenge = ${verifierChallenge}
    RETURNING user_id, company_id, scopes
  `) as Row[];

  if (rows.length === 0) {
    throw new OauthExchangeError(
      'invalid_grant',
      'Authorisation code is invalid, expired, used, redirect_uri mismatched, or PKCE verifier wrong',
    );
  }

  const r = rows[0]!;
  return await issueTokens({
    oauthAppId: args.oauthAppId,
    userId: r.user_id as string,
    companyId: r.company_id as string,
    scopes: (r.scopes as string[]) ?? [],
  });
}

// ── Token issue + refresh ───────────────────────────────────────────────────

interface IssueTokensInput {
  oauthAppId: string;
  userId: string;
  companyId: string;
  scopes: string[];
  /** Used by refreshAccessToken to record the rotated-out hash for replay
   *  detection. Undefined on initial issue. */
  previousRefreshHash?: string;
}

async function issueTokens(input: IssueTokensInput): Promise<ExchangeResult> {
  const access = generateToken('oat_', 32);
  const includesOffline = input.scopes.includes('offline_access');
  const refresh = includesOffline ? generateToken('ort_', 32) : null;

  // Compute timestamps in JS so we can pass NULL for the refresh expiry when
  // offline_access wasn't granted (avoids nested sql`` interpolation).
  const accessExpiresAt = new Date(Date.now() + ACCESS_TOKEN_TTL_SECS * 1000);
  const refreshExpiresAt = refresh ? new Date(Date.now() + REFRESH_TOKEN_TTL_SECS * 1000) : null;

  await sql`
    INSERT INTO oauth_authorisations (
      oauth_app_id, user_id, company_id, scopes,
      access_token_hash, access_token_prefix, access_token_expires_at,
      refresh_token_hash, refresh_token_prefix, refresh_token_expires_at,
      previous_refresh_token_hash
    )
    VALUES (
      ${input.oauthAppId}::uuid,
      ${input.userId},
      ${input.companyId}::uuid,
      ${input.scopes},
      ${access.hash},
      ${access.prefix12},
      ${accessExpiresAt},
      ${refresh?.hash ?? null},
      ${refresh?.prefix12 ?? null},
      ${refreshExpiresAt},
      ${input.previousRefreshHash ?? null}
    )
    ON CONFLICT (oauth_app_id, user_id, company_id)
    DO UPDATE SET
      scopes = EXCLUDED.scopes,
      access_token_hash = EXCLUDED.access_token_hash,
      access_token_prefix = EXCLUDED.access_token_prefix,
      access_token_expires_at = EXCLUDED.access_token_expires_at,
      refresh_token_hash = EXCLUDED.refresh_token_hash,
      refresh_token_prefix = EXCLUDED.refresh_token_prefix,
      refresh_token_expires_at = EXCLUDED.refresh_token_expires_at,
      previous_refresh_token_hash = EXCLUDED.previous_refresh_token_hash,
      revoked_at = NULL
  `;

  return {
    accessToken: access.raw,
    refreshToken: refresh?.raw ?? '',
    accessTokenExpiresIn: ACCESS_TOKEN_TTL_SECS,
    scopes: input.scopes,
  };
}

/**
 * Atomic refresh-token rotation (HIGH-2 fix). The UPDATE rotates the hash
 * in a single statement: only one concurrent caller can win the race. The
 * loser sees 0 rows and gets `invalid_grant`.
 *
 * Replay defence (HIGH-3 fix): if the presented hash matches a row's
 * `previous_refresh_token_hash` (a rotated-out token being re-presented), we
 * REVOKE the entire authorisation row instead of just denying. This signals
 * a stolen-refresh attack; the legitimate user must re-authorise.
 */
export async function refreshAccessToken(args: {
  refreshToken: string;
  clientId: string;
}): Promise<ExchangeResult> {
  const presentedHash = sha256Hex(args.refreshToken);

  const appRows = (await sql`
    SELECT id FROM oauth_apps WHERE client_id = ${args.clientId} AND revoked_at IS NULL LIMIT 1
  `) as Row[];
  if (appRows.length === 0) {
    throw new OauthExchangeError('invalid_client', 'Unknown client');
  }
  const oauthAppId = appRows[0]!.id as string;

  // Pre-allocate the new refresh token so we can write it inside the rotation UPDATE.
  const newAccess = generateToken('oat_', 32);
  const newRefresh = generateToken('ort_', 32);

  const newAccessExpiresAt = new Date(Date.now() + ACCESS_TOKEN_TTL_SECS * 1000);
  const newRefreshExpiresAt = new Date(Date.now() + REFRESH_TOKEN_TTL_SECS * 1000);

  // Atomic rotation: WHERE checks current hash + expiry; UPDATE writes the new
  // hash and stashes the old one as previous_refresh_token_hash. Returns the
  // user/company/scopes for the caller. A concurrent replay sees 0 rows.
  const rotated = (await sql`
    UPDATE oauth_authorisations
    SET access_token_hash = ${newAccess.hash},
        access_token_prefix = ${newAccess.prefix12},
        access_token_expires_at = ${newAccessExpiresAt},
        previous_refresh_token_hash = refresh_token_hash,
        refresh_token_hash = ${newRefresh.hash},
        refresh_token_prefix = ${newRefresh.prefix12},
        refresh_token_expires_at = ${newRefreshExpiresAt}
    WHERE refresh_token_hash = ${presentedHash}
      AND oauth_app_id = ${oauthAppId}::uuid
      AND revoked_at IS NULL
      AND refresh_token_expires_at > NOW()
    RETURNING id, user_id, company_id, scopes
  `) as Row[];

  if (rotated.length === 1) {
    const r = rotated[0]!;
    return {
      accessToken: newAccess.raw,
      refreshToken: newRefresh.raw,
      accessTokenExpiresIn: ACCESS_TOKEN_TTL_SECS,
      scopes: (r.scopes as string[]) ?? [],
    };
  }

  // No rotation happened. Check whether the presented hash matches a
  // *previous* hash (replay attack signal). If so, revoke the authorisation.
  const replayRows = (await sql`
    UPDATE oauth_authorisations
    SET revoked_at = NOW()
    WHERE previous_refresh_token_hash = ${presentedHash}
      AND oauth_app_id = ${oauthAppId}::uuid
      AND revoked_at IS NULL
    RETURNING id, user_id, company_id
  `) as Row[];

  if (replayRows.length > 0) {
    log.warn(
      'OAuth refresh-token replay detected — authorisation revoked',
      { clientId: args.clientId, authorisationId: replayRows[0]!.id, userId: replayRows[0]!.user_id },
      'oauth',
    );
  } else {
    log.info('OAuth refresh: unknown or expired token', { clientId: args.clientId }, 'oauth');
  }

  throw new OauthExchangeError('invalid_grant', 'Refresh token is invalid, expired, or has been replayed');
}

// ── Access token validation ─────────────────────────────────────────────────

export interface OauthAccessContext {
  authorisationId: string;
  oauthAppId: string;
  userId: string;
  companyId: string;
  scopes: string[];
}

export async function validateOauthAccessToken(
  rawToken: string,
  ip: string | null,
): Promise<OauthAccessContext | null> {
  if (!rawToken.startsWith('oat_')) return null;
  const hash = sha256Hex(rawToken);

  // Validation runs on the privileged default pool (validateOauthAccessToken
  // is called BEFORE the request's app_user transaction is set up). The query
  // bypasses RLS by virtue of the role; the lookup is hash-keyed so this is
  // intentional.
  const rows = (await sql`
    SELECT id, oauth_app_id, user_id, company_id, scopes, access_token_expires_at
    FROM oauth_authorisations
    WHERE access_token_hash = ${hash}
      AND revoked_at IS NULL
      AND access_token_expires_at > NOW()
    LIMIT 1
  `) as Row[];

  if (rows.length === 0) return null;
  const r = rows[0]!;

  // last_used_at update — also via the privileged default pool (HIGH-5 fix).
  // The original implementation used the same `sql` template inside ALS scope
  // and was rejected by RLS (FOR ALL TO app_user). Running outside ALS via a
  // fresh query goes through getPool() default role, bypassing RLS.
  void updateLastUsed(r.id as string, ip).catch((err) =>
    log.warn(
      'OAuth: failed to update last_used_at',
      { err: err instanceof Error ? err.message : String(err) },
      'oauth',
    ),
  );

  return {
    authorisationId: r.id as string,
    oauthAppId: r.oauth_app_id as string,
    userId: r.user_id as string,
    companyId: r.company_id as string,
    scopes: Array.isArray(r.scopes) ? (r.scopes as string[]) : [],
  };
}

/**
 * Last-used update that explicitly bypasses ALS context — must run on the
 * default-role pool because RLS on oauth_authorisations rejects writes from
 * app_user except via the owner policy (which works only when JWT claims are
 * set, i.e. inside the request's app_user tx).
 *
 * We use a no-op `als.run` with empty store... no — simplest path is to call
 * sql() outside any transaction context. Since this function is invoked from
 * validateOauthAccessToken which itself runs BEFORE als.run() in the auth
 * wrapper, the bare `sql` template falls through to getPool() (see neon.ts
 * line 88-93). That's the privileged role.
 */
async function updateLastUsed(authorisationId: string, ip: string | null): Promise<void> {
  await sql`
    UPDATE oauth_authorisations
    SET last_used_at = NOW(), last_used_ip = ${ip}::inet
    WHERE id = ${authorisationId}::uuid
  `;
}

// ── Connected apps ──────────────────────────────────────────────────────────

export interface ConnectedApp {
  authorisationId: string;
  appId: string;
  appName: string;
  appLogoUrl: string | null;
  appIsVerified: boolean;
  scopes: string[];
  companyId: string;
  lastUsedAt: string | null;
  createdAt: string;
}

export async function listConnectedApps(userId: string, companyId: string): Promise<ConnectedApp[]> {
  const rows = (await sql`
    SELECT a.id AS authorisation_id, a.oauth_app_id, a.scopes, a.company_id,
           a.last_used_at, a.created_at,
           app.name AS app_name, app.logo_url AS app_logo_url, app.is_verified
    FROM oauth_authorisations a
    JOIN oauth_apps app ON app.id = a.oauth_app_id
    WHERE a.user_id = ${userId}
      AND a.company_id = ${companyId}::uuid
      AND a.revoked_at IS NULL
    ORDER BY a.created_at DESC
  `) as Row[];

  return rows.map((r) => ({
    authorisationId: r.authorisation_id as string,
    appId: r.oauth_app_id as string,
    appName: r.app_name as string,
    appLogoUrl: r.app_logo_url as string | null,
    appIsVerified: Boolean(r.is_verified),
    scopes: Array.isArray(r.scopes) ? (r.scopes as string[]) : [],
    companyId: r.company_id as string,
    lastUsedAt: r.last_used_at ? (r.last_used_at as Date).toISOString() : null,
    createdAt: (r.created_at as Date).toISOString(),
  }));
}

/**
 * Revoke EVERY live OAuth authorisation belonging to a user, across all their
 * companies and every connected app. Counterpart to revokeAllUserPats; used by
 * suspendUser. validateOauthAccessToken filters on `revoked_at IS NULL`, so
 * both the access token and any refresh flow stop at the next request.
 *
 * Returns the number of authorisations actually revoked.
 */
export async function revokeAllUserAuthorisations(userId: string): Promise<number> {
  const rows = (await sql`
    UPDATE oauth_authorisations
    SET revoked_at = NOW()
    WHERE user_id = ${userId}
      AND revoked_at IS NULL
    RETURNING id
  `) as Row[];

  if (rows.length > 0) log.info('All OAuth authorisations revoked for user', { userId, count: rows.length }, 'oauth');
  return rows.length;
}

export async function revokeAuthorisation(
  authorisationId: string,
  userId: string,
  companyId: string,
): Promise<boolean> {
  const rows = (await sql`
    UPDATE oauth_authorisations
    SET revoked_at = NOW()
    WHERE id = ${authorisationId}::uuid
      AND user_id = ${userId}
      AND company_id = ${companyId}::uuid
      AND revoked_at IS NULL
    RETURNING id
  `) as Row[];
  return rows.length > 0;
}
