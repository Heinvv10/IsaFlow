// Enrolling a factor is not a sign-in: it must not turn an unticked session into a "Keep me signed in" one.
import { describe, expect, it, vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

vi.mock('@/lib/auth/withCsrf', () => ({ withCsrf: (h: unknown) => h }));
vi.mock('@/lib/auth/withUserAuth', () => ({ withUserAuth: (h: unknown) => h }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('@/lib/auth/impersonationGuard', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  refuseUnderImpersonation: async () => false,
  refuseImpersonation: async () => false,
}));
vi.mock('@/lib/rateLimit', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  checkRateLimit: async () => true,
  chargeRateLimit: async () => ({ admitted: true, charged: 1 }),
  refundRateLimit: async () => undefined,
  getClientIp: () => '127.0.0.1',
  withRateLimit: (h: unknown) => h,
}));
vi.mock('@/lib/auth/gotrue-mfa', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  challengeFactor: async () => 'challenge',
  verifyFactor: async () => ({ access_token: 'aal2', refresh_token: 'r2', expires_in: 3600 }),
}));

import handler from '../../../../pages/api/auth/2fa-confirm';

async function confirm(cookie: string) {
  const headers = new Map<string, unknown>();
  const state = { status: 0, body: null as unknown };
  const res = {
    status(c: number) { state.status = c; return res; },
    json(b: unknown) { state.body = b; return res; },
    setHeader(k: string, v: unknown) { headers.set(k.toLowerCase(), v); return res; },
    getHeader(k: string) { return headers.get(k.toLowerCase()); },
  } as unknown as NextApiResponse;
  const req = { method: 'POST', headers: { cookie }, body: { factor_id: 'f-1', code: '123456' }, socket: { remoteAddress: '127.0.0.1' } } as unknown as NextApiRequest;
  await (handler as unknown as (q: NextApiRequest, s: NextApiResponse) => Promise<unknown>)(req, res);
  const hint = ([] as unknown[]).concat(headers.get('set-cookie') ?? []).map(String).find((c) => c.startsWith('isaflow_remember_me='));
  return { status: state.status, body: state.body, hint: hint?.slice(0, hint.indexOf(';')) };
}

describe('/api/auth/2fa-confirm', () => {
  it.each([
    ['unticked stays unticked', 'sb-access-token=t; isaflow_remember_me=0', 'isaflow_remember_me=0'],
    ['ticked stays ticked', 'sb-access-token=t; isaflow_remember_me=1', 'isaflow_remember_me=1'],
  ])('%s', async (_label, cookie, hint) => {
    const answer = await confirm(cookie);
    expect(answer.status, JSON.stringify(answer.body)).toBe(200);
    expect(answer.hint).toBe(hint);
  });
});
