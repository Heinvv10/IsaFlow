/**
 * #1656 round 7 (breaker H1): four more places returned one person's pay or personal data on a role rule alone. A manager whose Payroll read
 * is unticked, or whose Approve is withheld (a former accountant), passed "owner / admin / manager" and read:
 *   - an employee's change history (name, ID number, pay, bank details) through GET /api/accounting/entity-changes and MCP entity_history;
 *   - employees by name or number through global search;
 *   - the hourly rate and billable amount on a project time entry.
 * Each now asks Payroll read from the database (checkPermission). A holder of it, an owner or admin, reads as before.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

vi.mock('@/lib/auth/permissionService', async (orig) => (await import('../helpers/modulePermissionMock')).permissionServiceAllowing(await orig<object>()));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/auth', () => ({ withAuth: (h: unknown) => h, withWriteAccess: (h: unknown) => h }));
vi.mock('@/lib/auth/withCsrf', () => ({ withCsrf: (h: unknown) => h }));
vi.mock('@/lib/api-error-handler', () => ({ withErrorHandler: (h: unknown) => h }));
vi.mock('@/lib/neon', () => ({ sql: vi.fn(async () => [{ id: 't1', hours: 2, hourly_rate: 450, billable_amount: 900, first_name: 'Thandi' }]) }));
vi.mock('@/modules/accounting/services/bank/bankControlRefusal', () => ({ assertHumanSession: vi.fn(async () => undefined), isHumanSession: vi.fn(async () => true) }));
vi.mock('@/modules/accounting/services/core/entityChanges/entityChangeQuery', async (orig) => ({
  ...(await orig<object>()),
  listEntityChanges: vi.fn(async () => ({ items: [], nextCursor: null })),
}));
vi.mock('@/modules/accounting/services/core/globalSearchService', () => ({ globalSearch: vi.fn(async () => []) }));

import { checkPermission } from '@/lib/auth/permissionService';
import { listEntityChanges } from '@/modules/accounting/services/core/entityChanges/entityChangeQuery';
import { globalSearch } from '@/modules/accounting/services/core/globalSearchService';
import { entityHistoryTool } from '@/lib/mcp/tools/entityHistory';
import entityChanges from '../../../pages/api/accounting/entity-changes';
import globalSearchRoute from '../../../pages/api/accounting/global-search';
import timeEntries from '../../../pages/api/accounting/project-time-entries';

const C = '11111111-1111-4111-8111-111111111111';
const U = '99999999-9999-4999-8999-999999999999';
const E = '22222222-2222-4222-8222-222222222222';
let payrollRead = false;

function call(handler: unknown, query: Record<string, unknown>, role = 'manager') {
  const req = { method: 'GET', query, companyId: C, companyRole: role, user: { id: U }, headers: {}, cookies: {} } as unknown as NextApiRequest;
  const res = { statusCode: 0, sent: undefined as unknown, setHeader() { return this; }, status(c: number) { this.statusCode = c; return this; }, json(p: unknown) { this.sent = p; return this; }, end() { return this; } };
  return Promise.resolve((handler as (a: NextApiRequest, b: NextApiResponse) => unknown)(req, res as unknown as NextApiResponse)).then(() => res);
}

const typesAsked = () => (vi.mocked(listEntityChanges).mock.calls[0]?.[1]?.types ?? []) as string[];

beforeEach(() => {
  vi.clearAllMocks();
  payrollRead = false;
  vi.mocked(checkPermission).mockImplementation(async (_c, _u, module, action) => !(module === 'payroll' && action === 'read') || payrollRead);
});

describe('employee change history (GET /api/accounting/entity-changes)', () => {
  it.each(['payroll_employee', 'payroll_bank_detail'])('a manager without Payroll read gets 403 for one %s timeline and nothing is read', async (entityType) => {
    const res = await call(entityChanges, { entityType, entityId: E });
    expect(res.statusCode).toBe(403);
    expect(checkPermission).toHaveBeenCalledWith(C, U, 'payroll', 'read');
    expect(listEntityChanges).not.toHaveBeenCalled();
  });

  it('a manager without Payroll read gets 403 for an employee bank-detail history by employeeId', async () => {
    const res = await call(entityChanges, { entityType: 'payroll_bank_detail', employeeId: E });
    expect(res.statusCode).toBe(403);
    expect(listEntityChanges).not.toHaveBeenCalled();
  });

  it('with Payroll read the same manager reads it; a supplier timeline never asks for Payroll', async () => {
    payrollRead = true;
    expect((await call(entityChanges, { entityType: 'payroll_employee', entityId: E })).statusCode).toBe(200);
    expect(typesAsked()).toEqual(['payroll_employee']);
    vi.mocked(checkPermission).mockClear();
    payrollRead = false;
    expect((await call(entityChanges, { entityType: 'supplier', entityId: E })).statusCode).toBe(200);
    expect(checkPermission).not.toHaveBeenCalled();
  });

  it('the company-wide feed leaves the employee types out when Payroll read is missing, and carries them when it is held', async () => {
    expect((await call(entityChanges, {}, 'admin')).statusCode).toBe(200);
    expect(typesAsked()).not.toContain('payroll_employee');
    expect(typesAsked()).not.toContain('payroll_bank_detail');
    expect(typesAsked()).toContain('supplier');
    vi.mocked(listEntityChanges).mockClear();
    payrollRead = true;
    await call(entityChanges, {}, 'admin');
    expect(typesAsked()).toEqual(expect.arrayContaining(['payroll_employee', 'payroll_bank_detail']));
  });
});

describe('MCP entity_history', () => {
  const ctx = (role: string) => ({ userId: U, companyId: C, scopes: ['read:reports', 'read:payroll'], tokenJti: null, oauthAppId: null, companyRole: role });

  it('a manager without Payroll read is refused an employee timeline, and the feed leaves the employee types out', async () => {
    const refused = await entityHistoryTool.handler({ entity_type: 'payroll_employee', entity_id: E }, ctx('manager'));
    expect(refused.isError).toBe(true);
    expect(listEntityChanges).not.toHaveBeenCalled();
    await entityHistoryTool.handler({}, ctx('admin'));
    expect(typesAsked()).not.toContain('payroll_employee');
    expect(typesAsked()).not.toContain('payroll_bank_detail');
  });

  it('with Payroll read the timeline is returned', async () => {
    payrollRead = true;
    const res = await entityHistoryTool.handler({ entity_type: 'payroll_employee', entity_id: E }, ctx('manager'));
    expect(res.isError).toBeFalsy();
    expect(typesAsked()).toEqual(['payroll_employee']);
  });
});

describe('global search', () => {
  it('searches employees only when the person has Payroll read', async () => {
    await call(globalSearchRoute, { q: 'Thandi' });
    expect(globalSearch).toHaveBeenLastCalledWith(C, 'Thandi', 8, { includeEmployees: false });
    payrollRead = true;
    await call(globalSearchRoute, { q: 'Thandi' });
    expect(globalSearch).toHaveBeenLastCalledWith(C, 'Thandi', 8, { includeEmployees: true });
  });
});

describe('project time entries', () => {
  it('hourly_rate and billable_amount are dropped without Payroll read, kept with it; the hours and the name stay', async () => {
    const without = (await call(timeEntries, { projectId: E })).sent as { data: Record<string, unknown>[] };
    expect(without.data[0]).toEqual({ id: 't1', hours: 2, first_name: 'Thandi' });
    payrollRead = true;
    const withRead = (await call(timeEntries, { projectId: E })).sent as { data: Record<string, unknown>[] };
    expect(withRead.data[0]).toMatchObject({ hourly_rate: 450, billable_amount: 900 });
  });
});
