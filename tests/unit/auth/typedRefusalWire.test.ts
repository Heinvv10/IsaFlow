/**
 * The two wire paths a typed refusal travels, and the poison rule it must not weaken.
 *
 * PATH 1 — `withErrorHandler`. A route that does not model the class rethrows; the handler answered a
 * blanket 500 `INTERNAL_SERVER_ERROR` whose message it also masks in production, so an
 * approval-required refusal on `supplier-payments-action` was indistinguishable from a crash. It must
 * now answer the status the class declares.
 *
 * PATH 2 — `withAuth`'s control-integrity override. `runJournalControl` POISONS everything its
 * controlled write throws, including the kernel's approval-required refusal, which is raised BEFORE
 * any controlled write and rolls its savepoint back. Poisoning is what forces the ROLLBACK the direct
 * journal routes need — they create the draft journal OUTSIDE the controlled write, and withAuth
 * COMMITs anything below 500, so a bare 4xx would strand an orphan draft. So the rollback stays and
 * only the wire answer changes: the refusal's own status and code instead of 500
 * `CONTROL_INTEGRITY_FAILED`.
 *
 * The mirror is the half that must not rot: a poisoned control write that is NOT a caller-actionable
 * refusal — a missing system account, a mismatched actor, a failed change-event insert, any of the
 * fourteen sites that set `controlWriteFailed` — still answers 500 `CONTROL_INTEGRITY_FAILED` and
 * still rolls back. Both are asserted here, because a fix that reports the refusal correctly while
 * quietly committing, or while turning an integrity failure into a 409, is worse than the defect.
 *
 * Harness copied from withAuth-commit-order.test.ts: a mock pg client recording BEGIN/COMMIT/ROLLBACK
 * and a mock res whose json() funnels through end() exactly like Next's api-resolver, so withAuth's
 * deferred flush is observable.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { pgTypesMock } from '../helpers/pgTypesMock';
import type { NextApiResponse } from 'next';
import { SignJWT } from 'jose';

const TEST_SECRET = 'a'.repeat(40);
const COMPANY_ID = '00000000-0000-0000-0000-000000000cc1';
const USER_ID = '00000000-0000-0000-0000-0000000000a1';

interface MockClient { query: ReturnType<typeof vi.fn>; release: ReturnType<typeof vi.fn> }
let currentClient: MockClient;
const poolFactory = { connect: vi.fn(async () => currentClient), on: vi.fn() };

vi.mock('pg', () => {
  class Pool { connect = poolFactory.connect; on = poolFactory.on; }
  return { default: { Pool, ...pgTypesMock() }, Pool, ...pgTypesMock() };
});
vi.mock('@/lib/rateLimit', () => ({ checkRateLimit: vi.fn(async () => true) }));

function makeClient(events: string[]): MockClient {
  return {
    query: vi.fn(async (text: string) => {
      const verb = typeof text === 'string' ? text.trim().split(/\s+/)[0]!.toUpperCase() : 'PARAM';
      if (/FROM company_users/i.test(String(text))) {
        return { rows: [{ role: 'admin', account_user_id: USER_ID, is_active: true, status: 'active', suspended_at: null }] };
      }
      if (verb === 'BEGIN' || verb === 'COMMIT' || verb === 'ROLLBACK') events.push(verb);
      return { rows: [], command: verb };
    }),
    release: vi.fn(),
  };
}

function makeRes(events: string[]) {
  const headers: Record<string, unknown> = {};
  const state = { statusCode: 200, headersSent: false, finished: false, body: undefined as unknown };
  const res = {
    get statusCode() { return state.statusCode; },
    set statusCode(c: number) { state.statusCode = c; },
    get headersSent() { return state.headersSent; },
    get finished() { return state.finished; },
    get writableEnded() { return state.finished; },
    status(c: number) { state.statusCode = c; return res; },
    setHeader(k: string, v: unknown) { headers[k.toLowerCase()] = v; },
    getHeader(k: string) { return headers[k.toLowerCase()]; },
    removeHeader(k: string) { delete headers[k.toLowerCase()]; },
    json(v: unknown) { state.body = v; return res.send(JSON.stringify(v)); },
    send(v: unknown) { state.body = v; return res.end(v); },
    end(v?: unknown) {
      if (state.finished) return res;
      state.finished = true; state.headersSent = true;
      if (v !== undefined) state.body = v;
      events.push('FLUSH');
      return res;
    },
  };
  return { res: res as unknown as NextApiResponse, state };
}

async function makeToken(sub: string) {
  return new SignJWT({ sub, email: 'x@y.z', aud: 'authenticated', role: 'authenticated', aal: 'aal2' })
    .setProtectedHeader({ alg: 'HS256' }).setExpirationTime('1h').sign(new TextEncoder().encode(TEST_SECRET));
}
function mkReq(token: string) {
  return { headers: { cookie: `sb-access-token=${token}; active_company_id=${COMPANY_ID}` }, url: '/api/test' } as never;
}

/** The body withAuth/withErrorHandler wrote, parsed from whichever envelope it used. */
function parse(body: unknown): { code?: string; message?: string } {
  const value = typeof body === 'string' ? JSON.parse(body) : body;
  const v = value as { code?: string; message?: string; error?: { code?: string; message?: string; details?: { code?: string } } };
  // Two envelopes, each matching its neighbour: withErrorHandler answers through
  // apiResponse.error (refusal identity in details.code, like respondIfLockTimeout),
  // withAuth's override keeps the flat shape CONTROL_INTEGRITY_FAILED already used.
  if (!v.error) return { code: v.code, message: v.message };
  return { code: v.error.details?.code ?? v.error.code, message: v.error.message };
}

describe('withErrorHandler — a rethrown typed refusal answers its own status', () => {
  beforeEach(() => { vi.resetModules(); process.env.NODE_ENV = 'test'; process.env.SENTRY_ENABLED = 'false'; });

  it('answers 409 OPERATION_APPROVAL_REQUIRED instead of 500 INTERNAL_SERVER_ERROR', async () => {
    const { withErrorHandler } = await import('@/lib/api-error-handler');
    const { ApApprovalRequiredError } = await import('@/modules/accounting/services/ap/apControlBoundary');
    const events: string[] = [];
    const { res, state } = makeRes(events);
    await withErrorHandler(async () => {
      throw new ApApprovalRequiredError('supplier_payment.process', 'payment-1');
    })({ method: 'POST', url: '/api/accounting/supplier-payments-action', query: {}, body: {}, headers: {} } as never, res);
    expect(state.statusCode).toBe(409);
    const body = parse(state.body);
    expect(body.code).toBe('OPERATION_APPROVAL_REQUIRED');
    expect(body.message).toMatch(/approval/i);
  });

  it('answers 400 for the impersonated-reviewer refusal a route did not model', async () => {
    const { withErrorHandler } = await import('@/lib/api-error-handler');
    const { IndependentReviewRefusal } = await import('@/modules/accounting/services/controls/independentReview');
    const events: string[] = [];
    const { res, state } = makeRes(events);
    await withErrorHandler(async () => {
      throw new IndependentReviewRefusal('An impersonated session cannot record an independent review');
    })({ method: 'POST', url: '/api/accounting/write-offs-action', query: {}, body: {}, headers: {} } as never, res);
    expect(state.statusCode).toBe(400);
    expect(parse(state.body).message).toBe('An impersonated session cannot record an independent review');
  });

  it('still answers 500 INTERNAL_SERVER_ERROR for anything untyped', async () => {
    const { withErrorHandler } = await import('@/lib/api-error-handler');
    const events: string[] = [];
    const { res, state } = makeRes(events);
    await withErrorHandler(async () => { throw new Error('Committed operation effect is ambiguous'); })(
      { method: 'POST', url: '/api/accounting/journal-entries-action', query: {}, body: {}, headers: {} } as never, res);
    expect(state.statusCode).toBe(500);
    expect(parse(state.body).code).toBe('INTERNAL_SERVER_ERROR');
  });
});

describe('withAuth — a poisoned control write still rolls back, whatever it answers', () => {
  beforeEach(() => {
    vi.resetModules();
    process.env.JWT_SECRET = TEST_SECRET;
    process.env.GOTRUE_URL = 'http://example.test/auth/v1';
    process.env.DATABASE_URL = 'postgresql://dummy:dummy@dummy/test';
    process.env.SENTRY_ENABLED = 'false';
    poolFactory.connect.mockClear();
  });

  /** Drive withAuth with a handler that poisons the request exactly as journalControlService does. */
  async function run(poisonWith: unknown) {
    const events: string[] = [];
    currentClient = makeClient(events);
    const { res, state } = makeRes(events);
    const { withAuth } = await import('@/lib/auth/withAuth');
    const { als } = await import('@/lib/als');
    const { recordControlRefusal } = await import('@/lib/als');
    const tok = await makeToken(USER_ID);
    await withAuth(async () => {
      const store = als.getStore()!;
      store.controlWriteFailed = true;
      recordControlRefusal(poisonWith);
      // The route caught the refusal and returned normally, which is the shape
      // withPrincipal's ControlIntegrityError exists to catch.
    })(mkReq(tok), res);
    return { events, state };
  }

  it('answers the refusal\'s own 409 and code, and ROLLS BACK the draft the request already wrote', async () => {
    const { OperationApprovalRequiredError } = await import('@/modules/accounting/services/controls/approvalExecutionService');
    const { events, state } = await run(new OperationApprovalRequiredError());
    expect(state.statusCode).toBe(409);
    expect(parse(state.body).code).toBe('OPERATION_APPROVAL_REQUIRED');
    // THE HALF THAT MATTERS: a 4xx normally COMMITs. This one must not.
    expect(events).toContain('ROLLBACK');
    expect(events).not.toContain('COMMIT');
    expect(events.indexOf('ROLLBACK')).toBeLessThan(events.indexOf('FLUSH'));
  });

  it('still answers 500 CONTROL_INTEGRITY_FAILED, and rolls back, for a genuine integrity failure', async () => {
    const { events, state } = await run(new Error('Change event could not be recorded'));
    expect(state.statusCode).toBe(500);
    expect(parse(state.body).code).toBe('CONTROL_INTEGRITY_FAILED');
    expect(events).toContain('ROLLBACK');
    expect(events).not.toContain('COMMIT');
  });

  it('a poisoned request that recorded NO refusal at all stays 500 CONTROL_INTEGRITY_FAILED', async () => {
    // The default for all fourteen poisoning sites: none of them records a refusal.
    const events: string[] = [];
    currentClient = makeClient(events);
    const { res, state } = makeRes(events);
    const { withAuth } = await import('@/lib/auth/withAuth');
    const { als } = await import('@/lib/als');
    const tok = await makeToken(USER_ID);
    await withAuth(async () => { als.getStore()!.controlWriteFailed = true; })(mkReq(tok), res);
    expect(state.statusCode).toBe(500);
    expect(parse(state.body).code).toBe('CONTROL_INTEGRITY_FAILED');
    expect(events).toContain('ROLLBACK');
    expect(events).not.toContain('COMMIT');
  });
});
