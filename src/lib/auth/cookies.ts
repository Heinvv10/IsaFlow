// src/lib/auth/cookies.ts
import type { NextApiRequest, NextApiResponse } from 'next';

export const ACCESS_COOKIE = 'sb-access-token';
export const REFRESH_COOKIE = 'sb-refresh-token';
export const ACTIVE_COMPANY_COOKIE = 'active_company_id';
export const ONBOARDING_DONE_COOKIE = 'ff_onboarding_done';
// Pentest H6: holds the AAL1 GoTrue token between /login and /2fa-challenge.
// HttpOnly + short TTL (5 min) — never exposed to JS or returned in response bodies.
export const PENDING_MFA_COOKIE = 'sb-pending-mfa';
// PRD-10 Layer 1: hint cookie that mirrors the rememberMe choice.
// Read at /api/auth/refresh so a rotated refresh cookie keeps the user's
// original "Keep me signed in" semantics (persistent vs browser-session).
// HttpOnly — the hint is only consumed server-side via parseCookies(req); making
// it readable from JS would let an XSS payload set it to '1' and silently
// upgrade a session-only login to a 30-day persistent one on next refresh.
export const REMEMBER_ME_COOKIE = 'isaflow_remember_me';

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

// Session-cookie flags: no Max-Age → browser deletes on close.
// Used when "Keep me signed in" is unchecked at login (PRD-10 Layer 1).
function sessionCookieFlags(domain?: string): string {
  const parts = [`Path=/`, `HttpOnly`, `SameSite=Lax`];
  if (isSecure()) parts.push('Secure');
  if (domain) parts.push(`Domain=${domain}`);
  return parts.join('; ');
}

function readableCookieFlags(maxAgeSeconds: number, domain?: string): string {
  const parts = [
    `Path=/`,
    `Max-Age=${maxAgeSeconds}`,
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
  params: { accessToken: string; refreshToken: string; expiresIn: number; persistent?: boolean }
): void {
  const domain = cookieDomain();
  const persistent = params.persistent ?? true;
  // When not persistent ("Keep me signed in" unchecked), BOTH cookies must be
  // session-only. If only the refresh cookie is session-only, a browser close
  // and reopen within ~1h leaves the access cookie alive and the user signed
  // in — contrary to user intent. The JWT's own `exp` claim is the upper
  // bound on session length; cookie Max-Age is just for browser persistence.
  const accessFlags = persistent ? cookieFlags(params.expiresIn, domain) : sessionCookieFlags(domain);
  appendSetCookie(res, `${ACCESS_COOKIE}=${params.accessToken}; ${accessFlags}`);

  const refreshFlags = persistent ? cookieFlags(60 * 60 * 24 * 30, domain) : sessionCookieFlags(domain);
  appendSetCookie(res, `${REFRESH_COOKIE}=${params.refreshToken}; ${refreshFlags}`);

  // Hint cookie mirrors the persistent flag and is HttpOnly (server-only read).
  const hintFlags = persistent ? cookieFlags(60 * 60 * 24 * 30, domain) : sessionCookieFlags(domain);
  appendSetCookie(res, `${REMEMBER_ME_COOKIE}=${persistent ? '1' : '0'}; ${hintFlags}`);
}

export function setActiveCompanyCookie(res: NextApiResponse, companyId: string): void {
  appendSetCookie(
    res,
    `${ACTIVE_COMPANY_COOKIE}=${companyId}; ${cookieFlags(60 * 60 * 24 * 30, cookieDomain())}`
  );
}

export function setOnboardingDoneCookie(res: NextApiResponse): void {
  appendSetCookie(
    res,
    `${ONBOARDING_DONE_COOKIE}=1; ${readableCookieFlags(60 * 60 * 24 * 365, cookieDomain())}`,
  );
}

export function setPendingMfaCookie(res: NextApiResponse, pendingToken: string): void {
  // 5-minute TTL — just long enough for the user to type a TOTP code.
  appendSetCookie(res, `${PENDING_MFA_COOKIE}=${pendingToken}; ${cookieFlags(300, cookieDomain())}`);
}

export function clearPendingMfaCookie(res: NextApiResponse): void {
  appendSetCookie(res, `${PENDING_MFA_COOKIE}=; ${cookieFlags(0, cookieDomain())}`);
}

// PRD-10 Layer 1: carries the rememberMe choice from /login through to /2fa-challenge.
// Same 5-minute TTL as the pending MFA cookie (paired lifecycle).
export const PENDING_REMEMBER_COOKIE = 'sb-pending-remember-me';

export function setPendingRememberCookie(res: NextApiResponse, persistent: boolean): void {
  appendSetCookie(
    res,
    `${PENDING_REMEMBER_COOKIE}=${persistent ? '1' : '0'}; ${cookieFlags(300, cookieDomain())}`,
  );
}

export function clearPendingRememberCookie(res: NextApiResponse): void {
  appendSetCookie(res, `${PENDING_REMEMBER_COOKIE}=; ${cookieFlags(0, cookieDomain())}`);
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
  for (const name of [ACCESS_COOKIE, REFRESH_COOKIE, ACTIVE_COMPANY_COOKIE, ONBOARDING_DONE_COOKIE, PENDING_MFA_COOKIE, PENDING_REMEMBER_COOKIE, REMEMBER_ME_COOKIE]) {
    appendSetCookie(res, `${name}=; ${cookieFlags(0)}`);
    if (domain) {
      appendSetCookie(res, `${name}=; ${cookieFlags(0, domain)}`);
    }
  }
}
