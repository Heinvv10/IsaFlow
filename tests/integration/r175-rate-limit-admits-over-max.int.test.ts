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
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { checkRateLimit, clearRateLimitCache, refundRateLimit } from '@/lib/rateLimit';

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

beforeEach(() => clearRateLimitCache());

afterAll(async () => {
  await pool.query('DELETE FROM rate_limit_counters WHERE key LIKE $1', [`${PREFIX}%`]);
  await pool.end();
});

describe('R-175 — checkRateLimit never admits more than max per window', () => {
  it('admits exactly max of 100 sequential calls, in order', async () => {
    const key = newKey();
    const verdicts: boolean[] = [];
    for (let i = 0; i < 100; i++) verdicts.push(await checkRateLimit(key, opts));

    expect(verdicts.filter(Boolean).length).toBe(MAX);
    // The first max calls are the admitted ones; nothing is admitted after a refusal.
    expect(verdicts.slice(0, MAX).every(Boolean)).toBe(true);
    expect(verdicts.slice(MAX).some(Boolean)).toBe(false);
    // Every admitted call is stored. A refused call changes nothing.
    expect(await storedCount(key)).toBe(MAX);
  });

  it('admits exactly max of 100 concurrent calls', async () => {
    const key = newKey();
    const verdicts = await Promise.all(Array.from({ length: 100 }, () => checkRateLimit(key, opts)));

    expect(verdicts.filter(Boolean).length).toBe(MAX);
    expect(await storedCount(key)).toBe(MAX);
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
    // The refused 3-unit calls took nothing: the 2 units left are still there.
    expect(await storedCount(key)).toBe(18);
    expect(await admittedSequentially(key, 5)).toBe(2);
    expect(await storedCount(key)).toBe(MAX);
  });

  it('starts a fresh allowance of exactly max when the window rolls over', async () => {
    const key = newKey();
    expect(await admittedSequentially(key, 30)).toBe(MAX);

    await pool.query(
      `UPDATE rate_limit_counters SET window_start = NOW() - INTERVAL '901 seconds' WHERE key = $1`, [key]);
    // The window was moved behind this process's back; a real rollover expires
    // the remembered refusal by itself (r175-refusal-cache.int.test.ts).
    clearRateLimitCache();

    expect(await admittedSequentially(key, 30)).toBe(MAX);
    expect(await storedCount(key)).toBe(MAX);
  });

  it('keeps counting inside a window that has not ended', async () => {
    const key = newKey();
    expect(await admittedSequentially(key, MAX)).toBe(MAX);

    await pool.query(
      `UPDATE rate_limit_counters SET window_start = NOW() - INTERVAL '890 seconds' WHERE key = $1`, [key]);

    expect(await checkRateLimit(key, opts)).toBe(false);
    expect(await storedCount(key)).toBe(MAX);
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
    expect(await storedCount(key)).toBe(MAX);
  });

  it('two module instances called concurrently together admit exactly max', async () => {
    const key = newKey();
    vi.resetModules();
    const second = await import('@/lib/rateLimit');

    const verdicts = await Promise.all(Array.from({ length: 100 }, (_, i) =>
      (i % 2 === 0 ? checkRateLimit : second.checkRateLimit)(key, opts)));

    expect(verdicts.filter(Boolean).length).toBe(MAX);
  });

  // Review round 3: a refused charge must not consume units.
  it('a refused large charge leaves the room it could not use: 9,950 of 10,000', async () => {
    const key = newKey();
    const volume = { max: 10_000, windowSecs: 86_400 };
    expect(await checkRateLimit(key, { ...volume, cost: 9_950 })).toBe(true);

    expect(await checkRateLimit(key, { ...volume, cost: 100 })).toBe(false);
    expect(await storedCount(key)).toBe(9_950);

    // The 50 real units left are still spendable, at once and by this same
    // process: the refused large call is not remembered against smaller ones.
    expect(await checkRateLimit(key, volume)).toBe(true);
    expect(await checkRateLimit(key, { ...volume, cost: 100 })).toBe(false);
    expect(await checkRateLimit(key, { ...volume, cost: 48 })).toBe(true);
    expect(await checkRateLimit(key, { ...volume, cost: 2 })).toBe(false);
    expect(await checkRateLimit(key, volume)).toBe(true);
    expect(await checkRateLimit(key, volume)).toBe(false);
    expect(await storedCount(key)).toBe(10_000);
  });

  it('a charge larger than the whole allowance is refused and creates no row', async () => {
    const key = newKey();
    expect(await checkRateLimit(key, { ...opts, cost: MAX + 1 })).toBe(false);
    expect(await storedCount(key)).toBeUndefined();
    expect(await checkRateLimit(key, { ...opts, cost: MAX })).toBe(true);
    expect(await storedCount(key)).toBe(MAX);
  });

  it('weighted concurrent charges never pass max, and fill it when they can', async () => {
    const key = newKey();
    // 30 calls of 3 units against 20: at most 6 fit.
    const verdicts = await Promise.all(Array.from({ length: 30 }, () => checkRateLimit(key, { ...opts, cost: 3 })));

    expect(verdicts.filter(Boolean).length).toBe(6);
    expect(await storedCount(key)).toBe(18);
  });

  // Review round 4.
  it('a row the old code left above max is refused until its window ends, then starts again', async () => {
    const key = newKey();
    // The old statement counted refused calls too, so a busy key could sit above its limit.
    await pool.query('INSERT INTO rate_limit_counters (key, count, window_start) VALUES ($1, 25, NOW())', [key]);

    expect(await checkRateLimit(key, opts)).toBe(false);
    expect(await checkRateLimit(key, opts)).toBe(false);
    expect(await storedCount(key)).toBe(25);

    await pool.query(`UPDATE rate_limit_counters SET window_start = NOW() - INTERVAL '901 seconds' WHERE key = $1`, [key]);
    clearRateLimitCache();

    expect(await admittedSequentially(key, 30)).toBe(MAX);
    expect(await storedCount(key)).toBe(MAX);
  });

  it('floors a fractional max and refuses an impossible one as a programming error', async () => {
    const key = newKey();
    const fractional = { max: 2.9, windowSecs: 900 };
    expect([await checkRateLimit(key, fractional), await checkRateLimit(key, fractional), await checkRateLimit(key, fractional)])
      .toEqual([true, true, false]);
    expect(await storedCount(key)).toBe(2);

    await expect(checkRateLimit(key, { max: Number.NaN, windowSecs: 900 })).rejects.toThrow(RangeError);
    await expect(checkRateLimit(key, { max: 3_000_000_000, windowSecs: 900 })).rejects.toThrow(RangeError);
    expect(await storedCount(key)).toBe(2);
  });
});
