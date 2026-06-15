/**
 * Pentest re-run H8 — portal chat had no per-company daily cap.
 *
 * /api/portal/chat (customer-facing, calls Claude) was IP-only rate-limited, so a tenant's
 * many portal customers (each a distinct IP/session) could collectively exhaust the AI budget.
 * A per-company daily counter was added. This test asserts that when the daily counter is over
 * (IP counter still under), the request is rejected with 429 before any AI work.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

vi.mock('@/lib/api-error-handler', () => ({
  withErrorHandler: (h: (req: NextApiRequest, res: NextApiResponse) => unknown) => h,
}));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('@/lib/neon', () => ({ sql: vi.fn() }));
vi.mock('@/modules/accounting/services/ar/portalChatbotService', () => ({
  classifyClientQuery: vi.fn(), buildClientChatPrompt: vi.fn(),
  parseClientChatResponse: vi.fn(), sanitizeClientResponse: vi.fn(),
}));
vi.mock('@/lib/auth/arPortalJwt', () => ({
  verifyArPortalToken: vi.fn().mockResolvedValue({
    clientId: 'client-1', companyId: '11111111-1111-4111-9111-111111111111',
  }),
}));

const { checkRateLimitMock } = vi.hoisted(() => ({ checkRateLimitMock: vi.fn() }));
vi.mock('@/lib/rateLimit', () => ({
  checkRateLimit: checkRateLimitMock,
  getClientIp: vi.fn().mockReturnValue('1.2.3.4'),
}));

vi.mock('@/lib/apiResponse', () => ({
  apiResponse: { success: vi.fn(), badRequest: vi.fn(), tooManyRequests: vi.fn(), methodNotAllowed: vi.fn() },
}));

// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore
import handler from '../../../pages/api/portal/chat';

type Handler = (req: NextApiRequest, res: NextApiResponse) => Promise<void>;

function makeRes(): { res: NextApiResponse; status: ReturnType<typeof vi.fn>; json: ReturnType<typeof vi.fn> } {
  const json = vi.fn();
  const status = vi.fn().mockReturnValue({ json });
  const res = { status, json } as unknown as NextApiResponse;
  return { res, status, json };
}
function makeReq(): NextApiRequest {
  return {
    method: 'POST',
    headers: { cookie: 'portal_session=tok' },
    body: { question: 'hi', clientId: 'client-1' },
  } as unknown as NextApiRequest;
}

describe('portal chat H8 — per-company daily cap', () => {
  beforeEach(() => vi.clearAllMocks());

  it('rejects with 429 when the per-company daily counter is over (IP counter still under)', async () => {
    // Route by key: the per-IP window passes, the per-company :day counter is exhausted.
    checkRateLimitMock.mockImplementation((key: string) =>
      Promise.resolve(!key.includes(':day')),
    );
    const { res, status } = makeRes();
    await (handler as Handler)(makeReq(), res);

    // Two limiter calls: per-IP (passed) then per-company-daily (failed) → 429 before any AI work.
    expect(checkRateLimitMock).toHaveBeenCalledTimes(2);
    expect(checkRateLimitMock.mock.calls[1][0]).toContain(':day');
    expect(status).toHaveBeenCalledWith(429);
  });
});
