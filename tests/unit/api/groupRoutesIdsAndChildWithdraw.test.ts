/**
 * D4 round 10:
 *  5. company-groups and consolidation/companies UUID-check every id (typeof first) before any
 *     ::UUID cast — a malformed or repeated value used to reach the cast and 500.
 *  3. consolidation/companies DELETE can be made from the CHILD side (?parentCompanyId=, the
 *     active company being the child), so a child's own owners can end a grant someone else made.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

const access = vi.hoisted(() => ({
  userBelongsToCompany: vi.fn(), userBelongsToGroup: vi.fn(), userCanWriteGroup: vi.fn(), userCreatedGroup: vi.fn(), userCanWriteCompany: vi.fn(),
}));
const rel = vi.hoisted(() => ({ create: vi.fn(), remove: vi.fn(), list: vi.fn() }));
vi.mock('@/lib/neon', () => ({ sql: vi.fn(async () => [{ id: 'row' }]) }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/auth', async () => ({
  withAuth: (h: unknown) => h,
  withWriteAccess: (await vi.importActual<typeof import('@/lib/auth/withWriteAccess')>('@/lib/auth/withWriteAccess')).withWriteAccess,
}));
vi.mock('@/lib/auth/withCsrf', () => ({ withCsrf: (h: unknown) => h }));
vi.mock('@/lib/api-error-handler', () => ({ withErrorHandler: (h: unknown) => h }));
vi.mock('@/modules/accounting/services/core/companyAccessService', () => access);
vi.mock('@/modules/accounting/services/reports/groupCompanyService', () => new Proxy({}, { get: () => vi.fn(async () => ({ id: 'x' })) }));
vi.mock('@/modules/accounting/services/reports/consolidationService', () => ({
  getGroupCompanies: rel.list, createCompanyRelationship: rel.create, deleteCompanyRelationship: rel.remove,
}));

import groupsHandler from '../../../pages/api/accounting/company-groups';
import companiesHandler from '../../../pages/api/accounting/consolidation/companies';

const ACTIVE = '10000000-0000-4000-8000-0000000000a1';
const OTHER = '10000000-0000-4000-8000-0000000000a2';
const U = '70000000-0000-4000-8000-000000000001';

type H = (rq: NextApiRequest, rs: NextApiResponse) => Promise<unknown>;
async function call(handler: unknown, method: string, query: Record<string, unknown>, body: unknown = {}, companyRole = 'admin') {
  const res = { status: vi.fn().mockReturnThis(), json: vi.fn(), setHeader: vi.fn(), end: vi.fn() };
  await (handler as H)({ method, query, body, companyId: ACTIVE, companyRole, user: { id: 'u1' } } as unknown as NextApiRequest,
    res as unknown as NextApiResponse);
  return res;
}
const msg = (res: { json: ReturnType<typeof vi.fn> }) => JSON.stringify(res.json.mock.calls[0]?.[0] ?? {});

beforeEach(() => {
  for (const fn of [...Object.values(access), ...Object.values(rel)]) fn.mockReset().mockResolvedValue(true);
  rel.list.mockResolvedValue([]);
});

describe('company-groups: every id is UUID-checked first (400)', () => {
  it.each([
    ['GET', { action: 'members', group_id: 'g-1' }, {}, 'group_id'],
    ['GET', { action: 'mappings', group_id: U, company_id: [U] }, {}, 'company_id'],
    ['POST', {}, { action: 'add-member', groupId: U, companyId: 'c-1' }, 'companyId'],
    ['POST', {}, { action: 'create-group-account', groupId: U, accountCode: 'G1', accountName: 'n', accountType: 'asset', parentAccountId: 7 }, 'parentAccountId'],
    ['POST', {}, { action: 'auto-generate-coa', groupId: U, sourceCompanyId: 'nope' }, 'sourceCompanyId'],
    ['POST', {}, { action: 'set-mapping', groupId: U, companyId: U, companyAccountId: 'ca1', groupAccountId: U }, 'companyAccountId'],
    ['POST', {}, { action: 'set-mapping', groupId: U, companyId: U, companyAccountId: U, groupAccountId: {} }, 'groupAccountId'],
    ['POST', {}, { action: 'auto-map', groupId: ['x'], companyId: U }, 'groupId'],
    ['POST', {}, { name: 'G', holdingCompanyId: 'h-1' }, 'holdingCompanyId'],
    ['PUT', {}, { action: 'update-member', memberId: 'm1', groupId: U }, 'memberId'],
    ['PUT', {}, { action: 'update-group-account', accountId: U, groupId: 'g' }, 'groupId'],
    ['PUT', {}, { groupId: U, holdingCompanyId: 'h' }, 'holdingCompanyId'],
    ['DELETE', { action: 'remove-member', member_id: 'm1', group_id: U }, {}, 'member_id'],
    ['DELETE', { action: 'remove-mapping', mapping_id: U, group_id: 'g' }, {}, 'group_id'],
    ['DELETE', { action: 'delete-group-account', account_id: 'a1', group_id: U }, {}, 'account_id'],
    ['DELETE', { group_id: [U, U] }, {}, 'group_id'],
  ] as const)('%s %j %j → 400 on %s', async (method, query, body, field) => {
    const res = await call(groupsHandler, method, query as Record<string, unknown>, body);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(msg(res)).toContain(`${field} must be a valid UUID`);
    expect(access.userBelongsToGroup).not.toHaveBeenCalled();
    expect(access.userCanWriteGroup).not.toHaveBeenCalled();
    expect(access.userCanWriteCompany).not.toHaveBeenCalled();
  });
});

// Round 11 (blind review of 28cd87199): an unknown action is refused on every method — DELETE had
// no such check and fell through to delete-group — and every id is checked whatever the action.
describe('company-groups: unknown actions and ids outside the action\'s own list', () => {
  it.each([
    ['DELETE', { action: 'foo', group_id: 'junk' }, {}, 'Unknown action: foo'],
    ['DELETE', { action: 'foo', group_id: U }, {}, 'Unknown action: foo'],
    ['GET', { action: 'everything', group_id: U }, {}, 'Unknown action: everything'],
    ['POST', {}, { action: 'add-account', groupId: U }, 'Unknown action: add-account'],
    ['PUT', {}, { action: 'update-account', groupId: U }, 'Unknown action: update-account'],
    ['DELETE', { action: ['remove-member', 'x'], group_id: U }, {}, 'action must be a string'],
    ['POST', {}, { action: 'add-member', groupId: U, companyId: U, holdingCompanyId: 'junk' }, 'holdingCompanyId must be a valid UUID'],
    ['DELETE', { group_id: U, mapping_id: 'junk' }, {}, 'mapping_id must be a valid UUID'],
    ['PUT', { group_id: 'junk' }, { groupId: U, name: 'x' }, 'group_id must be a valid UUID'],
  ] as const)('%s %j %j → 400 %s', async (method, query, body, message) => {
    const res = await call(groupsHandler, method, query as Record<string, unknown>, body);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(msg(res)).toContain(message);
    for (const fn of Object.values(access)) expect(fn).not.toHaveBeenCalled();
  });
});

describe('consolidation/companies: ids are UUID-checked (400)', () => {
  it.each([
    ['POST', {}, { childCompanyId: 'child-1' }, 'childCompanyId'],
    ['DELETE', { childCompanyId: 'child-1' }, {}, 'childCompanyId'],
    ['DELETE', { parentCompanyId: 'parent-1' }, {}, 'parentCompanyId'],
  ] as const)('%s %j %j → 400', async (method, query, body, field) => {
    const res = await call(companiesHandler, method, query as Record<string, unknown>, body);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(msg(res)).toContain(`${field} must be a valid UUID`);
    expect(rel.create).not.toHaveBeenCalled();
    expect(rel.remove).not.toHaveBeenCalled();
  });
});

describe('consolidation/companies DELETE from the child side', () => {
  it('as the parent: removes (active → child)', async () => {
    const res = await call(companiesHandler, 'DELETE', { childCompanyId: OTHER });
    expect(res.status).toHaveBeenCalledWith(200);
    expect(rel.remove).toHaveBeenCalledWith(ACTIVE, OTHER, 'u1');
  });

  it('as the child: removes (parent → active), so the child\'s own owners can withdraw', async () => {
    const res = await call(companiesHandler, 'DELETE', { parentCompanyId: OTHER });
    expect(res.status).toHaveBeenCalledWith(200);
    expect(rel.remove).toHaveBeenCalledWith(OTHER, ACTIVE, 'u1');
  });

  it('a viewer of the child cannot withdraw it (withWriteAccess on the active company)', async () => {
    const res = await call(companiesHandler, 'DELETE', { parentCompanyId: OTHER }, {}, 'viewer');
    expect(res.status).toHaveBeenCalledWith(403);
    expect(rel.remove).not.toHaveBeenCalled();
  });

  it('naming both sides is refused (400)', async () => {
    const res = await call(companiesHandler, 'DELETE', { parentCompanyId: OTHER, childCompanyId: OTHER });
    expect(res.status).toHaveBeenCalledWith(400);
    expect(rel.remove).not.toHaveBeenCalled();
  });

  it('a link that does not exist from this side is a 404', async () => {
    rel.remove.mockResolvedValue(false);
    const res = await call(companiesHandler, 'DELETE', { parentCompanyId: OTHER });
    expect(res.status).toHaveBeenCalledWith(404);
  });
});
