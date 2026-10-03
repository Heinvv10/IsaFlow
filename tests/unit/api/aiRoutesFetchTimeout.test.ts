/**
 * R-188: ai-narrative, ai-forecast and cash-flow-forecast (AI weekly mode) hold a withAuth pool connection (idle in
 * transaction) for the whole provider call. With no timeout a slow provider held
 * it for undici's default (~300 s); at a pool of 10 a few of those starve every
 * cookie-auth request. Both bound the call with an AbortController, and an abort
 * lands in the existing catch: the route answers 200 with its fallback.
 *
 * The provider is a fetch that never answers and rejects only when its signal aborts.
 * cash-flow-forecast has no fallback: a failure there is its existing databaseError answer.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

type H = (req: NextApiRequest, res: NextApiResponse) => unknown;
vi.mock('@/lib/auth', () => ({ withAuth: (h: H) => h, withWriteAccess: (h: H) => h }));
vi.mock('@/lib/auth/withCsrf', () => ({ withCsrf: (h: H) => h }));
vi.mock('@/lib/api-error-handler', () => ({ withErrorHandler: (h: H) => h }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
const { checkAi } = vi.hoisted(() => ({ checkAi: vi.fn() }));
vi.mock('@/lib/rateLimit', () => ({ checkAiRateLimit: checkAi }));
vi.mock('@/lib/apiResponse', () => ({
  apiResponse: { success: vi.fn(), databaseError: vi.fn(), badRequest: vi.fn(), tooManyRequests: vi.fn(), methodNotAllowed: vi.fn() },
}));

import { apiResponse } from '@/lib/apiResponse';
import { log } from '@/lib/logger';
import aiNarrative from '../../../pages/api/accounting/ai-narrative';
import aiForecast from '../../../pages/api/accounting/ai-forecast';
import cashFlowForecast from '../../../pages/api/accounting/cash-flow-forecast';

// The route's data reads are not under test: the provider call is.
vi.mock('@/modules/accounting/services/reports/cashFlowForecastDataService', () => ({
  getActualCashFlow: async () => [], getBankBalance: async () => 0,
  getUpcomingReceivablesAndPayables: async () => [],
  getRecurringTemplates: async () => [], toNum: (v: unknown) => Number(v ?? 0),
}));

// max_tokens 1024 -> 30 s; 512 -> 20 s (nl-query's bound for 512; ai-categorize uses 15 s for 256 tokens);
// the cash-flow forecast asks for 1000 -> 30 s.
type Route = {
  name: string; handler: H; timeoutMs: number;
  request: () => Record<string, unknown>;
  /** What the route answers once the provider call has failed. */
  failed: () => void;
};
let nth = 0;
const answeredWithFallback = () => {
  expect(apiResponse.success).toHaveBeenCalledTimes(1);
  expect(apiResponse.success).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ aiGenerated: false }));
};
const ROUTES: Route[] = [
  { name: 'ai-narrative', handler: aiNarrative as unknown as H, timeoutMs: 30_000, failed: answeredWithFallback,
    request: () => ({ method: 'POST', companyId: 'c', body: { reportData: { reportType: 'income_statement', companyName: 'Co', period: '2026-08', currentPeriod: { revenue: 100, expenses: 80, netProfit: 20 } } } }) },
  { name: 'ai-forecast', handler: aiForecast as unknown as H, timeoutMs: 20_000, failed: answeredWithFallback,
    request: () => ({ method: 'POST', companyId: 'c', body: { baseRevenue: 100_000, baseExpenses: 80_000, cashBalance: 50_000, months: 3 } }) },
  { name: 'cash-flow-forecast', handler: cashFlowForecast as unknown as H, timeoutMs: 30_000,
    failed: () => { expect(apiResponse.databaseError).toHaveBeenCalledTimes(1); expect(apiResponse.success).not.toHaveBeenCalled(); },
    // A fresh company per call: the service caches a successful forecast per company for 4 hours.
    request: () => ({ method: 'GET', companyId: `co-${++nth}`, query: { horizon: '30' } }) },
];

let signal: AbortSignal | undefined;
const abortError = () => Object.assign(new Error('This operation was aborted'), { name: 'AbortError' });
const hangingFetch = vi.fn((_url: string, init?: { signal?: AbortSignal }) => new Promise((_resolve, reject) => {
  signal = init?.signal;
  init?.signal?.addEventListener('abort', () => reject(abortError()));
}));
/** The provider answers 200 at once, then the body never arrives and fails only when the signal aborts. */
const hangingBodyFetch = vi.fn(async (_url: string, init?: { signal?: AbortSignal }) => {
  signal = init?.signal;
  return {
    ok: true,
    json: () => new Promise((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(abortError()))),
    text: () => new Promise((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(abortError()))),
  };
});

describe.each(ROUTES)('$name provider call is bounded (R-188)', (route) => {
  const call = () => route.handler(route.request() as unknown as NextApiRequest, {} as NextApiResponse);
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    signal = undefined;
    vi.stubGlobal('fetch', hangingFetch);
    vi.stubEnv('ANTHROPIC_API_KEY', 'test-key');
    checkAi.mockResolvedValue(true);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it(`aborts the provider call after ${route.timeoutMs} ms and answers as it does for any provider failure`, async () => {
    const done = call();
    await vi.advanceTimersByTimeAsync(route.timeoutMs - 1);
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(signal!.aborted).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    expect(signal!.aborted).toBe(true);
    await done;
    route.failed();
    expect(vi.mocked(log.error)).toHaveBeenCalledTimes(1);
  });

  it(`the timer runs until the body is read: a body that never arrives is aborted at ${route.timeoutMs} ms`, async () => {
    vi.stubGlobal('fetch', hangingBodyFetch);
    const done = call();
    await vi.advanceTimersByTimeAsync(route.timeoutMs - 1);
    expect(signal!.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(signal!.aborted).toBe(true);
    await done;
    route.failed();
  });

  it('leaves no timer running once the provider has answered', async () => {
    hangingFetch.mockImplementationOnce(async () => ({ ok: true, json: async () => ({ content: [{ text: '{}' }] }) }) as never);
    await call();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('leaves no timer running when the provider cannot be reached', async () => {
    hangingFetch.mockRejectedValueOnce(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } }));
    await call();
    expect(vi.getTimerCount()).toBe(0);
  });
});
