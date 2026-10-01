/**
 * K-103: the rate-limit counter was written on the request's own transaction.
 *
 * `checkRateLimit` and `refundRateLimit` used the shared `sql` template, which
 * routes onto the AsyncLocalStorage client whenever a request transaction is
 * open. So a request that rolled back was never charged, and the key's row
 * lock was held until the request ended, which made same-key requests queue.
 * R-175 made every call reach the table, so every call took that lock.
 *
 * The limiter now writes on its own small pool: the charge commits at once,
 * whatever the request does, and holds no lock past its own statement.
 *
 * Runs against real PostgreSQL. Keys are random per run.
 */
import { randomUUID } from 'node:crypto';
import { Pool, type PoolClient } from 'pg';
import { afterAll, describe, expect, it } from 'vitest';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { als } from '@/lib/als';
import { withAlsTransaction } from '@/lib/alsTransaction';
import { getPoolForTests } from '@/lib/neon';
import { checkRateLimit, refundRateLimit } from '@/lib/rateLimit';

assertDisposable();

const PREFIX = `k103:${randomUUID()}:`;
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: false });
const opts = { max: 20, windowSecs: 900 };
const actor = { userId: randomUUID(), companyId: undefined };

const newKey = () => `${PREFIX}${randomUUID()}`;

async function storedCount(key: string): Promise<number | undefined> {
  const { rows } = await pool.query('SELECT count FROM rate_limit_counters WHERE key = $1', [key]);
  return rows[0]?.count as number | undefined;
}

/** Runs `fn` as a request would: on a client with an open transaction bound into ALS. */
function inRequest<T>(client: PoolClient, fn: () => Promise<T>): Promise<T> {
  return als.run({ client, userId: actor.userId, companyId: undefined, claims: {}, afterCommit: [] }, fn);
}

/** Rejects if `p` has not settled in `ms`, so a blocked call fails the test instead of hanging it. */
function within<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    p,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`still blocked after ${ms}ms`)), ms)),
  ]);
}

async function transactionState(client: PoolClient): Promise<string> {
  const pid = (await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid as number;
  const { rows } = await pool.query('SELECT state FROM pg_stat_activity WHERE pid = $1', [pid]);
  return rows[0].state as string;
}

afterAll(async () => {
  await pool.query('DELETE FROM rate_limit_counters WHERE key LIKE $1', [`${PREFIX}%`]);
  await pool.end();
});

describe('K-103 rate-limit counter survives the request that spent it', () => {
  it('charges the counter even when the request transaction rolls back', async () => {
    const key = newKey();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      expect(await inRequest(client, () => checkRateLimit(key, opts))).toBe(true);
      // Committed at once: another connection sees it while the request is still open.
      expect(await storedCount(key)).toBe(1);
      await client.query('ROLLBACK');
    } finally { client.release(); }

    expect(await storedCount(key)).toBe(1);
  });

  it('charges a request whose handler throws inside withAlsTransaction', async () => {
    const key = newKey();
    const failed = withAlsTransaction(actor, async () => {
      await checkRateLimit(key, opts);
      throw new Error('handler failed after the charge');
    });

    await expect(failed).rejects.toThrow('handler failed after the charge');
    expect(await storedCount(key)).toBe(1);
  });

  it('a refund made by a request that rolls back still lands', async () => {
    const key = newKey();
    await checkRateLimit(key, { ...opts, cost: 3 });
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await inRequest(client, () => refundRateLimit(key, 2));
      expect(await storedCount(key)).toBe(1);
      await client.query('ROLLBACK');
    } finally { client.release(); }

    expect(await storedCount(key)).toBe(1);
  });

  it('does not hold the counter row lock for the rest of the request', async () => {
    const key = newKey();
    const first = await pool.connect();
    const second = await pool.connect();
    try {
      await first.query('BEGIN');
      await second.query('BEGIN');
      expect(await inRequest(first, () => checkRateLimit(key, opts))).toBe(true);

      // The first request is still open. A second request on the same key must
      // get its verdict, and its refund, without waiting for the first to end.
      expect(await within(inRequest(second, () => checkRateLimit(key, opts)), 2000)).toBe(true);
      await within(inRequest(second, () => refundRateLimit(key, 1)), 2000);
      expect(await within(checkRateLimit(key, opts), 2000)).toBe(true);

      // Prove the hold: both request transactions were open the whole time.
      expect(await transactionState(first)).toBe('idle in transaction');
      expect(await transactionState(second)).toBe('idle in transaction');
      expect(await storedCount(key)).toBe(2);
    } finally {
      await first.query('ROLLBACK');
      await second.query('ROLLBACK');
      first.release();
      second.release();
    }
  });

  it('admits exactly max when 40 concurrent requests charge one key', async () => {
    const key = newKey();
    const verdicts = await Promise.all(Array.from({ length: 40 }, () =>
      withAlsTransaction(actor, () => checkRateLimit(key, opts))));

    expect(verdicts.filter(Boolean).length).toBe(opts.max);
    // Later refusals may be answered from memory, so not all 40 are stored.
    expect(await storedCount(key)).toBeGreaterThan(opts.max);
  });

  it('still answers while every request connection is held by an open request', async () => {
    const appPool = getPoolForTests();
    const size = appPool.options.max!;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const verdicts: boolean[] = [];

    // As many requests as the request pool has connections, each holding its
    // transaction open after the limiter call. A limiter that needed a second
    // connection from that same pool would wait here until the connect timeout.
    const requests = Array.from({ length: size }, () => withAlsTransaction(actor, async () => {
      const key = newKey();
      const verdict = await checkRateLimit(key, opts);
      await refundRateLimit(key, 1);
      verdicts.push(verdict);
      await gate;
    }));
    try {
      const deadline = Date.now() + 4000;
      while (verdicts.length < size && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));

      expect(verdicts).toEqual(Array.from({ length: size }, () => true));
      // Prove the hold: the request pool is fully checked out.
      expect(appPool.totalCount).toBe(size);
      expect(appPool.idleCount).toBe(0);
    } finally {
      release();
      await Promise.all(requests);
    }
  });

  // The bound here is the test's own timeout, not a stopwatch: both calls wait
  // for a connection at the same time, so one connect timeout covers them, and
  // a limiter with no timeout fails the test by never settling.
  it('fails, and does not admit, when the limiter cannot get a connection', async () => {
    const { getRateLimitPool, RATE_LIMIT_POOL_MAX } = await import('@/lib/rateLimitPool');
    const limiterPool = getRateLimitPool();
    const held = await Promise.all(Array.from({ length: RATE_LIMIT_POOL_MAX }, () => limiterPool.connect()));
    const key = newKey();
    let outcomes: PromiseSettledResult<unknown>[];
    try {
      outcomes = await Promise.allSettled([checkRateLimit(key, opts), refundRateLimit(key, 1)]);
    } finally {
      held.forEach((client) => client.release());
    }

    expect(outcomes.map((o) => o.status)).toEqual(['rejected', 'rejected']);
    for (const o of outcomes) expect(String((o as PromiseRejectedResult).reason)).toMatch(/timeout/i);
    expect(await storedCount(key)).toBeUndefined();
    // The pool recovers once a connection is free.
    expect(await checkRateLimit(key, opts)).toBe(true);
  }, 25_000);

  it('gives up on a counter row another connection has locked, with an error and no admission', async () => {
    const key = newKey();
    expect(await checkRateLimit(key, opts)).toBe(true);
    const holder = await pool.connect();
    try {
      // What the cleanup cron's DELETE inside a transaction, or any stalled
      // writer, does to this row.
      await holder.query('BEGIN');
      await holder.query('UPDATE rate_limit_counters SET count = count WHERE key = $1', [key]);

      const outcomes = await Promise.allSettled([checkRateLimit(key, opts), refundRateLimit(key, 1)]);

      expect(outcomes.map((o) => o.status)).toEqual(['rejected', 'rejected']);
      // 55P03 lock_not_available: the server gave up, so the connection is clean.
      for (const o of outcomes) expect((o as PromiseRejectedResult).reason).toMatchObject({ code: '55P03' });
      // Prove the hold: the locking transaction was still open when they failed.
      expect(await transactionState(holder)).toBe('idle in transaction');
    } finally {
      await holder.query('ROLLBACK');
      holder.release();
    }

    // Neither abandoned statement was applied, and the pool works again.
    expect(await storedCount(key)).toBe(1);
    expect(await checkRateLimit(key, opts)).toBe(true);
    expect(await storedCount(key)).toBe(2);
  }, 25_000);

  it('bounds every statement on a limiter connection, server side first', async () => {
    const { getRateLimitPool, RATE_LIMIT_POOL_MAX } = await import('@/lib/rateLimitPool');
    const limiterPool = getRateLimitPool();
    const show = async (name: string): Promise<number> => {
      const { rows } = await limiterPool.query(`SELECT setting::int AS ms FROM pg_settings WHERE name = '${name}'`);
      return rows[0].ms as number;
    };
    const lockMs = await show('lock_timeout');
    const statementMs = await show('statement_timeout');

    expect(lockMs).toBeGreaterThan(0);
    expect(statementMs).toBeGreaterThanOrEqual(lockMs);
    // The client-side timer must fire AFTER the server's: when it fires first
    // the query is abandoned still running and the connection is handed back.
    expect(limiterPool.options.query_timeout).toBeGreaterThan(statementMs);

    // A statement that stalls without waiting on a lock is cancelled by the server.
    await expect(limiterPool.query('SELECT pg_sleep(30)')).rejects.toMatchObject({ code: '57014' });
    // Every connection is usable afterwards.
    const after = await Promise.all(Array.from({ length: RATE_LIMIT_POOL_MAX }, () => limiterPool.query('SELECT 1 AS ok')));
    expect(after.map((r) => r.rows[0].ok)).toEqual(Array.from({ length: RATE_LIMIT_POOL_MAX }, () => 1));
  }, 25_000);
});
