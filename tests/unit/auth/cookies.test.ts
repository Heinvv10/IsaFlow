// tests/unit/auth/cookies.test.ts
import { describe, it, expect, afterEach } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';
import {
  parseCookies,
  setAuthCookies,
  clearAuthCookies,
  setActiveCompanyCookie,
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
    for (const c of cookies) {
      expect(c).toMatch(/HttpOnly/i);
      expect(c).toMatch(/SameSite=Lax/i);
    }
  });

  it('clearAuthCookies emits Max-Age=0 for all auth cookies', () => {
    const { res, headers } = mkRes();
    clearAuthCookies(res);
    const cookies = headers['set-cookie'];
    // access, refresh, active_company, pending_mfa
    expect(cookies).toHaveLength(4);
    for (const c of cookies) expect(c).toMatch(/Max-Age=0/);
  });

  it('setActiveCompanyCookie writes the cookie without clobbering prior Set-Cookie', () => {
    const { res, headers } = mkRes();
    setAuthCookies(res, { accessToken: 'a', refreshToken: 'r', expiresIn: 3600 });
    setActiveCompanyCookie(res, '00000000-0000-0000-0000-00000000abcd');
    expect(headers['set-cookie']).toHaveLength(3);
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
      for (const c of headers['set-cookie']) {
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
      // 4 cookies × 2 scopings (host-scoped + domain-scoped)
      expect(headers['set-cookie']).toHaveLength(8);
      const hostScoped = headers['set-cookie'].filter((c) => !/Domain=/.test(c));
      const domainScoped = headers['set-cookie'].filter((c) => /Domain=\.isaflow\.co\.za/.test(c));
      expect(hostScoped).toHaveLength(4);
      expect(domainScoped).toHaveLength(4);
      for (const c of headers['set-cookie']) expect(c).toMatch(/Max-Age=0/);
    });
  });
});
