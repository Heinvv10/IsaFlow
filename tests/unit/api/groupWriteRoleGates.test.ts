/**
 * D4 round 8 (security review of 36bdb957e): every write on an existing group — company-groups
 * POST / PUT / DELETE branches and intercompany-transactions create / match — needs a group
 * WRITE role (companyAccessService.userCanWriteGroup: owner / admin / manager of a current member
 * company). Membership alone (a viewer) used to be enough, and a matched intercompany transaction
 * becomes an elimination on the next auto-eliminate. Each branch: a viewer member gets 403 and
 * nothing is written; a non-member gets 'Access denied'; a writer is allowed.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

const access = vi.hoisted(() => ({
  userBelongsToCompany: vi.fn(), userBelongsToGroup: vi.fn(), userCanWriteGroup: vi.fn(), userCreatedGroup: vi.fn(),
  userCanWriteCompany: vi.fn(),
}));
const svc = vi.hoisted(() => ({
  getGroup: vi.fn(), listGroupsForUser: vi.fn(), createGroup: vi.fn(), updateGroup: vi.fn(), deleteGroup: vi.fn(),
  addMember: vi.fn(), updateMember: vi.fn(), removeMember: vi.fn(), getGroupMembers: vi.fn(), getGroupAccounts: vi.fn(),
  createGroupAccount: vi.fn(), updateGroupAccount: vi.fn(), deleteGroupAccount: vi.fn(), autoGenerateGroupCOA: vi.fn(),
  getCoaMappings: vi.fn(), setCoaMapping: vi.fn(), removeCoaMapping: vi.fn(), autoMapAccounts: vi.fn(), getUnmappedAccounts: vi.fn(),
  listIntercompanyTransactions: vi.fn(), createIntercompanyTransaction: vi.fn(), matchIntercompanyTransactions: vi.fn(),
  getIntercompanyReconciliation: vi.fn(),
}));
vi.mock('@/lib/neon', () => ({ sql: vi.fn(async () => [{ '?column?': 1 }]) }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/auth', () => ({ withAuth: (h: unknown) => h }));
vi.mock('@/lib/auth/withCsrf', () => ({ withCsrf: (h: unknown) => h }));
vi.mock('@/lib/api-error-handler', () => ({ withErrorHandler: (h: unknown) => h }));
vi.mock('@/modules/accounting/services/core/companyAccessService', () => access);
vi.mock('@/modules/accounting/services/reports/groupCompanyService', () => svc);

import groupsHandler from '../../../pages/api/accounting/company-groups';
import intercoHandler from '../../../pages/api/accounting/intercompany-transactions';

const G = '80000000-0000-4000-8000-000000000001';
const CO = '10000000-0000-4000-8000-0000000000a1';
const CO2 = '10000000-0000-4000-8000-0000000000a2';

type Case = [string, 'groups' | 'interco', string, Record<string, unknown>, Record<string, unknown>, keyof typeof svc];
const CASES: Case[] = [
  ['add-member', 'groups', 'POST', {}, { action: 'add-member', groupId: G, companyId: CO }, 'addMember'],
  ['create-group-account', 'groups', 'POST', {}, { action: 'create-group-account', groupId: G, accountCode: 'G1', accountName: 'n', accountType: 'asset' }, 'createGroupAccount'],
  ['auto-generate-coa', 'groups', 'POST', {}, { action: 'auto-generate-coa', groupId: G, sourceCompanyId: CO }, 'autoGenerateGroupCOA'],
  ['set-mapping', 'groups', 'POST', {}, { action: 'set-mapping', groupId: G, companyId: CO, companyAccountId: 'c', groupAccountId: 'g' }, 'setCoaMapping'],
  ['auto-map', 'groups', 'POST', {}, { action: 'auto-map', groupId: G, companyId: CO }, 'autoMapAccounts'],
  ['update-member', 'groups', 'PUT', {}, { action: 'update-member', memberId: 'm', groupId: G, ownershipPct: 60 }, 'updateMember'],
  ['update-group-account', 'groups', 'PUT', {}, { action: 'update-group-account', accountId: 'a', groupId: G, accountName: 'x' }, 'updateGroupAccount'],
  ['update-group', 'groups', 'PUT', {}, { groupId: G, name: 'renamed' }, 'updateGroup'],
  ['remove-member', 'groups', 'DELETE', { action: 'remove-member', member_id: 'm', group_id: G }, {}, 'removeMember'],
  ['remove-mapping', 'groups', 'DELETE', { action: 'remove-mapping', mapping_id: 'p', group_id: G }, {}, 'removeCoaMapping'],
  ['delete-group-account', 'groups', 'DELETE', { action: 'delete-group-account', account_id: 'a', group_id: G }, {}, 'deleteGroupAccount'],
  ['delete-group', 'groups', 'DELETE', { group_id: G }, {}, 'deleteGroup'],
  ['interco create', 'interco', 'POST', {}, { groupId: G, sourceCompanyId: CO, targetCompanyId: CO2, transactionType: 'sale', amount: 1000000, transactionDate: '2026-01-15' }, 'createIntercompanyTransaction'],
  ['interco match', 'interco', 'POST', {}, { action: 'match', groupId: G, sourceId: CO, targetId: CO2 }, 'matchIntercompanyTransactions'],
];

async function call(c: Case) {
  const [, route, method, query, body] = c;
  const res = { status: vi.fn().mockReturnThis(), json: vi.fn(), setHeader: vi.fn(), end: vi.fn() };
  const handler = (route === 'groups' ? groupsHandler : intercoHandler) as (rq: NextApiRequest, rs: NextApiResponse) => Promise<unknown>;
  await handler({ method, query, body, user: { id: 'u1' } } as unknown as NextApiRequest, res as unknown as NextApiResponse);
  return res;
}
const msg = (res: { json: ReturnType<typeof vi.fn> }) => JSON.stringify(res.json.mock.calls[0]?.[0] ?? {});

beforeEach(() => {
  for (const fn of Object.values(svc)) fn.mockReset().mockResolvedValue({ id: 'x' });
  access.userBelongsToCompany.mockReset().mockResolvedValue(true);
  access.userBelongsToGroup.mockReset().mockResolvedValue(true);
  access.userCanWriteGroup.mockReset().mockResolvedValue(true);
  access.userCreatedGroup.mockReset().mockResolvedValue(false);
  access.userCanWriteCompany.mockReset().mockResolvedValue(true);
});

describe.each(CASES)('%s', (...c) => {
  it('a viewer member is refused 403 and nothing is written', async () => {
    access.userCanWriteGroup.mockResolvedValue(false);
    const res = await call(c);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(msg(res)).toContain('does not allow this change');
    expect(svc[c[5]]).not.toHaveBeenCalled();
    expect(access.userCanWriteGroup).toHaveBeenCalledWith('u1', G);
  });

  it('a non-member is refused as before', async () => {
    access.userBelongsToGroup.mockResolvedValue(false);
    access.userCanWriteGroup.mockResolvedValue(false);
    const res = await call(c);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(msg(res)).toContain('Access denied to this group');
    expect(svc[c[5]]).not.toHaveBeenCalled();
  });

  it('a writer is allowed', async () => {
    const res = await call(c);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(svc[c[5]]).toHaveBeenCalledTimes(1);
  });
});

describe('add-member bootstrap', () => {
  it('the group creator may still add the first member without a write role in it', async () => {
    access.userBelongsToGroup.mockResolvedValue(false);
    access.userCanWriteGroup.mockResolvedValue(false);
    access.userCreatedGroup.mockResolvedValue(true);
    const res = await call(CASES[0]!);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(svc.addMember).toHaveBeenCalledTimes(1);
  });
});

describe('reads stay membership-only', () => {
  it('a viewer can still list the group\'s intercompany transactions and accounts', async () => {
    access.userCanWriteGroup.mockResolvedValue(false);
    for (const c of [
      ['list', 'interco', 'GET', { group_id: G }, {}, 'listIntercompanyTransactions'],
      ['accounts', 'groups', 'GET', { action: 'accounts', group_id: G }, {}, 'getGroupAccounts'],
    ] as Case[]) {
      const res = await call(c);
      expect(res.status, c[0]).toHaveBeenCalledWith(200);
    }
  });
});
