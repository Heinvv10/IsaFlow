/**
 * R-188: ai-narrative and ai-forecast hold a withAuth pool connection (idle in
 * transaction) for the whole provider call. With no timeout a slow provider held
 * it for undici's default (~300 s); at a pool of 10 a few of those starve every
 * cookie-auth request. Both bound the call with an AbortController, and an abort
 * lands in the existing catch: the route answers 200 with its fallback.
 *
 * The provider is a fetch that never answers and rejects only when its signal aborts.
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
  apiResponse: { success: vi.fn(), badRequest: vi.fn(), tooManyRequests: vi.fn(), methodNotAllowed: vi.fn() },
}));

import { apiResponse } from '@/lib/apiResponse';
import { log } from '@/lib/logger';
import aiNarrative from '../../../pages/api/accounting/ai-narrative';
import aiForecast from '../../../pages/api/accounting/ai-forecast';

// max_tokens 1024 -> 30 s; max_tokens 512 -> 20 s (the bound nl-query and ai-categorize use for 512).
const ROUTES = [
  { name: 'ai-narrative', handler: aiNarrative as unknown as H, timeoutMs: 30_000, body: { reportData: { reportType: 'income_statement', companyName: 'Co', period: '2026-08', currentPeriod: { revenue: 100, expenses: 80, netProfit: 20 } } } },
  { name: 'ai-forecast', handler: aiForecast as unknown as H, timeoutMs: 20_000, body: { baseRevenue: 100_000, baseExpenses: 80_000, cashBalance: 50_000, months: 3 } },
] as const;

let signal: AbortSignal | undefined;
const hangingFetch = vi.fn((_url: string, init?: { signal?: AbortSignal }) => new Promise((_resolve, reject) => {
  signal = init?.signal;
  init?.signal?.addEventListener('abort', () => reject(Object.assign(new Error('This operation was aborted'), { name: 'AbortError' })));
}));

describe.each(ROUTES)('$name provider call is bounded (R-188)', (route) => {
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

  it(`aborts the provider call after ${route.timeoutMs} ms and answers 200 with its fallback`, async () => {
    const done = route.handler({ method: 'POST', body: route.body, companyId: 'c' } as unknown as NextApiRequest, {} as NextApiResponse);
    await vi.advanceTimersByTimeAsync(route.timeoutMs - 1);
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(signal!.aborted).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    expect(signal!.aborted).toBe(true);
    await done;

    expect(apiResponse.success).toHaveBeenCalledTimes(1);
    expect(apiResponse.success).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ aiGenerated: false }));
    expect(vi.mocked(log.error)).toHaveBeenCalledTimes(1);
  });

  it('leaves no timer running once the provider has answered', async () => {
    hangingFetch.mockImplementationOnce(async () => ({ ok: true, json: async () => ({ content: [{ text: '{}' }] }) }) as never);
    await route.handler({ method: 'POST', body: route.body, companyId: 'c' } as unknown as NextApiRequest, {} as NextApiResponse);
    expect(vi.getTimerCount()).toBe(0);
  });
});
