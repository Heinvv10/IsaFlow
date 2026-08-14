/**
 * Pentest MEDIUM — cross-tenant record forgery on intercompany-transactions POST.
 *
 * verifyGroupAccess only proves the caller belongs to SOME company in the group.
 * Before this guard, a group member could POST an arbitrary targetCompanyId (a
 * company NOT in the group / not theirs) and forge an intercompany_transactions
 * row that leaks that tenant's name via later reconciliation JOINs.
 *
 * These tests drive the real handler with a mocked DB and prove:
 *  - a create whose targetCompanyId is NOT an active group member is rejected 403;
 *  - a create whose source+target are both active members is allowed.
 * Mutation check: delete the verifyCompanyInGroup guard in the handler and the
 * first test goes red (create is called, status 200).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

const sqlMock = vi.fn();
const createTxMock = vi.fn(async () => ({ id: 'itx-1' }));

vi.mock('@/lib/neon', () => ({ sql: (...a: unknown[]) => sqlMock(...a) }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('@/lib/auth', () => ({ withAuth: (h: unknown) => h }));
vi.mock('@/lib/auth/withCsrf', () => ({ withCsrf: (h: unknown) => h }));
vi.mock('@/lib/api-error-handler', () => ({ withErrorHandler: (h: unknown) => h }));
vi.mock('@/modules/accounting/services/reports/groupCompanyService', () => ({
  listIntercompanyTransactions: vi.fn(),
  createIntercompanyTransaction: (...a: unknown[]) => createTxMock(...a),
  matchIntercompanyTransactions: vi.fn(),
  getIntercompanyReconciliation: vi.fn(),
}));

import handler from '../../../pages/api/accounting/intercompany-transactions';

const GROUP = 'group-1';
const SOURCE = 'company-source';
const TARGET_IN = 'company-target-in';
const TARGET_FOREIGN = 'company-foreign';

function mockReqRes(body: Record<string, unknown>) {
  const req = {
    method: 'POST',
    query: {},
    body,
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

/** Route the mocked sql calls by the membership/access query text. */
function installSql(opts: { groupAccess: boolean; membersInGroup: string[] }) {
  sqlMock.mockImplementation(async (strings: readonly string[], ...values: unknown[]) => {
    const q = strings.join('?');
    // verifyGroupAccess: caller belongs to some company in the group
    if (q.includes('JOIN company_users cu ON cu.company_id = cgm.company_id')) {
      return opts.groupAccess ? [{ ok: 1 }] : [];
    }
    // verifyCompanyInGroup: company_id is an active member of the group
    if (q.includes('FROM company_group_members') && q.includes('left_date IS NULL')) {
      const companyId = values[1] as string; // group_id, company_id
      return opts.membersInGroup.includes(companyId) ? [{ ok: 1 }] : [];
    }
    return [];
  });
}

const validBody = {
  groupId: GROUP,
  sourceCompanyId: SOURCE,
  targetCompanyId: TARGET_IN,
  transactionType: 'loan',
  amount: 1000,
  transactionDate: '2026-08-14',
};

beforeEach(() => vi.clearAllMocks());

describe('intercompany-transactions POST — cross-tenant forgery guard', () => {
  it('rejects a create whose targetCompanyId is not an active group member', async () => {
    installSql({ groupAccess: true, membersInGroup: [SOURCE, TARGET_IN] });
    const { req, res } = mockReqRes({ ...validBody, targetCompanyId: TARGET_FOREIGN });

    await (handler as (rq: NextApiRequest, rs: NextApiResponse) => Promise<unknown>)(req, res);

    expect(res.statusCode).toBe(403);
    expect(createTxMock).not.toHaveBeenCalled();
  });

  it('rejects a create whose sourceCompanyId is not an active group member', async () => {
    installSql({ groupAccess: true, membersInGroup: [TARGET_IN] });
    const { req, res } = mockReqRes(validBody);

    await (handler as (rq: NextApiRequest, rs: NextApiResponse) => Promise<unknown>)(req, res);

    expect(res.statusCode).toBe(403);
    expect(createTxMock).not.toHaveBeenCalled();
  });

  it('allows a create when both companies are active group members', async () => {
    installSql({ groupAccess: true, membersInGroup: [SOURCE, TARGET_IN] });
    const { req, res } = mockReqRes(validBody);

    await (handler as (rq: NextApiRequest, rs: NextApiResponse) => Promise<unknown>)(req, res);

    expect(res.statusCode).toBe(200);
    expect(createTxMock).toHaveBeenCalledTimes(1);
  });
});
