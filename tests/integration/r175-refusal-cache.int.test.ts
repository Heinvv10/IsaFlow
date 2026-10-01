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

/** Charges `key` until the database refuses it once: count is then max + 1. */
async function driveOverLimit(key: string): Promise<void> {
  for (let i = 0; i < MAX; i++) expect(await checkRateLimit(key, opts)).toBe(true);
  expect(await checkRateLimit(key, opts)).toBe(false);
  expect(await storedCount(key)).toBe(MAX + 1);
}

beforeEach(() => clearRateLimitCache());

afterAll(async () => {
  await pool.query('DELETE FROM rate_limit_counters WHERE key LIKE $1', [`${PREFIX}%`]);
  await pool.end();
});

describe('R-175 — an over-limit key is refused from memory', () => {
  it('answers a flood on an over-limit key without writing to the database', async () => {
    const key = newKey();
    await driveOverLimit(key);

    const verdicts = await Promise.all(Array.from({ length: 200 }, () => checkRateLimit(key, opts)));

    expect(verdicts.some(Boolean)).toBe(false);
    expect(await storedCount(key)).toBe(MAX + 1);
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

    // 21 - 2 = 19: exactly one more call fits.
    expect(await checkRateLimit(key, opts)).toBe(true);
    expect(await checkRateLimit(key, opts)).toBe(false);
    expect(await storedCount(key)).toBe(MAX + 1);
  });

  it('re-admits when the window rolls over, without the cache being cleared', async () => {
    const key = newKey();
    const short = { max: 2, windowSecs: 2 };
    expect(await checkRateLimit(key, short)).toBe(true);
    expect(await checkRateLimit(key, short)).toBe(true);
    expect(await checkRateLimit(key, short)).toBe(false);
    expect(await checkRateLimit(key, short)).toBe(false);
    expect(await storedCount(key)).toBe(3);

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

    // 21 is over 20 but not over 100: this caller must be asked of the database.
    expect(await checkRateLimit(key, { max: 100, windowSecs: 900 })).toBe(true);
    expect(await storedCount(key)).toBe(MAX + 2);
  });

  it('does not remember an admission: a key at its limit is still checked', async () => {
    const key = newKey();
    for (let i = 0; i < MAX; i++) expect(await checkRateLimit(key, opts)).toBe(true);
    await pool.query('UPDATE rate_limit_counters SET count = 5 WHERE key = $1', [key]);

    expect(await checkRateLimit(key, opts)).toBe(true);
    expect(await storedCount(key)).toBe(6);
  });
});
