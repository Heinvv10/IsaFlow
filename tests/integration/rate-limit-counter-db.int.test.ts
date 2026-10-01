/**
 * The limiter's counter against real PostgreSQL (BL-21).
 *
 * Moved here from tests/unit/lib/rateLimit.test.ts in R-175: there these cases
 * ran against whatever DATABASE_URL vitest.config.ts found in .env.local, and
 * wrote test keys to the shared dev database. Here they need the disposable
 * fixture, and the key is random per run.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { checkRateLimit, clearRateLimitCache } from '@/lib/rateLimit';
import { getPoolForTests, sql } from '@/lib/neon';

assertDisposable();
afterAll(() => getPoolForTests().end());

describe('checkRateLimit — Neon-backed persistence (BL-21)', () => {
  const KEY = `test:rl:bl21:${randomUUID()}`;

  beforeAll(async () => {
    await sql`DELETE FROM rate_limit_counters WHERE key = ${KEY}`;
  });

  afterEach(async () => {
    // Clear the DB row and any remembered refusal so each test starts clean.
    await sql`DELETE FROM rate_limit_counters WHERE key = ${KEY}`;
    clearRateLimitCache();
  });

  it('blocks the (N+1)-th request within the window', async () => {
    // The exact boundary: calls 1 to 5 are admitted, call 6 is the first refused.
    for (let i = 0; i < 5; i++) {
      expect(await checkRateLimit(KEY, { max: 5, windowSecs: 60 })).toBe(true);
    }
    expect(await checkRateLimit(KEY, { max: 5, windowSecs: 60 })).toBe(false);
  });

  it('resets the window after expiry (simulated via DB update)', async () => {
    for (let i = 0; i < 5; i++) await checkRateLimit(KEY, { max: 5, windowSecs: 60 });
    // simulate window expiry
    await sql`UPDATE rate_limit_counters SET window_start = NOW() - INTERVAL '2 minutes' WHERE key = ${KEY}`;
    const allowed = await checkRateLimit(KEY, { max: 5, windowSecs: 60 });
    expect(allowed).toBe(true);
  });

  it('two independent callers share the same counter (cross-pod)', async () => {
    // "Pod A" makes 4 calls. All 4 reach the DB.
    for (let i = 0; i < 4; i++) await checkRateLimit(KEY, { max: 5, windowSecs: 60 });
    // "Pod B": pods share nothing but the table.
    clearRateLimitCache();
    // Pod B makes 3 more calls. DB counter is shared, so it accumulates.
    // Total DB increments >= 6 (> max=5), last call must be blocked.
    for (let i = 0; i < 2; i++) await checkRateLimit(KEY, { max: 5, windowSecs: 60 });
    clearRateLimitCache();
    const blocked = await checkRateLimit(KEY, { max: 5, windowSecs: 60 });
    expect(blocked).toBe(false);
  });

  it('a single call with cost=N increments the DB counter by N', async () => {
    const allowed = await checkRateLimit(KEY, { max: 100, windowSecs: 60, cost: 40 });
    expect(allowed).toBe(true);
    clearRateLimitCache(); // force the next check to read the authoritative DB row
    const rows = (await sql`SELECT count FROM rate_limit_counters WHERE key = ${KEY}`) as {
      count: number;
    }[];
    expect(rows[0]?.count).toBe(40);
  });

  it(
    'rejects a single call whose cost alone exceeds max, and charges nothing for it',
    async () => {
      await checkRateLimit(KEY, { max: 50, windowSecs: 60, cost: 1 });
      // A single call costing more than the remaining budget must be rejected.
      const blocked = await checkRateLimit(KEY, { max: 50, windowSecs: 60, cost: 200 });
      expect(blocked).toBe(false);
      // A refused call consumes nothing (R-175 review round 3): the count is
      // still the one unit charged above.
      const rows = (await sql`SELECT count FROM rate_limit_counters WHERE key = ${KEY}`) as {
        count: number;
      }[];
      expect(rows[0]?.count).toBe(1);
    },
  );

  it(
    'cumulative cost across calls blocks once the running total exceeds max',
    async () => {
      const first = await checkRateLimit(KEY, { max: 10, windowSecs: 60, cost: 6 });
      expect(first).toBe(true);
      clearRateLimitCache();
      const second = await checkRateLimit(KEY, { max: 10, windowSecs: 60, cost: 6 });
      expect(second).toBe(false); // 6 + 6 = 12 > 10
    },
  );
});
