// src/lib/auth/gotrue.ts
import { jwtVerify, SignJWT, type JWTPayload } from 'jose';

export interface GoTrueUser {
  id: string;
  email: string;
  created_at?: string;
  user_metadata?: Record<string, unknown>;
  app_metadata?: Record<string, unknown>;
}

export interface GoTrueTokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  token_type: 'bearer';
  user: GoTrueUser;
}

export interface GoTrueClaims extends JWTPayload {
  sub: string;
  email?: string;
  role?: string;
  aud?: string | string[];
}

function getEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set`);
  return v;
}

function gotrueUrl(path: string): string {
  const base = getEnv('GOTRUE_URL').replace(/\/+$/, '');
  return `${base}${path.startsWith('/') ? path : `/${path}`}`;
}

function jwtKey(): Uint8Array {
  return new TextEncoder().encode(getEnv('JWT_SECRET'));
}

export async function verifyToken(token: string): Promise<GoTrueClaims> {
  const { payload } = await jwtVerify(token, jwtKey(), { algorithms: ['HS256'] });
  if (typeof payload.sub !== 'string') {
    throw new Error('JWT missing sub claim');
  }
  return payload as GoTrueClaims;
}

async function gotrueFetch(
  path: string,
  init: RequestInit,
  extraHeaders: Record<string, string> = {}
): Promise<Response> {
  const res = await fetch(gotrueUrl(path), {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...(init.headers as Record<string, string> | undefined),
      ...extraHeaders,
    },
  });
  return res;
}

function adminHeaders(): Record<string, string> {
  const key = getEnv('SUPABASE_SERVICE_ROLE_KEY');
  return { Authorization: `Bearer ${key}`, apikey: key };
}

export async function signIn(email: string, password: string): Promise<GoTrueTokenResponse> {
  const res = await gotrueFetch(
    '/token?grant_type=password',
    { method: 'POST', body: JSON.stringify({ email, password }) },
    { apikey: getEnv('SUPABASE_ANON_KEY') }
  );
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`gotrue signIn failed: ${res.status} ${body}`);
  }
  return res.json() as Promise<GoTrueTokenResponse>;
}

export async function refresh(refreshToken: string): Promise<GoTrueTokenResponse> {
  const res = await gotrueFetch(
    '/token?grant_type=refresh_token',
    { method: 'POST', body: JSON.stringify({ refresh_token: refreshToken }) },
    { apikey: getEnv('SUPABASE_ANON_KEY') }
  );
  if (!res.ok) throw new Error(`gotrue refresh failed: ${res.status}`);
  return res.json() as Promise<GoTrueTokenResponse>;
}

// GoTrue /logout scopes (verified against this deployment, GoTrue @ :7770):
//   'global'  — revoke EVERY refresh token for the token's user (default).
//   'others'  — revoke every session EXCEPT the presented one (keeps the caller).
//   'local'   — revoke only the presented session.
// Empirically: scope=others → 204, the presented refresh token still refreshes
// (200) while every other refresh token is revoked (400); scope=global → 204,
// the presented token is revoked too (400).
export type LogoutScope = 'global' | 'local' | 'others';

/**
 * Sign a user out of GoTrue sessions. THROWS on any non-2xx response so callers
 * can treat a failed revocation as a real error instead of silently assuming
 * sessions were cleared — a stateless HS256 refresh token stays live until
 * GoTrue actually revokes it here.
 */
export async function logout(accessToken: string, scope: LogoutScope = 'global'): Promise<void> {
  const res = await gotrueFetch(
    `/logout?scope=${scope}`,
    { method: 'POST' },
    { apikey: getEnv('SUPABASE_ANON_KEY'), Authorization: `Bearer ${accessToken}` }
  );
  if (!res.ok) {
    throw new Error(`gotrue logout failed: ${res.status} ${await res.text().catch(() => '')}`);
  }
}

/**
 * Mint a short-lived GoTrue-shaped access token for `userId`, signed with the
 * same JWT_SECRET GoTrue uses (HS256). ADMIN-ONLY: this authorises a global
 * sign-out for a target user WITHOUT their password. GoTrue's global /logout
 * reads only the `sub` claim, so no live session row is required and no new
 * session is created by minting this token. The 60s lifetime is only long
 * enough to survive the single /logout call it is minted for.
 */
export async function mintUserAccessToken(userId: string, email?: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const claims: Record<string, unknown> = { aud: 'authenticated', role: 'authenticated' };
  if (email) claims.email = email;
  return new SignJWT(claims)
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setSubject(userId)
    .setIssuedAt(now)
    .setExpirationTime(now + 60)
    .sign(jwtKey());
}

/**
 * Admin "force logout": revoke EVERY GoTrue refresh token for `userId` without
 * their password. Mints a token for the target user, then POST /logout?scope=
 * global, which GoTrue serves by deleting all refresh tokens for the token's
 * `sub`. THROWS on any non-2xx (via logout) so callers fail closed — a stateless
 * HS256 refresh token stays live until GoTrue actually revokes it, so a caller
 * must never report a successful logout while sessions may still refresh.
 *
 * Verified against this deployment (GoTrue @ :7770): self-minted token →
 * /logout?scope=global → 204; the target's refresh tokens then return
 * refresh_token_not_found (400). The alternative POST /admin/users/{id}/logout
 * route does NOT exist here (404).
 */
export async function adminRevokeAllUserSessions(userId: string, email?: string): Promise<void> {
  const token = await mintUserAccessToken(userId, email);
  await logout(token, 'global');
}

export interface AdminCreateUserInput {
  email: string;
  password?: string;
  email_confirm?: boolean;
  user_metadata?: Record<string, unknown>;
  app_metadata?: Record<string, unknown>;
}

export async function adminCreateUser(input: AdminCreateUserInput): Promise<GoTrueUser> {
  const res = await gotrueFetch(
    '/admin/users',
    { method: 'POST', body: JSON.stringify(input) },
    adminHeaders()
  );
  if (!res.ok && res.status !== 422) {
    throw new Error(`gotrue adminCreateUser failed: ${res.status} ${await res.text().catch(() => '')}`);
  }
  if (res.status === 422) {
    // User already exists — look them up instead
    return adminGetUserByEmail(input.email);
  }
  return res.json() as Promise<GoTrueUser>;
}

export async function adminGetUserByEmail(email: string): Promise<GoTrueUser> {
  // GoTrue's admin `/admin/users?filter=` is a free-text ILIKE over email/phone,
  // NOT a PostgREST `col.op.val` expression: `email.eq.<x>` is taken literally
  // and matches nothing, so the old query silently found no users (e.g. every
  // forgot-password lookup threw "no user" → no reset email was ever sent).
  // Filter by the raw email to narrow server-side, then exact-match (case-
  // insensitive) client-side since ILIKE can also return substring near-matches.
  // per_page large enough that the exact match can't be paginated off page 1
  // even if many substring near-matches share the filter (admin list paginates).
  const res = await gotrueFetch(
    `/admin/users?filter=${encodeURIComponent(email)}&per_page=1000`,
    { method: 'GET' },
    adminHeaders()
  );
  if (!res.ok) throw new Error(`gotrue getUserByEmail failed: ${res.status}`);
  const body = (await res.json()) as { users?: GoTrueUser[] };
  const target = email.trim().toLowerCase();
  const user = body.users?.find((u) => u.email?.trim().toLowerCase() === target);
  if (!user) throw new Error(`no gotrue user with email ${email}`);
  return user;
}

export async function adminUpdateUser(
  userId: string,
  patch: {
    email?: string;
    password?: string;
    user_metadata?: Record<string, unknown>;
    // When true, an admin-initiated email change skips GoTrue's secure-email-
    // change double-confirm and switches the login email immediately.
    email_confirm?: boolean;
  }
): Promise<GoTrueUser> {
  const res = await gotrueFetch(
    `/admin/users/${userId}`,
    { method: 'PUT', body: JSON.stringify(patch) },
    adminHeaders()
  );
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`gotrue adminUpdateUser failed: ${res.status} ${body}`);
  }
  return res.json() as Promise<GoTrueUser>;
}

export async function adminDeleteUser(userId: string): Promise<void> {
  const res = await gotrueFetch(`/admin/users/${userId}`, { method: 'DELETE' }, adminHeaders());
  if (!res.ok) throw new Error(`gotrue adminDeleteUser failed: ${res.status}`);
}

