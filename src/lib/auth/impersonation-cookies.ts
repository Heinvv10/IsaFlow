// src/lib/auth/impersonation-cookies.ts
// Cookie helpers for impersonation — mirrors the dual-scope pattern in cookies.ts.
import type { NextApiResponse } from 'next';

export const IMPERSONATION_PROOF_COOKIE = 'sb-impersonation-proof';
export const ADMIN_STASH_COOKIE = 'sb-admin-stash';
export const IS_IMPERSONATING_COOKIE = 'is_impersonating';
const ONE_HOUR_SECS = 3600;

function cookieDomain(): string | undefined {
  const v = process.env.COOKIE_DOMAIN?.trim();
  return v ? v : undefined;
}

function isSecure(): boolean {
  return process.env.NODE_ENV === 'production';
}

function buildFlags(maxAgeSeconds: number, opts: { httpOnly: boolean; domain?: string }): string {
  const parts = [`Path=/`, `Max-Age=${maxAgeSeconds}`, `SameSite=Lax`];
  if (opts.httpOnly) parts.push('HttpOnly');
  if (isSecure()) parts.push('Secure');
  if (opts.domain) parts.push(`Domain=${opts.domain}`);
  return parts.join('; ');
}

function append(res: NextApiResponse, cookie: string): void {
  const existing = res.getHeader('Set-Cookie');
  if (!existing) {
    res.setHeader('Set-Cookie', [cookie]);
    return;
  }
  const arr = Array.isArray(existing) ? existing.map(String) : [String(existing)];
  arr.push(cookie);
  res.setHeader('Set-Cookie', arr);
}

export function setImpersonationCookies(res: NextApiResponse, stashId: string, proof?: string): void {
  const domain = cookieDomain();
  if (proof) append(res, `${IMPERSONATION_PROOF_COOKIE}=${proof}; ${buildFlags(ONE_HOUR_SECS, { httpOnly: true, domain })}`);
  append(res, `${ADMIN_STASH_COOKIE}=${stashId}; ${buildFlags(ONE_HOUR_SECS, { httpOnly: true, domain })}`);
  append(res, `${IS_IMPERSONATING_COOKIE}=1; ${buildFlags(ONE_HOUR_SECS, { httpOnly: false, domain })}`);
}

export function clearImpersonationCookies(res: NextApiResponse): void {
  const domain = cookieDomain();
  for (const name of [ADMIN_STASH_COOKIE, IS_IMPERSONATING_COOKIE, IMPERSONATION_PROOF_COOKIE]) {
    append(res, `${name}=; ${buildFlags(0, { httpOnly: name !== IS_IMPERSONATING_COOKIE })}`);
    if (domain) {
      append(res, `${name}=; ${buildFlags(0, { httpOnly: name !== IS_IMPERSONATING_COOKIE, domain })}`);
    }
  }
}

export function clearImpersonationProofCookie(res: NextApiResponse): void {
  append(res, `${IMPERSONATION_PROOF_COOKIE}=; ${buildFlags(0, { httpOnly: true })}`);
  const domain = cookieDomain();
  if (domain) append(res, `${IMPERSONATION_PROOF_COOKIE}=; ${buildFlags(0, { httpOnly: true, domain })}`);
}
