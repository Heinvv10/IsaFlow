/**
 * A Login-as session is time-boxed by its proof (at most an hour), but the refresh
 * cookie it holds lasts 30 days. Renewal must end with the box. Runs the real proof
 * mint and check; GoTrue and the session store are stubbed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';
import { SignJWT } from 'jose';

vi.mock('@/lib/rateLimit', () => ({ withRateLimit: (h: unknown) => h }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/auth/requireActiveAccount', () => ({ requireActiveAccount: async () => null }));
const h = vi.hoisted(() => ({
  actor: 'self' as string | Error,
  accessToken: '',
  logout: vi.fn(async (_token: string, _scope: string) => undefined),
  deleteEndedStashes: vi.fn(async (_input: unknown) => 1),
  audit: vi.fn(async (_strings: TemplateStringsArray, ..._values: unknown[]) => []),
}));
vi.mock('@/modules/admin/services/userImpersonationService', () => ({ deleteEndedStashes: h.deleteEndedStashes }));
vi.mock('@/lib/neon', () => ({ sql: h.audit }));
vi.mock('@/lib/auth/impersonationSessions', () => ({
  impersonationPartiesOf: async (sessionId: string) =>
    (sessionId === SESSION_ID ? { actorUserId: 'admin-1', targetUserId: 'target-1' } : null),
  sessionActorOfToken: async () => {
    if (h.actor instanceof Error) throw h.actor;
    return h.actor;
  },
}));
vi.mock('@/lib/auth/gotrue', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  logout: h.logout,
  refresh: async () => ({ access_token: h.accessToken, refresh_token: 'r2', expires_in: 3600, user: { id: TARGET } }),
}));

import handler from '../../../../pages/api/auth/refresh';
import { mintImpersonationProof } from '@/lib/auth/impersonationAssurance';
import { ADMIN_STASH_COOKIE } from '@/lib/auth/impersonation-cookies';

const SESSION_ID = vi.hoisted(() => '00000000-0000-0000-0000-0000000000a3');
const TARGET = '00000000-0000-0000-0000-0000000000a2';
const ACTOR = '00000000-0000-0000-0000-0000000000a1';
const SESSION = SESSION_ID;
const JWT_KEY = 'login-as-synthetic-'.repeat(3); // HS256 test key, not a credential

let lastSetCookies: string[] = [];
const accessMaxAge = () => Number(/Max-Age=(\d+)/.exec(lastSetCookies.find((c) => c.startsWith('sb-access-token=')) ?? '')?.[1]);
const clearedCookie = (name: string) => lastSetCookies.some((c) => c.startsWith(`${name}=`) && /Max-Age=0/.test(c));

async function refreshWith(cookie: string) {
  const headers = new Map<string, unknown>();
  const state = { status: 0 };
  const res = {
    status(code: number) { state.status = code; return res; },
    json() { return res; },
    setHeader(k: string, v: unknown) { headers.set(k.toLowerCase(), v); return res; },
    getHeader(k: string) { return headers.get(k.toLowerCase()); },
  } as unknown as NextApiResponse;
  await (handler as unknown as (q: NextApiRequest, s: NextApiResponse) => Promise<unknown>)(
    { method: 'POST', headers: { cookie } } as unknown as NextApiRequest, res);
  const set = ([] as unknown[]).concat(headers.get('set-cookie') ?? []).map(String);
  lastSetCookies = set;
  return {
    status: state.status,
    renewed: set.some((c) => c.startsWith('sb-access-token=') && !/Max-Age=0/.test(c)),
    clearedRefresh: set.some((c) => c.startsWith('sb-refresh-token=') && /Max-Age=0/.test(c)),
  };
}

const STASH_COOKIE = ADMIN_STASH_COOKIE;
const proof = (targetSessionId = SESSION) => {
  const now = Math.floor(Date.now() / 1000);
  return mintImpersonationProof({ actorUserId: ACTOR, targetUserId: TARGET, targetSessionId, actorExpiresAt: now + 600, stashExpiresAt: now + 600 });
};

beforeEach(async () => {
  vi.stubEnv('JWT_SECRET', JWT_KEY);
  h.actor = 'self';
  h.logout.mockReset();
  h.deleteEndedStashes.mockReset();
  h.deleteEndedStashes.mockResolvedValue(1);
  h.audit.mockClear();
  h.accessToken = await new SignJWT({ sub: TARGET, session_id: SESSION }).setProtectedHeader({ alg: 'HS256' })
    .setExpirationTime('1h').sign(new TextEncoder().encode(JWT_KEY));
});
afterEach(() => { vi.unstubAllEnvs(); vi.useRealTimers(); });

describe('/api/auth/refresh', () => {
  it('renews an ordinary session with no proof', async () => {
    expect(await refreshWith('sb-refresh-token=r1')).toEqual({ status: 200, renewed: true, clearedRefresh: false });
  });

  it('an ordinary session keeps the full access cookie lifetime', async () => {
    await refreshWith('sb-refresh-token=r1');
    expect(accessMaxAge()).toBe(3600);
  });

  it('answers 503 and keeps the cookies when the session lookup fails', async () => {
    h.actor = new Error('pool down');
    expect(await refreshWith('sb-refresh-token=r1')).toEqual({ status: 503, renewed: false, clearedRefresh: false });
  });

  describe('on a Login-as session', () => {
    beforeEach(() => { h.actor = 'impersonation'; });

    it('renews while its proof is good', async () => {
      expect(await refreshWith(`sb-refresh-token=r1; sb-impersonation-proof=${await proof()}`))
        .toEqual({ status: 200, renewed: true, clearedRefresh: false });
    });

    it('a renewal gets an access cookie that dies with the proof, not an hour later', async () => {
      await refreshWith(`sb-refresh-token=r1; sb-impersonation-proof=${await proof()}`);
      expect(accessMaxAge()).toBeGreaterThan(590);
      expect(accessMaxAge()).toBeLessThanOrEqual(600);
    });

    it('a refusal ends the session: revoked, stash gone, all cookies cleared, end audited to the admin', async () => {
      expect(await refreshWith(`sb-refresh-token=r1; ${STASH_COOKIE}=stash-1`))
        .toEqual({ status: 401, renewed: false, clearedRefresh: true });
      expect(h.logout).toHaveBeenCalledExactlyOnceWith(h.accessToken, 'local');
      expect(h.deleteEndedStashes).toHaveBeenCalledExactlyOnceWith({ adminUserId: 'admin-1', targetUserId: 'target-1', stashId: 'stash-1' });
      expect(clearedCookie(STASH_COOKIE)).toBe(true);
      expect(clearedCookie('sb-impersonation-proof')).toBe(true);
      const [strings, ...values] = h.audit.mock.calls[0]!;
      expect(strings.join('?')).toContain('admin_audit_log');
      expect(values.slice(0, 3)).toEqual(['admin-1', 'target-1', JSON.stringify({ reason: 'proof_expired', stashes_removed: 1 })]);
    });

    it('still removes the stash when the stash cookie has already expired', async () => {
      await refreshWith('sb-refresh-token=r1');
      expect(h.deleteEndedStashes).toHaveBeenCalledExactlyOnceWith({ adminUserId: 'admin-1', targetUserId: 'target-1', stashId: undefined });
    });

    it('a failed stash removal is still audited, as unknown', async () => {
      h.deleteEndedStashes.mockRejectedValueOnce(new Error('down'));
      await refreshWith('sb-refresh-token=r1');
      expect(h.audit.mock.calls[0]!.slice(1, 4)).toEqual(['admin-1', 'target-1', JSON.stringify({ reason: 'proof_expired', stashes_removed: null })]);
    });

    it.each([
      ['the stash removal', () => h.deleteEndedStashes.mockRejectedValueOnce(new Error('down'))],
      ['the audit row', () => h.audit.mockRejectedValueOnce(new Error('down'))],
    ])('still refuses and clears when %s fails', async (_label, fail) => {
      fail();
      expect(await refreshWith(`sb-refresh-token=r1; ${STASH_COOKIE}=stash-1`)).toEqual({ status: 401, renewed: false, clearedRefresh: true });
    });

    it('still refuses and clears when the revocation fails', async () => {
      h.logout.mockRejectedValueOnce(new Error('gotrue logout failed: 500'));
      expect(await refreshWith('sb-refresh-token=r1')).toEqual({ status: 401, renewed: false, clearedRefresh: true });
    });

    it('refuses and clears once the proof has expired', async () => {
      const stale = await proof();
      vi.useFakeTimers({ now: Date.now() + 11 * 60 * 1000 });
      expect(await refreshWith(`sb-refresh-token=r1; sb-impersonation-proof=${stale}`))
        .toEqual({ status: 401, renewed: false, clearedRefresh: true });
    });

    it('refuses a proof minted for another session', async () => {
      expect(await refreshWith(`sb-refresh-token=r1; sb-impersonation-proof=${await proof('00000000-0000-0000-0000-0000000000ff')}`))
        .toEqual({ status: 401, renewed: false, clearedRefresh: true });
    });
  });
});
