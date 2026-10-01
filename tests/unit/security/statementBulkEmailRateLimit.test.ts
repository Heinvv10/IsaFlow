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
const { sqlMock, checkSendRateLimitMock, checkRateLimitMock } = vi.hoisted(() => ({
  sqlMock: vi.fn(), checkSendRateLimitMock: vi.fn(), checkRateLimitMock: vi.fn(),
}));
vi.mock('@/lib/neon', () => ({ sql: sqlMock }));

vi.mock('@/lib/rateLimit', () => ({
  checkSendRateLimit: checkSendRateLimitMock,
  checkRateLimit: checkRateLimitMock,
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
const id = (n: number) => `22222222-2222-4222-9222-${String(n).padStart(12, '0')}`;
const [C1, C2, C3] = [id(1), id(2), id(3)];
function makeRes(): NextApiResponse {
  const res = { status: vi.fn(), json: vi.fn() } as unknown as NextApiResponse;
  (res.status as ReturnType<typeof vi.fn>).mockReturnValue(res);
  return res;
}

describe('statement-bulk-email — checkSendRateLimit gate', () => {
  let owned: string[] | null = null;
  beforeEach(() => {
    vi.clearAllMocks();
    checkRateLimitMock.mockResolvedValue(true);
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
        customerIds: [C1, C2],
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
      refundUnused: true,
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
        customerIds: Array.from({ length: 47 }, (_, i) => id(i)),
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
      refundUnused: true,
    });
  });

  // ── R-175: the volume quota bounds emails sent; an abuse limit guards the rest ──
  it('charges no volume when the ownership guard refuses, and logs a count and a sample, not every id', async () => {
    const foreign = Array.from({ length: 40 }, (_, i) => id(100 + i));
    owned = [C1];
    checkSendRateLimitMock.mockResolvedValue(true);

    await (statementBulkEmail as Handler)(request([C1, ...foreign]), makeRes());

    expect(apiResponse.forbidden).toHaveBeenCalledTimes(1);
    expect(checkSendRateLimitMock).not.toHaveBeenCalled();
    expect(sendStatementEmail).not.toHaveBeenCalled();
    const { log } = await import('@/lib/logger');
    expect(vi.mocked(log.warn).mock.calls[0]![1]).toEqual({ companyId: COMPANY, count: 40, sample: foreign.slice(0, 3) });
  });

  it('counts every attempt against the user before the ownership query, and refuses when over', async () => {
    checkRateLimitMock.mockResolvedValue(false);

    await (statementBulkEmail as Handler)(request([C1, C2]), makeRes());

    // Keyed by company and user: a bureau user has one allowance per client.
    expect(checkRateLimitMock.mock.calls).toEqual([[`statement-bulk-email:attempts:${COMPANY}:u1`, { max: 30, windowSecs: 900 }]]);
    expect(apiResponse.tooManyRequests).toHaveBeenCalledTimes(1);
    expect(sqlMock).not.toHaveBeenCalled();
    expect(checkSendRateLimitMock).not.toHaveBeenCalled();
  });

  it('counts the attempt even for a request it then rejects as malformed', async () => {
    await (statementBulkEmail as Handler)(request([]), makeRes());

    expect(checkRateLimitMock).toHaveBeenCalledTimes(1);
    expect(apiResponse.badRequest).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['a plain word', 'not-a-uuid'],
    ['a uuid with trailing SQL', `${C1}'::text`],
    ['an empty string', ''],
  ])('answers 400, before any query, for an id that is %s', async (_label, bad) => {
    checkSendRateLimitMock.mockResolvedValue(true);

    await (statementBulkEmail as Handler)(request([C1, bad]), makeRes());

    expect(apiResponse.badRequest).toHaveBeenCalledWith(expect.anything(), 'all customerIds must be UUIDs');
    expect(sqlMock).not.toHaveBeenCalled();
    expect(checkSendRateLimitMock).not.toHaveBeenCalled();
  });

  it('sends to every recipient when all checks pass', async () => {
    checkSendRateLimitMock.mockResolvedValue(true);
    vi.mocked(sendStatementEmail).mockResolvedValue({ success: true });

    await (statementBulkEmail as Handler)(request([C1, C2, C3]), makeRes());

    expect(sendStatementEmail).toHaveBeenCalledTimes(3);
    expect(apiResponse.success).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ sent: 3, failed: 0 }));
  });
});
