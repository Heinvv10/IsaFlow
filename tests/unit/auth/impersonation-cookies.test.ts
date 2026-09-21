// tests/unit/auth/impersonation-cookies.test.ts
import { describe, it, expect, afterEach } from 'vitest';
import type { NextApiResponse } from 'next';

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

describe('impersonation-cookies', () => {
  const origDomain = process.env.COOKIE_DOMAIN;
  afterEach(() => {
    if (origDomain === undefined) delete process.env.COOKIE_DOMAIN;
    else process.env.COOKIE_DOMAIN = origDomain;
  });

  it('setImpersonationCookies writes sb-admin-stash (HttpOnly) and is_impersonating (not HttpOnly)', async () => {
    delete process.env.COOKIE_DOMAIN;
    const { setImpersonationCookies } = await import('@/lib/auth/impersonation-cookies');
    const { res, headers } = mkRes();
    setImpersonationCookies(res, 'stash-uuid-1');
    const cookies = headers['set-cookie'];
    expect(cookies).toHaveLength(2);
    const adminStash = cookies.find((c) => c.startsWith('sb-admin-stash=stash-uuid-1'));
    expect(adminStash).toBeDefined();
    expect(adminStash!).toMatch(/HttpOnly/i);
    const flag = cookies.find((c) => c.startsWith('is_impersonating=1'));
    expect(flag).toBeDefined();
    expect(flag!).not.toMatch(/HttpOnly/i);
  });

  it('clearImpersonationCookies emits dual-scope Max-Age=0 when COOKIE_DOMAIN is set', async () => {
    process.env.COOKIE_DOMAIN = '.isaflow.co.za';
    const { clearImpersonationCookies } = await import('@/lib/auth/impersonation-cookies');
    const { res, headers } = mkRes();
    clearImpersonationCookies(res);
    const cookies = headers['set-cookie'];
    expect(cookies).toHaveLength(6);
    for (const c of cookies) expect(c).toMatch(/Max-Age=0/);
    expect(cookies.filter((c) => /Domain=\.isaflow\.co\.za/.test(c))).toHaveLength(3);
  });

  it('clearImpersonationCookies emits single-scope clears when COOKIE_DOMAIN unset', async () => {
    delete process.env.COOKIE_DOMAIN;
    const { clearImpersonationCookies } = await import('@/lib/auth/impersonation-cookies');
    const { res, headers } = mkRes();
    clearImpersonationCookies(res);
    expect(headers['set-cookie']).toHaveLength(3);
    for (const c of headers['set-cookie']) expect(c).toMatch(/Max-Age=0/);
  });
});

it('delegation proof is HttpOnly and expires on return', async () => {
  const { setImpersonationCookies, clearImpersonationCookies } = await import('@/lib/auth/impersonation-cookies');
  const created = mkRes(); setImpersonationCookies(created.res, 'stash', 'signed-proof');
  expect(created.headers['set-cookie'].find((c) => c.startsWith('sb-impersonation-proof=signed-proof;'))).toMatch(/HttpOnly/);
  const cleared = mkRes(); clearImpersonationCookies(cleared.res);
  expect(cleared.headers['set-cookie'].find((c) => c.startsWith('sb-impersonation-proof=;'))).toMatch(/Max-Age=0/);
});
