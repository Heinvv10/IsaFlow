/**
 * Round 2 of the 999r review: the narrower row-security policies return 0 rows where the routes used to assume success,
 * so each route checks what the policy will check and never reports what did not happen:
 *  - remove-member / update-member need a write role in the MEMBER's company (403), and a vanished or unchanged row is a 404;
 *  - add-member answers 409 for a company that is already a current member (a left one is re-activated by the service);
 *  - a group rename carries the unchanged holding company without a role check in it, a changed one needs it;
 *  - match needs a write role in a party of EACH row (403), not a half-applied match.
 * Mutation checks: delete the guard each case names and that case goes red.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

const access = vi.hoisted(() => ({
  userBelongsToCompany: vi.fn(), userBelongsToGroup: vi.fn(), userCanWriteGroup: vi.fn(), userCreatedGroup: vi.fn(), userCanWriteCompany: vi.fn(),
}));
const svc = vi.hoisted(() => ({
  getGroup: vi.fn(), listGroupsForUser: vi.fn(), createGroup: vi.fn(), updateGroup: vi.fn(), deleteGroup: vi.fn(),
  addMember: vi.fn(), findMember: vi.fn(), updateMember: vi.fn(), removeMember: vi.fn(), getGroupMembers: vi.fn(), getGroupAccounts: vi.fn(),
  createGroupAccount: vi.fn(), updateGroupAccount: vi.fn(), deleteGroupAccount: vi.fn(), autoGenerateGroupCOA: vi.fn(),
  getCoaMappings: vi.fn(), setCoaMapping: vi.fn(), removeCoaMapping: vi.fn(), autoMapAccounts: vi.fn(), getUnmappedAccounts: vi.fn(),
  listIntercompanyTransactions: vi.fn(), createIntercompanyTransaction: vi.fn(), matchIntercompanyTransactions: vi.fn(),
  getTransactionParties: vi.fn(), getIntercompanyReconciliation: vi.fn(),
}));
vi.mock('@/lib/neon', () => ({ sql: vi.fn(async () => [{ '?column?': 1 }]) }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/auth', () => ({ withAuth: (h: unknown) => h }));
vi.mock('@/lib/auth/withCsrf', () => ({ withCsrf: (h: unknown) => h }));
vi.mock('@/lib/api-error-handler', () => ({ withErrorHandler: (h: unknown) => h }));
vi.mock('@/modules/accounting/services/core/companyAccessService', () => access);
const guards = vi.hoisted(() => ({
  creatorMayBootstrapGroup: vi.fn(), refuseGroupCompanyRead: vi.fn(), refuseGroupCompanyWrite: vi.fn(), mappingAccountsBelong: vi.fn(),
}));
vi.mock('@/modules/accounting/services/core/groupRouteGuards', async () => ({
  ...(await vi.importActual<typeof import('@/modules/accounting/services/core/groupRouteGuards')>('@/modules/accounting/services/core/groupRouteGuards')),
  ...guards,
}));
vi.mock('@/modules/accounting/services/reports/groupCompanyService', () => svc);

import groupsHandler from '../../../pages/api/accounting/company-groups';
import intercoHandler from '../../../pages/api/accounting/intercompany-transactions';

const G = '80000000-0000-4000-8000-000000000001';
const CO = '10000000-0000-4000-8000-0000000000a1';
const CO2 = '10000000-0000-4000-8000-0000000000a2';
const M = '70000000-0000-4000-8000-0000000000e1';
const T1 = '60000000-0000-4000-8000-0000000000a1';
const T2 = '60000000-0000-4000-8000-0000000000a2';

async function call(route: 'groups' | 'interco', method: string, query: Record<string, unknown>, body: Record<string, unknown>, active = CO) {
  const res = { status: vi.fn().mockReturnThis(), json: vi.fn(), setHeader: vi.fn(), end: vi.fn() };
  const handler = (route === 'groups' ? groupsHandler : intercoHandler) as (rq: NextApiRequest, rs: NextApiResponse) => Promise<unknown>;
  await handler({ method, query, body, user: { id: 'u1' }, companyId: active } as unknown as NextApiRequest, res as unknown as NextApiResponse);
  return res;
}
const status = (res: { status: ReturnType<typeof vi.fn> }) => res.status.mock.calls[0]?.[0];

beforeEach(() => {
  for (const fn of Object.values(svc)) fn.mockReset().mockResolvedValue({ id: 'x' });
  svc.findMember.mockResolvedValue({ companyId: CO });
  svc.removeMember.mockResolvedValue(true);
  svc.getGroup.mockResolvedValue({ id: G, holdingCompanyId: CO });
  svc.getTransactionParties.mockResolvedValue([]);
  for (const fn of Object.values(access)) fn.mockReset().mockResolvedValue(true);
  access.userCreatedGroup.mockResolvedValue(false);
  guards.creatorMayBootstrapGroup.mockReset().mockResolvedValue(false);
});

describe('remove-member', () => {
  const remove = () => call('groups', 'DELETE', { action: 'remove-member', member_id: M, group_id: G }, {});
  it('a member that is not there (or not visible) is a 404, nothing is removed', async () => {
    svc.findMember.mockResolvedValue(null);
    expect(status(await remove())).toBe(404);
    expect(svc.removeMember).not.toHaveBeenCalled();
  });
  it('a group writer without a write role in the member\'s company is refused 403', async () => {
    access.userCanWriteCompany.mockImplementation(async (_u: string, c: string) => c !== CO);
    const res = await remove();
    expect(status(res)).toBe(403);
    expect(svc.removeMember).not.toHaveBeenCalled();
    expect(access.userCanWriteCompany).toHaveBeenCalledWith('u1', CO);
  });
  it('a removal that changed no row is a 404, never { removed: true }', async () => {
    svc.removeMember.mockResolvedValue(false);
    const res = await remove();
    expect(status(res)).toBe(404);
    expect(JSON.stringify(res.json.mock.calls[0]?.[0])).not.toContain('"removed":true');
  });
  it('a writer of the group and the company removes it', async () => {
    const res = await remove();
    expect(status(res)).toBe(200);
    expect(svc.removeMember).toHaveBeenCalledWith(M, G);
  });
});

describe('update-member', () => {
  const update = () => call('groups', 'PUT', {}, { action: 'update-member', memberId: M, groupId: G, ownershipPct: 60 });
  it('is a 404 for a member that is not there, a 403 without a write role in its company, 200 otherwise', async () => {
    svc.findMember.mockResolvedValue(null);
    expect(status(await update())).toBe(404);
    svc.findMember.mockResolvedValue({ companyId: CO });
    access.userCanWriteCompany.mockResolvedValue(false);
    expect(status(await update())).toBe(403);
    expect(svc.updateMember).not.toHaveBeenCalled();
    access.userCanWriteCompany.mockResolvedValue(true);
    expect(status(await update())).toBe(200);
    expect(svc.updateMember).toHaveBeenCalledTimes(1);
  });
});

describe('add-member', () => {
  it('a company that is already a current member is a 409, not a join', async () => {
    svc.addMember.mockResolvedValue(null);
    expect(status(await call('groups', 'POST', {}, { action: 'add-member', groupId: G, companyId: CO }))).toBe(409);
  });
});

describe('update-group (the details tab sends the holding company on every save)', () => {
  it('an unchanged holding company needs no role in it: a group writer outside it renames', async () => {
    access.userCanWriteCompany.mockResolvedValue(false);
    const res = await call('groups', 'PUT', {}, { groupId: G, name: 'renamed', holdingCompanyId: CO });
    expect(status(res)).toBe(200);
    expect(svc.updateGroup).toHaveBeenCalledTimes(1);
  });
  it('a changed holding company still needs a write role in it', async () => {
    access.userCanWriteCompany.mockResolvedValue(false);
    const res = await call('groups', 'PUT', {}, { groupId: G, name: 'renamed', holdingCompanyId: CO2 });
    expect(status(res)).toBe(403);
    expect(svc.updateGroup).not.toHaveBeenCalled();
  });
});

describe('interco match', () => {
  const match = () => call('interco', 'POST', {}, { action: 'match', groupId: G, sourceId: T1, targetId: T2 });
  const parties = [{ id: T1, sourceCompanyId: CO, targetCompanyId: CO2 }, { id: T2, sourceCompanyId: CO2, targetCompanyId: CO2 }];
  it('a writer of neither party of one of the rows is refused 403, nothing is matched', async () => {
    svc.getTransactionParties.mockResolvedValue(parties);
    access.userCanWriteCompany.mockImplementation(async (_u: string, c: string) => c === CO);   // writes CO: a party of T1 only
    expect(status(await match())).toBe(403);
    expect(svc.matchIntercompanyTransactions).not.toHaveBeenCalled();
  });
  it('a writer of the source of one and the target of the other matches both', async () => {
    svc.getTransactionParties.mockResolvedValue(parties);
    access.userCanWriteCompany.mockImplementation(async (_u: string, c: string) => c === CO || c === CO2);
    expect(status(await match())).toBe(200);
    expect(svc.matchIntercompanyTransactions).toHaveBeenCalledWith(T1, T2, G);
  });
  it('a row that is not visible is left to the service\'s typed 404', async () => {
    svc.getTransactionParties.mockResolvedValue([]);
    expect(status(await match())).toBe(200);
    expect(svc.matchIntercompanyTransactions).toHaveBeenCalledTimes(1);
  });
});

// Row security keeps a member row written with ITS company active (999r): the routes say so as a 403, never as a 500.
describe('a member company that is not the active company is a 403 that says to switch', () => {
  const switchMsg = (res: { json: ReturnType<typeof vi.fn> }) => JSON.stringify(res.json.mock.calls[0]?.[0] ?? {});
  it('add-member (and so a re-join: the same route and service call)', async () => {
    const res = await call('groups', 'POST', {}, { action: 'add-member', groupId: G, companyId: CO2 }, CO);
    expect(status(res)).toBe(403);
    expect(switchMsg(res)).toContain('active company');
    expect(svc.addMember).not.toHaveBeenCalled();
    expect(status(await call('groups', 'POST', {}, { action: 'add-member', groupId: G, companyId: CO2 }, CO2))).toBe(200);
  });
  it('update-member and remove-member', async () => {
    svc.findMember.mockResolvedValue({ companyId: CO2 });
    const upd = await call('groups', 'PUT', {}, { action: 'update-member', memberId: M, groupId: G, ownershipPct: 60 }, CO);
    expect(status(upd)).toBe(403);
    expect(switchMsg(upd)).toContain('active company');
    expect(svc.updateMember).not.toHaveBeenCalled();
    const del = await call('groups', 'DELETE', { action: 'remove-member', member_id: M, group_id: G }, {}, CO);
    expect(status(del)).toBe(403);
    expect(svc.removeMember).not.toHaveBeenCalled();
    expect(status(await call('groups', 'DELETE', { action: 'remove-member', member_id: M, group_id: G }, {}, CO2))).toBe(200);
  });
  it('the active company is compared whatever the case of the ids', async () => {
    svc.findMember.mockResolvedValue({ companyId: CO.toUpperCase() });
    expect(status(await call('groups', 'DELETE', { action: 'remove-member', member_id: M, group_id: G }, {}, CO))).toBe(200);
  });
  it('a new group\'s holding company, whose member row is inserted with it', async () => {
    expect(status(await call('groups', 'POST', {}, { name: 'g', holdingCompanyId: CO2 }, CO))).toBe(403);
    expect(svc.createGroup).not.toHaveBeenCalled();
    expect(status(await call('groups', 'POST', {}, { name: 'g', holdingCompanyId: CO }, CO))).toBe(200);
  });
});

describe('update-group: the holding company id is compared whatever its case (round 3: 6)', () => {
  it('an unchanged holding company in upper case is not a change', async () => {
    access.userCanWriteCompany.mockResolvedValue(false);
    expect(status(await call('groups', 'PUT', {}, { groupId: G, name: 'r', holdingCompanyId: CO.toUpperCase() }))).toBe(200);
  });
});

describe('interco match: a transaction is never matched with itself (round 3: 3)', () => {
  it('the same id twice, in any case, is a 400 and nothing is looked up or matched', async () => {
    expect(status(await call('interco', 'POST', {}, { action: 'match', groupId: G, sourceId: T1, targetId: T1.toUpperCase() }))).toBe(400);
    expect(svc.getTransactionParties).not.toHaveBeenCalled();
    expect(svc.matchIntercompanyTransactions).not.toHaveBeenCalled();
  });
});
