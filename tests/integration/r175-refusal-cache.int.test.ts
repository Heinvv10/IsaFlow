/**
 * R-175 review round 1: the refuse-only cache.
 *
 * Without it every call is a committed write, refused ones included, so a
 * flood from one over-limit address keeps the limiter's small pool busy and
 * every limited route starts failing. Once the database reports a key over
 * its limit, the process remembers the refusal for a short while and answers
 * `false` without touching the database.
 *
 * The cache may only ever refuse. Nothing in memory admits a call.
 *
 * Runs against real PostgreSQL. Keys are random per run.
 */
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { checkRateLimit, clearRateLimitCache, refundRateLimit } from '@/lib/rateLimit';
import { getRateLimitPool, RATE_LIMIT_POOL_MAX } from '@/lib/rateLimitPool';

assertDisposable();

const PREFIX = `r175c:${randomUUID()}:`;
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: false });
const MAX = 20;
const opts = { max: MAX, windowSecs: 900 };

const newKey = () => `${PREFIX}${randomUUID()}`;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function storedCount(key: string): Promise<number | undefined> {
  const { rows } = await pool.query('SELECT count FROM rate_limit_counters WHERE key = $1', [key]);
  return rows[0]?.count as number | undefined;
}

/** Fills `key` and has the database refuse it once. A refusal changes nothing: count stays at max. */
async function driveOverLimit(key: string): Promise<void> {
  for (let i = 0; i < MAX; i++) expect(await checkRateLimit(key, opts)).toBe(true);
  expect(await checkRateLimit(key, opts)).toBe(false);
  expect(await storedCount(key)).toBe(MAX);
}

beforeEach(() => clearRateLimitCache());

afterAll(async () => {
  await pool.query('DELETE FROM rate_limit_counters WHERE key LIKE $1', [`${PREFIX}%`]);
  await pool.end();
});

describe('R-175 — an over-limit key is refused from memory', () => {
  it('answers a flood on a full key without touching the database', async () => {
    const key = newKey();
    await driveOverLimit(key);

    // With every limiter connection held, a call that needed the database would
    // wait for one and time out. The flood is answered anyway.
    const limiterPool = getRateLimitPool();
    const held = await Promise.all(Array.from({ length: RATE_LIMIT_POOL_MAX }, () => limiterPool.connect()));
    let verdicts: boolean[];
    try {
      verdicts = await Promise.all(Array.from({ length: 200 }, () => checkRateLimit(key, opts)));
    } finally {
      held.forEach((client) => client.release());
    }

    expect(verdicts).toHaveLength(200);
    expect(verdicts.some(Boolean)).toBe(false);
    expect(await storedCount(key)).toBe(MAX);
  });

  it('never admits from memory: a deleted row is not noticed until the cache is cleared', async () => {
    const key = newKey();
    await driveOverLimit(key);
    await pool.query('DELETE FROM rate_limit_counters WHERE key = $1', [key]);

    // Still refused, and still no row: the answer came from memory.
    expect(await checkRateLimit(key, opts)).toBe(false);
    expect(await storedCount(key)).toBeUndefined();

    clearRateLimitCache();
    expect(await checkRateLimit(key, opts)).toBe(true);
    expect(await storedCount(key)).toBe(1);
  });

  it('a refund in this process drops the remembered refusal', async () => {
    const key = newKey();
    await driveOverLimit(key);

    await refundRateLimit(key, 2);

    // 20 - 2 = 18: exactly two more calls fit.
    expect(await checkRateLimit(key, opts)).toBe(true);
    expect(await checkRateLimit(key, opts)).toBe(true);
    expect(await checkRateLimit(key, opts)).toBe(false);
    expect(await storedCount(key)).toBe(MAX);
  });

  it('re-admits when the window rolls over, without the cache being cleared', async () => {
    const key = newKey();
    const short = { max: 2, windowSecs: 2 };
    expect(await checkRateLimit(key, short)).toBe(true);
    expect(await checkRateLimit(key, short)).toBe(true);
    expect(await checkRateLimit(key, short)).toBe(false);
    expect(await checkRateLimit(key, short)).toBe(false);
    expect(await storedCount(key)).toBe(2);

    await sleep(2300);

    expect(await checkRateLimit(key, short)).toBe(true);
    expect(await storedCount(key)).toBe(1);
  });

  it('forgets a refusal after REFUSAL_TTL_MS, so a refund made elsewhere is honoured', async () => {
    const { REFUSAL_TTL_MS } = await import('@/lib/rateLimit');
    const key = newKey();
    await driveOverLimit(key);
    // What another process's refund, the cleanup cron or an operator does: the
    // row changes and this process is not told.
    await pool.query('UPDATE rate_limit_counters SET count = 0 WHERE key = $1', [key]);

    expect(await checkRateLimit(key, opts)).toBe(false);
    expect(await storedCount(key)).toBe(0);

    await sleep(REFUSAL_TTL_MS + 300);

    expect(await checkRateLimit(key, opts)).toBe(true);
    expect(await storedCount(key)).toBe(1);
  }, 20_000);

  it('a remembered refusal for one limit does not refuse a caller with a higher limit', async () => {
    const key = newKey();
    await driveOverLimit(key);

    // 20 + 1 does not fit under 20 but fits under 100: this caller must be asked of the database.
    expect(await checkRateLimit(key, { max: 100, windowSecs: 900 })).toBe(true);
    expect(await storedCount(key)).toBe(MAX + 1);
  });

  it('a remembered refusal of a large call does not refuse a smaller call that fits', async () => {
    const key = newKey();
    expect(await checkRateLimit(key, { ...opts, cost: 15 })).toBe(true);
    expect(await checkRateLimit(key, { ...opts, cost: 10 })).toBe(false);

    // 15 + 5 fits. Memory holds "15 and a refusal"; it must not turn this away.
    expect(await checkRateLimit(key, { ...opts, cost: 5 })).toBe(true);
    expect(await storedCount(key)).toBe(MAX);
    expect(await checkRateLimit(key, opts)).toBe(false);
  });

  it('does not remember an admission: a key at its limit is still checked', async () => {
    const key = newKey();
    for (let i = 0; i < MAX; i++) expect(await checkRateLimit(key, opts)).toBe(true);
    await pool.query('UPDATE rate_limit_counters SET count = 5 WHERE key = $1', [key]);

    expect(await checkRateLimit(key, opts)).toBe(true);
    expect(await storedCount(key)).toBe(6);
  });

  it('a 30-day window does not overflow: it admits, refuses and remembers like any other', async () => {
    const key = newKey();
    const month = { max: 2, windowSecs: 30 * 86_400 };
    // 30 days is 2.6e9 ms, more than a 4-byte integer holds. The time left in
    // the window used to be cast to int, and every call on such a key threw.
    expect(await checkRateLimit(key, month)).toBe(true);
    expect(await checkRateLimit(key, month)).toBe(true);
    expect(await checkRateLimit(key, month)).toBe(false);
    expect(await checkRateLimit(key, month)).toBe(false);
    expect(await storedCount(key)).toBe(2);
  });

  // Review round 5: the refused row is read from the statement's snapshot.
  it('a refund that commits while a refused charge waits for the row lock does not get the key cached as full', async () => {
    const key = newKey();
    for (let i = 0; i < MAX; i++) expect(await checkRateLimit(key, opts)).toBe(true);
    const holder = await pool.connect();
    try {
      // Another process's refund of 2, holding the row.
      await holder.query('BEGIN');
      await holder.query('UPDATE rate_limit_counters SET count = count - 2 WHERE key = $1', [key]);
      // A 5-unit charge: its snapshot still says 20, and it waits for the lock.
      const charge = checkRateLimit(key, { ...opts, cost: 5 });
      await sleep(300);
      expect(await transactionState(holder)).toBe('idle in transaction');
      await holder.query('COMMIT');
      // 18 + 5 does not fit: refused.
      expect(await charge).toBe(false);
    } finally {
      holder.release();
    }

    // 18 + 1 fits. It must be asked of the database, not refused from memory.
    expect(await checkRateLimit(key, opts)).toBe(true);
    expect(await storedCount(key)).toBe(19);
  });
});

async function transactionState(client: import('pg').PoolClient): Promise<string> {
  const pid = (await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid as number;
  const { rows } = await pool.query('SELECT state FROM pg_stat_activity WHERE pid = $1', [pid]);
  return rows[0].state as string;
}
