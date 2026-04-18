/**
 * Integration test: GoTrue cookie acceptance
 *
 * Phase 2 uses sb-access-token (ACCESS_COOKIE from @/lib/auth/cookies).
 * The legacy ff_auth_token / isaflow_auth cookies are no longer checked.
 *
 * Properties under test:
 *   A. parseCookies() returns the sb-access-token value when present.
 *   B. parseCookies() returns undefined for unknown cookie names.
 *   C. Old cookie names (ff_auth_token, isaflow_auth) do not grant access
 *      — their values are just regular unknown cookies, not treated as auth tokens.
 */

import { describe, it, expect } from 'vitest';
import { parseCookies, ACCESS_COOKIE } from '@/lib/auth/cookies';
import type { NextApiRequest } from 'next';

function makeReq(cookies: Record<string, string>): NextApiRequest {
  // Build a Cookie header string from the cookies map
  const cookieHeader = Object.entries(cookies)
    .map(([k, v]) => `${k}=${v}`)
    .join('; ');
  return {
    headers: { cookie: cookieHeader },
  } as unknown as NextApiRequest;
}

describe('GoTrue cookie (Phase 2 — BL-32 successor)', () => {
  it('parses sb-access-token when present', () => {
    const req = makeReq({ [ACCESS_COOKIE]: 'valid.jwt.token' });
    const cookies = parseCookies(req);
    expect(cookies[ACCESS_COOKIE]).toBe('valid.jwt.token');
  });

  it('returns undefined for ACCESS_COOKIE when only legacy ff_auth_token is present', () => {
    const req = makeReq({ ff_auth_token: 'old.token' });
    const cookies = parseCookies(req);
    expect(cookies[ACCESS_COOKIE]).toBeUndefined();
  });

  it('returns undefined for ACCESS_COOKIE when only legacy isaflow_auth is present', () => {
    const req = makeReq({ isaflow_auth: 'old.token' });
    const cookies = parseCookies(req);
    expect(cookies[ACCESS_COOKIE]).toBeUndefined();
  });

  it('prefers sb-access-token even when legacy cookies are also present', () => {
    const req = makeReq({ [ACCESS_COOKIE]: 'new.token', isaflow_auth: 'old.token' });
    const cookies = parseCookies(req);
    expect(cookies[ACCESS_COOKIE]).toBe('new.token');
  });
});
