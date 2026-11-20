/**
 * #1656 security fix: the consolidated-reports elimination Approve (post / reverse) is asked in the companies of the
 * REQUESTED GROUP (the user's current member companies of gId), not in the session company. The session company can be
 * any company the user is in, unrelated to the group. checkPermission, userBelongsToGroup and userCanWriteGroup run
 * for real over an in-memory company_users / company_group_members / company_user_permissions fake.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';
import { permissionDb, permissionSql } from '../helpers/permissionSqlMock';

const svc = vi.hoisted(() => ({
  getConsolidatedTrialBalance: vi.fn(), getConsolidatedIncomeStatement: vi.fn(), getConsolidatedBalanceSheet: vi.fn(),
  getGroupDashboardStats: vi.fn(), getEliminationAdjustments: vi.fn(), createEliminationAdjustment: vi.fn(),
  postEliminationAdjustment: vi.fn(), reverseEliminationAdjustment: vi.fn(), autoGenerateEliminations: vi.fn(),
}));
vi.mock('@/lib/neon', () => ({ sql: vi.fn() }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/auth', () => ({ withAuth: (h: unknown) => h }));
vi.mock('@/lib/auth/withCsrf', () => ({ withCsrf: (h: unknown) => h }));
vi.mock('@/lib/api-error-handler', () => ({ withErrorHandler: (h: unknown) => h }));
vi.mock('@/modules/accounting/services/reports/consolidatedReportingService', () => svc);
vi.mock('@/modules/accounting/services/reports/groupCompanyService', () => ({ getGroupAccounts: vi.fn(async () => []) }));

import { sql } from '@/lib/neon';
import handler from '../../../pages/api/accounting/consolidated-reports';

const SESSION = '11111111-1111-4111-8111-111111111111'; // the company the request is made in
const MEMBER = '22222222-2222-4222-8222-222222222222'; // a current member of GROUP
const OTHER = '33333333-3333-4333-8333-333333333333'; // a company in another group
const GROUP = '80000000-0000-4000-8000-000000000001';
const ADJ = '70000000-0000-4000-8000-000000000001';
const USER = '99999999-9999-4999-8999-999999999999';

let db = permissionDb();
/** company ids that are CURRENT members of GROUP */
let groupCompanies: string[] = [];

function fakeSql() {
  const perm = permissionSql(db, (text, values) => {
    if (text.includes('FROM   company_group_members cgm') || text.includes('FROM company_group_members cgm')) {
      const [gid, user] = values as [string, string, ...unknown[]];
      const writeOnly = text.includes('cu.role = ANY');
      const rows = gid === GROUP ? groupCompanies : [];
      return rows
        .filter((c) => db.members.has(`${c}:${user}`) && (!writeOnly || ['owner', 'admin', 'manager'].includes(db.members.get(`${c}:${user}`)!)))
        .map((c) => ({ company_id: c, '?column?': 1 }));
    }
    return [];
  });
  return perm;
}

async function post(action: 'post-elimination' | 'reverse-elimination') {
  const res = { status: vi.fn().mockReturnThis(), json: vi.fn(), setHeader: vi.fn() };
  await handler({ method: 'POST', user: { id: USER }, companyId: SESSION, query: { group_id: GROUP }, body: { action, adjustmentId: ADJ } } as unknown as NextApiRequest, res as unknown as NextApiResponse);
  return res;
}
const status = (res: { status: ReturnType<typeof vi.fn> }) => res.status.mock.calls[0]?.[0];

beforeEach(() => {
  for (const fn of Object.values(svc)) fn.mockReset().mockResolvedValue([]);
  db = permissionDb();
  groupCompanies = [MEMBER];
  vi.mocked(sql).mockImplementation(fakeSql() as never);
});

describe.each(['post-elimination', 'reverse-elimination'] as const)('%s asks Approve in the group\'s companies', (action) => {
  const service = () => (action === 'post-elimination' ? svc.postEliminationAdjustment : svc.reverseEliminationAdjustment);

  it('Approve in the session company does not carry: the user\'s member company of the group has it unticked -> 403', async () => {
    db.members.set(`${SESSION}:${USER}`, 'manager');
    db.members.set(`${MEMBER}:${USER}`, 'manager');
    db.rows.set(`${MEMBER}:${USER}:group`, { can_read: true, can_write: true, can_approve: false });
    const res = await post(action);
    expect(status(res)).toBe(403);
    expect(service()).not.toHaveBeenCalled();
  });

  it('a session company with group Approve unticked does not refuse: the group\'s own company grants it', async () => {
    db.members.set(`${SESSION}:${USER}`, 'manager');
    db.rows.set(`${SESSION}:${USER}:group`, { can_read: true, can_write: true, can_approve: false });
    db.members.set(`${MEMBER}:${USER}`, 'manager');
    const res = await post(action);
    expect(status(res)).toBe(200);
    expect(service()).toHaveBeenCalledTimes(1);
  });

  it('a user in the session company only (with Approve there), not in any member company of the group -> 403, nothing called', async () => {
    db.members.set(`${SESSION}:${USER}`, 'owner');
    const res = await post(action);
    expect(status(res)).toBe(403);
    expect(service()).not.toHaveBeenCalled();
  });

  it('a user in another group\'s company is not a member of this group -> 403', async () => {
    db.members.set(`${OTHER}:${USER}`, 'owner');
    const res = await post(action);
    expect(status(res)).toBe(403);
    expect(service()).not.toHaveBeenCalled();
  });

  it('a company that LEFT the group no longer carries the user\'s Approve -> 403', async () => {
    db.members.set(`${MEMBER}:${USER}`, 'owner');
    groupCompanies = []; // left_date set: not a current member
    const res = await post(action);
    expect(status(res)).toBe(403);
    expect(service()).not.toHaveBeenCalled();
  });
});

describe('reads of the group', () => {
  it('Approve/read in the session company does not open a group the user has no member company in -> 403', async () => {
    db.members.set(`${SESSION}:${USER}`, 'owner');
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn(), setHeader: vi.fn() };
    await handler({ method: 'GET', user: { id: USER }, companyId: SESSION, query: { group_id: GROUP, action: 'dashboard' } } as unknown as NextApiRequest, res as unknown as NextApiResponse);
    expect(status(res)).toBe(403);
    expect(svc.getGroupDashboardStats).not.toHaveBeenCalled();
  });
});
