/**
 * R-175 review round 2: customer-statements-send had two of the shapes found
 * in statement-bulk-email. A non-UUID id reached the `::UUID[]` cast and
 * answered 500, and a refused request logged every id it named at warn.
 * (Its limiter already runs before the ownership query.)
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

type H = (req: NextApiRequest, res: NextApiResponse) => unknown;
vi.mock('@/lib/auth', () => ({ withAuth: (h: H) => h, withWriteAccess: (h: H) => h }));
vi.mock('@/lib/auth/withCsrf', () => ({ withCsrf: (h: H) => h }));
vi.mock('@/lib/api-error-handler', () => ({ withErrorHandler: (h: H) => h }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
const { sqlMock, checkSend, checkAttempts } = vi.hoisted(() => ({ sqlMock: vi.fn(), checkSend: vi.fn(), checkAttempts: vi.fn() }));
vi.mock('@/lib/neon', () => ({ sql: sqlMock }));
vi.mock('@/lib/rateLimit', () => ({ checkSendRateLimit: checkSend, checkRateLimit: checkAttempts }));
vi.mock('@/modules/accounting/services/ar/statementEmailService', () => ({
  sendStatementEmail: vi.fn().mockResolvedValue({ success: true }),
}));
vi.mock('@/lib/apiResponse', () => ({
  apiResponse: {
    success: vi.fn(), badRequest: vi.fn(), tooManyRequests: vi.fn(), methodNotAllowed: vi.fn(), forbidden: vi.fn(),
  },
}));

import { apiResponse } from '@/lib/apiResponse';
import { log } from '@/lib/logger';
import { sendStatementEmail } from '@/modules/accounting/services/ar/statementEmailService';
import handler from '../../../pages/api/accounting/customer-statements-send';

const COMPANY = '11111111-1111-4111-9111-111111111111';
const id = (n: number) => `22222222-2222-4222-9222-${String(n).padStart(12, '0')}`;
const call = (customer_ids: unknown[]) => (handler as unknown as H)(
  { method: 'POST', body: { customer_ids, as_at_date: '2026-08-14' }, companyId: COMPANY, user: { id: 'u1' } } as unknown as NextApiRequest,
  {} as NextApiResponse,
);

describe('customer-statements-send — id and logging guards (R-175)', () => {
  let owned: string[] | null = null;
  beforeEach(() => {
    vi.clearAllMocks();
    owned = null;
    checkSend.mockResolvedValue(true);
    checkAttempts.mockResolvedValue(true);
    sqlMock.mockImplementation(async (strings: TemplateStringsArray, ids: string[]) =>
      (strings.join('').includes('FROM customers') ? (owned ?? ids).map((x) => ({ id: x })) : [{ name: 'Co' }]));
  });

  it.each([
    ['a plain word', 'not-a-uuid'],
    ['a uuid with trailing SQL', `${id(1)}'::text`],
    ['an empty string', ''],
  ])('answers 400, before any query, for an id that is %s', async (_label, bad) => {
    await call([id(1), bad]);

    expect(apiResponse.badRequest).toHaveBeenCalledWith(expect.anything(), 'all customer_ids must be UUIDs');
    expect(sqlMock).not.toHaveBeenCalled();
    expect(sendStatementEmail).not.toHaveBeenCalled();
    // Review round 3: a malformed request counts against its user, never
    // against the company bucket every colleague shares.
    expect(checkAttempts.mock.calls).toEqual([['customer-statements:attempts:u1', { max: 30, windowSecs: 900 }]]);
    expect(checkSend).not.toHaveBeenCalled();
  });

  it('an empty body costs the company bucket nothing', async () => {
    await call([]);

    expect(apiResponse.badRequest).toHaveBeenCalledTimes(1);
    expect(checkAttempts).toHaveBeenCalledTimes(1);
    expect(checkSend).not.toHaveBeenCalled();
  });

  it('refuses a user over the abuse limit before anything else', async () => {
    checkAttempts.mockResolvedValue(false);
    await call([id(1)]);

    expect(apiResponse.tooManyRequests).toHaveBeenCalledTimes(1);
    expect(checkSend).not.toHaveBeenCalled();
    expect(sqlMock).not.toHaveBeenCalled();
  });

  it('logs a count and a sample of the ids it refuses, not every id', async () => {
    const foreign = Array.from({ length: 40 }, (_, i) => id(100 + i));
    owned = [id(1)];

    await call([id(1), ...foreign]);

    expect(apiResponse.forbidden).toHaveBeenCalledTimes(1);
    expect(vi.mocked(log.warn).mock.calls[0]![1]).toEqual({ companyId: COMPANY, count: 40, sample: foreign.slice(0, 3) });
    expect(sendStatementEmail).not.toHaveBeenCalled();
  });

  it('is limited before the ownership query, asks for refundUnused, and sends when all checks pass', async () => {
    await call([id(1), id(2)]);

    expect(checkSend.mock.calls[0]!.slice(1)).toEqual([COMPANY, 'customer-statements', { refundUnused: true }]);
    expect(checkSend.mock.invocationCallOrder[0]!).toBeLessThan(sqlMock.mock.invocationCallOrder[0]!);
    expect(sendStatementEmail).toHaveBeenCalledTimes(2);
  });
});
