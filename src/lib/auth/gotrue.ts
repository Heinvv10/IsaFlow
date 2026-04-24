// src/lib/auth/gotrue.ts
import { jwtVerify, type JWTPayload } from 'jose';

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

export async function logout(accessToken: string): Promise<void> {
  await gotrueFetch(
    '/logout',
    { method: 'POST' },
    { apikey: getEnv('SUPABASE_ANON_KEY'), Authorization: `Bearer ${accessToken}` }
  );
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
  const res = await gotrueFetch(
    `/admin/users?filter=${encodeURIComponent(`email.eq.${email}`)}`,
    { method: 'GET' },
    adminHeaders()
  );
  if (!res.ok) throw new Error(`gotrue getUserByEmail failed: ${res.status}`);
  const body = (await res.json()) as { users?: GoTrueUser[] };
  const user = body.users?.[0];
  if (!user) throw new Error(`no gotrue user with email ${email}`);
  return user;
}

/**
 * User-level self-update via GoTrue. Unlike adminUpdateUser, a PUT /user
 * call with a new `email` does NOT change the address immediately — GoTrue
 * starts an email-change flow and sends a confirmation link to the new
 * address. The email only switches over when the user clicks that link.
 *
 * Caller must pass the user's own access token (not the service role key).
 */
export async function userUpdateSelf(
  accessToken: string,
  patch: { email?: string; password?: string; data?: Record<string, unknown> }
): Promise<GoTrueUser> {
  const res = await gotrueFetch(
    '/user',
    { method: 'PUT', body: JSON.stringify(patch) },
    { Authorization: `Bearer ${accessToken}`, apikey: getEnv('SUPABASE_ANON_KEY') }
  );
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`gotrue userUpdateSelf failed: ${res.status} ${body}`);
  }
  return res.json() as Promise<GoTrueUser>;
}

export async function adminUpdateUser(
  userId: string,
  patch: { email?: string; password?: string; user_metadata?: Record<string, unknown> }
): Promise<GoTrueUser> {
  const res = await gotrueFetch(
    `/admin/users/${userId}`,
    { method: 'PUT', body: JSON.stringify(patch) },
    adminHeaders()
  );
  if (!res.ok) throw new Error(`gotrue adminUpdateUser failed: ${res.status}`);
  return res.json() as Promise<GoTrueUser>;
}

export async function adminDeleteUser(userId: string): Promise<void> {
  const res = await gotrueFetch(`/admin/users/${userId}`, { method: 'DELETE' }, adminHeaders());
  if (!res.ok) throw new Error(`gotrue adminDeleteUser failed: ${res.status}`);
}

export async function recoverPassword(email: string, redirectTo: string): Promise<void> {
  // GoTrue's /recover validates redirect_to against GOTRUE_URI_ALLOW_LIST but
  // prefers the Referer header when constructing the recovery mail link. If
  // Referer is missing or just the site origin, the emailed redirect_to is
  // stripped to bare SITE_URL and users land on /login instead of
  // /reset-password. Set Referer explicitly to the target URL so the emailed
  // link preserves the full path.
  const res = await gotrueFetch(
    '/recover',
    { method: 'POST', body: JSON.stringify({ email, redirect_to: redirectTo }) },
    { apikey: getEnv('SUPABASE_ANON_KEY'), Referer: redirectTo }
  );
  if (!res.ok) throw new Error(`gotrue recover failed: ${res.status}`);
}
