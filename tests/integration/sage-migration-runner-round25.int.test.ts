/**
 * Round 28 (R28-2, R28-5, R28-8, B28-4, B28-5) on a real database: BLOCKER_SQL and HOLDER_SQL run against real sessions, never a grep
 * of their text. Sessions here are plain pg clients holding advisory locks (no table is touched):
 *   - a HARD chain: the request waits only on B, and B waits on A for another lock: the root, A, is named, never B;
 *   - a cycle through the request (deadlock_timeout raised in both sessions, so the server does not break it first): the nearest blocker,
 *     said to be waiting, and the cycle flagged;
 *   - a queue of 25 waiters on one lock: one query, answered fast (the walk is a UNION on pid, not a count of paths);
 *   - the holder's idle_in_transaction_session_timeout is read from ITS role's settings (pg_db_role_setting), never the lookup's.
 * Fixture route: isaflow_schema_fixture (assertDisposable). Never skips.
 */
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { Client, Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { BLOCKER_SQL } from '@/modules/accounting/services/sage-migration/sageWaitWatch';
import { HOLDER_SQL } from '@/modules/accounting/services/sage-migration/sageKeyLock';
import { holderFrom } from '@/modules/accounting/services/sage-migration/sageLockHolder';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
const clients: Client[] = [];
const base = Math.floor(Math.random() * 1e9); // advisory keys of this run only
afterEach(async () => { for (const c of clients.splice(0)) await c.end().catch(() => undefined); });
afterAll(async () => { await pool.end(); });

const session = async (app: string, connectionString = process.env.DATABASE_URL!): Promise<{ c: Client; pid: number }> => {
  const c = new Client({ connectionString, application_name: app });
  await c.connect();
  clients.push(c);
  return { c, pid: (await c.query('SELECT pg_backend_pid() AS pid')).rows[0].pid as number };
};
/** Until `pid` is blocked (pg_blocking_pids not empty), at most 10 s. */
async function blocked(pid: number): Promise<void> {
  for (const t0 = Date.now(); Date.now() - t0 < 10_000; await new Promise((r) => setTimeout(r, 50))) {
    if ((await pool.query('SELECT cardinality(pg_blocking_pids($1)) AS n', [pid])).rows[0].n > 0) return;
  }
  throw new Error(`backend ${pid} never blocked`);
}
const blockerOf = async (pid: number) => holderFrom((await pool.query(BLOCKER_SQL, [pid])).rows[0]);

describe('BLOCKER_SQL on real sessions', () => {
  it('a hard chain (request -> B -> A, each on another lock): A, the root, is named; B is not; neither is waiting', async () => {
    const a = await session('r25 A');
    const b = await session('r25 B');
    const req = await session('r25 request');
    await a.c.query('BEGIN');
    await a.c.query('SELECT pg_advisory_xact_lock($1)', [base + 1]);
    await b.c.query('BEGIN');
    await b.c.query('SELECT pg_advisory_xact_lock($1)', [base + 2]);
    const bWaits = b.c.query('SELECT pg_advisory_xact_lock($1)', [base + 1]).catch((e: unknown) => e);
    await blocked(b.pid);
    const reqWaits = req.c.query('SELECT pg_advisory_lock($1)', [base + 2]).catch((e: unknown) => e);
    await blocked(req.pid);
    expect((await pool.query('SELECT pg_blocking_pids($1) AS p', [req.pid])).rows[0].p).toEqual([b.pid]); // hard: only B blocks it
    const h = await blockerOf(req.pid);
    expect(h).toMatchObject({ pid: a.pid, app: 'r25 A', state: 'idle in transaction', waiting: false, cycle: false });
    expect([...(h!.chain ?? [])].sort()).toEqual([a.pid, b.pid].sort());
    await a.c.query('ROLLBACK');
    await bWaits;
    await b.c.query('ROLLBACK');
    await reqWaits;
  }, 60_000);

  it('a cycle through the request: the nearest blocker, waiting, the cycle flagged, with the server deadlock_timeout', async () => {
    const b = await session('r25 cycle B');
    const req = await session('r25 cycle request');
    for (const s of [b, req]) await s.c.query("SET deadlock_timeout = '60s'"); // the server must not break it before we look
    await req.c.query('BEGIN');
    await req.c.query('SELECT pg_advisory_xact_lock($1)', [base + 3]);
    await b.c.query('BEGIN');
    await b.c.query('SELECT pg_advisory_xact_lock($1)', [base + 4]);
    const reqWaits = req.c.query('SELECT pg_advisory_xact_lock($1)', [base + 4]).catch((e: unknown) => e);
    await blocked(req.pid);
    const bWaits = b.c.query('SELECT pg_advisory_xact_lock($1)', [base + 3]).catch((e: unknown) => e);
    await blocked(b.pid);
    const h = await blockerOf(req.pid);
    expect(h).toMatchObject({ pid: b.pid, waiting: true, cycle: true, chain: [b.pid] });
    expect(typeof h!.deadlockTimeout).toBe('string');
    await pool.query('SELECT pg_cancel_backend($1)', [b.pid]); // break it
    await bWaits;
    await b.c.query('ROLLBACK');
    await reqWaits;
    await req.c.query('ROLLBACK');
  }, 60_000);

  it('a queue of 25 waiters on one lock: the holder is named, in one fast query', async () => {
    const holder = await session('r25 fan holder');
    await holder.c.query('BEGIN');
    await holder.c.query('SELECT pg_advisory_xact_lock($1)', [base + 5]);
    const waiters: Array<{ pid: number; done: Promise<unknown> }> = [];
    for (let i = 0; i < 25; i++) {
      const w = await session(`r25 fan ${i}`); // autocommit: once granted, its lock goes at the end of its statement, so the queue drains
      waiters.push({ pid: w.pid, done: w.c.query('SELECT pg_advisory_xact_lock($1)', [base + 5]).catch((e: unknown) => e) });
      await blocked(w.pid);
    }
    const t0 = Date.now();
    const h = await blockerOf(waiters.at(-1)!.pid);
    expect(Date.now() - t0).toBeLessThan(2_000);
    expect(h).toMatchObject({ pid: holder.pid, waiting: false });
    await holder.c.query('ROLLBACK');
    await Promise.all(waiters.map((w) => w.done));
  }, 120_000);
});

describe("HOLDER_SQL: the holder's own idle_in_transaction_session_timeout default (R28-2 / B28-4)", () => {
  const role = `sage_r28_${randomBytes(4).toString('hex')}`;
  const password = randomBytes(12).toString('hex');
  afterAll(async () => { await pool.query(`DROP ROLE IF EXISTS ${role}`); });
  it('read from its role (pg_db_role_setting): 25 s for a holder of that role; none for one of a role without it', async () => {
    await pool.query(`CREATE ROLE ${role} LOGIN PASSWORD '${password}'`);
    await pool.query(`ALTER ROLE ${role} SET idle_in_transaction_session_timeout = '25s'`);
    const u = new URL(process.env.DATABASE_URL!);
    [u.username, u.password] = [role, password];
    const theirs = await session('r25 role holder', u.toString());
    await theirs.c.query('BEGIN');
    await theirs.c.query('SELECT pg_advisory_xact_lock(hashtext($1)::bigint)', [`r25-${base}-a`]);
    expect(holderFrom((await pool.query(HOLDER_SQL, [`r25-${base}-a`])).rows[0])).toMatchObject({ pid: theirs.pid, idleMs: 25_000 });
    const ours = await session('r25 default holder');
    await ours.c.query('BEGIN');
    await ours.c.query('SELECT pg_advisory_xact_lock(hashtext($1)::bigint)', [`r25-${base}-b`]);
    expect(holderFrom((await pool.query(HOLDER_SQL, [`r25-${base}-b`])).rows[0])).toMatchObject({ pid: ours.pid, idleMs: null });
    await theirs.c.query('ROLLBACK');
    await ours.c.query('ROLLBACK');
  }, 60_000);
});
