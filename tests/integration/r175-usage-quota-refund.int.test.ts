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
import { afterAll, describe, expect, it } from 'vitest';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { als, type RequestContext } from '@/lib/als';
import { markQuotaUsed } from '@/lib/quotaUse';
import { chargeRateLimit, checkAiRateLimit, checkSendRateLimit, refundRateLimit } from '@/lib/rateLimit';
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
});
