/**
 * R-175 review round 1: a failed request gives back its daily usage-quota
 * units, and only those, against real PostgreSQL.
 *
 * `als.run` with a `quotaCharges` list stands in for withAuth, which is the
 * owner that keeps the list and calls `refundQuotaCharges` on a 5xx
 * (tests/unit/auth/withAuth-commit-order.test.ts covers that wiring).
 */
import { randomUUID } from 'node:crypto';
import type { NextApiRequest } from 'next';
import { Pool } from 'pg';
import { afterAll, describe, expect, it } from 'vitest';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { als, type RequestContext } from '@/lib/als';
import { checkAiRateLimit, checkSendRateLimit } from '@/lib/rateLimit';
import { refundAiDailyQuota, refundQuotaCharges, refundSendDailyQuota } from '@/lib/rateLimitQuota';

assertDisposable();

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: false });
const NAME = `r175q-${randomUUID()}`;
const CO = randomUUID();
const IP = '203.0.113.75';
const req = { headers: {}, socket: { remoteAddress: IP } } as unknown as NextApiRequest;

const request = (): RequestContext =>
  ({ client: {} as RequestContext['client'], userId: 'u', claims: {}, quotaCharges: [] });

async function counts(kind: 'ai' | 'send'): Promise<Record<string, number>> {
  const { rows } = await pool.query('SELECT key, count FROM rate_limit_counters WHERE key LIKE $1', [`${kind}:${NAME}:%`]);
  const at = (key: string) => rows.find((r) => r.key === key)?.count as number;
  return { ip: at(`${kind}:${NAME}:ip:${IP}`), company: at(`${kind}:${NAME}:co:${CO}`), day: at(`${kind}:${NAME}:co:${CO}:day`) };
}

afterAll(async () => {
  await pool.query('DELETE FROM rate_limit_counters WHERE key LIKE $1 OR key LIKE $2', [`ai:${NAME}:%`, `send:${NAME}:%`]);
  await pool.end();
});

describe('R-175 — usage quota is given back by a failed request', () => {
  it('a failed AI request gets its daily unit back; the 15-minute buckets stay charged', async () => {
    const failed = request();
    const kept = request();
    const other = request();
    for (const ctx of [failed, kept, other]) expect(await als.run(ctx, () => checkAiRateLimit(req, CO, NAME))).toBe(true);
    expect(await counts('ai')).toEqual({ ip: 3, company: 3, day: 3 });

    // What withAuth does when the first request ends in a 5xx. Twice: the
    // second call must find nothing left.
    await refundQuotaCharges(failed);
    await refundQuotaCharges(failed);

    expect(await counts('ai')).toEqual({ ip: 3, company: 3, day: 2 });

    // A handler that knows the provider gave no answer does the same itself,
    // once; the failed-request refund then finds nothing left to give back.
    // The third request's unit is never touched.
    await als.run(kept, async () => {
      await refundAiDailyQuota(CO, NAME);
      await refundAiDailyQuota(CO, NAME);
    });
    await refundQuotaCharges(kept);

    expect(await counts('ai')).toEqual({ ip: 3, company: 3, day: 1 });
  });

  it('a send request gives back the emails that failed, then the rest if it fails outright, never another request\'s', async () => {
    const ctx = request();
    const other = request();
    for (const c of [ctx, other]) expect(await als.run(c, () => checkSendRateLimit(req, CO, NAME, { count: 10 }))).toBe(true);
    expect(await counts('send')).toEqual({ ip: 2, company: 20, day: 20 });

    await als.run(ctx, () => refundSendDailyQuota(CO, NAME, 4));
    expect(await counts('send')).toEqual({ ip: 2, company: 20, day: 16 });

    // Asking for more than it charged gives back only what is left of its own 10.
    await als.run(ctx, () => refundSendDailyQuota(CO, NAME, 100));
    await refundQuotaCharges(ctx);
    expect(await counts('send')).toEqual({ ip: 2, company: 20, day: 10 });
  });

  it('a request refused by the daily bucket has nothing to give back', async () => {
    const name = `${NAME}-full`;
    const ctx = request();
    expect(await als.run(ctx, () => checkAiRateLimit(req, CO, name, { dailyMax: 1 }))).toBe(true);
    const refusedCtx = request();
    expect(await als.run(refusedCtx, () => checkAiRateLimit(req, CO, name, { dailyMax: 1 }))).toBe(false);

    await refundQuotaCharges(refusedCtx);

    const { rows } = await pool.query('SELECT count FROM rate_limit_counters WHERE key = $1', [`ai:${name}:co:${CO}:day`]);
    expect(rows[0].count).toBe(2);
    await pool.query('DELETE FROM rate_limit_counters WHERE key LIKE $1', [`ai:${name}:%`]);
  });
});
