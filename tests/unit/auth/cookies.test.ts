// tests/unit/auth/cookies.test.ts
import { describe, it, expect, afterEach } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';
import {
  parseCookies,
  setAuthCookies,
  clearAuthCookies,
  setActiveCompanyCookie,
  setPendingRememberCookie,
  clearPendingRememberCookie,
} from '@/lib/auth/cookies';

function mkReq(cookieHeader: string): NextApiRequest {
  return { headers: { cookie: cookieHeader } } as unknown as NextApiRequest;
}

function mkRes(): { res: NextApiResponse; headers: Record<string, string[]> } {
  const headers: Record<string, string[]> = {};
  const res = {
    getHeader: (name: string) => headers[name.toLowerCase()],
    setHeader: (name: string, value: string | string[]) => {
      headers[name.toLowerCase()] = Array.isArray(value) ? value : [value];
    },
  } as unknown as NextApiResponse;
  return { res, headers };
}

describe('cookies', () => {
  it('parseCookies extracts sb-access-token and active_company_id', () => {
    const c = parseCookies(
      mkReq('sb-access-token=abc; sb-refresh-token=def; active_company_id=cid-1')
    );
    expect(c['sb-access-token']).toBe('abc');
    expect(c['sb-refresh-token']).toBe('def');
    expect(c['active_company_id']).toBe('cid-1');
  });

  it('setAuthCookies writes both access and refresh cookies with httpOnly', () => {
    const { res, headers } = mkRes();
    setAuthCookies(res, { accessToken: 'a', refreshToken: 'r', expiresIn: 3600 });
    const cookies = headers['set-cookie'];
    expect(cookies.some((c) => c.startsWith('sb-access-token=a;'))).toBe(true);
    expect(cookies.some((c) => c.startsWith('sb-refresh-token=r;'))).toBe(true);
    // All cookies set by setAuthCookies (access, refresh, remember_me hint) must
    // be HttpOnly + SameSite=Lax. The hint is HttpOnly because it's only consumed
    // server-side at /api/auth/refresh; exposing it would let XSS upgrade a
    // session-only login to a 30-day persistent one.
    for (const c of cookies) {
      expect(c).toMatch(/HttpOnly/i);
      expect(c).toMatch(/SameSite=Lax/i);
    }
  });

  it('setAuthCookies with persistent=false emits session-only cookies (no Max-Age)', () => {
    const { res, headers } = mkRes();
    setAuthCookies(res, { accessToken: 'a', refreshToken: 'r', expiresIn: 3600, persistent: false });
    const cookies = headers['set-cookie'];
    // Both auth credentials AND the remember-me hint must be session-only.
    // A Max-Age would survive browser close, defeating the rememberMe=false intent.
    expect(cookies.find((c) => c.startsWith('sb-impersonation-proof='))).toMatch(/Max-Age=0/);
    for (const c of cookies.filter((c) => !c.startsWith('sb-impersonation-proof='))) {
      expect(c).not.toMatch(/Max-Age=/i);
      expect(c).toMatch(/HttpOnly/i);
      expect(c).toMatch(/SameSite=Lax/i);
    }
    // Hint cookie value must reflect the persistent choice — a regression that
    // emits '1' here would silently re-enable persistence on next refresh.
    expect(cookies.some((c) => c.startsWith('isaflow_remember_me=0;'))).toBe(true);
  });

  it('setAuthCookies with persistent=true gives the refresh cookie 30-day Max-Age and hint=1', () => {
    const { res, headers } = mkRes();
    setAuthCookies(res, { accessToken: 'a', refreshToken: 'r', expiresIn: 3600, persistent: true });
    const refresh = headers['set-cookie'].find((c) => c.startsWith('sb-refresh-token='));
    expect(refresh).toMatch(/Max-Age=2592000/);
    expect(headers['set-cookie'].some((c) => c.startsWith('isaflow_remember_me=1;'))).toBe(true);
  });

  it('setPendingRememberCookie persists rememberMe across the 2FA round-trip', () => {
    const { res, headers } = mkRes();
    setPendingRememberCookie(res, true);
    const c = headers['set-cookie'][0]!;
    expect(c).toMatch(/^sb-pending-remember-me=1;/);
    // 5-minute TTL — paired with the pending-MFA cookie.
    expect(c).toMatch(/Max-Age=300/);
    expect(c).toMatch(/HttpOnly/i);
    expect(c).toMatch(/SameSite=Lax/i);
  });

  it('setPendingRememberCookie writes 0 when rememberMe is false', () => {
    const { res, headers } = mkRes();
    setPendingRememberCookie(res, false);
    expect(headers['set-cookie'][0]).toMatch(/^sb-pending-remember-me=0;/);
  });

  it('clearPendingRememberCookie expires the cookie', () => {
    const { res, headers } = mkRes();
    clearPendingRememberCookie(res);
    expect(headers['set-cookie'][0]).toMatch(/Max-Age=0/);
  });

  it('clearAuthCookies emits Max-Age=0 for all auth cookies', () => {
    const { res, headers } = mkRes();
    clearAuthCookies(res);
    const cookies = headers['set-cookie'];
    // access, refresh, active_company, onboarding_done, pending_mfa, pending_remember, remember_me hint
    expect(cookies).toHaveLength(8);
    for (const c of cookies) expect(c).toMatch(/Max-Age=0/);
  });

  it('setActiveCompanyCookie writes the cookie without clobbering prior Set-Cookie', () => {
    const { res, headers } = mkRes();
    setAuthCookies(res, { accessToken: 'a', refreshToken: 'r', expiresIn: 3600 });
    setActiveCompanyCookie(res, '00000000-0000-0000-0000-00000000abcd');
    // access + refresh + remember_me hint + active_company
    expect(headers['set-cookie']).toHaveLength(5); // credentials/hint + expired proof + company
    expect(
      headers['set-cookie'].some((c) =>
        c.startsWith('active_company_id=00000000-0000-0000-0000-00000000abcd;')
      )
    ).toBe(true);
  });

  describe('COOKIE_DOMAIN support', () => {
    const origDomain = process.env.COOKIE_DOMAIN;
    afterEach(() => {
      if (origDomain === undefined) delete process.env.COOKIE_DOMAIN;
      else process.env.COOKIE_DOMAIN = origDomain;
    });

    it('does not append Domain= when COOKIE_DOMAIN is unset', () => {
      delete process.env.COOKIE_DOMAIN;
      const { res, headers } = mkRes();
      setAuthCookies(res, { accessToken: 'a', refreshToken: 'r', expiresIn: 3600 });
      for (const c of headers['set-cookie']) {
        expect(c).not.toMatch(/Domain=/);
      }
    });

    it('appends Domain=<value> to all auth cookies when COOKIE_DOMAIN is set', () => {
      process.env.COOKIE_DOMAIN = '.isaflow.co.za';
      const { res, headers } = mkRes();
      setAuthCookies(res, { accessToken: 'a', refreshToken: 'r', expiresIn: 3600 });
      setActiveCompanyCookie(res, 'cid-1');
      for (const c of headers['set-cookie'].filter((c) => !c.startsWith('sb-impersonation-proof='))) {
        expect(c).toMatch(/Domain=\.isaflow\.co\.za/);
      }
    });

    it('treats whitespace-only COOKIE_DOMAIN as unset', () => {
      process.env.COOKIE_DOMAIN = '   ';
      const { res, headers } = mkRes();
      setAuthCookies(res, { accessToken: 'a', refreshToken: 'r', expiresIn: 3600 });
      for (const c of headers['set-cookie']) {
        expect(c).not.toMatch(/Domain=/);
      }
    });

    it('clearAuthCookies emits dual-scope clears (host + domain) during transition', () => {
      process.env.COOKIE_DOMAIN = '.isaflow.co.za';
      const { res, headers } = mkRes();
      clearAuthCookies(res);
      // 8 cookies × 2 scopings (host-scoped + domain-scoped)
      expect(headers['set-cookie']).toHaveLength(16);
      const hostScoped = headers['set-cookie'].filter((c) => !/Domain=/.test(c));
      const domainScoped = headers['set-cookie'].filter((c) => /Domain=\.isaflow\.co\.za/.test(c));
      expect(hostScoped).toHaveLength(8);
      expect(domainScoped).toHaveLength(8);
      for (const c of headers['set-cookie']) expect(c).toMatch(/Max-Age=0/);
    });
  });
});

it('ordinary session replacement clears delegation while refresh preserves it', () => {
  const ordinary = mkRes();
  setAuthCookies(ordinary.res, { accessToken: 'a', refreshToken: 'r', expiresIn: 3600 });
  expect(ordinary.headers['set-cookie'].find((c) => c.startsWith('sb-impersonation-proof='))).toMatch(/Max-Age=0/);
  const refresh = mkRes();
  setAuthCookies(refresh.res, { accessToken: 'a', refreshToken: 'r', expiresIn: 3600, preserveImpersonation: true });
  expect(refresh.headers['set-cookie'].some((c) => c.startsWith('sb-impersonation-proof='))).toBe(false);
});
