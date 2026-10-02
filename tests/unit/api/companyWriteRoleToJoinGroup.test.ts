/**
 * D4 round 9: putting a company INTO a group exposes its whole ledger to every member of that
 * group, so it needs a WRITE role in that company (companyAccessService.userCanWriteCompany),
 * not plain membership — a viewer must not be able to publish a company's books. Covered:
 * company-groups add-member, create group (holdingCompanyId), update group (holdingCompanyId),
 * consolidation/companies attach subsidiary. Plus: intercompany-transactions validates its ids
 * as UUIDs (400) before any ::UUID cast.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

const access = vi.hoisted(() => ({
  userBelongsToCompany: vi.fn(), userBelongsToGroup: vi.fn(), userCanWriteGroup: vi.fn(),
  userCreatedGroup: vi.fn(), userCanWriteCompany: vi.fn(),
}));
const svc = vi.hoisted(() => ({
  createGroup: vi.fn(), updateGroup: vi.fn(), addMember: vi.fn(), getGroup: vi.fn(), listGroupsForUser: vi.fn(),
  deleteGroup: vi.fn(), updateMember: vi.fn(), removeMember: vi.fn(), getGroupMembers: vi.fn(), getGroupAccounts: vi.fn(),
  createGroupAccount: vi.fn(), updateGroupAccount: vi.fn(), deleteGroupAccount: vi.fn(), autoGenerateGroupCOA: vi.fn(),
  getCoaMappings: vi.fn(), setCoaMapping: vi.fn(), removeCoaMapping: vi.fn(), autoMapAccounts: vi.fn(), getUnmappedAccounts: vi.fn(),
  listIntercompanyTransactions: vi.fn(), createIntercompanyTransaction: vi.fn(), matchIntercompanyTransactions: vi.fn(),
  getIntercompanyReconciliation: vi.fn(),
}));
const rel = vi.hoisted(() => ({ create: vi.fn(), remove: vi.fn(), list: vi.fn() }));
vi.mock('@/lib/neon', () => ({ sql: vi.fn(async () => [{ id: 'row' }]) }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/auth', () => ({ withAuth: (h: unknown) => h, withWriteAccess: (h: unknown) => h }));
vi.mock('@/lib/auth/withCsrf', () => ({ withCsrf: (h: unknown) => h }));
vi.mock('@/lib/api-error-handler', () => ({ withErrorHandler: (h: unknown) => h }));
vi.mock('@/modules/accounting/services/core/companyAccessService', () => access);
vi.mock('@/modules/accounting/services/reports/groupCompanyService', () => svc);
vi.mock('@/modules/accounting/services/reports/consolidationService', () => ({
  getGroupCompanies: rel.list, createCompanyRelationship: rel.create, deleteCompanyRelationship: rel.remove,
}));

import groupsHandler from '../../../pages/api/accounting/company-groups';
import intercoHandler from '../../../pages/api/accounting/intercompany-transactions';
import companiesHandler from '../../../pages/api/accounting/consolidation/companies';

const G = '80000000-0000-4000-8000-000000000001';
const CO = '10000000-0000-4000-8000-0000000000a1';
const CO2 = '10000000-0000-4000-8000-0000000000a2';

type H = (rq: NextApiRequest, rs: NextApiResponse) => Promise<unknown>;
async function call(handler: unknown, method: string, body: Record<string, unknown>, query: Record<string, unknown> = {}) {
  const res = { status: vi.fn().mockReturnThis(), json: vi.fn(), setHeader: vi.fn(), end: vi.fn() };
  await (handler as H)({ method, query, body, companyId: CO2, companyRole: 'admin', user: { id: 'u1' } } as unknown as NextApiRequest,
    res as unknown as NextApiResponse);
  return res;
}
const msg = (res: { json: ReturnType<typeof vi.fn> }) => JSON.stringify(res.json.mock.calls[0]?.[0] ?? {});

beforeEach(() => {
  for (const fn of [...Object.values(svc), ...Object.values(rel)]) fn.mockReset().mockResolvedValue({ id: 'x' });
  rel.remove.mockResolvedValue(true);
  for (const fn of Object.values(access)) fn.mockReset().mockResolvedValue(true);
});

const JOINS: Array<[string, unknown, string, Record<string, unknown>, () => ReturnType<typeof vi.fn>]> = [
  ['add-member', groupsHandler, 'POST', { action: 'add-member', groupId: G, companyId: CO }, () => svc.addMember],
  ['create group with a holding company', groupsHandler, 'POST', { name: 'Grp', holdingCompanyId: CO }, () => svc.createGroup],
  ['update group holding company', groupsHandler, 'PUT', { groupId: G, holdingCompanyId: CO }, () => svc.updateGroup],
  ['consolidation attach subsidiary', companiesHandler, 'POST', { childCompanyId: CO }, () => rel.create],
];

describe.each(JOINS)('%s', (_name, handler, method, body, written) => {
  it('a VIEWER of the company being added is refused 403, nothing written', async () => {
    access.userCanWriteCompany.mockResolvedValue(false); // still a member of it
    const res = await call(handler, method, body);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(access.userCanWriteCompany).toHaveBeenCalledWith('u1', CO);
    expect(written()).not.toHaveBeenCalled();
  });

  it('an owner / admin / manager of it is allowed', async () => {
    const res = await call(handler, method, body);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(written()).toHaveBeenCalledTimes(1);
  });
});

it('the add-member refusal names the role needed', async () => {
  access.userCanWriteCompany.mockResolvedValue(false);
  expect(msg(await call(groupsHandler, 'POST', { action: 'add-member', groupId: G, companyId: CO })))
    .toContain('needs an owner, admin or manager role in that company');
});

describe('intercompany ids are UUID-checked before any query', () => {
  const MATCH = { action: 'match', groupId: G, sourceId: CO, targetId: CO2 };
  const CREATE = { groupId: G, sourceCompanyId: CO, targetCompanyId: CO2, transactionType: 'sale', amount: 10, transactionDate: '2026-01-15' };

  it.each([
    ['match', MATCH, 'sourceId', 'nope'], ['match', MATCH, 'targetId', [CO2]], ['match', MATCH, 'groupId', 'g-1'],
    ['create', CREATE, 'groupId', 'g-1'], ['create', CREATE, 'sourceCompanyId', [CO]], ['create', CREATE, 'targetCompanyId', 'x'],
    ['create', CREATE, 'sourceJournalEntryId', 'je-1'], ['create', CREATE, 'targetJournalEntryId', 42],
  ] as const)('%s with a malformed %s → 400', async (_kind, base, field, value) => {
    const res = await call(intercoHandler, 'POST', { ...base, [field]: value });
    expect(res.status).toHaveBeenCalledWith(400);
    expect(msg(res)).toContain(`${field} must be a valid UUID`);
    expect(access.userBelongsToGroup).not.toHaveBeenCalled();
    expect(svc.matchIntercompanyTransactions).not.toHaveBeenCalled();
    expect(svc.createIntercompanyTransaction).not.toHaveBeenCalled();
  });

  it('valid ids pass through to the match', async () => {
    const res = await call(intercoHandler, 'POST', MATCH);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(svc.matchIntercompanyTransactions).toHaveBeenCalledWith(CO, CO2, G);
  });
});
