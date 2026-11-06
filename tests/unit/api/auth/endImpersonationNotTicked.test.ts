// Login-as overwrote the admin's "Keep me signed in" hint, so their real choice is unknown when they return. Unknown
// counts as not ticked: the idle rule must not read the restored session as ticked.
import { expect, it, vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('@/lib/auth/csrf', () => ({ verifyCsrf: () => true }));
vi.mock('@/lib/auth/gotrue', () => ({ verifyTokenSignature: async () => ({ sub: 'target-1', session_id: 'session-1' }) }));
const LOGIN_AS = { actorUserId: 'admin-1', targetUserId: 'target-1' };
const record = vi.hoisted(() => ({ parties: null as { actorUserId: string; targetUserId: string } | null, asked: [] as string[] }));
vi.mock('@/lib/auth/impersonationSessions', () => ({
  impersonationPartiesOf: async (sessionId: string) => { record.asked.push(sessionId); return record.parties; },
}));
vi.mock('@/lib/auth/liveCompanies', () => ({ pickInitialCompanyId: async () => null }));
vi.mock('@/lib/neon', () => ({ sql: async () => [] }));
vi.mock('@/modules/admin/services/userImpersonationService', () => ({
  loadStash: async () => ({
    admin_user_id: 'admin-1', target_user_id: 'target-1', admin_access_token: 'admin-a', admin_refresh_token: 'admin-r',
  }),
  deleteStash: async () => undefined,
}));

import handler from '../../../../pages/api/auth/end-impersonation';

it.each([
  ['no Login-as on record', null],
  ["another admin's Login-as of the same target", { actorUserId: 'admin-2', targetUserId: 'target-1' }],
  ["this admin's Login-as of someone else", { actorUserId: 'admin-1', targetUserId: 'target-2' }],
])('refuses a target session with %s, and restores nothing', async (_label, parties) => {
  record.parties = parties;
  const headers = new Map<string, unknown>();
  const state = { status: 0 };
  const res = {
    status(c: number) { state.status = c; return res; },
    json() { return res; },
    setHeader(k: string, v: unknown) { headers.set(k.toLowerCase(), v); return res; },
    getHeader(k: string) { return headers.get(k.toLowerCase()); },
  } as unknown as NextApiResponse;
  await (handler as unknown as (q: NextApiRequest, s: NextApiResponse) => Promise<unknown>)(
    { method: 'POST', headers: { cookie: 'sb-access-token=target; sb-admin-stash=stash-1' } } as unknown as NextApiRequest, res);
  expect(state.status).toBe(403);
  const set = ([] as unknown[]).concat(headers.get('set-cookie') ?? []).map(String);
  expect(set.some((c) => c.startsWith('sb-access-token=admin-a'))).toBe(false);
});

it('restores the admin as not ticked, with a session-only refresh cookie', async () => {
  record.parties = LOGIN_AS;
  record.asked = [];
  const headers = new Map<string, unknown>();
  const state = { status: 0 };
  const res = {
    status(c: number) { state.status = c; return res; },
    json() { return res; },
    setHeader(k: string, v: unknown) { headers.set(k.toLowerCase(), v); return res; },
    getHeader(k: string) { return headers.get(k.toLowerCase()); },
  } as unknown as NextApiResponse;
  const cookie = 'sb-access-token=target; sb-admin-stash=stash-1; isaflow_remember_me=1';
  await (handler as unknown as (q: NextApiRequest, s: NextApiResponse) => Promise<unknown>)(
    { method: 'POST', headers: { cookie } } as unknown as NextApiRequest, res);
  const set = ([] as unknown[]).concat(headers.get('set-cookie') ?? []).map(String);
  expect(state.status).toBe(200);
  expect(record.asked).toEqual(['session-1']);
  expect(set.find((c) => c.startsWith('isaflow_remember_me='))).toMatch(/^isaflow_remember_me=0;/);
  expect(set.find((c) => c.startsWith('sb-refresh-token='))).not.toMatch(/Max-Age/);
});
