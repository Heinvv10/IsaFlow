/**
 * A session ending, or a new one replacing it, ends the Login-as. A stash cookie left behind lets the target restore
 * the admin's session, and the readable marker would exempt the next sign-in from the idle rule. A renewal inside a
 * Login-as keeps them, and starting one sets them after the clear.
 */
import { describe, expect, it } from 'vitest';
import type { NextApiResponse } from 'next';
import { clearAuthCookies, setAuthCookies } from '@/lib/auth/cookies';
import { setImpersonationCookies } from '@/lib/auth/impersonation-cookies';

function jar() {
  const headers = new Map<string, unknown>();
  const res = {
    setHeader(k: string, v: unknown) { headers.set(k.toLowerCase(), v); return res; },
    getHeader(k: string) { return headers.get(k.toLowerCase()); },
  } as unknown as NextApiResponse;
  return { res, cookies: () => ([] as unknown[]).concat(headers.get('set-cookie') ?? []).map(String) };
}

const CLEARED = ['sb-impersonation-proof', 'is_impersonating', 'sb-admin-stash'];
const cleared = (cookies: string[], name: string) => cookies.some((c) => c.startsWith(`${name}=;`) && /Max-Age=0/.test(c));
const tokens = { accessToken: 'a', refreshToken: 'r', expiresIn: 3600 };

describe.each(CLEARED)('%s', (name) => {
  it('goes when a session is cleared', () => {
    const { res, cookies } = jar();
    clearAuthCookies(res);
    expect(cleared(cookies(), name)).toBe(true);
  });

  it('goes when a sign-in replaces the session', () => {
    const { res, cookies } = jar();
    setAuthCookies(res, tokens);
    expect(cleared(cookies(), name)).toBe(true);
  });

  it('stays through a renewal inside a Login-as', () => {
    const { res, cookies } = jar();
    setAuthCookies(res, { ...tokens, preserveImpersonation: true });
    expect(cookies().some((c) => c.startsWith(`${name}=`))).toBe(false);
  });

  it('is set after the clear when a Login-as starts, as the impersonate route does', () => {
    const { res, cookies } = jar();
    setAuthCookies(res, tokens);
    setImpersonationCookies(res, 'stash-1', 'proof-1');
    const last = cookies().filter((c) => c.startsWith(`${name}=`)).at(-1)!;
    expect(last).not.toMatch(/Max-Age=0/);
  });
});
