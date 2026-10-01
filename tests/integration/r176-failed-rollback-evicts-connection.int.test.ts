/**
 * R-176 — a transaction owner that cannot end its transaction must destroy the connection.
 *
 * withAuth, the Bearer pipeline and withExtensionToken released the client bare in `finally`.
 * pg-pool evicts a dead socket by itself, but not a live connection whose ROLLBACK never
 * reached the server (a client-side query timeout, say). That connection went back to the pool
 * inside its open transaction, and the next request's COMMIT committed the failed request's
 * writes.
 *
 * Each case writes a row, then makes the wrapper's own ROLLBACK and/or COMMIT reject on the
 * request's client without reaching Postgres, so the transaction really stays open. It is
 * decided by outcome: the backend is gone, the next request gets another backend, and the row
 * is not there after that request commits. The healthy paths must still reuse the connection.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'crypto';
import { call, type TestResponse } from './r159-auth-wrapper.helpers';
import { arm, backendState, seen, type Seen, type Statement } from './r176-evict.helpers';
import {
  CO, bearerReq, cookieReq, customers, extReq, pool, setupWrapperFixture, teardownWrapperFixture,
} from './r176-wrapper-fixture.helpers';
import { sql } from '@/lib/neon';
import { als } from '@/lib/als';
import { log } from '@/lib/logger';
import { withAuth } from '@/lib/auth/withAuth';
import { withBearerOrCookieAuth } from '@/lib/auth/withBearerOrCookieAuth';
import { withBearerAuth } from '@/lib/auth/withBearerAuth';
import { withExtensionToken } from '@/lib/auth/withExtensionToken';
import { withPublicRouteTransaction } from '@/lib/publicRouteTx';

type Outcome = 'throw' | 'ok' | 'answer-503';

/** The work inside the owner's transaction: note the backend, write a row, arm the failure. */
async function work(name: string, fail: Statement[], s: Seen): Promise<void> {
  s.pid = (await sql<{ pid: number }>`SELECT pg_backend_pid() AS pid`)[0]!.pid;
  await sql`INSERT INTO customers (id, company_id, name) VALUES (${randomUUID()}::uuid, ${CO}::uuid, ${name})`;
  arm(als.getStore()!.client, fail, s);
}

function handler(name: string, outcome: Outcome, fail: Statement[], s: Seen) {
  return async (_req: unknown, res: TestResponse) => {
    await work(name, fail, s);
    if (outcome === 'ok') return res.status(200).json({ success: true });
    // A status that means ROLLBACK, with the handler's own body (a lock timeout, say).
    if (outcome === 'answer-503') return res.status(503).json({ success: false, code: 'R176_BUSY' });
    throw new Error(`R-176 forced failure after the ${name} INSERT`);
  };
}

type Wrapped = (req: never, res: never) => unknown;
type Run = (name: string, outcome: Outcome, fail: Statement[], s: Seen) => Promise<{ status: number; code: unknown }>;

const viaWrapper = (wrap: (h: ReturnType<typeof handler>) => Wrapped, req: () => unknown): Run =>
  async (name, outcome, fail, s) => {
    const r = await call(wrap(handler(name, outcome, fail, s)), req());
    expect(r.threw).toBeNull();
    return { status: r.status, code: r.body?.code };
  };

/** withPublicRouteTransaction answers nothing itself: a throw is rethrown to the route. */
const viaPublicRouteTx: Run = async (name, outcome, fail, s) => {
  try {
    await withPublicRouteTransaction('r176', async () => {
      await work(name, fail, s);
      if (outcome !== 'ok') throw new Error(`R-176 forced failure after the ${name} INSERT`);
    });
    return { status: 200, code: undefined };
  } catch {
    return { status: 500, code: undefined };
  }
};

const owners: Array<[string, Run]> = [
  ['withAuth', viaWrapper((h) => withAuth(h), cookieReq)],
  ['withBearerOrCookieAuth (PAT)', viaWrapper((h) => withBearerOrCookieAuth(h), bearerReq)],
  ['withBearerAuth (PAT)', viaWrapper((h) => withBearerAuth(h), bearerReq)],
  ['withExtensionToken', viaWrapper((h) => withExtensionToken(h), extReq)],
  ['withPublicRouteTransaction', viaPublicRouteTx],
];

beforeAll(() => setupWrapperFixture('R176 rollback evicts'));
afterAll(teardownWrapperFixture);

/**
 * One failing request, then a healthy one on the same owner. Everything is gathered before
 * anything is asserted, so a connection left in its transaction is always used up by the
 * second request and cannot leak into the next case.
 */
async function requestThenNext(run: Run, outcome: Outcome, fail: Statement[], want: 'gone' | 'idle') {
  const name = `r176-${randomUUID()}`;
  const first = seen();
  const logged = vi.spyOn(log, 'error');
  const answer = await run(name, outcome, fail, first);
  const finalizeLog = logged.mock.calls.find((c) => String(c[0]).includes('transaction finalize failed'))?.[1];
  const throwLog = logged.mock.calls.find((c) => String(c[0]).includes('request threw inside its transaction'))?.[1];
  const rollbackLogs = logged.mock.calls.filter((c) => String(c[0]).includes('ROLLBACK failed, destroying')).length;
  logged.mockRestore();
  first.disarm();
  const state = await backendState(pool, first.pid, want);
  const next = seen();
  const nextAnswer = await run(`${name}-next`, 'ok', [], next);
  next.disarm();
  return {
    answer, refused: first.refused, state, samePid: next.pid === first.pid, nextStatus: nextAnswer.status,
    rows: await customers(name), nextRows: await customers(`${name}-next`), finalizeLog, throwLog, rollbackLogs,
  };
}

describe.each(owners)('%s', (label, run) => {
  const isWrapper = label !== 'withPublicRouteTransaction';

  it('a throw whose ROLLBACK fails: the connection is destroyed, and the next request cannot commit the write', async () => {
    const r = await requestThenNext(run, 'throw', ['ROLLBACK'], 'gone');
    expect(r.refused.ROLLBACK).toBeGreaterThanOrEqual(1); // the failure fired
    expect(r.answer.status).toBe(500);
    expect(r.nextStatus).toBe(200);
    expect(r.rows).toBe(0); // the next request's COMMIT must not land the failed request's write
    expect(r.nextRows).toBe(1);
    expect(r.samePid).toBe(false);
    expect(r.state).toBeNull(); // not 'idle in transaction' in the pool
    if (isWrapper) expect(r.throwLog).toMatchObject({ rolledBack: false });
  });

  it('a COMMIT that fails, and then its ROLLBACK: the connection is destroyed, the write never lands', async () => {
    const r = await requestThenNext(run, 'ok', ['COMMIT', 'ROLLBACK'], 'gone');
    expect(r.refused).toEqual({ COMMIT: 1, ROLLBACK: 1 });
    expect(r.answer.status).toBe(500);
    if (isWrapper) expect(r.answer.code).toBe('COMMIT_FAILED');
    expect(r.state).toBeNull();
    expect(r.samePid).toBe(false);
    expect(r.rows).toBe(0);
    expect(r.nextRows).toBe(1);
    if (isWrapper) expect(r.finalizeLog).toMatchObject({ connectionDestroyed: true });
  });

  it.runIf(isWrapper)('a 503 answer whose ROLLBACK fails: destroyed, and the handler\'s own 503 is what the client gets', async () => {
    const r = await requestThenNext(run, 'answer-503', ['ROLLBACK'], 'gone');
    // Nothing was meant to commit, so this is not a COMMIT failure: the buffered answer stands.
    expect(r.answer).toEqual({ status: 503, code: 'R176_BUSY' });
    expect(r.refused.ROLLBACK).toBe(1);
    expect(r.finalizeLog).toBeUndefined();
    expect(r.rollbackLogs).toBe(1);
    expect(r.state).toBeNull();
    expect(r.samePid).toBe(false);
    expect(r.rows).toBe(0);
  });

  it('a throw whose ROLLBACK succeeds: the connection goes back to the pool and is reused', async () => {
    const r = await requestThenNext(run, 'throw', [], 'idle');
    expect(r.refused).toEqual({ COMMIT: 0, ROLLBACK: 0 });
    expect(r.answer.status).toBe(500);
    expect(r.state).toBe('idle');
    expect(r.samePid).toBe(true);
    expect(r.rows).toBe(0);
    expect(r.nextRows).toBe(1);
  });

  it('a COMMIT that fails but whose ROLLBACK succeeds: rolled back, and the connection is reused', async () => {
    const r = await requestThenNext(run, 'ok', ['COMMIT'], 'idle');
    expect(r.refused).toEqual({ COMMIT: 1, ROLLBACK: 0 });
    expect(r.answer.status).toBe(500);
    expect(r.state).toBe('idle');
    expect(r.samePid).toBe(true);
    expect(r.rows).toBe(0);
    if (isWrapper) expect(r.finalizeLog).toMatchObject({ connectionDestroyed: false });
  });

  it('a 200: committed, and the connection is reused', async () => {
    const r = await requestThenNext(run, 'ok', [], 'idle');
    expect(r.answer.status).toBe(200);
    expect(r.state).toBe('idle');
    expect(r.samePid).toBe(true);
    expect(r.rows).toBe(1);
  });
});
