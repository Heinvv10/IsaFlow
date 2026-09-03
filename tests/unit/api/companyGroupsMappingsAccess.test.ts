/**
 * GRP-02 — the `action=mappings` GET branch of company-groups was the only
 * branch with no verifyGroupAccess() call. A caller who belonged to no company
 * in the group could read the group's whole COA mapping table (which exposes the
 * member companies' account codes/names) simply by omitting `company_id`.
 *
 * GRP-03 — userBelongsToGroup ignored `left_date`, so a departed member kept
 * group access forever. The sql mock below emulates the predicate: it holds a
 * member row whose left_date is set and returns it only when the query does NOT
 * filter on `left_date IS NULL`. Remove the predicate from the service and the
 * departed-member test goes red.
 *
 * Mutation check: drop the verifyGroupAccess call from the mappings branch and
 * the first test goes red (200 + getCoaMappings called).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

const sqlMock = vi.fn();
const getCoaMappingsMock = vi.fn(async () => [] as unknown[]);

vi.mock('@/lib/neon', () => ({ sql: (...a: unknown[]) => sqlMock(...a) }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('@/lib/auth', () => ({ withAuth: (h: unknown) => h }));
vi.mock('@/lib/auth/withCsrf', () => ({ withCsrf: (h: unknown) => h }));
vi.mock('@/lib/api-error-handler', () => ({ withErrorHandler: (h: unknown) => h }));
vi.mock('@/modules/accounting/services/reports/groupCompanyService', () => ({
  getGroup: vi.fn(), createGroup: vi.fn(), updateGroup: vi.fn(), deleteGroup: vi.fn(),
  addMember: vi.fn(), updateMember: vi.fn(), removeMember: vi.fn(), getGroupMembers: vi.fn(),
  getGroupAccounts: vi.fn(), createGroupAccount: vi.fn(), updateGroupAccount: vi.fn(),
  deleteGroupAccount: vi.fn(), autoGenerateGroupCOA: vi.fn(),
  getCoaMappings: (...a: unknown[]) => getCoaMappingsMock(...(a as [])),
  setCoaMapping: vi.fn(), removeCoaMapping: vi.fn(), autoMapAccounts: vi.fn(),
  getUnmappedAccounts: vi.fn(),
}));

import handler from '../../../pages/api/accounting/company-groups';

const GROUP = 'group-1';
const MY_COMPANY = 'company-mine';

function mockReqRes(query: Record<string, unknown>) {
  const req = {
    method: 'GET',
    query,
    body: {},
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

/**
 * Emulates the two guard queries.
 *
 * `memberLeft` models a company_group_members row for the caller whose
 * left_date is NOT NULL: Postgres would drop it under a `left_date IS NULL`
 * predicate, so the mock returns it only when that predicate is absent.
 */
function installSql(opts: { groupMember: boolean; memberLeft?: boolean; myCompanies?: string[] }) {
  sqlMock.mockImplementation(async (strings: readonly string[], ...values: unknown[]) => {
    const q = strings.join('?').replace(/\s+/g, ' ');
    if (q.includes('FROM company_group_members')) {
      if (!opts.groupMember) return [];
      if (opts.memberLeft && q.includes('left_date IS NULL')) return [];
      return [{ ok: 1 }];
    }
    if (q.includes('FROM company_users')) {
      const companyId = values[0] as string;
      return (opts.myCompanies ?? []).includes(companyId) ? [{ ok: 1 }] : [];
    }
    return [];
  });
}

beforeEach(() => vi.clearAllMocks());

describe('company-groups GET action=mappings — group access guard (GRP-02)', () => {
  it('refuses 403 when the caller belongs to no company in the group', async () => {
    installSql({ groupMember: false });
    const { req, res } = mockReqRes({ action: 'mappings', group_id: GROUP });

    await (handler as (rq: NextApiRequest, rs: NextApiResponse) => Promise<unknown>)(req, res);

    expect(res.statusCode).toBe(403);
    expect(getCoaMappingsMock).not.toHaveBeenCalled();
  });

  it('returns the mappings for a genuine group member', async () => {
    installSql({ groupMember: true });
    const { req, res } = mockReqRes({ action: 'mappings', group_id: GROUP });

    await (handler as (rq: NextApiRequest, rs: NextApiResponse) => Promise<unknown>)(req, res);

    expect(res.statusCode).toBe(200);
    expect(getCoaMappingsMock).toHaveBeenCalledTimes(1);
  });

  it('still refuses a company_id the caller does not belong to', async () => {
    installSql({ groupMember: true, myCompanies: [] });
    const { req, res } = mockReqRes({ action: 'mappings', group_id: GROUP, company_id: MY_COMPANY });

    await (handler as (rq: NextApiRequest, rs: NextApiResponse) => Promise<unknown>)(req, res);

    expect(res.statusCode).toBe(403);
    expect(getCoaMappingsMock).not.toHaveBeenCalled();
  });
});

describe('userBelongsToGroup — departed members lose access (GRP-03)', () => {
  it('refuses a caller whose only membership row has a left_date', async () => {
    installSql({ groupMember: true, memberLeft: true });
    const { req, res } = mockReqRes({ action: 'members', group_id: GROUP });

    await (handler as (rq: NextApiRequest, rs: NextApiResponse) => Promise<unknown>)(req, res);

    expect(res.statusCode).toBe(403);
  });

  it('still admits a caller whose membership row is active', async () => {
    installSql({ groupMember: true, memberLeft: false });
    const { req, res } = mockReqRes({ action: 'members', group_id: GROUP });

    await (handler as (rq: NextApiRequest, rs: NextApiResponse) => Promise<unknown>)(req, res);

    expect(res.statusCode).toBe(200);
  });
});
