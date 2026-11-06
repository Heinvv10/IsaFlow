/**
 * The heartbeat exempts a Login-as session on coming back by the readable is_impersonating marker. Left behind when a
 * session ends, it would exempt the next person to sign in on this browser for up to an hour.
 */
import { describe, expect, it } from 'vitest';
import type { NextApiResponse } from 'next';
import { clearAuthCookies } from '@/lib/auth/cookies';

function jar() {
  const headers = new Map<string, unknown>();
  const res = {
    setHeader(k: string, v: unknown) { headers.set(k.toLowerCase(), v); return res; },
    getHeader(k: string) { return headers.get(k.toLowerCase()); },
  } as unknown as NextApiResponse;
  return { res, cookies: () => ([] as unknown[]).concat(headers.get('set-cookie') ?? []).map(String) };
}

describe('clearing a session', () => {
  it('takes the readable is_impersonating marker with it', () => {
    const { res, cookies } = jar();
    clearAuthCookies(res);
    expect(cookies().some((c) => c.startsWith('is_impersonating=;') && /Max-Age=0/.test(c))).toBe(true);
  });

});
