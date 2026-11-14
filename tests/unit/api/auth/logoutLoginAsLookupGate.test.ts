/**
 * #1371 review LOW (WP9): Sign Out takes a Login-as look-up slot only when it could be a Login-as. A verifying token
 * with a session id but NO stash cookie does no look-up at all (so it can never hold one of the shared slots); the
 * same token WITH a stash cookie does one. Runs on every CI (unit); the slot behaviour against a real pool is in
 * tests/integration/logout-login-as-bounds.int.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';
import { SignJWT } from 'jose';

vi.mock('@/lib/auth/withCsrf', () => ({ withCsrf: (h: unknown) => h }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
const gotrueLogout = vi.hoisted(() => vi.fn(async (_token: string, _scope?: string) => undefined));
vi.mock('@/lib/auth/gotrue', async (orig) => ({
  ...(await orig<typeof import('@/lib/auth/gotrue')>()), logout: gotrueLogout,
}));
const lookup = vi.hoisted(() => vi.fn(async (_sessionId: string) => null));
vi.mock('@/lib/auth/impersonationSessions', () => ({ impersonationPartiesOfBounded: lookup }));
// The stash the cookie names is this user's (round 3 M1b: a slot only for a party to a real stash).
const stash = vi.hoisted(() => vi.fn(async (_id: string) => ({ adminUserId: 'admin-1', targetUserId: 'user-1' })));
vi.mock('@/modules/admin/services/userImpersonationService', () => ({ stashPartiesOf: stash }));

import handler from '../../../../pages/api/auth/logout';

const SIGNING_KEY = 'gate-synthetic-'.repeat(4); // HS256 test key, not a credential
const token = () => new SignJWT({ aal: 'aal2', session_id: 'session-1' }).setProtectedHeader({ alg: 'HS256' })
  .setSubject('user-1').setExpirationTime('1h').sign(new TextEncoder().encode(SIGNING_KEY));

async function signOut(cookie: string) {
  const headers = new Map<string, unknown>();
  const state = { status: 0 };
  const res = {
    status(code: number) { state.status = code; return res; },
    json() { return res; },
    setHeader(name: string, value: unknown) { headers.set(name.toLowerCase(), value); return res; },
    getHeader(name: string) { return headers.get(name.toLowerCase()); },
  } as unknown as NextApiResponse;
  await (handler as unknown as (q: NextApiRequest, s: NextApiResponse) => Promise<unknown>)(
    { method: 'POST', headers: { cookie } } as unknown as NextApiRequest, res);
  return state.status;
}

describe('Sign Out: the Login-as look-up gate', () => {
  beforeEach(() => {
    vi.stubEnv('JWT_SECRET', SIGNING_KEY);
    lookup.mockClear();
    stash.mockClear();
    gotrueLogout.mockClear();
  });

  it('a verifying token with a session id but no stash cookie: no look-up, still revoked', async () => {
    expect(await signOut(`sb-access-token=${await token()}`)).toBe(200);
    expect(stash).not.toHaveBeenCalled();
    expect(lookup).not.toHaveBeenCalled();
    expect(gotrueLogout).toHaveBeenCalledOnce();
  });

  it('the same token with a stash cookie: one look-up for its session', async () => {
    expect(await signOut(`sb-access-token=${await token()}; sb-admin-stash=stash-1`)).toBe(200);
    expect(lookup).toHaveBeenCalledExactlyOnceWith('session-1');
  });

  it("a stash cookie naming someone else's stash: no look-up slot", async () => {
    stash.mockResolvedValueOnce({ adminUserId: 'admin-1', targetUserId: 'someone-else' });
    expect(await signOut(`sb-access-token=${await token()}; sb-admin-stash=stash-1`)).toBe(200);
    expect(lookup).not.toHaveBeenCalled();
    expect(gotrueLogout).toHaveBeenCalledOnce();
  });
});
