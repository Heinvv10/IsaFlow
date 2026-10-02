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
import { markQuotaUsed, markQuotaUsedUnlessNoWork } from '@/lib/quotaUse';
import { checkAiRateLimit, checkSendRateLimit, clearRateLimitCache } from '@/lib/rateLimit';
import { settleQuotaCharges } from '@/lib/rateLimitQuota';

const CO = 'company-1';
const AI_DAY = `ai:nl-query:co:${CO}:day`;
const SEND_DAY = `send:bulk:co:${CO}:day`;
const req = { headers: {}, socket: { remoteAddress: '10.0.0.9' } } as unknown as NextApiRequest;

function request(): RequestContext {
  return { client: {} as RequestContext['client'], userId: 'u', claims: {}, quotaCharges: [] };
}

const WINDOW = '2026-10-01 00:00:00.654321+00';
const isCharge = (text: string) => text.startsWith('WITH charged');

/** Every charge is admitted, in WINDOW; refunds resolve. */
function admitAll(): void {
  queryMock.mockImplementation(async (text: string) =>
    (isCharge(text) ? { rows: [{ admitted: true, count: 1, window_start: WINDOW, remaining_ms: 60_000 }] } : { rows: [] }));
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
      { kind: 'ai', key: AI_DAY, charged: 1, used: 0, windowStart: WINDOW },
      { kind: 'send', key: SEND_DAY, charged: 7, used: 0, windowStart: WINDOW },
    ]);
  });

  it('AI: no provider answer, then a 200 with a fallback, gives the unit back', async () => {
    await asRequest(async () => { await checkAiRateLimit(req, CO, 'nl-query', { refundUnused: true }); });

    expect(refunds()).toEqual([[AI_DAY, 1, WINDOW]]);
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
      await checkSendRateLimit(req, CO, 'bulk', { count: 100, companyMax: 2_000, dailyMax: 10_000, refundUnused: true });
      for (let i = 0; i < 59; i++) markQuotaUsed('send');
      throw new Error('recipient 60 blew up');
    });

    expect(refunds()).toEqual([[SEND_DAY, 41, WINDOW]]);
  });

  it('send: nothing accepted (SMTP down), answered 200, gives every unit back', async () => {
    await asRequest(async () => { await checkSendRateLimit(req, CO, 'bulk', { count: 4, refundUnused: true }); });

    expect(refunds()).toEqual([[SEND_DAY, 4, WINDOW]]);
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
    expect(refunds()).toEqual([[SEND_DAY, 2, WINDOW]]);
  });

  it('never gives back more than was charged, whatever the record holds', async () => {
    await asRequest(async () => {
      await checkSendRateLimit(req, CO, 'bulk', { count: 2, refundUnused: true });
      for (let i = 0; i < 9; i++) markQuotaUsed('send');
    });
    expect(refunds()).toEqual([]);

    const ctx = request();
    ctx.quotaCharges!.push({ kind: 'send', key: SEND_DAY, charged: 2, used: -41, windowStart: WINDOW });
    await settleQuotaCharges(ctx);
    expect(refunds()).toEqual([[SEND_DAY, 2, WINDOW]]);
  });

  it('use of one kind does not spend the other kind', async () => {
    await asRequest(async () => {
      await checkAiRateLimit(req, CO, 'nl-query', { refundUnused: true });
      await checkSendRateLimit(req, CO, 'bulk', { count: 2, refundUnused: true });
      markQuotaUsed('send');
      markQuotaUsed('send');
    });

    expect(refunds()).toEqual([[AI_DAY, 1, WINDOW]]);
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
      (isCharge(text) ? { rows: [{ admitted: false, count: 300, window_start: WINDOW, remaining_ms: 60_000 }] } : { rows: [] }));
    const ctx = await asRequest(async () => {
      expect(await checkAiRateLimit(req, CO, 'nl-query', { refundUnused: true })).toBe(false);
    });

    expect(ctx.quotaCharges).toEqual([]);
    expect(refunds()).toEqual([]);
  });

  it('settles once: a second settle gives nothing back', async () => {
    const ctx = await asRequest(async () => { await checkAiRateLimit(req, CO, 'nl-query', { refundUnused: true }); });
    await settleQuotaCharges(ctx);

    expect(refunds()).toEqual([[AI_DAY, 1, WINDOW]]);
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
    ctx.quotaCharges!.push({ kind: 'ai', key: 'a', charged: 1, used: 0, windowStart: WINDOW }, { kind: 'send', key: 'b', charged: 5, used: 3, windowStart: null });
    queryMock.mockRejectedValueOnce(new Error('pool timeout')).mockResolvedValue({ rows: [] });

    await expect(settleQuotaCharges(ctx)).resolves.toBeUndefined();

    expect(refunds()).toEqual([['a', 1, WINDOW], ['b', 2, null]]);
    expect(logError).toHaveBeenCalledTimes(1);
    expect(logError.mock.calls[0]![1]).toMatchObject({ key: 'a', units: 1, error: 'pool timeout' });
  });

  // Review round 4: a call the daily bucket refuses consumes nothing.
  it('when the daily bucket refuses, the 15-minute company charge goes back into its window; the per-IP one never does', async () => {
    queryMock.mockImplementation(async (text: string, params: unknown[]) => {
      if (!isCharge(text)) return { rows: [] };
      const admitted = !String(params[0]).endsWith(':day');
      return { rows: [{ admitted, count: 1, window_start: WINDOW, remaining_ms: 60_000 }] };
    });
    const ctx = request();
    expect(await als.run(ctx, () => checkSendRateLimit(req, CO, 'bulk', { count: 7, companyMax: 50, refundUnused: true }))).toBe(false);
    expect(await als.run(ctx, () => checkAiRateLimit(req, CO, 'nl-query', { refundUnused: true }))).toBe(false);

    expect(refunds()).toEqual([[`send:bulk:co:${CO}`, 7, WINDOW], [`ai:nl-query:co:${CO}`, 1, WINDOW]]);
    expect(ctx.quotaCharges).toEqual([]);
  });

  it('when the 15-minute company bucket refuses, nothing is charged to the day and nothing is given back', async () => {
    queryMock.mockImplementation(async (text: string, params: unknown[]) => {
      if (!isCharge(text)) return { rows: [] };
      const admitted = String(params[0]).includes(':ip:');
      return { rows: [{ admitted, count: 1, window_start: WINDOW, remaining_ms: 60_000 }] };
    });
    expect(await checkSendRateLimit(req, CO, 'bulk', { count: 7, companyMax: 50 })).toBe(false);

    expect(queryMock.mock.calls.map((c) => (c[1] as unknown[])[0])).toEqual(['send:bulk:ip:10.0.0.9', `send:bulk:co:${CO}`]);
  });

  // Review round 3.
  it('work handed to runAfterCommit forfeits the refund: use recorded there would never be seen', async () => {
    const { runAfterCommit } = await import('@/lib/afterCommit');
    const ctx = request();
    ctx.afterCommit = [];
    await asRequest(async () => {
      await checkSendRateLimit(req, CO, 'bulk', { count: 5, refundUnused: true });
      runAfterCommit('send later', async () => { markQuotaUsed('send'); });
    }, ctx);

    expect(ctx.afterCommit).toHaveLength(1);
    expect(refunds()).toEqual([]);
  });

  it('the same request without deferred work gets its units back', async () => {
    const ctx = request();
    ctx.afterCommit = [];
    await asRequest(async () => { await checkSendRateLimit(req, CO, 'bulk', { count: 5, refundUnused: true }); }, ctx);

    expect(refunds()).toEqual([[SEND_DAY, 5, WINDOW]]);
  });

  describe('a provider call that threw', () => {
    const afterThrow = async (err: unknown) => {
      await asRequest(async () => {
        await checkAiRateLimit(req, CO, 'nl-query', { refundUnused: true });
        markQuotaUsedUnlessNoWork('ai', err);
      });
      return refunds();
    };
    const fetchFailed = (code: string) => Object.assign(new TypeError('fetch failed'), { cause: { code } });

    it.each([
      ['a timeout', Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' })],
      ['an abort', Object.assign(new Error('This operation was aborted'), { name: 'AbortError' })],
      ['a reset after the request was sent', fetchFailed('ECONNRESET')],
      ['a socket closed mid-response', fetchFailed('UND_ERR_SOCKET')],
      ['an SDK timeout (no status)', Object.assign(new Error('Request timed out.'), { name: 'APIConnectionTimeoutError' })],
      ['an unknown error', new Error('something else')],
      ['a provider 529 answer (SDK): a 5xx may come after the work', Object.assign(new Error('overloaded'), { status: 529 })],
      ['a 502 from a proxy in front of the provider', Object.assign(new Error('bad gateway'), { status: 502 })],
      ['a 408 request timeout', Object.assign(new Error('timeout'), { status: 408 })],
      ['a non-error value', 'boom'],
    ])('counts as use after %s: the provider may have done the work', async (_label, err) => {
      expect(await afterThrow(err)).toEqual([]);
    });

    it.each([
      ['a refused connection', fetchFailed('ECONNREFUSED')],
      ['a name that does not resolve', fetchFailed('ENOTFOUND')],
      ['a DNS failure', fetchFailed('EAI_AGAIN')],
      ['a connect timeout', fetchFailed('UND_ERR_CONNECT_TIMEOUT')],
      ['a code on the error itself', Object.assign(new Error('connect'), { code: 'ECONNREFUSED' })],
      ['a provider 400 answer (SDK)', Object.assign(new Error('bad request'), { status: 400 })],
      ['a provider 401 answer (SDK)', Object.assign(new Error('unauthorised'), { status: 401 })],
      ['a provider 429 rate-limit answer (SDK)', Object.assign(new Error('rate limited'), { status: 429 })],
    ])('is not use after %s: no work was done', async (_label, err) => {
      expect(await afterThrow(err)).toEqual([[AI_DAY, 1, WINDOW]]);
    });
  });
});
