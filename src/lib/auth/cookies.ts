// src/lib/auth/cookies.ts
import type { NextApiRequest, NextApiResponse } from 'next';

export const ACCESS_COOKIE = 'sb-access-token';
export const REFRESH_COOKIE = 'sb-refresh-token';
export const ACTIVE_COMPANY_COOKIE = 'active_company_id';

function isSecure(): boolean {
  return process.env.NODE_ENV === 'production';
}

function cookieFlags(maxAgeSeconds: number): string {
  const parts = [
    `Path=/`,
    `Max-Age=${maxAgeSeconds}`,
    `HttpOnly`,
    `SameSite=Lax`,
  ];
  if (isSecure()) parts.push('Secure');
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
  appendSetCookie(res, `${ACCESS_COOKIE}=${params.accessToken}; ${cookieFlags(params.expiresIn)}`);
  // Refresh token lives longer than the access token; GoTrue default 30d.
  appendSetCookie(
    res,
    `${REFRESH_COOKIE}=${params.refreshToken}; ${cookieFlags(60 * 60 * 24 * 30)}`
  );
}

export function setActiveCompanyCookie(res: NextApiResponse, companyId: string): void {
  appendSetCookie(
    res,
    `${ACTIVE_COMPANY_COOKIE}=${companyId}; ${cookieFlags(60 * 60 * 24 * 30)}`
  );
}

export function clearAuthCookies(res: NextApiResponse): void {
  for (const name of [ACCESS_COOKIE, REFRESH_COOKIE, ACTIVE_COMPANY_COOKIE]) {
    appendSetCookie(res, `${name}=; ${cookieFlags(0)}`);
  }
}
