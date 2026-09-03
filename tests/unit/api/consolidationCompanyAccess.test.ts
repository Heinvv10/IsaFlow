/**
 * GRP-01 — cross-tenant leak on consolidation/companies POST.
 *
 * The handler's comment claimed "child must be accessible to current user" but it
 * only ran an EXISTENCE check (`SELECT id FROM companies WHERE id = $1`). Any
 * authenticated user could therefore attach ANY company as a subsidiary and then
 * read its whole GL through consolidation/trial-balance and
 * consolidation/intercompany-balances, which aggregate across company_id by design.
 *
 * These tests drive the real handler with a mocked DB and prove:
 *  - a POST whose childCompanyId is a company the caller does NOT belong to is
 *    refused 403 and never reaches createCompanyRelationship;
 *  - a POST for a company the caller DOES belong to still succeeds;
 *  - a non-existent child still 404s (the membership guard must not mask that).
 *
 * Mutation check: delete the userBelongsToCompany guard in the handler and the
 * first test goes red (relationship created, status 200).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

const sqlMock = vi.fn();
const createRelMock = vi.fn(async () => undefined);
const getGroupCompaniesMock = vi.fn(async () => [] as unknown[]);

vi.mock('@/lib/neon', () => ({ sql: (...a: unknown[]) => sqlMock(...a) }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('@/lib/auth', () => ({ withAuth: (h: unknown) => h }));
vi.mock('@/lib/auth/withCsrf', () => ({ withCsrf: (h: unknown) => h }));
vi.mock('@/lib/api-error-handler', () => ({ withErrorHandler: (h: unknown) => h }));
vi.mock('@/modules/accounting/services/reports/consolidationService', () => ({
  getGroupCompanies: (...a: unknown[]) => getGroupCompaniesMock(...(a as [])),
  createCompanyRelationship: (...a: unknown[]) => createRelMock(...(a as [])),
  getConsolidatedTrialBalance: vi.fn(),
  getIntercompanyBalances: vi.fn(),
}));

import handler from '../../../pages/api/accounting/consolidation/companies';

const PARENT = 'company-parent';
const CHILD_MINE = 'company-child-mine';
const CHILD_FOREIGN = 'company-foreign';
const CHILD_MISSING = 'company-missing';

function mockReqRes(body: Record<string, unknown>) {
  const req = {
    method: 'POST',
    query: {},
    body,
    companyId: PARENT,
    user: { id: 'user-1' },
  } as unknown as NextApiRequest;
  const res = {
    statusCode: 0,
    sent: undefined as unknown,
    setHeader() { return this; },
    status(code: number) { this.statusCode = code; return this; },
    json(payload: unknown) { this.sent = payload; return this; },
    end() { return this; },
  };
  return { req, res: res as unknown as NextApiResponse & typeof res };
}

/** Route mocked sql calls by query text: company existence vs user membership. */
function installSql(opts: { existingCompanies: string[]; myCompanies: string[] }) {
  sqlMock.mockImplementation(async (strings: readonly string[], ...values: unknown[]) => {
    const q = strings.join('?').replace(/\s+/g, ' ');
    if (q.includes('FROM company_users')) {
      const companyId = values[0] as string; // company_id, user_id
      return opts.myCompanies.includes(companyId) ? [{ ok: 1 }] : [];
    }
    if (q.includes('FROM companies')) {
      const companyId = values[0] as string;
      return opts.existingCompanies.includes(companyId) ? [{ id: companyId }] : [];
    }
    return [];
  });
}

beforeEach(() => vi.clearAllMocks());

describe('consolidation/companies POST — child company access guard', () => {
  it('refuses 403 when the caller does not belong to the child company', async () => {
    installSql({
      existingCompanies: [PARENT, CHILD_MINE, CHILD_FOREIGN],
      myCompanies: [PARENT, CHILD_MINE],
    });
    const { req, res } = mockReqRes({ childCompanyId: CHILD_FOREIGN });

    await (handler as (rq: NextApiRequest, rs: NextApiResponse) => Promise<unknown>)(req, res);

    expect(res.statusCode).toBe(403);
    expect(createRelMock).not.toHaveBeenCalled();
  });

  it('allows the relationship when the caller belongs to the child company', async () => {
    installSql({
      existingCompanies: [PARENT, CHILD_MINE],
      myCompanies: [PARENT, CHILD_MINE],
    });
    const { req, res } = mockReqRes({ childCompanyId: CHILD_MINE, ownershipPercent: 75 });

    await (handler as (rq: NextApiRequest, rs: NextApiResponse) => Promise<unknown>)(req, res);

    expect(res.statusCode).toBe(200);
    expect(createRelMock).toHaveBeenCalledTimes(1);
  });

  it('still 404s a child company that does not exist', async () => {
    installSql({ existingCompanies: [PARENT], myCompanies: [PARENT] });
    const { req, res } = mockReqRes({ childCompanyId: CHILD_MISSING });

    await (handler as (rq: NextApiRequest, rs: NextApiResponse) => Promise<unknown>)(req, res);

    expect(res.statusCode).toBe(404);
    expect(createRelMock).not.toHaveBeenCalled();
  });
});
