/**
 * R-175: ai-narrative and ai-forecast call their provider themselves, and both
 * answer 200 with a fallback when it is down. They must mark the daily AI unit
 * used only when the provider answered, so that the fallback costs nothing.
 *
 * The limiter is mocked to admit; the charge is placed on the request context
 * the way checkAiRateLimit({ refundUnused: true }) places it. `quotaUse` is real.
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

import { als, type RequestContext } from '@/lib/als';
import { apiResponse } from '@/lib/apiResponse';
import aiNarrative from '../../../pages/api/accounting/ai-narrative';
import aiForecast from '../../../pages/api/accounting/ai-forecast';

const fetchMock = vi.fn();
const ROUTES = [
  { name: 'ai-narrative', handler: aiNarrative as unknown as H, body: { reportData: { reportType: 'income_statement', companyName: 'Co', period: '2026-08', currentPeriod: { revenue: 100, expenses: 80, netProfit: 20 } } } },
  { name: 'ai-forecast', handler: aiForecast as unknown as H, body: { baseRevenue: 100_000, baseExpenses: 80_000, cashBalance: 50_000, months: 3 } },
] as const;

/** Runs the route as a request that charged one daily AI unit; returns how much of it was used. */
async function unitsUsed(route: (typeof ROUTES)[number]): Promise<number> {
  const ctx: RequestContext = {
    client: {} as RequestContext['client'], userId: 'u', claims: {},
    quotaCharges: [{ kind: 'ai', key: `ai:${route.name}:co:c:day`, charged: 1, used: 0 }],
  };
  await als.run(ctx, async () => {
    await route.handler({ method: 'POST', body: route.body, companyId: 'c' } as unknown as NextApiRequest, {} as NextApiResponse);
  });
  return ctx.quotaCharges![0]!.used;
}

describe.each(ROUTES)('$name — the daily AI unit is used only when the provider answers (R-175)', (route) => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', fetchMock);
    vi.stubEnv('ANTHROPIC_API_KEY', 'test-key');
    checkAi.mockResolvedValue(true);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('asks the limiter for refundUnused', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 529 });
    await unitsUsed(route);

    expect(checkAi.mock.calls[0]![2]).toBe(route.name);
    expect(checkAi.mock.calls[0]![3]).toMatchObject({ refundUnused: true });
  });

  it.each([[400, 0], [401, 0], [429, 0], [529, 0], [408, 1], [500, 1], [502, 1], [503, 1]])('answers 200 with its fallback after a provider %i, and uses %i unit', async (status, units) => {
    fetchMock.mockResolvedValue({ ok: false, status });

    // A 4xx refused the request, and so did Anthropic's own 529 (overloaded); a 5xx may follow
    // the provider's work, a 408 is a timeout.
    expect(await unitsUsed(route)).toBe(units);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(apiResponse.success).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ aiGenerated: false }));
  });

  it('answers 200 with its fallback and uses nothing when the provider cannot be reached', async () => {
    fetchMock.mockRejectedValue(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } }));

    expect(await unitsUsed(route)).toBe(0);
    expect(apiResponse.success).toHaveBeenCalledTimes(1);
  });

  it('answers 200 with its fallback but uses the unit when the provider call times out', async () => {
    fetchMock.mockRejectedValue(Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' }));

    expect(await unitsUsed(route)).toBe(1);
    expect(apiResponse.success).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ aiGenerated: false }));
  });

  it('uses nothing when no provider key is configured', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', '');

    expect(await unitsUsed(route)).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('uses the unit when the provider answers', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ content: [{ text: '{"summary":"ok"}' }] }) });

    expect(await unitsUsed(route)).toBe(1);
  });
});
