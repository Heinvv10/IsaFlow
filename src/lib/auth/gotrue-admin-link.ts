// src/lib/auth/gotrue-admin-link.ts
// Thin HTTP client for GoTrue's admin generate_link + verify endpoints.

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

export class GotrueAdminLinkError extends Error {
  constructor(public readonly status: number, message: string, public readonly body: unknown) {
    super(message);
    this.name = 'GotrueAdminLinkError';
  }
}

async function doFetch<T>(path: string, init: RequestInit, headers: Record<string, string>): Promise<T> {
  const res = await fetch(gotrueUrl(path), {
    ...init,
    headers: { 'content-type': 'application/json', ...headers },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new GotrueAdminLinkError(res.status, `gotrue ${path} failed: ${res.status}`, body);
  }
  return res.json() as Promise<T>;
}

export type LinkType = 'magiclink' | 'recovery';

export interface GenerateLinkResult {
  action_link: string;
  token: string;
  hashed_token: string;
  verification_type: LinkType;
}

export async function generateLink(
  type: LinkType,
  email: string,
  redirectTo?: string,
): Promise<GenerateLinkResult> {
  const key = serviceKey();
  interface RawResponse { action_link?: string; hashed_token?: string; verification_type?: LinkType }
  const body: Record<string, unknown> = { type, email };
  if (redirectTo) body.redirect_to = redirectTo;
  const raw = await doFetch<RawResponse>(
    '/admin/generate_link',
    { method: 'POST', body: JSON.stringify(body) },
    { Authorization: `Bearer ${key}`, apikey: key }
  );
  const actionLink = raw.action_link ?? '';
  // Use String.match (not RegExp.exec) — semantically identical for this
  // non-global pattern, returns [fullMatch, group1].
  const match = actionLink.match(/[?&]token=([^&]+)/);
  const token = match ? match[1]! : (raw.hashed_token ?? '');
  if (!token) {
    throw new GotrueAdminLinkError(500, 'gotrue generate_link returned no token', raw);
  }
  return {
    action_link: actionLink,
    token,
    hashed_token: raw.hashed_token ?? token,
    verification_type: raw.verification_type ?? type,
  };
}

export interface VerifyMagicLinkResult {
  access_token: string;
  refresh_token: string;
  expires_in: number;
}

export async function verifyMagicLink(tokenHash: string, _email: string): Promise<VerifyMagicLinkResult> {
  // GoTrue /verify with token_hash accepts ONLY { type, token_hash } — no email field.
  const res = await doFetch<VerifyMagicLinkResult & { token_type?: string; expires_at?: number }>(
    '/verify',
    { method: 'POST', body: JSON.stringify({ type: 'magiclink', token_hash: tokenHash }) },
    { apikey: anonKey() }
  );
  return { access_token: res.access_token, refresh_token: res.refresh_token, expires_in: res.expires_in };
}
