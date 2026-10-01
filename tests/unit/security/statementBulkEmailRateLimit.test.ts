/**
 * Pentest HIGH — statement-bulk-email had no send-rate-limit.
 *
 * Every sibling send endpoint (customer-statements-send, invoice-email,
 * ar/dunning/send, afs/[documentId]/send-for-signing) gates on
 * checkSendRateLimit, but statement-bulk-email only capped customerIds.length
 * at 100 with no per-IP/per-company throttle — an authenticated/CSRF-riding
 * session could loop the endpoint into an email bomb, each call fanning out
 * up to 100 emails. This test asserts the endpoint returns 429 and does NOT
 * send when the limiter is over, and would fail (mutation-catch) if the
 * checkSendRateLimit guard were removed or made a no-op.
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
// The handler's first query is the ownership guard, its second the company
// name. `owned` is what the guard finds; null means "every id named".
const { sqlMock, checkSendRateLimitMock, refundSendMock } = vi.hoisted(() => ({
  sqlMock: vi.fn(), checkSendRateLimitMock: vi.fn(), refundSendMock: vi.fn(),
}));
vi.mock('@/lib/neon', () => ({ sql: sqlMock }));
vi.mock('@/lib/rateLimitQuota', () => ({ refundSendDailyQuota: refundSendMock }));

vi.mock('@/lib/rateLimit', () => ({
  checkSendRateLimit: checkSendRateLimitMock,
  checkRateLimit: vi.fn().mockResolvedValue(true),
  getClientIp: vi.fn().mockReturnValue('1.2.3.4'),
}));

vi.mock('@/modules/accounting/services/ar/statementEmailService', () => ({
  sendStatementEmail: vi.fn().mockResolvedValue({ success: true }),
}));

vi.mock('@/lib/apiResponse', () => ({
  apiResponse: {
    success: vi.fn(), badRequest: vi.fn(), tooManyRequests: vi.fn(),
    methodNotAllowed: vi.fn(), forbidden: vi.fn(), notFound: vi.fn(), internalError: vi.fn(),
  },
}));

import { apiResponse } from '@/lib/apiResponse';
import { sendStatementEmail } from '@/modules/accounting/services/ar/statementEmailService';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore
import statementBulkEmail from '../../../pages/api/accounting/statement-bulk-email';

type Handler = (req: NextApiRequest, res: NextApiResponse) => Promise<void>;

const COMPANY = '11111111-1111-4111-9111-111111111111';
function makeRes(): NextApiResponse {
  const res = { status: vi.fn(), json: vi.fn() } as unknown as NextApiResponse;
  (res.status as ReturnType<typeof vi.fn>).mockReturnValue(res);
  return res;
}

describe('statement-bulk-email — checkSendRateLimit gate', () => {
  let owned: string[] | null = null;
  beforeEach(() => {
    vi.clearAllMocks();
    owned = null;
    sqlMock.mockImplementation(async (strings: TemplateStringsArray, ids: string[]) =>
      (strings.join('').includes('FROM customers') ? (owned ?? ids).map((id) => ({ id })) : [{ name: 'Co' }]));
  });
  const request = (customerIds: string[]) => ({
    method: 'POST', query: {}, body: { customerIds, asAtDate: '2026-08-14' }, companyId: COMPANY, user: { id: 'u1' },
  }) as unknown as NextApiRequest;

  it('returns 429 and does not send when over the limit', async () => {
    checkSendRateLimitMock.mockResolvedValue(false);
    const req = {
      method: 'POST',
      query: {},
      body: {
        customerIds: ['c1', 'c2'],
        asAtDate: '2026-08-14',
      },
      companyId: COMPANY,
      user: { id: 'u1' },
    } as unknown as NextApiRequest;

    await (statementBulkEmail as Handler)(req, makeRes());

    expect(checkSendRateLimitMock).toHaveBeenCalledWith(req, COMPANY, 'statement-bulk-email', {
      ipMax: 30,
      companyMax: 2_000,
      dailyMax: 10_000,
      count: 2,
    });
    expect(apiResponse.tooManyRequests).toHaveBeenCalledTimes(1);
    expect(sendStatementEmail).not.toHaveBeenCalled();
  });

  it('weights the limiter cost by customerIds.length (cost-weighting fix)', async () => {
    checkSendRateLimitMock.mockResolvedValue(false);
    const req = {
      method: 'POST',
      query: {},
      body: {
        customerIds: Array.from({ length: 47 }, (_, i) => `c${i}`),
        asAtDate: '2026-08-14',
      },
      companyId: COMPANY,
      user: { id: 'u1' },
    } as unknown as NextApiRequest;

    await (statementBulkEmail as Handler)(req, makeRes());

    expect(checkSendRateLimitMock).toHaveBeenCalledWith(req, COMPANY, 'statement-bulk-email', {
      ipMax: 30,
      companyMax: 2_000,
      dailyMax: 10_000,
      count: 47,
    });
  });

  // ── R-175: the quota bounds emails sent ─────────────────────────────────────
  it('charges nothing when the ownership guard refuses the request', async () => {
    owned = ['c1'];
    checkSendRateLimitMock.mockResolvedValue(true);

    await (statementBulkEmail as Handler)(request(['c1', 'not-ours']), makeRes());

    expect(apiResponse.forbidden).toHaveBeenCalledTimes(1);
    expect(checkSendRateLimitMock).not.toHaveBeenCalled();
    expect(sendStatementEmail).not.toHaveBeenCalled();
    expect(refundSendMock).not.toHaveBeenCalled();
  });

  it('gives back the daily units of the emails that failed, and only those', async () => {
    checkSendRateLimitMock.mockResolvedValue(true);
    vi.mocked(sendStatementEmail)
      .mockResolvedValueOnce({ success: true })
      .mockResolvedValueOnce({ success: false, error: 'SMTP down' })
      .mockResolvedValueOnce({ success: false, error: 'SMTP down' });

    await (statementBulkEmail as Handler)(request(['c1', 'c2', 'c3']), makeRes());

    expect(refundSendMock.mock.calls).toEqual([[COMPANY, 'statement-bulk-email', 2]]);
    expect(apiResponse.success).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ sent: 1, failed: 2 }));
  });

  it('gives nothing back when every email was sent', async () => {
    checkSendRateLimitMock.mockResolvedValue(true);
    vi.mocked(sendStatementEmail).mockResolvedValue({ success: true });

    await (statementBulkEmail as Handler)(request(['c1', 'c2']), makeRes());

    expect(sendStatementEmail).toHaveBeenCalledTimes(2);
    expect(refundSendMock).not.toHaveBeenCalled();
  });
});
