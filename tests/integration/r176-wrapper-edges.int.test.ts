/**
 * R-176 review round 1 — the edges of the three deferred-flush wrappers:
 *   - an early return (403 / 429) whose own ROLLBACK fails: still 403 / 429, connection destroyed;
 *   - a ROLLBACK that succeeds in the catch after an earlier one failed (the log must say so);
 *   - a ROLLBACK that does not answer: the wait is bounded, the response still goes out, the
 *     query in flight is cancelled and the connection destroyed;
 *   - a real client-side query_timeout, with the COMMIT and the ROLLBACK queued behind it.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { PoolClient } from 'pg';
import { randomUUID } from 'crypto';
import { call, response, type TestResponse } from './r159-auth-wrapper.helpers';
import { arm, armAllCheckouts, backendState, seen, survivesClientError, type Seen } from './r176-evict.helpers';
import {
  CO, bearerReq, cookieReq, customers, extReq, extTokenFor, pool, setupWrapperFixture, teardownWrapperFixture,
} from './r176-wrapper-fixture.helpers';

const h = vi.hoisted(() => ({ refuseRate: false, refusedRate: 0 }));
// The per-company limiter says no, so the wrapper takes its 429 early return.
vi.mock('@/lib/rateLimit', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/lib/rateLimit')>();
  return {
    ...original,
    checkRateLimit: async (...a: Parameters<typeof original.checkRateLimit>) => {
      if (h.refuseRate) { h.refusedRate += 1; return false; }
      return original.checkRateLimit(...a);
    },
  };
});
import { sql } from '@/lib/neon';
import { als } from '@/lib/als';
import { log } from '@/lib/logger';
import { setRollbackBoundForTests } from '@/lib/rollbackFailed';
import { withAuth } from '@/lib/auth/withAuth';
import { withBearerOrCookieAuth } from '@/lib/auth/withBearerOrCookieAuth';
import { withBearerAuth } from '@/lib/auth/withBearerAuth';
import { withExtensionToken } from '@/lib/auth/withExtensionToken';

beforeAll(() => setupWrapperFixture('R176 wrapper edges'));
afterAll(teardownWrapperFixture);

type Handler = (req: unknown, res: TestResponse) => Promise<unknown>;
type Wrapped = (req: never, res: never) => unknown;
const reportsUrl = (req: unknown) => ({ ...(req as object), url: '/api/accounting/reports-r176' });

/** [label, wrap, a normal request, a request that takes an early return, the status that return owes] */
const wrappers: Array<[string, (handler: Handler) => Wrapped, () => unknown, () => Promise<unknown>, number]> = [
  ['withAuth', (x) => withAuth(x), cookieReq, async () => cookieReq(randomUUID()), 403], // not a member of the cookie's company
  ['withBearerOrCookieAuth (PAT)', (x) => withBearerOrCookieAuth(x), bearerReq, async () => reportsUrl(bearerReq()), 429],
  ['withBearerAuth (PAT)', (x) => withBearerAuth(x), bearerReq, async () => reportsUrl(bearerReq()), 429],
  ['withExtensionToken', (x) => withExtensionToken(x), extReq,
    async () => extReq(await extTokenFor(randomUUID())), 403], // no such connection
];

const ok = (s: Seen): Handler => async (_req, res) => {
  s.pid = (await sql<{ pid: number }>`SELECT pg_backend_pid() AS pid`)[0]!.pid;
  return res.status(200).json({ success: true });
};

/** The early return's ROLLBACK is refused; a healthy request follows. */
async function earlyReturn(wrap: (handler: Handler) => Wrapped, early: unknown, normal: () => unknown) {
  const s = seen();
  let ran = false;
  armAllCheckouts(['ROLLBACK'], s);
  const r = await call(wrap(async (_req, res) => { ran = true; return res.status(200).json({}); }), early);
  s.disarm();
  const state = await backendState(pool, s.pid, 'gone');
  const next = seen();
  const nextR = await call(wrap(ok(next)), normal());
  return { r, ran, refused: s.refused.ROLLBACK, state, samePid: next.pid === s.pid, nextStatus: nextR.status, pools: s.pools };
}

describe.each(wrappers)('%s', (_label, wrap, normal, early, owed) => {
  it(`an early return (${owed}) whose ROLLBACK fails: still ${owed}, and the connection is destroyed`, async () => {
    h.refuseRate = owed === 429;
    const before = h.refusedRate;
    let out: Awaited<ReturnType<typeof earlyReturn>>;
    try { out = await earlyReturn(wrap, await early(), normal); } finally { h.refuseRate = false; }
    if (owed === 429) expect(h.refusedRate).toBe(before + 1); // the limiter's refusal fired
    expect(out.ran).toBe(false);
    expect(out.refused).toBe(1);
    expect(out.r.threw).toBeNull();
    expect(out.r.status).toBe(owed); // nothing was written before this return, so the answer owed stands
    expect(out.r.ends).toBe(1);
    expect(out.nextStatus).toBe(200);
    expect(out.samePid).toBe(false);
    expect(out.state).toBeNull();
    // Destroying a client can surface its error on the pool; an unlistened pool would crash the process.
    expect(out.pools.map(survivesClientError)).toEqual([true]);
  });

  it('a ROLLBACK that succeeds in the catch after an earlier one failed is logged as rolled back', async () => {
    const name = `r176-${randomUUID()}`;
    const s = seen();
    // The response's own end() throws once, so the 500 COMMIT_FAILED answer lands in the catch.
    const { res, ends } = response();
    const realEnd = res.end.bind(res);
    let threw = 0;
    res.end = (...a: unknown[]) => { if (threw === 0) { threw += 1; throw new Error('R-176 socket write failed'); } return realEnd(...a); };
    const logged = vi.spyOn(log, 'error');
    await wrap(async (_req, r) => {
      s.pid = (await sql<{ pid: number }>`SELECT pg_backend_pid() AS pid`)[0]!.pid;
      await sql`INSERT INTO customers (id, company_id, name) VALUES (${randomUUID()}::uuid, ${CO}::uuid, ${name})`;
      arm(als.getStore()!.client, ['COMMIT', 'ROLLBACK'], s, { times: 1 });
      return r.status(200).json({ success: true });
    })(normal() as never, res as never);
    const throwLog = logged.mock.calls.find((c) => String(c[0]).includes('request threw inside its transaction'))?.[1];
    logged.mockRestore();
    s.disarm();
    expect(s.refused).toEqual({ COMMIT: 1, ROLLBACK: 1 });
    expect(threw).toBe(1);
    expect(throwLog).toMatchObject({ rolledBack: true }); // the second ROLLBACK reached the server
    expect(res.statusCode).toBe(500);
    expect(ends).toHaveLength(1);
    expect(await customers(name)).toBe(0);
    expect(await backendState(pool, s.pid, 'gone')).toBeNull(); // one ROLLBACK did fail: still destroyed
  });
});

describe.each(wrappers)('%s', (_label, wrap, normal) => {
  it('a COMMIT that fails after the headers were flushed is aborted as a COMMIT failure, not answered as a throw', async () => {
    const name = `r176-${randomUUID()}`;
    const s = seen();
    const logged = vi.spyOn(log, 'error');
    const r = await call(wrap(async (_req, res) => {
      s.pid = (await sql<{ pid: number }>`SELECT pg_backend_pid() AS pid`)[0]!.pid;
      await sql`INSERT INTO customers (id, company_id, name) VALUES (${randomUUID()}::uuid, ${CO}::uuid, ${name})`;
      arm(als.getStore()!.client, ['COMMIT'], s);
      res.writeHead(200); res.write('partial');
      return res.end('rest');
    }), normal());
    const messages = logged.mock.calls.map((c) => String(c[0]));
    logged.mockRestore();
    s.disarm();
    expect(s.refused).toEqual({ COMMIT: 1, ROLLBACK: 0 });
    expect(r.destroyed).toBe(true);
    expect(r.ends).toBe(0);
    expect(messages.filter((m) => m.includes('transaction finalize failed'))).toHaveLength(1);
    expect(messages.filter((m) => m.includes('request threw inside its transaction'))).toHaveLength(0);
    expect(await customers(name)).toBe(0);
    expect(await backendState(pool, s.pid, 'idle')).toBe('idle'); // its ROLLBACK worked: reused
  });
});

describe('withAuth: its other early returns', () => {
  it.each([
    ['a company cookie that is not a UUID (the membership lookup throws)', () => cookieReq('not-a-uuid'), 403, false],
    ['the per-company rate limit', () => reportsUrl(cookieReq()), 429, true],
  ] as const)('%s, ROLLBACK fails: still answered, connection destroyed', async (_what, early, owed, limited) => {
    h.refuseRate = limited;
    let out: Awaited<ReturnType<typeof earlyReturn>>;
    try { out = await earlyReturn((x) => withAuth(x), early(), cookieReq); } finally { h.refuseRate = false; }
    expect(out.ran).toBe(false);
    expect(out.refused).toBe(1);
    expect(out.r.status).toBe(owed);
    expect(out.samePid).toBe(false);
    expect(out.state).toBeNull();
  });
});

describe('withAuth: a ROLLBACK that does not answer', () => {
  /** Leaves a query in flight on the request's connection, so everything after it queues behind it. */
  const busy = (client: PoolClient, seconds: number) => {
    client.query(`SELECT pg_sleep(${seconds})`).catch(() => undefined); // ends with the connection
  };

  it('the wait is bounded: 500 is sent, the query in flight is cancelled, the connection is destroyed', async () => {
    const name = `r176-${randomUUID()}`;
    const s = seen();
    const restore = setRollbackBoundForTests(300); // the production bound is seconds; the mechanism is the same
    let r: Awaited<ReturnType<typeof call>>;
    try {
      r = await call(withAuth(async () => {
        s.pid = (await sql<{ pid: number }>`SELECT pg_backend_pid() AS pid`)[0]!.pid;
        await sql`INSERT INTO customers (id, company_id, name) VALUES (${randomUUID()}::uuid, ${CO}::uuid, ${name})`;
        busy(als.getStore()!.client, 60); // the ROLLBACK queues behind this
        throw new Error(`R-176 forced failure after the ${name} INSERT`);
      }) as never, cookieReq());
    } finally { restore(); }
    expect(r.threw).toBeNull();
    expect(r.status).toBe(500); // answered: the test would time out waiting for the 60s query otherwise
    expect(r.ends).toBe(1);
    // Postgres 16 runs a statement to completion after its client socket is destroyed, so the
    // backend would linger for the rest of the 60s. The cancel request ends it now.
    expect(await backendState(pool, s.pid, 'gone', 4000)).toBeNull();
    expect(await customers(name)).toBe(0);
    const next = seen();
    expect((await call(withAuth(ok(next)) as never, cookieReq())).status).toBe(200);
    expect(next.pid).not.toBe(s.pid);
  }, 20000);

  it('a real client-side query_timeout: COMMIT and ROLLBACK both time out in the queue; cancelled and destroyed', async () => {
    const name = `r176-${randomUUID()}`;
    const s = seen();
    let client: PoolClient | undefined;
    const params = () => (client as unknown as { connectionParameters: { query_timeout?: number } }).connectionParameters;
    const logged = vi.spyOn(log, 'error');
    const r = await call(withAuth(async (_req: unknown, res: TestResponse) => {
      client = als.getStore()!.client;
      s.pid = (await sql<{ pid: number }>`SELECT pg_backend_pid() AS pid`)[0]!.pid;
      await sql`INSERT INTO customers (id, company_id, name) VALUES (${randomUUID()}::uuid, ${CO}::uuid, ${name})`;
      params().query_timeout = 300; // node-postgres reads it per query
      busy(client, 60);
      return res.status(200).json({ success: true });
    }) as never, cookieReq());
    const messages = logged.mock.calls.map((c) => `${String(c[0])} ${JSON.stringify(c[1])}`);
    logged.mockRestore();
    delete params().query_timeout;
    expect(messages.some((m) => m.includes('transaction finalize failed') && m.includes('Query read timeout'))).toBe(true);
    expect(messages.some((m) => m.includes('ROLLBACK failed, destroying') && m.includes('Query read timeout'))).toBe(true);
    expect(r.status).toBe(500);
    expect(r.body).toMatchObject({ code: 'COMMIT_FAILED' });
    expect(await backendState(pool, s.pid, 'gone', 4000)).toBeNull(); // cancelled, not left to finish its 60s
    expect(await customers(name)).toBe(0); // the COMMIT never reached the server
    const next = seen();
    expect((await call(withAuth(ok(next)) as never, cookieReq())).status).toBe(200);
    expect(next.pid).not.toBe(s.pid);
  }, 30000);
});
