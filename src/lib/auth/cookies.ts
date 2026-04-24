// src/lib/auth/cookies.ts
import type { NextApiRequest, NextApiResponse } from 'next';

export const ACCESS_COOKIE = 'sb-access-token';
export const REFRESH_COOKIE = 'sb-refresh-token';
export const ACTIVE_COMPANY_COOKIE = 'active_company_id';
// Pentest H6: holds the AAL1 GoTrue token between /login and /2fa-challenge.
// HttpOnly + short TTL (5 min) — never exposed to JS or returned in response bodies.
export const PENDING_MFA_COOKIE = 'sb-pending-mfa';

function isSecure(): boolean {
  return process.env.NODE_ENV === 'production';
}

function cookieDomain(): string | undefined {
  const v = process.env.COOKIE_DOMAIN?.trim();
  return v ? v : undefined;
}

function cookieFlags(maxAgeSeconds: number, domain?: string): string {
  const parts = [
    `Path=/`,
    `Max-Age=${maxAgeSeconds}`,
    `HttpOnly`,
    `SameSite=Lax`,
  ];
  if (isSecure()) parts.push('Secure');
  if (domain) parts.push(`Domain=${domain}`);
  return parts.join('; ');
}

export function parseCookies(req: NextApiRequest): Record<string, string> {
  const header = req.headers.cookie ?? '';
  const out: Record<string, string> = {};
  for (const part of header.split(';')) {
    const s = part.trim();
    if (!s) continue;
    const eq = s.indexOf('=');
    if (eq < 0) continue;
    const k = s.slice(0, eq).trim();
    const v = decodeURIComponent(s.slice(eq + 1).trim());
    out[k] = v;
  }
  return out;
}

function appendSetCookie(res: NextApiResponse, cookie: string): void {
  const existing = res.getHeader('Set-Cookie');
  if (!existing) {
    res.setHeader('Set-Cookie', [cookie]);
    return;
  }
  const arr = Array.isArray(existing) ? existing.map(String) : [String(existing)];
  arr.push(cookie);
  res.setHeader('Set-Cookie', arr);
}

export function setAuthCookies(
  res: NextApiResponse,
  params: { accessToken: string; refreshToken: string; expiresIn: number }
): void {
  const domain = cookieDomain();
  appendSetCookie(
    res,
    `${ACCESS_COOKIE}=${params.accessToken}; ${cookieFlags(params.expiresIn, domain)}`
  );
  // Refresh token lives longer than the access token; GoTrue default 30d.
  appendSetCookie(
    res,
    `${REFRESH_COOKIE}=${params.refreshToken}; ${cookieFlags(60 * 60 * 24 * 30, domain)}`
  );
}

export function setActiveCompanyCookie(res: NextApiResponse, companyId: string): void {
  appendSetCookie(
    res,
    `${ACTIVE_COMPANY_COOKIE}=${companyId}; ${cookieFlags(60 * 60 * 24 * 30, cookieDomain())}`
  );
}

export function setPendingMfaCookie(res: NextApiResponse, pendingToken: string): void {
  // 5-minute TTL — just long enough for the user to type a TOTP code.
  appendSetCookie(res, `${PENDING_MFA_COOKIE}=${pendingToken}; ${cookieFlags(300, cookieDomain())}`);
}

export function clearPendingMfaCookie(res: NextApiResponse): void {
  appendSetCookie(res, `${PENDING_MFA_COOKIE}=; ${cookieFlags(0, cookieDomain())}`);
}

/**
 * Clears auth cookies. During the COOKIE_DOMAIN transition we emit clears for
 * BOTH host-scoped (pre-transition) and domain-scoped (post-transition)
 * cookies, so a single logout resolves any ambiguity left by older sessions.
 *
 * NOTE: If COOKIE_DOMAIN is removed from env after previously being set,
 * domain-scoped cookies from pre-removal sessions will NOT be cleared by
 * this function. Always pair a COOKIE_DOMAIN removal with a forced session
 * invalidation on the server side (e.g. rotate JWT_SECRET).
 */
export function clearAuthCookies(res: NextApiResponse): void {
  const domain = cookieDomain();
  for (const name of [ACCESS_COOKIE, REFRESH_COOKIE, ACTIVE_COMPANY_COOKIE, PENDING_MFA_COOKIE]) {
    appendSetCookie(res, `${name}=; ${cookieFlags(0)}`);
    if (domain) {
      appendSetCookie(res, `${name}=; ${cookieFlags(0, domain)}`);
    }
  }
}
