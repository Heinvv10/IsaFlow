/**
 * R-032 re-check LOW-2: logout always clears the cookies. The Login-as scope
 * lookup reads the session store; if it throws (a DB blip), the route must
 * still sign the session out — with the narrow `local` scope, since it cannot
 * tell whether this is a Login-as session — and clear the cookies. The route
 * has no withErrorHandler, so an escaping error left the cookies set.
 */
import { describe, it, expect, vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

vi.mock('@/lib/auth/withCsrf', () => ({ withCsrf: (h: unknown) => h }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
const gotrueLogout = vi.hoisted(() => vi.fn(async (_token: string, _scope?: string) => undefined));
vi.mock('@/lib/auth/gotrue', () => ({ logout: gotrueLogout }));
vi.mock('@/lib/auth/impersonationSessions', () => ({
  sessionActorOfToken: async () => { throw new Error('connection terminated unexpectedly'); },
}));

import handler from '../../../../pages/api/auth/logout';

describe('POST /api/auth/logout when the session lookup fails', () => {
  it('still signs out (local scope) and clears the cookies', async () => {
    const headers = new Map<string, unknown>();
    const state = { statusCode: 0, body: undefined as unknown };
    const res = {
      status(code: number) { state.statusCode = code; return res; },
      json(body: unknown) { state.body = body; return res; },
      setHeader(name: string, value: unknown) { headers.set(name.toLowerCase(), value); return res; },
      getHeader(name: string) { return headers.get(name.toLowerCase()); },
    } as unknown as NextApiResponse;
    const req = { method: 'POST', headers: { cookie: 'sb-access-token=tok' }, cookies: { 'sb-access-token': 'tok' } } as unknown as NextApiRequest;

    const outcome = await (handler as unknown as (q: NextApiRequest, s: NextApiResponse) => Promise<unknown>)(req, res)
      .then(() => 'answered', (err: unknown) => err);
    expect(outcome).toBe('answered');
    expect(state.statusCode).toBe(200);
    expect(gotrueLogout).toHaveBeenCalledWith('tok', 'local');
    const cleared = ([] as unknown[]).concat(headers.get('set-cookie') ?? []).map(String);
    expect(cleared.some((c) => c.startsWith('sb-access-token=') && /Max-Age=0/i.test(c))).toBe(true);
  });
});
