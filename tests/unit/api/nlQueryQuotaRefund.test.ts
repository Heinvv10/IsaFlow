/**
 * R-175: nl-query calls its provider itself, so it records the use itself.
 * It marks the daily AI unit used when, and only when, the provider answered.
 * Every other exit leaves the unit unused and withAuth gives it back.
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

const { sqlMock, withTransactionMock, checkAi } = vi.hoisted(() => ({
  sqlMock: vi.fn(), withTransactionMock: vi.fn(), checkAi: vi.fn(),
}));
vi.mock('@/lib/neon', () => ({ sql: sqlMock, withTransaction: withTransactionMock }));
vi.mock('@/lib/rateLimit', () => ({ checkAiRateLimit: checkAi }));
vi.mock('@/lib/apiResponse', () => ({
  apiResponse: { success: vi.fn(), badRequest: vi.fn(), tooManyRequests: vi.fn(), methodNotAllowed: vi.fn() },
}));

import { apiResponse } from '@/lib/apiResponse';
import { als, type RequestContext } from '@/lib/als';
import nlQuery from '../../../pages/api/accounting/nl-query';

const COMPANY = '11111111-1111-4111-9111-111111111111';
const fetchMock = vi.fn();
/** Runs the route as a request that charged one daily AI unit (quotaUse is real); returns how much was used. */
async function call(question: unknown): Promise<number> {
  const ctx: RequestContext = {
    client: {} as RequestContext['client'], userId: 'u', claims: {},
    quotaCharges: [{ kind: 'ai', key: `ai:nl-query:co:${COMPANY}:day`, charged: 1, used: 0, windowStart: null }],
  };
  await als.run(ctx, async () => {
    await (nlQuery as unknown as H)(
      { method: 'POST', body: { question }, companyId: COMPANY } as unknown as NextApiRequest,
      {} as NextApiResponse,
    );
  });
  return ctx.quotaCharges![0]!.used;
}
const answer = (text: string) => ({ ok: true, json: async () => ({ content: [{ text }] }) });
const SCOPED_SQL = `SELECT id FROM customers WHERE company_id = '${COMPANY}' LIMIT 5`;

describe('nl-query — the daily AI unit is marked used only when the provider answers (R-175)', () => {
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

  it('asks for refundUnused, and does nothing more when the limiter refuses', async () => {
    checkAi.mockResolvedValue(false);
    expect(await call('How many customers do we have?')).toBe(0);

    expect(apiResponse.tooManyRequests).toHaveBeenCalledTimes(1);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(checkAi.mock.calls[0]![3]).toMatchObject({ dailyMax: 300, refundUnused: true });
  });

  it.each([
    ['a question that is too short', 'hi'],
    ['a question that is not a string', 42],
    ['a question that is too long', 'x'.repeat(501)],
  ])('leaves the unit unused for %s', async (_label, question) => {
    expect(await call(question)).toBe(0);

    expect(apiResponse.badRequest).toHaveBeenCalledTimes(1);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('leaves the unit unused when no provider key is configured', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', '');

    expect(await call('How many customers do we have?')).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([[400, 0], [429, 0], [529, 0], [408, 1], [500, 1], [503, 1]])('after an Anthropic %i answer, uses %i unit (a 4xx or 529 refused it; a 5xx may follow the work)', async (status, units) => {
    fetchMock.mockResolvedValue({ ok: false, status });

    expect(await call('How many customers do we have?')).toBe(units);
  });

  it('leaves the unit unused when the provider cannot be reached', async () => {
    fetchMock.mockRejectedValue(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } }));

    expect(await call('How many customers do we have?')).toBe(0);
  });

  it('uses the unit when the provider call times out or is aborted: the work may have been done', async () => {
    fetchMock.mockRejectedValue(Object.assign(new Error('This operation was aborted'), { name: 'AbortError' }));

    expect(await call('How many customers do we have?')).toBe(1);
  });

  it('marks the unit used when the provider answered, even if its answer could not be used', async () => {
    fetchMock.mockResolvedValue(answer('I cannot help with that.'));

    expect(await call('How many customers do we have?')).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('marks the unit used when the provider answered and the generated query then fails', async () => {
    fetchMock.mockResolvedValue(answer('```sql\n' + SCOPED_SQL + '\n```\nCounts customers.'));
    withTransactionMock.mockRejectedValue(Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNREFUSED' } }));

    // The later failure even looks like "never sent"; the answer already counted.
    expect(await call('How many customers do we have?')).toBe(1);
  });

  it('marks the unit used once on success', async () => {
    fetchMock.mockResolvedValue(answer('```sql\n' + SCOPED_SQL + '\n```\nCounts customers.'));

    expect(await call('How many customers do we have?')).toBe(1);
    expect(apiResponse.success).toHaveBeenCalledTimes(1);
  });
});
