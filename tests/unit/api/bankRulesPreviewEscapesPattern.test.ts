/**
 * K-141 (review M-4) — the rule preview must count what the rule will act on.
 *
 * `/api/accounting/bank-rules-preview` assembled its ILIKE from the raw
 * `pattern` query param with no escaping. Once `applyRules` escaped `_` and `%`,
 * the preview disagreed with it in the one direction that matters: the user
 * creating a `SALARY_JAN` rule was shown the OVER-matched count and then got a
 * smaller set — and the preview exists precisely to answer "how many
 * transactions will this rule affect".
 *
 * All DB calls are mocked; what is asserted is the pattern the handler binds.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

const sqlMock = vi.fn(async () => [{ cnt: 3 }]);

vi.mock('@/lib/neon', () => ({ sql: (...a: unknown[]) => sqlMock(...(a as [])) }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('@/lib/auth', () => ({
  withAuth: (h: unknown) => h,
  withWriteAccess: (h: unknown) => h,
}));
vi.mock('@/lib/auth/withCsrf', () => ({ withCsrf: (h: unknown) => h }));
vi.mock('@/lib/api-error-handler', () => ({ withErrorHandler: (h: unknown) => h }));

import previewHandler from '../../../pages/api/accounting/bank-rules-preview';
import { toSqlPattern } from '@/modules/accounting/services/bank/bankRulesMatchingHelpers';

const COMPANY = 'aaaaaaaa-0000-0000-0000-000000000001';

function mockReqRes(query: Record<string, string>) {
  const req = { method: 'GET', query, companyId: COMPANY } as unknown as NextApiRequest;
  const res = {
    statusCode: 0,
    sent: undefined as unknown,
    setHeader() { return this; },
    status(code: number) { this.statusCode = code; return this; },
    json(payload: unknown) { this.sent = payload; return this; },
    send(payload: unknown) { this.sent = payload; return this; },
    end(payload?: unknown) { this.sent = payload; return this; },
  };
  return { req, res: res as unknown as NextApiResponse & typeof res };
}

const call = previewHandler as unknown as (q: NextApiRequest, r: NextApiResponse) => Promise<void>;

/** The values bound into the tagged template of the single query the handler ran. */
function boundValues(): unknown[] {
  expect(sqlMock).toHaveBeenCalledOnce();
  return sqlMock.mock.calls[0]!.slice(1);
}

beforeEach(() => vi.clearAllMocks());

describe('GET /api/accounting/bank-rules-preview', () => {
  it('binds the same escaped pattern applyRules will use for _', async () => {
    const { req, res } = mockReqRes({ pattern: 'SALARY_JAN', matchType: 'contains' });
    await call(req, res);
    expect(boundValues()).toContain(toSqlPattern('contains', 'SALARY_JAN'));
    expect(boundValues()).toContain('%SALARY\\_JAN%');
  });

  it('binds an escaped pattern for %', async () => {
    const { req, res } = mockReqRes({ pattern: '50% OFF', matchType: 'contains' });
    await call(req, res);
    expect(boundValues()).toContain('%50\\% OFF%');
  });

  it('keeps exact exact', async () => {
    const { req, res } = mockReqRes({ pattern: 'SALARY_JAN', matchType: 'exact' });
    await call(req, res);
    expect(boundValues()).toContain('SALARY\\_JAN');
  });

  // Adjacent case: a pattern with no metacharacter must be bound unchanged, so
  // the escaping cannot quietly narrow the ordinary preview.
  it('leaves a plain pattern untouched', async () => {
    const { req, res } = mockReqRes({ pattern: 'SALARY', matchType: 'starts_with' });
    await call(req, res);
    expect(boundValues()).toContain('SALARY%');
  });

  // Adjacent case: the company scope is not lost to the rewrite.
  it('still scopes the count to the caller company', async () => {
    const { req, res } = mockReqRes({ pattern: 'SALARY' });
    await call(req, res);
    expect(boundValues()).toContain(COMPANY);
  });
});
