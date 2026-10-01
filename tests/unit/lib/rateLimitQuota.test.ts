/**
 * R-175 review round 1: usage-quota units are given back by a request that
 * did none of the bounded work, and by nobody else.
 *
 * The limiter's pool is mocked. `als.run` stands in for withAuth, which is the
 * one owner that keeps a `quotaCharges` list.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextApiRequest } from 'next';

const { queryMock, logError } = vi.hoisted(() => ({ queryMock: vi.fn(), logError: vi.fn() }));
vi.mock('@/lib/rateLimitPool', () => ({ getRateLimitPool: () => ({ query: queryMock }) }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: logError } }));

import { als, type RequestContext } from '@/lib/als';
import { checkAiRateLimit, checkSendRateLimit, clearRateLimitCache } from '@/lib/rateLimit';
import { refundAiDailyQuota, refundQuotaCharges, refundSendDailyQuota } from '@/lib/rateLimitQuota';

const CO = 'company-1';
const req = { headers: {}, socket: { remoteAddress: '10.0.0.9' } } as unknown as NextApiRequest;

function request(): RequestContext {
  return { client: {} as RequestContext['client'], userId: 'u', claims: {}, quotaCharges: [] };
}

/** Every charge is admitted with count 1; refunds resolve. */
function admitAll(): void {
  queryMock.mockImplementation(async (text: string) =>
    (text.startsWith('INSERT') ? { rows: [{ count: 1, remaining_ms: 60_000 }] } : { rows: [] }));
}

const refunds = () => queryMock.mock.calls.filter((c) => String(c[0]).startsWith('UPDATE')).map((c) => c[1]);

describe('usage-quota refunds (R-175)', () => {
  beforeEach(() => {
    queryMock.mockReset();
    logError.mockReset();
    clearRateLimitCache();
    admitAll();
  });

  it('checkAiRateLimit notes one unit of the daily bucket, and only that bucket', async () => {
    const ctx = request();
    expect(await als.run(ctx, () => checkAiRateLimit(req, CO, 'nl-query'))).toBe(true);

    expect(ctx.quotaCharges).toEqual([{ key: `ai:nl-query:co:${CO}:day`, units: 1 }]);
  });

  it('checkSendRateLimit notes the recipient count on the daily bucket', async () => {
    const ctx = request();
    await als.run(ctx, () => checkSendRateLimit(req, CO, 'bulk', { count: 7 }));

    expect(ctx.quotaCharges).toEqual([{ key: `send:bulk:co:${CO}:day`, units: 7 }]);
  });

  it('notes nothing when the call is refused', async () => {
    queryMock.mockResolvedValue({ rows: [{ count: 999, remaining_ms: 60_000 }] });
    const ctx = request();
    expect(await als.run(ctx, () => checkAiRateLimit(req, CO, 'nl-query'))).toBe(false);

    expect(ctx.quotaCharges).toEqual([]);
  });

  it('does nothing outside a request that keeps the list', async () => {
    expect(await checkAiRateLimit(req, CO, 'nl-query')).toBe(true);
    const bare = { client: {} as RequestContext['client'], userId: 'u', claims: {} };
    expect(await als.run(bare, () => checkAiRateLimit(req, CO, 'nl-query'))).toBe(true);
    await als.run(bare, () => refundAiDailyQuota(CO, 'nl-query'));

    expect(refunds()).toEqual([]);
  });

  it('refundQuotaCharges gives back each noted charge once', async () => {
    const ctx = request();
    await als.run(ctx, async () => {
      await checkAiRateLimit(req, CO, 'nl-query');
      await checkSendRateLimit(req, CO, 'bulk', { count: 4 });
    });

    await refundQuotaCharges(ctx);
    await refundQuotaCharges(ctx);

    expect(refunds()).toEqual([[`ai:nl-query:co:${CO}:day`, 1], [`send:bulk:co:${CO}:day`, 4]]);
    expect(ctx.quotaCharges).toEqual([]);
  });

  it('tolerates a request that has no list', async () => {
    await refundQuotaCharges(null);
    await refundQuotaCharges({});

    expect(queryMock).not.toHaveBeenCalled();
  });

  it('a refund that fails is logged, does not throw, and does not stop the next one', async () => {
    const ctx = request();
    ctx.quotaCharges!.push({ key: 'a', units: 1 }, { key: 'b', units: 2 });
    queryMock.mockRejectedValueOnce(new Error('pool timeout')).mockResolvedValue({ rows: [] });

    await expect(refundQuotaCharges(ctx)).resolves.toBeUndefined();

    expect(refunds()).toEqual([['a', 1], ['b', 2]]);
    expect(logError).toHaveBeenCalledTimes(1);
    expect(logError.mock.calls[0]![1]).toMatchObject({ key: 'a', units: 1, error: 'pool timeout' });
  });

  it('refundAiDailyQuota gives the unit back once, and then the failed-request refund has nothing left', async () => {
    const ctx = request();
    await als.run(ctx, async () => {
      await checkAiRateLimit(req, CO, 'nl-query');
      await refundAiDailyQuota(CO, 'nl-query');
      await refundAiDailyQuota(CO, 'nl-query');
    });
    await refundQuotaCharges(ctx);

    expect(refunds()).toEqual([[`ai:nl-query:co:${CO}:day`, 1]]);
  });

  it('a request cannot give back a bucket it did not charge', async () => {
    const ctx = request();
    await als.run(ctx, async () => {
      await checkAiRateLimit(req, CO, 'nl-query');
      await refundAiDailyQuota(CO, 'ai-forecast');
      await refundAiDailyQuota('another-company', 'nl-query');
      await refundSendDailyQuota(CO, 'nl-query', 1);
    });

    expect(refunds()).toEqual([]);
  });

  it('refundSendDailyQuota gives back at most what the request charged', async () => {
    const ctx = request();
    await als.run(ctx, async () => {
      await checkSendRateLimit(req, CO, 'bulk', { count: 5 });
      await refundSendDailyQuota(CO, 'bulk', 2);
      await refundSendDailyQuota(CO, 'bulk', 0);
      await refundSendDailyQuota(CO, 'bulk', -4);
      await refundSendDailyQuota(CO, 'bulk', Number.NaN);
      expect(ctx.quotaCharges).toEqual([{ key: `send:bulk:co:${CO}:day`, units: 3 }]);
      await refundSendDailyQuota(CO, 'bulk', 10);
    });

    expect(refunds()).toEqual([[`send:bulk:co:${CO}:day`, 2], [`send:bulk:co:${CO}:day`, 3]]);
    expect(ctx.quotaCharges).toEqual([]);
  });
});
