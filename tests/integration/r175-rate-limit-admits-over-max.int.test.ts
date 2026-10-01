/**
 * R-175: checkRateLimit admitted more than `max` units per window.
 *
 * The limiter kept a 5-second in-process LRU copy of each counter. While that
 * copy sat below half of `max` it admitted the call and bumped only the copy;
 * the shared `rate_limit_counters` row never saw it. Every call that did reach
 * the database then overwrote the copy with the (lower) database count, so the
 * copy fell back under the threshold and admitted again.
 *
 * These cases run against real PostgreSQL. Each uses a random key, so reruns
 * and parallel runs never share a counter.
 */
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { checkRateLimit, refundRateLimit } from '@/lib/rateLimit';

assertDisposable();

const PREFIX = `r175:${randomUUID()}:`;
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: false });
const MAX = 20;
const opts = { max: MAX, windowSecs: 900 };

const newKey = () => `${PREFIX}${randomUUID()}`;

async function storedCount(key: string): Promise<number | undefined> {
  const { rows } = await pool.query('SELECT count FROM rate_limit_counters WHERE key = $1', [key]);
  return rows[0]?.count as number | undefined;
}

/** Calls the limiter `calls` times one after another; returns how many it admitted. */
async function admittedSequentially(key: string, calls: number, check = checkRateLimit): Promise<number> {
  let admitted = 0;
  for (let i = 0; i < calls; i++) if (await check(key, opts)) admitted++;
  return admitted;
}

afterAll(async () => {
  await pool.query('DELETE FROM rate_limit_counters WHERE key LIKE $1', [`${PREFIX}%`]);
  await pool.end();
});

describe('R-175 — checkRateLimit never admits more than max per window', () => {
  it('admits exactly max of 100 sequential calls, in order, and counts every call', async () => {
    const key = newKey();
    const verdicts: boolean[] = [];
    for (let i = 0; i < 100; i++) verdicts.push(await checkRateLimit(key, opts));

    expect(verdicts.filter(Boolean).length).toBe(MAX);
    // The first max calls are the admitted ones; nothing is admitted after a refusal.
    expect(verdicts.slice(0, MAX).every(Boolean)).toBe(true);
    expect(verdicts.slice(MAX).some(Boolean)).toBe(false);
    expect(await storedCount(key)).toBe(100);
  });

  it('admits exactly max of 100 concurrent calls', async () => {
    const key = newKey();
    const verdicts = await Promise.all(Array.from({ length: 100 }, () => checkRateLimit(key, opts)));

    expect(verdicts.filter(Boolean).length).toBe(MAX);
    expect(await storedCount(key)).toBe(100);
  });

  it('writes a call far below the limit to the shared counter', async () => {
    const key = newKey();
    for (let i = 0; i < 3; i++) expect(await checkRateLimit(key, { max: 1000, windowSecs: 900 })).toBe(true);

    expect(await storedCount(key)).toBe(3);
  });

  it('counts cost-1 calls against a later weighted call', async () => {
    const key = newKey();
    expect(await admittedSequentially(key, 9)).toBe(9);
    // 9 + 11 = 20: the last units of the window.
    expect(await checkRateLimit(key, { ...opts, cost: 11 })).toBe(true);
    expect(await storedCount(key)).toBe(MAX);
    expect(await checkRateLimit(key, opts)).toBe(false);
  });

  it('admits weighted calls only while their running total stays within max', async () => {
    const key = newKey();
    const verdicts: boolean[] = [];
    for (let i = 0; i < 8; i++) verdicts.push(await checkRateLimit(key, { ...opts, cost: 3 }));

    // 6 x 3 = 18 admitted; the 7th would make 21.
    expect(verdicts).toEqual([true, true, true, true, true, true, false, false]);
    expect(await storedCount(key)).toBe(24);
  });

  it('starts a fresh allowance of exactly max when the window rolls over', async () => {
    const key = newKey();
    expect(await admittedSequentially(key, 30)).toBe(MAX);

    await pool.query(
      `UPDATE rate_limit_counters SET window_start = NOW() - INTERVAL '901 seconds' WHERE key = $1`, [key]);

    expect(await admittedSequentially(key, 30)).toBe(MAX);
    expect(await storedCount(key)).toBe(30);
  });

  it('keeps counting inside a window that has not ended', async () => {
    const key = newKey();
    expect(await admittedSequentially(key, MAX)).toBe(MAX);

    await pool.query(
      `UPDATE rate_limit_counters SET window_start = NOW() - INTERVAL '890 seconds' WHERE key = $1`, [key]);

    expect(await checkRateLimit(key, opts)).toBe(false);
    expect(await storedCount(key)).toBe(MAX + 1);
  });

  it('a refund gives back exactly the refunded units', async () => {
    const key = newKey();
    expect(await admittedSequentially(key, MAX)).toBe(MAX);

    await refundRateLimit(key, 2);
    expect(await storedCount(key)).toBe(MAX - 2);

    expect(await admittedSequentially(key, 10)).toBe(2);
  });

  it('a refund floors at zero, leaves the window alone and ignores an absent key', async () => {
    const key = newKey();
    expect(await admittedSequentially(key, 3)).toBe(3);
    const before = await pool.query('SELECT window_start FROM rate_limit_counters WHERE key = $1', [key]);

    await refundRateLimit(key, 50);

    const after = await pool.query('SELECT count, window_start FROM rate_limit_counters WHERE key = $1', [key]);
    expect(after.rows[0].count).toBe(0);
    expect(after.rows[0].window_start).toEqual(before.rows[0].window_start);

    const absent = newKey();
    await refundRateLimit(absent, 1);
    expect(await storedCount(absent)).toBeUndefined();
  });

  it('two module instances sharing the database together admit exactly max', async () => {
    const key = newKey();
    // A second copy of the module is a second process as far as any
    // module-level state goes: it shares nothing with the first but the table.
    vi.resetModules();
    const second = await import('@/lib/rateLimit');
    expect(second.checkRateLimit).not.toBe(checkRateLimit);

    let admitted = 0;
    for (let i = 0; i < 50; i++) {
      if (await checkRateLimit(key, opts)) admitted++;
      if (await second.checkRateLimit(key, opts)) admitted++;
    }

    expect(admitted).toBe(MAX);
    expect(await storedCount(key)).toBe(100);
  });

  it('two module instances called concurrently together admit exactly max', async () => {
    const key = newKey();
    vi.resetModules();
    const second = await import('@/lib/rateLimit');

    const verdicts = await Promise.all(Array.from({ length: 100 }, (_, i) =>
      (i % 2 === 0 ? checkRateLimit : second.checkRateLimit)(key, opts)));

    expect(verdicts.filter(Boolean).length).toBe(MAX);
  });
});
