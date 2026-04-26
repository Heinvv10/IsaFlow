/**
 * OAuth 2.0 service — PRD-10 Layer 2.
 *
 * Standard authorization-code flow with PKCE. Opaque access + refresh tokens
 * (instant revocation, mirrors PAT pattern from src/lib/auth/personalAccessTokens.ts).
 * Single-use refresh tokens — replaying a used refresh token returns
 * invalid_grant.
 *
 * Token formats:
 *   - Authorisation code:  oac_<32 base62>     (5-min TTL, single-use, PKCE-bound)
 *   - Access token:        oat_<32 base62>     (~1h TTL, opaque)
 *   - Refresh token:       ort_<32 base62>     (30d rolling, single-use)
 *   - Client secret:       cls_<32 base62>     (shown once at app registration)
 *
 * All tokens are SHA-256 hashed before storage; raw values are returned to the
 * client exactly once at issue time.
 */

import { createHash, randomBytes, timingSafeEqual } from 'crypto';
import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';

type Row = Record<string, unknown>;

export const OAUTH_SCOPES = [
  'read:invoices',
  'write:invoices',
  'read:bank-tx',
  'write:bank-tx',
  'write:journals',
  'read:reports',
  'offline_access',
] as const;
export type OAuthScope = (typeof OAUTH_SCOPES)[number];

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

function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

function generateToken(prefix: string, len = 32): { raw: string; hash: string; prefix12: string } {
  const raw = `${prefix}${base62(len)}`;
  return { raw, hash: sha256(raw), prefix12: raw.slice(0, 12) };
}

// ── App registration ────────────────────────────────────────────────────────

export interface RegisterAppInput {
  ownerUserId: string;
  name: string;
  description?: string | null;
  logoUrl?: string | null;
  homepageUrl?: string | null;
  redirectUris: string[];
}

export interface RegisteredApp {
  id: string;
  clientId: string;
  clientSecret: string;
}

export async function registerOauthApp(input: RegisterAppInput): Promise<RegisteredApp> {
  if (input.redirectUris.length === 0) {
    throw new Error('registerOauthApp: at least one redirect URI required');
  }
  for (const uri of input.redirectUris) {
    try { new URL(uri); } catch { throw new Error(`registerOauthApp: invalid redirect URI: ${uri}`); }
  }

  const clientId = `client_${base62(24)}`;
  const { raw: clientSecret, hash: secretHash, prefix12: secretPrefix } = generateToken('cls_', 32);

  const rows = (await sql`
    INSERT INTO oauth_apps (
      name, description, logo_url, homepage_url, redirect_uris,
      client_id, client_secret_hash, client_secret_prefix, owner_user_id
    )
    VALUES (
      ${input.name},
      ${input.description ?? null},
      ${input.logoUrl ?? null},
      ${input.homepageUrl ?? null},
      ${input.redirectUris},
      ${clientId},
      ${secretHash},
      ${secretPrefix},
      ${input.ownerUserId}
    )
    RETURNING id
  `) as Row[];

  if (!rows[0]) throw new Error('registerOauthApp: insert returned no row');

  log.info('OAuth app registered', { appId: rows[0].id, ownerUserId: input.ownerUserId, name: input.name }, 'oauth');
  return { id: rows[0].id as string, clientId, clientSecret };
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
}

export async function getOauthAppByClientId(clientId: string): Promise<PublicOauthApp | null> {
  const rows = (await sql`
    SELECT id, name, description, logo_url, homepage_url, redirect_uris,
           client_id, is_verified, is_first_party
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
  const expected = sha256(presentedSecret);
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
  const codeHash = sha256(code);
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

export async function exchangeCode(args: {
  code: string;
  redirectUri: string;
  codeVerifier: string;
  oauthAppId: string;
}): Promise<ExchangeResult> {
  const codeHash = sha256(args.code);
  const verifierChallenge = createHash('sha256').update(args.codeVerifier).digest('base64url');

  const rows = (await sql`
    UPDATE oauth_authorisation_codes
    SET used_at = NOW()
    WHERE code_hash = ${codeHash}
      AND used_at IS NULL
      AND expires_at > NOW()
      AND oauth_app_id = ${args.oauthAppId}::uuid
      AND redirect_uri = ${args.redirectUri}
    RETURNING user_id, company_id, scopes, code_challenge
  `) as Row[];

  if (rows.length === 0) {
    throw new OauthExchangeError(
      'invalid_grant',
      'Authorisation code is invalid, expired, used, or does not match the redirect URI',
    );
  }

  const r = rows[0]!;
  if ((r.code_challenge as string) !== verifierChallenge) {
    throw new OauthExchangeError(
      'invalid_grant',
      'PKCE verifier does not match the challenge from /authorize',
    );
  }

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
}

async function issueTokens(input: IssueTokensInput): Promise<ExchangeResult> {
  const access = generateToken('oat_', 32);
  const refresh = generateToken('ort_', 32);
  const includesOffline = input.scopes.includes('offline_access');

  await sql`
    INSERT INTO oauth_authorisations (
      oauth_app_id, user_id, company_id, scopes,
      access_token_hash, access_token_prefix, access_token_expires_at,
      refresh_token_hash, refresh_token_prefix, refresh_token_expires_at
    )
    VALUES (
      ${input.oauthAppId}::uuid,
      ${input.userId},
      ${input.companyId}::uuid,
      ${input.scopes},
      ${access.hash},
      ${access.prefix12},
      NOW() + (${ACCESS_TOKEN_TTL_SECS} || ' seconds')::interval,
      ${refresh.hash},
      ${refresh.prefix12},
      NOW() + (${REFRESH_TOKEN_TTL_SECS} || ' seconds')::interval
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
      revoked_at = NULL
  `;

  return {
    accessToken: access.raw,
    refreshToken: includesOffline ? refresh.raw : '',
    accessTokenExpiresIn: ACCESS_TOKEN_TTL_SECS,
    scopes: input.scopes,
  };
}

export async function refreshAccessToken(args: {
  refreshToken: string;
  clientId: string;
}): Promise<ExchangeResult> {
  const oldHash = sha256(args.refreshToken);

  const appRows = (await sql`
    SELECT id FROM oauth_apps WHERE client_id = ${args.clientId} AND revoked_at IS NULL LIMIT 1
  `) as Row[];
  if (appRows.length === 0) {
    throw new OauthExchangeError('invalid_client', 'Unknown client');
  }
  const oauthAppId = appRows[0]!.id as string;

  const rows = (await sql`
    SELECT id, user_id, company_id, scopes, refresh_token_expires_at
    FROM oauth_authorisations
    WHERE refresh_token_hash = ${oldHash}
      AND oauth_app_id = ${oauthAppId}::uuid
      AND revoked_at IS NULL
    LIMIT 1
  `) as Row[];

  if (rows.length === 0) {
    log.warn('OAuth refresh: invalid or replayed refresh token', { clientId: args.clientId }, 'oauth');
    throw new OauthExchangeError('invalid_grant', 'Refresh token is invalid or expired');
  }

  const r = rows[0]!;
  if ((r.refresh_token_expires_at as Date).getTime() <= Date.now()) {
    throw new OauthExchangeError('invalid_grant', 'Refresh token has expired');
  }

  return await issueTokens({
    oauthAppId,
    userId: r.user_id as string,
    companyId: r.company_id as string,
    scopes: (r.scopes as string[]) ?? [],
  });
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
  const hash = sha256(rawToken);

  const rows = (await sql`
    SELECT id, oauth_app_id, user_id, company_id, scopes, access_token_expires_at
    FROM oauth_authorisations
    WHERE access_token_hash = ${hash}
      AND revoked_at IS NULL
    LIMIT 1
  `) as Row[];

  if (rows.length === 0) return null;
  const r = rows[0]!;
  const expiry = (r.access_token_expires_at as Date | null)?.getTime() ?? 0;
  if (expiry <= Date.now()) return null;

  sql`
    UPDATE oauth_authorisations
    SET last_used_at = NOW(), last_used_ip = ${ip}::inet
    WHERE id = ${r.id as string}::uuid
  `.catch((err: unknown) =>
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
