/**
 * R-175 review round 1: nl-query gives its daily AI unit back on every exit
 * where the provider gave no answer, and keeps it once the provider answered.
 *
 * The daily bucket is 300 per company. Before this, a provider outage plus
 * retries used the whole day's allowance with nothing to show for it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

type H = (req: NextApiRequest, res: NextApiResponse) => unknown;
vi.mock('@/lib/auth', () => ({ withAuth: (h: H) => h, withWriteAccess: (h: H) => h }));
vi.mock('@/lib/auth/withCsrf', () => ({ withCsrf: (h: H) => h }));
vi.mock('@/lib/api-error-handler', () => ({ withErrorHandler: (h: H) => h }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

const { sqlMock, withTransactionMock, checkAi, refundAi } = vi.hoisted(() => ({
  sqlMock: vi.fn(), withTransactionMock: vi.fn(), checkAi: vi.fn(), refundAi: vi.fn(),
}));
vi.mock('@/lib/neon', () => ({ sql: sqlMock, withTransaction: withTransactionMock }));
vi.mock('@/lib/rateLimit', () => ({ checkAiRateLimit: checkAi }));
vi.mock('@/lib/rateLimitQuota', () => ({ refundAiDailyQuota: refundAi }));
vi.mock('@/lib/apiResponse', () => ({
  apiResponse: { success: vi.fn(), badRequest: vi.fn(), tooManyRequests: vi.fn(), methodNotAllowed: vi.fn() },
}));

import { apiResponse } from '@/lib/apiResponse';
import nlQuery from '../../../pages/api/accounting/nl-query';

const COMPANY = '11111111-1111-4111-9111-111111111111';
const fetchMock = vi.fn();
const call = (question: unknown) => (nlQuery as unknown as H)(
  { method: 'POST', body: { question }, companyId: COMPANY } as unknown as NextApiRequest,
  {} as NextApiResponse,
);
const answer = (text: string) => ({ ok: true, json: async () => ({ content: [{ text }] }) });
const SCOPED_SQL = `SELECT id FROM customers WHERE company_id = '${COMPANY}' LIMIT 5`;

describe('nl-query — daily AI quota is spent only when the provider answers (R-175)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', fetchMock);
    vi.stubEnv('ANTHROPIC_API_KEY', 'test-key');
    checkAi.mockResolvedValue(true);
    sqlMock.mockReturnValue(Object.assign(Promise.resolve([{ statement_timeout: '0' }]), {}));
    withTransactionMock.mockResolvedValue([{ id: 'c1' }]);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('refunds nothing, and asks nothing, when the limiter refuses', async () => {
    checkAi.mockResolvedValue(false);
    await call('How many customers do we have?');

    expect(apiResponse.tooManyRequests).toHaveBeenCalledTimes(1);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(refundAi).not.toHaveBeenCalled();
  });

  it.each([
    ['a question that is too short', 'hi'],
    ['a question that is not a string', 42],
    ['a question that is too long', 'x'.repeat(501)],
  ])('gives the unit back for %s', async (_label, question) => {
    await call(question);

    expect(apiResponse.badRequest).toHaveBeenCalledTimes(1);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(refundAi.mock.calls).toEqual([[COMPANY, 'nl-query']]);
  });

  it('gives the unit back when no provider key is configured', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', '');
    await call('How many customers do we have?');

    expect(fetchMock).not.toHaveBeenCalled();
    expect(refundAi.mock.calls).toEqual([[COMPANY, 'nl-query']]);
  });

  it('gives the unit back when the provider answers with an error status', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 529 });
    await call('How many customers do we have?');

    expect(refundAi.mock.calls).toEqual([[COMPANY, 'nl-query']]);
  });

  it('gives the unit back when the provider call throws', async () => {
    fetchMock.mockRejectedValue(new Error('network down'));
    await call('How many customers do we have?');

    expect(refundAi.mock.calls).toEqual([[COMPANY, 'nl-query']]);
  });

  it('keeps the unit when the provider answered, even if its answer could not be used', async () => {
    fetchMock.mockResolvedValue(answer('I cannot help with that.'));
    await call('How many customers do we have?');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(refundAi).not.toHaveBeenCalled();
  });

  it('keeps the unit when the provider answered and the generated query then fails', async () => {
    fetchMock.mockResolvedValue(answer('```sql\n' + SCOPED_SQL + '\n```\nCounts customers.'));
    withTransactionMock.mockRejectedValue(new Error('statement timeout'));
    await call('How many customers do we have?');

    expect(refundAi).not.toHaveBeenCalled();
  });

  it('keeps the unit on success', async () => {
    fetchMock.mockResolvedValue(answer('```sql\n' + SCOPED_SQL + '\n```\nCounts customers.'));
    await call('How many customers do we have?');

    expect(refundAi).not.toHaveBeenCalled();
    expect(apiResponse.success).toHaveBeenCalledTimes(1);
  });
});
