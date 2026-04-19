// src/lib/auth/gotrue-mfa.ts
// Thin HTTP client for GoTrue's MFA endpoints. IsaFlow does not persist any
// factor material — GoTrue's auth.mfa_factors owns TOTP.

function gotrueUrl(path: string): string {
  const base = (process.env.GOTRUE_URL ?? '').replace(/\/+$/, '');
  if (!base) throw new Error('GOTRUE_URL is not set');
  return `${base}${path.startsWith('/') ? path : `/${path}`}`;
}

function anonKey(): string {
  const v = process.env.SUPABASE_ANON_KEY;
  if (!v) throw new Error('SUPABASE_ANON_KEY is not set');
  return v;
}

function serviceKey(): string {
  const v = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!v) throw new Error('SUPABASE_SERVICE_ROLE_KEY is not set');
  return v;
}

export class GotrueMfaError extends Error {
  constructor(public readonly status: number, message: string, public readonly body: unknown) {
    super(message);
    this.name = 'GotrueMfaError';
  }
}

async function mfaFetch<T>(
  path: string,
  init: RequestInit,
  headers: Record<string, string>
): Promise<T> {
  const res = await fetch(gotrueUrl(path), {
    ...init,
    headers: { 'content-type': 'application/json', apikey: anonKey(), ...headers },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new GotrueMfaError(res.status, `gotrue ${path} failed: ${res.status}`, body);
  }
  return res.json() as Promise<T>;
}

export interface Factor {
  id: string;
  status: 'verified' | 'unverified';
  factor_type: 'totp' | 'phone';
  friendly_name?: string;
  created_at?: string;
}

export interface ListFactorsResponse {
  totp: Factor[];
}

// GoTrue v2 has no GET /factors — the authoritative source for a user's
// enrolled factors is GET /user, which returns { ..., factors: [...] }.
export async function listFactors(userAccessToken: string): Promise<ListFactorsResponse> {
  const user = await mfaFetch<{ factors?: Factor[] }>(
    '/user',
    { method: 'GET' },
    { Authorization: `Bearer ${userAccessToken}` }
  );
  const all = user.factors ?? [];
  return { totp: all.filter((f) => f.factor_type === 'totp') };
}

export interface EnrollTotpResult {
  factor_id: string;
  qr_code: string; // SVG XML string (raw <svg>…</svg>) — NOT a data: URL
  secret: string; // base32 shared secret (32 chars)
}

export async function enrollTotp(userAccessToken: string, friendlyName: string): Promise<EnrollTotpResult> {
  const res = await mfaFetch<{ id: string; totp: { qr_code: string; secret: string; uri: string } }>(
    '/factors',
    {
      method: 'POST',
      body: JSON.stringify({ factor_type: 'totp', issuer: 'IsaFlow', friendly_name: friendlyName }),
    },
    { Authorization: `Bearer ${userAccessToken}` }
  );
  return { factor_id: res.id, qr_code: res.totp.qr_code, secret: res.totp.secret };
}

export async function challengeFactor(factorId: string, userAccessToken: string): Promise<string> {
  const res = await mfaFetch<{ id: string; expires_at: number }>(
    `/factors/${encodeURIComponent(factorId)}/challenge`,
    { method: 'POST' },
    { Authorization: `Bearer ${userAccessToken}` }
  );
  return res.id;
}

export interface VerifyFactorResult {
  access_token: string;
  refresh_token: string;
  expires_in: number;
}

export async function verifyFactor(
  factorId: string,
  challengeId: string,
  code: string,
  userAccessToken: string
): Promise<VerifyFactorResult> {
  return mfaFetch<VerifyFactorResult>(
    `/factors/${encodeURIComponent(factorId)}/verify`,
    { method: 'POST', body: JSON.stringify({ challenge_id: challengeId, code }) },
    { Authorization: `Bearer ${userAccessToken}` }
  );
}

export async function unenrollFactor(factorId: string, userAccessToken: string): Promise<void> {
  await mfaFetch<unknown>(
    `/factors/${encodeURIComponent(factorId)}`,
    { method: 'DELETE' },
    { Authorization: `Bearer ${userAccessToken}` }
  );
}

export async function adminUnenrollFactor(userId: string, factorId: string): Promise<void> {
  const key = serviceKey();
  await mfaFetch<unknown>(
    `/admin/users/${encodeURIComponent(userId)}/factors/${encodeURIComponent(factorId)}`,
    { method: 'DELETE' },
    { Authorization: `Bearer ${key}`, apikey: key }
  );
}
