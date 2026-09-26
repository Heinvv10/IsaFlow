/**
 * R-032 L5: the shared approve/post/decide guard refuses a Login-as session and
 * nothing else — bearer callers (MCP, PATs, the extension) and background jobs
 * carry no session id and must keep working. The Postgres side of the session
 * signal is proven in tests/integration/r-032-*.int.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const actor = vi.hoisted(() => ({ value: 'self' as 'self' | 'impersonation' | 'unknown' }));
vi.mock('@/lib/auth/impersonationSessions', () => ({ currentSessionActor: async () => actor.value }));

import {
  assertNotImpersonating, respondIfImpersonationForbidden, ImpersonationForbiddenError,
} from '@/lib/auth/impersonationGuard';

function response() {
  const state = { statusCode: 200, body: undefined as unknown };
  const res = {
    status(code: number) { state.statusCode = code; return res; },
    json(body: unknown) { state.body = body; return res; },
    setHeader() { return res; },
  };
  return { res: res as never, state };
}

describe('assertNotImpersonating', () => {
  beforeEach(() => { actor.value = 'self'; });

  it('refuses a Login-as session', async () => {
    actor.value = 'impersonation';
    await expect(assertNotImpersonating()).rejects.toBeInstanceOf(ImpersonationForbiddenError);
  });

  it('lets an ordinary session through', async () => {
    await expect(assertNotImpersonating()).resolves.toBeUndefined();
  });

  it('lets a caller with no session id through (bearer tokens, jobs)', async () => {
    actor.value = 'unknown';
    await expect(assertNotImpersonating()).resolves.toBeUndefined();
  });
});

describe('respondIfImpersonationForbidden', () => {
  it('answers 403 with reason IMPERSONATION_FORBIDDEN', () => {
    const { res, state } = response();
    expect(respondIfImpersonationForbidden(res, new ImpersonationForbiddenError())).toBe(true);
    expect(state.statusCode).toBe(403);
    expect(state.body).toMatchObject({ error: { code: 'FORBIDDEN', details: { reason: 'IMPERSONATION_FORBIDDEN' } } });
  });

  it('leaves every other error to the caller', () => {
    const { res, state } = response();
    expect(respondIfImpersonationForbidden(res, new Error('Payroll run not found'))).toBe(false);
    expect(state.body).toBeUndefined();
  });
});
