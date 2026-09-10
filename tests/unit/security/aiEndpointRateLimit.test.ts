/**
 * Pentest re-run H8 — Anthropic-backed endpoints need a per-company DAILY budget cap.
 *
 * ai-narrative / ai-forecast / nl-query previously used checkRateLimit (per-IP + per-company,
 * 15-min windows only) — no daily cap, so a company could sustain thousands of Anthropic
 * calls/day. They now use checkAiRateLimit (adds the 24h per-company counter). These tests
 * assert each endpoint returns 429 (and never reaches the AI call) when the limiter says over.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

vi.mock('@/lib/auth', () => ({
  withAuth: (h: (req: NextApiRequest, res: NextApiResponse) => unknown) => h,
  withWriteAccess: (h: (req: NextApiRequest, res: NextApiResponse) => unknown) => h,
}));
vi.mock('@/lib/auth/withCsrf', () => ({
  withCsrf: (h: (req: NextApiRequest, res: NextApiResponse) => unknown) => h,
}));
vi.mock('@/lib/api-error-handler', () => ({
  withErrorHandler: (h: (req: NextApiRequest, res: NextApiResponse) => unknown) => h,
}));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('@/lib/neon', () => ({ sql: vi.fn() }));

const { checkAiRateLimitMock } = vi.hoisted(() => ({ checkAiRateLimitMock: vi.fn() }));
vi.mock('@/lib/rateLimit', () => ({
  checkAiRateLimit: checkAiRateLimitMock,
  checkRateLimit: vi.fn().mockResolvedValue(true),
  checkSendRateLimit: vi.fn().mockResolvedValue(true),
  getClientIp: vi.fn().mockReturnValue('1.2.3.4'),
}));

// Auto-mock the downstream AI service modules so imports resolve; they are never reached
// because the rate-limit gate returns early.
vi.mock('@/modules/accounting/services/reports/reportNarrativeService', () => ({
  buildNarrativePrompt: vi.fn(), parseNarrativeResponse: vi.fn(),
  buildVarianceCommentary: vi.fn(), buildTrendAnalysis: vi.fn(),
}));
vi.mock('@/modules/accounting/services/reports/cashFlowAIService', () => ({
  buildForecastScenario: vi.fn(), calculateWeeklyForecast: vi.fn(),
  buildForecastNarrativePrompt: vi.fn(), parseForecastNarrative: vi.fn(),
}));
vi.mock('@/modules/accounting/services/core/nlQueryService', () => ({
  buildTextToSQLPrompt: vi.fn(), validateGeneratedSQL: vi.fn(), detectIntent: vi.fn(),
}));
vi.mock('@/modules/accounting/services/afs/noteAiService', () => ({ generateNoteNarrative: vi.fn() }));

vi.mock('@/lib/apiResponse', () => ({
  apiResponse: {
    success: vi.fn(), badRequest: vi.fn(), tooManyRequests: vi.fn(),
    methodNotAllowed: vi.fn(), notFound: vi.fn(), forbidden: vi.fn(),
  },
}));

import { apiResponse } from '@/lib/apiResponse';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore
import aiNarrative from '../../../pages/api/accounting/ai-narrative';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore
import aiForecast from '../../../pages/api/accounting/ai-forecast';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore
import nlQuery from '../../../pages/api/accounting/nl-query';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore
import afsNarrative from '../../../pages/api/accounting/afs/[documentId]/sections/[sectionId]/ai-narrative';

type Handler = (req: NextApiRequest, res: NextApiResponse) => Promise<void>;

function makeRes(): NextApiResponse {
  const res = { status: vi.fn(), json: vi.fn() } as unknown as NextApiResponse;
  (res.status as ReturnType<typeof vi.fn>).mockReturnValue(res);
  return res;
}
function req(query: Record<string, unknown> = {}): NextApiRequest {
  return {
    method: 'POST', query,
    body: { reportData: {}, question: 'x' },
    companyId: '11111111-1111-4111-9111-111111111111',
    user: { id: 'u1' },
  } as unknown as NextApiRequest;
}

const CASES: Array<[string, Handler, Record<string, unknown>]> = [
  ['ai-narrative', aiNarrative as Handler, {}],
  ['ai-forecast', aiForecast as Handler, {}],
  ['nl-query', nlQuery as Handler, {}],
  // Real UUIDs: the AFS route validates its path params before it spends anything.
  ['afs ai-narrative', afsNarrative as Handler,
    { documentId: '22222222-2222-4222-9222-222222222222', sectionId: '33333333-3333-4333-9333-333333333333' }],
];

describe('AI endpoints H8 — daily budget cap via checkAiRateLimit', () => {
  beforeEach(() => vi.clearAllMocks());

  it.each(CASES)('%s returns 429 (via checkAiRateLimit) when over the limit', async (_name, handler, query) => {
    checkAiRateLimitMock.mockResolvedValue(false);
    await handler(req(query), makeRes());
    // The AI daily-cap limiter fired exactly once and short-circuited to 429 before any AI call.
    expect(checkAiRateLimitMock).toHaveBeenCalledTimes(1);
    expect(apiResponse.tooManyRequests).toHaveBeenCalledTimes(1);
  });
});
