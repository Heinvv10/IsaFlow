/**
 * Sign Out ends this browser's session only: on the global scope, signing out on
 * one machine killed the account's other sessions, and their next request wiped
 * their cookies. "Every device" stays with password change and reset. The cookies
 * clear whatever GoTrue answers: the route has no withErrorHandler.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

vi.mock('@/lib/auth/withCsrf', () => ({ withCsrf: (h: unknown) => h }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
const gotrueLogout = vi.hoisted(() => vi.fn(async (_token: string, _scope?: string) => undefined));
const gotrueRefresh = vi.hoisted(() => vi.fn(async (_token: string) => ({ access_token: 'renewed' })));
vi.mock('@/lib/auth/gotrue', () => ({ logout: gotrueLogout, refresh: gotrueRefresh }));

import handler from '../../../../pages/api/auth/logout';

async function signOut(cookie = 'sb-access-token=tok') {
  const headers = new Map<string, unknown>();
  const state = { statusCode: 0 };
  const res = {
    status(code: number) { state.statusCode = code; return res; },
    json() { return res; },
    setHeader(name: string, value: unknown) { headers.set(name.toLowerCase(), value); return res; },
    getHeader(name: string) { return headers.get(name.toLowerCase()); },
  } as unknown as NextApiResponse;
  const req = { method: 'POST', headers: { cookie } } as unknown as NextApiRequest;
  await (handler as unknown as (q: NextApiRequest, s: NextApiResponse) => Promise<unknown>)(req, res);
  const cleared = ([] as unknown[]).concat(headers.get('set-cookie') ?? []).map(String);
  return { status: state.statusCode, clearedAccess: cleared.some((c) => c.startsWith('sb-access-token=') && /Max-Age=0/i.test(c)) };
}

describe('POST /api/auth/logout', () => {
  beforeEach(() => { gotrueLogout.mockReset(); gotrueRefresh.mockClear(); });

  it('ends this session only and clears the cookies', async () => {
    gotrueLogout.mockResolvedValue(undefined);
    expect(await signOut()).toEqual({ status: 200, clearedAccess: true });
    expect(gotrueLogout).toHaveBeenCalledExactlyOnceWith('tok', 'local');
  });

  it('with only the refresh cookie, renews to name the session and still revokes it', async () => {
    expect(await signOut('sb-refresh-token=live')).toMatchObject({ status: 200 });
    expect(gotrueRefresh).toHaveBeenCalledExactlyOnceWith('live');
    expect(gotrueLogout).toHaveBeenCalledExactlyOnceWith('renewed', 'local');
  });

  it('falls back to the refresh cookie when GoTrue refuses an expired access token', async () => {
    gotrueLogout.mockRejectedValueOnce(new Error('gotrue logout failed: 403'));
    expect(await signOut('sb-access-token=expired; sb-refresh-token=live')).toMatchObject({ status: 200 });
    expect(gotrueLogout.mock.calls).toEqual([['expired', 'local'], ['renewed', 'local']]);
  });

  it('does not spend the refresh token once the access token has signed out', async () => {
    await signOut('sb-access-token=tok; sb-refresh-token=live');
    expect(gotrueRefresh).not.toHaveBeenCalled();
  });

  it('still clears the cookies when the refresh is refused too', async () => {
    gotrueRefresh.mockRejectedValueOnce(new Error('gotrue refresh failed: 400'));
    expect(await signOut('sb-refresh-token=dead')).toMatchObject({ status: 200 });
    expect(gotrueLogout).not.toHaveBeenCalled();
  });

  it('still clears the cookies when GoTrue refuses', async () => {
    gotrueLogout.mockRejectedValue(new Error('gotrue logout failed: 500'));
    expect(await signOut()).toEqual({ status: 200, clearedAccess: true });
  });
});
