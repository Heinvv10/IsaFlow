/**
 * R-175: a request gets back the usage-quota units it charged and did not use.
 * Never more than it charged, never a key it did not charge, never twice.
 *
 * The limiter's pool is mocked. `als.run` with a `quotaCharges` list stands in
 * for withAuth, the one owner that keeps the list.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextApiRequest } from 'next';

const { queryMock, logError } = vi.hoisted(() => ({ queryMock: vi.fn(), logError: vi.fn() }));
vi.mock('@/lib/rateLimitPool', () => ({ getRateLimitPool: () => ({ query: queryMock }) }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: logError } }));

import { als, type RequestContext } from '@/lib/als';
import { markQuotaUsed } from '@/lib/quotaUse';
import { checkAiRateLimit, checkSendRateLimit, clearRateLimitCache } from '@/lib/rateLimit';
import { settleQuotaCharges } from '@/lib/rateLimitQuota';

const CO = 'company-1';
const AI_DAY = `ai:nl-query:co:${CO}:day`;
const SEND_DAY = `send:bulk:co:${CO}:day`;
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

/** Runs `work` as one request and settles it, the way withAuth does on every exit. */
async function asRequest(work: () => Promise<unknown>, ctx = request()): Promise<RequestContext> {
  await als.run(ctx, work).catch(() => undefined);
  await settleQuotaCharges(ctx);
  return ctx;
}

describe('usage-quota: charged minus used comes back (R-175)', () => {
  beforeEach(() => {
    queryMock.mockReset();
    logError.mockReset();
    clearRateLimitCache();
    admitAll();
  });

  it('notes the daily bucket only, and only when the caller asks for refundUnused', async () => {
    const ctx = request();
    await als.run(ctx, async () => {
      expect(await checkAiRateLimit(req, CO, 'nl-query', { refundUnused: true })).toBe(true);
      expect(await checkSendRateLimit(req, CO, 'bulk', { count: 7, refundUnused: true })).toBe(true);
      expect(await checkAiRateLimit(req, CO, 'document-validation')).toBe(true);
      expect(await checkSendRateLimit(req, CO, 'other', { count: 3 })).toBe(true);
    });

    expect(ctx.quotaCharges).toEqual([
      { kind: 'ai', key: AI_DAY, charged: 1, used: 0 },
      { kind: 'send', key: SEND_DAY, charged: 7, used: 0 },
    ]);
  });

  it('AI: no provider answer, then a 200 with a fallback, gives the unit back', async () => {
    await asRequest(async () => { await checkAiRateLimit(req, CO, 'nl-query', { refundUnused: true }); });

    expect(refunds()).toEqual([[AI_DAY, 1]]);
  });

  it('AI: the provider answered, then the request threw, keeps the unit', async () => {
    await asRequest(async () => {
      await checkAiRateLimit(req, CO, 'nl-query', { refundUnused: true });
      markQuotaUsed('ai');
      throw new Error('saving the answer failed');
    });

    expect(refunds()).toEqual([]);
  });

  it('send: every email accepted keeps every unit', async () => {
    await asRequest(async () => {
      await checkSendRateLimit(req, CO, 'bulk', { count: 3, refundUnused: true });
      for (let i = 0; i < 3; i++) markQuotaUsed('send');
    });

    expect(refunds()).toEqual([]);
  });

  it('send: 59 of 100 accepted, then a throw, gives back 41', async () => {
    await asRequest(async () => {
      await checkSendRateLimit(req, CO, 'bulk', { count: 100, refundUnused: true });
      for (let i = 0; i < 59; i++) markQuotaUsed('send');
      throw new Error('recipient 60 blew up');
    });

    expect(refunds()).toEqual([[SEND_DAY, 41]]);
  });

  it('send: nothing accepted (SMTP down), answered 200, gives every unit back', async () => {
    await asRequest(async () => { await checkSendRateLimit(req, CO, 'bulk', { count: 4, refundUnused: true }); });

    expect(refunds()).toEqual([[SEND_DAY, 4]]);
  });

  it('use cannot be taken back: a negative count is ignored', async () => {
    await asRequest(async () => {
      await checkSendRateLimit(req, CO, 'bulk', { count: 2, refundUnused: true });
      markQuotaUsed('send', 2);
      markQuotaUsed('send', -50);
    });

    expect(refunds()).toEqual([]);
  });

  it('a zero or NaN count records no use, and does not poison the record', async () => {
    await asRequest(async () => {
      await checkSendRateLimit(req, CO, 'bulk', { count: 2, refundUnused: true });
      markQuotaUsed('send', 0);
      markQuotaUsed('send', Number.NaN);
    });

    // Nothing was used, so both units come back. A NaN that reached the record
    // would make `charged - used` NaN and silently keep them.
    expect(refunds()).toEqual([[SEND_DAY, 2]]);
  });

  it('never gives back more than was charged, whatever the record holds', async () => {
    await asRequest(async () => {
      await checkSendRateLimit(req, CO, 'bulk', { count: 2, refundUnused: true });
      for (let i = 0; i < 9; i++) markQuotaUsed('send');
    });
    expect(refunds()).toEqual([]);

    const ctx = request();
    ctx.quotaCharges!.push({ kind: 'send', key: SEND_DAY, charged: 2, used: -41 });
    await settleQuotaCharges(ctx);
    expect(refunds()).toEqual([[SEND_DAY, 2]]);
  });

  it('use of one kind does not spend the other kind', async () => {
    await asRequest(async () => {
      await checkAiRateLimit(req, CO, 'nl-query', { refundUnused: true });
      await checkSendRateLimit(req, CO, 'bulk', { count: 2, refundUnused: true });
      markQuotaUsed('send');
      markQuotaUsed('send');
    });

    expect(refunds()).toEqual([[AI_DAY, 1]]);
  });

  it('a caller that did not ask for refundUnused keeps its charge whatever happens', async () => {
    await asRequest(async () => {
      await checkAiRateLimit(req, CO, 'document-validation');
      await checkSendRateLimit(req, CO, 'other', { count: 5 });
      throw new Error('failed');
    });

    expect(refunds()).toEqual([]);
  });

  it('a refused call notes nothing and gets nothing back', async () => {
    queryMock.mockImplementation(async (text: string) =>
      (text.startsWith('INSERT') ? { rows: [{ count: 999, remaining_ms: 60_000 }] } : { rows: [] }));
    const ctx = await asRequest(async () => {
      expect(await checkAiRateLimit(req, CO, 'nl-query', { refundUnused: true })).toBe(false);
    });

    expect(ctx.quotaCharges).toEqual([]);
    expect(refunds()).toEqual([]);
  });

  it('settles once: a second settle gives nothing back', async () => {
    const ctx = await asRequest(async () => { await checkAiRateLimit(req, CO, 'nl-query', { refundUnused: true }); });
    await settleQuotaCharges(ctx);

    expect(refunds()).toEqual([[AI_DAY, 1]]);
    expect(ctx.quotaCharges).toEqual([]);
  });

  it('outside a request that keeps the list (bearer, cron, platform admin) nothing is noted, marked or given back', async () => {
    const bare = { client: {} as RequestContext['client'], userId: 'u', claims: {} };
    expect(await checkAiRateLimit(req, CO, 'nl-query', { refundUnused: true })).toBe(true);
    await als.run(bare, async () => {
      expect(await checkAiRateLimit(req, CO, 'nl-query', { refundUnused: true })).toBe(true);
      markQuotaUsed('ai');
    });
    markQuotaUsed('send');
    await settleQuotaCharges(bare);
    await settleQuotaCharges(null);
    await settleQuotaCharges(undefined);

    expect(bare).not.toHaveProperty('quotaCharges');
    expect(refunds()).toEqual([]);
  });

  it('a refund that fails is logged, does not throw, and does not stop the next one', async () => {
    const ctx = request();
    ctx.quotaCharges!.push({ kind: 'ai', key: 'a', charged: 1, used: 0 }, { kind: 'send', key: 'b', charged: 5, used: 3 });
    queryMock.mockRejectedValueOnce(new Error('pool timeout')).mockResolvedValue({ rows: [] });

    await expect(settleQuotaCharges(ctx)).resolves.toBeUndefined();

    expect(refunds()).toEqual([['a', 1], ['b', 2]]);
    expect(logError).toHaveBeenCalledTimes(1);
    expect(logError.mock.calls[0]![1]).toMatchObject({ key: 'a', units: 1, error: 'pool timeout' });
  });
});
