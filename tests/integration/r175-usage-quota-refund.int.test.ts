/**
 * R-175: when a request ends, it gets back the daily usage-quota units it
 * charged and did not use. Against real PostgreSQL.
 *
 * `als.run` with a `quotaCharges` list stands in for withAuth, the owner that
 * keeps the list and calls `settleQuotaCharges` on every exit
 * (tests/unit/auth/withAuth-commit-order.test.ts covers that wiring).
 * `markQuotaUsed` is what the shared email and AI clients call when the work
 * happened (tests/unit/lib/quotaUseChokepoints.test.ts).
 */
import { randomUUID } from 'node:crypto';
import type { NextApiRequest } from 'next';
import { Pool } from 'pg';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { als, type RequestContext } from '@/lib/als';
import { markQuotaUsed } from '@/lib/quotaUse';
import { chargeRateLimit, checkAiRateLimit, checkSendRateLimit, refundRateLimit } from '@/lib/rateLimit';
import { getRateLimitPool } from '@/lib/rateLimitPool';
import { settleQuotaCharges } from '@/lib/rateLimitQuota';

assertDisposable();

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: false });
const RUN = randomUUID();
const CO = randomUUID();
const IP = '203.0.113.75';
const req = { headers: {}, socket: { remoteAddress: IP } } as unknown as NextApiRequest;
const refundable = { refundUnused: true };

/** One request: runs `work` on a context that keeps the list, then settles, whatever happened. */
async function asRequest(work: () => Promise<unknown>): Promise<RequestContext> {
  const ctx: RequestContext = { client: {} as RequestContext['client'], userId: 'u', claims: {}, quotaCharges: [] };
  await als.run(ctx, work).catch(() => undefined);
  await settleQuotaCharges(ctx);
  return ctx;
}

async function counts(kind: 'ai' | 'send', name: string): Promise<{ ip: number; company: number; day: number }> {
  const { rows } = await pool.query('SELECT key, count FROM rate_limit_counters WHERE key LIKE $1', [`${kind}:${name}:%`]);
  const at = (key: string) => rows.find((r) => r.key === key)?.count as number;
  return { ip: at(`${kind}:${name}:ip:${IP}`), company: at(`${kind}:${name}:co:${CO}`), day: at(`${kind}:${name}:co:${CO}:day`) };
}

afterAll(async () => {
  await pool.query('DELETE FROM rate_limit_counters WHERE key LIKE $1 OR key LIKE $2', [`ai:${RUN}%`, `send:${RUN}%`]);
  await pool.end();
});

describe('R-175 — charged minus used comes back, on every exit', () => {
  it('AI: three requests, one used its unit, one fell back, one threw after the answer', async () => {
    const name = `${RUN}-ai`;
    await asRequest(async () => { await checkAiRateLimit(req, CO, name, refundable); markQuotaUsed('ai'); });
    await asRequest(async () => { await checkAiRateLimit(req, CO, name, refundable); });
    await asRequest(async () => {
      await checkAiRateLimit(req, CO, name, refundable);
      markQuotaUsed('ai');
      throw new Error('saving the answer failed');
    });

    // Two answers were received: two daily units stay spent. The 15-minute
    // buckets keep all three.
    expect(await counts('ai', name)).toEqual({ ip: 3, company: 3, day: 2 });
  });

  it('send: 59 of 100 accepted, then a throw, leaves 59 spent', async () => {
    const name = `${RUN}-bulk`;
    await asRequest(async () => {
      await checkSendRateLimit(req, CO, name, { count: 100, companyMax: 2000, dailyMax: 10_000, ...refundable });
      for (let i = 0; i < 59; i++) markQuotaUsed('send');
      throw new Error('recipient 60 blew up');
    });

    expect(await counts('send', name)).toEqual({ ip: 1, company: 100, day: 59 });
  });

  it('send: SMTP down, answered 200, leaves nothing spent; a second request on the key is untouched', async () => {
    const name = `${RUN}-smtp`;
    await asRequest(async () => {
      await checkSendRateLimit(req, CO, name, { count: 10, ...refundable });
      for (let i = 0; i < 10; i++) markQuotaUsed('send');
    });
    const failed = await asRequest(async () => { await checkSendRateLimit(req, CO, name, { count: 4, ...refundable }); });
    expect(await counts('send', name)).toEqual({ ip: 2, company: 14, day: 10 });

    // Settling again gives nothing more back: the first request's 10 stay.
    await settleQuotaCharges(failed);
    expect(await counts('send', name)).toEqual({ ip: 2, company: 14, day: 10 });
  });

  it('a caller that did not ask for refundUnused keeps its charge, even when it fails', async () => {
    const name = `${RUN}-kept`;
    await asRequest(async () => {
      await checkAiRateLimit(req, CO, name);
      throw new Error('failed');
    });

    expect(await counts('ai', name)).toEqual({ ip: 1, company: 1, day: 1 });
  });

  it('a request refused by the daily bucket gets nothing back', async () => {
    const name = `${RUN}-full`;
    await asRequest(async () => { await checkAiRateLimit(req, CO, name, { dailyMax: 1, ...refundable }); markQuotaUsed('ai'); });
    await asRequest(async () => { expect(await checkAiRateLimit(req, CO, name, { dailyMax: 1, ...refundable })).toBe(false); });

    expect((await counts('ai', name)).day).toBe(1);
  });

  // Review round 3: a refund must only reduce the window it was charged in.
  it('a refund that arrives after the window rolled over does not touch the new window', async () => {
    const name = `${RUN}-roll`;
    const dayKey = `send:${name}:co:${CO}:day`;
    const bulk = { count: 100, companyMax: 2000, dailyMax: 10_000, ...refundable };
    // Request A charges 100 at the end of a window; none of its emails go out.
    const a: RequestContext = { client: {} as RequestContext['client'], userId: 'u', claims: {}, quotaCharges: [] };
    await als.run(a, async () => { await checkSendRateLimit(req, CO, name, bulk); });
    // The day ends.
    await pool.query(`UPDATE rate_limit_counters SET window_start = window_start - INTERVAL '25 hours' WHERE key = $1`, [dayKey]);
    // Request B charges 100 in the new window and sends all 100.
    await asRequest(async () => {
      await checkSendRateLimit(req, CO, name, bulk);
      for (let i = 0; i < 100; i++) markQuotaUsed('send');
    });
    expect((await counts('send', name)).day).toBe(100);

    // A settles now. Its 100 belonged to yesterday's count.
    await settleQuotaCharges(a);

    expect((await counts('send', name)).day).toBe(100);
  });

  it('the same refund, with no rollover, lands', async () => {
    const name = `${RUN}-noroll`;
    const a: RequestContext = { client: {} as RequestContext['client'], userId: 'u', claims: {}, quotaCharges: [] };
    await als.run(a, async () => { await checkSendRateLimit(req, CO, name, { count: 100, companyMax: 2000, dailyMax: 10_000, ...refundable }); });
    await asRequest(async () => {
      await checkSendRateLimit(req, CO, name, { count: 100, companyMax: 2000, dailyMax: 10_000, ...refundable });
      for (let i = 0; i < 100; i++) markQuotaUsed('send');
    });
    expect(a.quotaCharges![0]!.windowStart).toMatch(/^\d{4}-\d{2}-\d{2} /);

    await settleQuotaCharges(a);

    expect((await counts('send', name)).day).toBe(100);
  });

  it('refundRateLimit with a window is a no-op on any other window, and unchanged without one', async () => {
    const key = `send:${RUN}-direct:co:${CO}:day`;
    const charge = await chargeRateLimit(key, { max: 50, windowSecs: 86_400, cost: 10 });
    expect(charge.admitted).toBe(true);

    await refundRateLimit(key, 3, '2020-01-01 00:00:00+00');
    expect((await pool.query('SELECT count FROM rate_limit_counters WHERE key = $1', [key])).rows[0].count).toBe(10);
    await refundRateLimit(key, 3, charge.windowStart);
    expect((await pool.query('SELECT count FROM rate_limit_counters WHERE key = $1', [key])).rows[0].count).toBe(7);
    await refundRateLimit(key, 2);
    expect((await pool.query('SELECT count FROM rate_limit_counters WHERE key = $1', [key])).rows[0].count).toBe(5);
  });

  // Review round 4.
  it('invite-accept shape: a charge in the last second of its hour, refunded after the rollover, takes nothing off the new hour', async () => {
    const key = `invite-accept:${RUN}`;
    const attempt = { max: 20, windowSecs: 3600, cost: 2 };
    const first = await chargeRateLimit(key, attempt);
    await pool.query(`UPDATE rate_limit_counters SET window_start = window_start - INTERVAL '3601 seconds' WHERE key = $1`, [key]);
    // The hour rolls: the next attempt opens a new window.
    const second = await chargeRateLimit(key, attempt);
    expect(second.windowStart).not.toBe(first.windowStart);

    await refundRateLimit(key, 2, first.windowStart);

    const count = async () => (await pool.query('SELECT count FROM rate_limit_counters WHERE key = $1', [key])).rows[0].count;
    expect(await count()).toBe(2);
    // The second attempt's own refund still lands.
    await refundRateLimit(key, 2, second.windowStart);
    expect(await count()).toBe(0);
    await pool.query('DELETE FROM rate_limit_counters WHERE key = $1', [key]);
  });

  it('send: a batch the daily bucket refuses takes nothing from the 15-minute company bucket; the per-IP attempt stays', async () => {
    const name = `${RUN}-daily-full`;
    const bulk = { companyMax: 2000, dailyMax: 150 };
    expect(await asRequest(async () => { await checkSendRateLimit(req, CO, name, { count: 100, ...bulk }); })).toBeTruthy();
    expect(await counts('send', name)).toEqual({ ip: 1, company: 100, day: 100 });

    let verdict: boolean | undefined;
    await asRequest(async () => { verdict = await checkSendRateLimit(req, CO, name, { count: 100, ...bulk, ...refundable }); });

    expect(verdict).toBe(false);
    // 100 + 100 does not fit under 150 a day. The 15-minute bucket is back at 100.
    expect(await counts('send', name)).toEqual({ ip: 2, company: 100, day: 100 });
    // And a smaller batch that does fit is still admitted.
    expect(await checkSendRateLimit(req, CO, name, { count: 50, ...bulk })).toBe(true);
    expect(await counts('send', name)).toEqual({ ip: 3, company: 150, day: 150 });
  });

  it('AI: a call the daily bucket refuses takes nothing from the 15-minute company bucket', async () => {
    const name = `${RUN}-ai-daily-full`;
    expect(await checkAiRateLimit(req, CO, name, { dailyMax: 1 })).toBe(true);
    expect(await checkAiRateLimit(req, CO, name, { dailyMax: 1 })).toBe(false);
    expect(await checkAiRateLimit(req, CO, name, { dailyMax: 1 })).toBe(false);

    // The third call is refused from memory: the daily key is known full, so
    // not even the per-IP bucket is written.
    expect(await counts('ai', name)).toEqual({ ip: 2, company: 1, day: 1 });
  });

  it('a call the 15-minute company bucket refuses never reaches the daily bucket', async () => {
    const name = `${RUN}-short-full`;
    expect(await checkAiRateLimit(req, CO, name, { companyMax: 1 })).toBe(true);
    expect(await checkAiRateLimit(req, CO, name, { companyMax: 1 })).toBe(false);

    expect(await counts('ai', name)).toEqual({ ip: 2, company: 1, day: 1 });
  });

  // Review round 5.
  it('a company whose daily bucket is known full costs no limiter statement at all', async () => {
    const name = `${RUN}-known-full`;
    expect(await checkSendRateLimit(req, CO, name, { dailyMax: 1 })).toBe(true);
    expect(await checkSendRateLimit(req, CO, name, { dailyMax: 1 })).toBe(false);
    const before = await counts('send', name);

    const limiterPool = getRateLimitPool();
    const query = vi.spyOn(limiterPool, 'query');
    try {
      for (let i = 0; i < 25; i++) expect(await checkSendRateLimit(req, CO, name, { dailyMax: 1 })).toBe(false);
      expect(query).not.toHaveBeenCalled();
      // The spy does see limiter statements: an AI key with room costs three.
      expect(await checkAiRateLimit(req, CO, name, { dailyMax: 100 })).toBe(true);
      expect(query).toHaveBeenCalledTimes(3);
    } finally {
      query.mockRestore();
    }
    expect(await counts('send', name)).toEqual(before);
  });
});
