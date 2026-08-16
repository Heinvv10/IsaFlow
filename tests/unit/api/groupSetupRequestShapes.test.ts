// tests/unit/api/groupSetupRequestShapes.test.ts
//
// The group setup UI was comprehensively non-functional and NOTHING caught it:
// every caller sent snake_case bodies while every route action destructures
// camelCase, and two UI actions did not exist in the route at all.
//
//   create group        only `name` landed — holdingCompanyId, defaultCurrency
//                       and financialYearStart were silently dropped, so the new
//                       group enrolled no member and became orphaned
//   add-member          400 'groupId and companyId required'
//   update-member       400
//   auto-generate-coa   400
//   auto-map            400
//   set-mapping         400
//   'add-account'       NO SUCH ACTION — fell through to the default POST branch
//                       and CREATED A COMPANY GROUP named after the GL account,
//                       while reporting "Account added" to the user
//   'update-account'    NO SUCH ACTION — fell through
//   remove-member       400, group_id was never sent
//
// Neither tsc nor eslint could see any of it: the bodies are JSON.stringify of
// object literals, and the responses arrived through an untyped `res.json()`.
// Only a test that drives the REAL handler with the REAL body the UI sends can
// catch this class, which is exactly what this file does.
//
// The bodies below are built with the SAME builders the UI uses
// (src/components/accounting/group/groupRequests.ts). A test holding its own
// copy of the shape would keep passing after the UI drifted back to snake_case —
// which is how this class of bug survived in the first place.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

const svc = {
  createGroup: vi.fn(async () => ({ id: 'g1' })),
  addMember: vi.fn(async () => ({ id: 'm1' })),
  updateMember: vi.fn(async () => ({ id: 'm1' })),
  removeMember: vi.fn(async () => undefined),
  createGroupAccount: vi.fn(async () => ({ id: 'a1' })),
  updateGroupAccount: vi.fn(async () => ({ id: 'a1' })),
  autoGenerateGroupCOA: vi.fn(async () => 7),
  setCoaMapping: vi.fn(async () => ({ id: 'map1' })),
  autoMapAccounts: vi.fn(async () => 3),
};

vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('@/lib/auth', () => ({ withAuth: (h: unknown) => h }));
vi.mock('@/lib/auth/withCsrf', () => ({ withCsrf: (h: unknown) => h }));
vi.mock('@/lib/api-error-handler', () => ({ withErrorHandler: (h: unknown) => h }));
vi.mock('@/modules/accounting/services/core/companyAccessService', () => ({
  userBelongsToCompany: vi.fn(async () => true),
  userBelongsToGroup: vi.fn(async () => true),
  userCreatedGroup: vi.fn(async () => true),
}));
vi.mock('@/modules/accounting/services/reports/groupCompanyService', () => ({
  getGroup: vi.fn(async () => ({ id: 'g1' })),
  listGroupsForUser: vi.fn(async () => []),
  createGroup: (...a: unknown[]) => svc.createGroup(...(a as [])),
  updateGroup: vi.fn(async () => ({ id: 'g1' })),
  deleteGroup: vi.fn(async () => undefined),
  addMember: (...a: unknown[]) => svc.addMember(...(a as [])),
  updateMember: (...a: unknown[]) => svc.updateMember(...(a as [])),
  removeMember: (...a: unknown[]) => svc.removeMember(...(a as [])),
  getGroupMembers: vi.fn(async () => []),
  getGroupAccounts: vi.fn(async () => []),
  createGroupAccount: (...a: unknown[]) => svc.createGroupAccount(...(a as [])),
  updateGroupAccount: (...a: unknown[]) => svc.updateGroupAccount(...(a as [])),
  deleteGroupAccount: vi.fn(async () => undefined),
  autoGenerateGroupCOA: (...a: unknown[]) => svc.autoGenerateGroupCOA(...(a as [])),
  getCoaMappings: vi.fn(async () => []),
  setCoaMapping: (...a: unknown[]) => svc.setCoaMapping(...(a as [])),
  removeCoaMapping: vi.fn(async () => undefined),
  autoMapAccounts: (...a: unknown[]) => svc.autoMapAccounts(...(a as [])),
  getUnmappedAccounts: vi.fn(async () => []),
}));

import handler from '../../../pages/api/accounting/company-groups';
import {
  createGroupBody, addMemberBody, updateMemberBody, autoGenerateCoaBody,
  createGroupAccountBody, updateGroupAccountBody, setMappingBody, autoMapBody,
  removeMemberQuery,
} from '@/components/accounting/group/groupRequests';

const GROUP = 'group-1';
const COMPANY = 'company-1';

function call(method: string, body: Record<string, unknown> = {}, query: Record<string, string> = {}) {
  const req = { method, query, body, user: { id: 'user-1' } } as unknown as NextApiRequest;
  const res = {
    statusCode: 0,
    sent: undefined as unknown,
    setHeader() { return this; },
    status(c: number) { this.statusCode = c; return this; },
    json(p: unknown) { this.sent = p; return this; },
    end() { return this; },
  };
  return {
    req, res: res as unknown as NextApiResponse & typeof res,
    run: () => (handler as (rq: NextApiRequest, rs: NextApiResponse) => Promise<unknown>)(req, res as unknown as NextApiResponse),
  };
}

beforeEach(() => vi.clearAllMocks());

describe('group setup: every UI request shape is accepted by the route', () => {
  it('create group — carries the holding company through instead of dropping it', async () => {
    // GroupDetailsTab handleCreateGroup: JSON.stringify(createForm)
    const c = call('POST', createGroupBody({
      name: 'Incendio Global', holdingCompanyId: COMPANY, defaultCurrency: 'ZAR', financialYearStart: 3,
    }));
    await c.run();
    expect(c.res.statusCode).toBe(200);
    // The dropped holding company is what left a new group with zero members.
    expect(svc.createGroup).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'Incendio Global', holdingCompanyId: COMPANY, defaultCurrency: 'ZAR', financialYearStart: 3 }),
      'user-1',
    );
  });

  it('add-member', async () => {
    // GroupMembersSection handleAddMember
    const c = call('POST', addMemberBody(GROUP, { companyId: COMPANY, ownershipPct: 100, consolidationMethod: 'full' }));
    await c.run();
    expect(c.res.statusCode).toBe(200);
    expect(svc.addMember).toHaveBeenCalledWith(GROUP, COMPANY, { ownershipPct: 100, consolidationMethod: 'full' });
  });

  it('update-member', async () => {
    const c = call('PUT', updateMemberBody(GROUP, 'm1', { ownershipPct: 60, consolidationMethod: 'proportionate' }));
    await c.run();
    expect(c.res.statusCode).toBe(200);
    expect(svc.updateMember).toHaveBeenCalled();
  });

  it('remove-member — sends the group_id the route requires', async () => {
    // Built from the same helper the UI uses, then parsed back into query params.
    const url = new URL(removeMemberQuery(GROUP, 'm1'), 'http://x');
    const c = call('DELETE', {}, Object.fromEntries(url.searchParams));
    await c.run();
    expect(c.res.statusCode).toBe(200);
    expect(svc.removeMember).toHaveBeenCalledWith('m1', GROUP);
  });

  it('auto-generate-coa', async () => {
    // GroupCoaTab handleAutoGenerateCoa
    const c = call('POST', autoGenerateCoaBody(GROUP, COMPANY));
    await c.run();
    expect(c.res.statusCode).toBe(200);
    expect(svc.autoGenerateGroupCOA).toHaveBeenCalledWith(GROUP, COMPANY);
  });

  it('create-group-account — NOT "add-account", which used to create a company group', async () => {
    // GroupCoaTab handleAddGroupAccount
    const c = call('POST', createGroupAccountBody(GROUP, {
      accountCode: '1000', accountName: 'Bank', accountType: 'asset', accountSubtype: '', level: 1,
    }));
    await c.run();
    expect(c.res.statusCode).toBe(200);
    expect(svc.createGroupAccount).toHaveBeenCalled();
    // The old 'add-account' fell through to the default branch. If that ever
    // happens again, createGroup fires on an account payload.
    expect(svc.createGroup).not.toHaveBeenCalled();
  });

  it('update-group-account — NOT "update-account"', async () => {
    // GroupCoaTab handleSaveAccountName
    const c = call('PUT', updateGroupAccountBody(GROUP, 'a1', 'Renamed'));
    await c.run();
    expect(c.res.statusCode).toBe(200);
    expect(svc.updateGroupAccount).toHaveBeenCalledWith('a1', expect.objectContaining({ accountName: 'Renamed' }), GROUP);
  });

  it('set-mapping', async () => {
    // GroupMappingTab handleSetMapping
    const c = call('POST', setMappingBody(GROUP, COMPANY, 'ca1', 'ga1'));
    await c.run();
    expect(c.res.statusCode).toBe(200);
    expect(svc.setCoaMapping).toHaveBeenCalledWith(GROUP, COMPANY, 'ca1', 'ga1');
  });

  it('auto-map', async () => {
    // GroupMappingTab handleAutoMap
    const c = call('POST', autoMapBody(GROUP, COMPANY));
    await c.run();
    expect(c.res.statusCode).toBe(200);
    expect(svc.autoMapAccounts).toHaveBeenCalledWith(GROUP, COMPANY);
  });
});

describe('the old snake_case bodies must NOT be silently accepted', () => {
  it('add-member with snake_case is rejected, not half-applied', async () => {
    const c = call('POST', {
      action: 'add-member', group_id: GROUP, company_id: COMPANY, ownership_pct: 100, consolidation_method: 'full',
    });
    await c.run();
    expect(c.res.statusCode).toBe(400);
    expect(svc.addMember).not.toHaveBeenCalled();
  });

  it("'add-account' is rejected outright — it must never reach createGroup", async () => {
    const c = call('POST', {
      action: 'add-account', group_id: GROUP, code: '1000', name: 'Bank', account_type: 'asset', sub_type: '', level: 1,
    });
    await c.run();
    expect(c.res.statusCode).toBe(400);
    // The whole point: a GL-account payload must not create a company group.
    expect(svc.createGroup).not.toHaveBeenCalled();
  });

  it("'update-account' is rejected outright, not applied as a group update", async () => {
    const c = call('PUT', { action: 'update-account', account_id: 'a1', name: 'Renamed' });
    await c.run();
    expect(c.res.statusCode).toBe(400);
  });

  it('a genuinely unknown action is rejected on both POST and PUT', async () => {
    const post = call('POST', { action: 'not-a-real-action', name: 'x' });
    await post.run();
    expect(post.res.statusCode).toBe(400);
    expect(svc.createGroup).not.toHaveBeenCalled();

    const put = call('PUT', { action: 'not-a-real-action', groupId: GROUP });
    await put.run();
    expect(put.res.statusCode).toBe(400);
  });
});
