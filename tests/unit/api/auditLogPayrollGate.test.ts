/**
 * #1656 round 8 (breaker HIGH): GET /api/accounting/audit-log, audit-log-entity and audit-log-export return `changes` / `metadata` of
 * payroll entity types only to a person with Payroll read. Naming such a type without it is a 403; every other request is made with
 * payrollRead=false, which the service applies to the rows AND the count (the CSV rides the same call).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

vi.mock('@/lib/auth/permissionService', async (orig) => (await import('../helpers/modulePermissionMock')).permissionServiceAllowing(await orig<object>()));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/auth', () => ({ withAuth: (h: unknown) => h, withWriteAccess: (h: unknown) => h }));
vi.mock('@/lib/api-error-handler', () => ({ withErrorHandler: (h: unknown) => h }));
vi.mock('@/lib/rateLimit', () => ({ checkReportRateLimit: vi.fn(async () => true) }));
vi.mock('@/lib/trustedClientIp', () => ({ trustedClientIp: () => null }));
vi.mock('@/modules/accounting/services/core/auditTrailService', async (orig) => ({
  ...(await orig<object>()),
  getAuditLog: vi.fn(async () => ({ items: [], total: 0 })),
  getEntityHistory: vi.fn(async () => []),
  logAuditOrThrow: vi.fn(async () => undefined),
}));

import { checkPermission } from '@/lib/auth/permissionService';
import { getAuditLog, getEntityHistory } from '@/modules/accounting/services/core/auditTrailService';
import { PAYROLL_AUDIT_ENTITY_TYPES } from '@/modules/accounting/services/core/auditPayrollTypes';
import list from '../../../pages/api/accounting/audit-log';
import entity from '../../../pages/api/accounting/audit-log-entity';
import exportCsv from '../../../pages/api/accounting/audit-log-export';

const C = '11111111-1111-4111-8111-111111111111';
const U = '99999999-9999-4999-8999-999999999999';
const ID = '22222222-2222-4222-8222-222222222222';
let payrollRead = false;

function get(handler: unknown, query: Record<string, unknown>) {
  const req = { method: 'GET', query, companyId: C, companyRole: 'manager', user: { id: U, email: 'u@x.test' }, headers: {} } as unknown as NextApiRequest;
  const res = { statusCode: 0, sent: undefined as unknown, setHeader() { return this; }, status(c: number) { this.statusCode = c; return this; }, json(p: unknown) { this.sent = p; return this; }, send(p: unknown) { this.sent = p; return this; }, end() { return this; } };
  return Promise.resolve((handler as (a: NextApiRequest, b: NextApiResponse) => unknown)(req, res as unknown as NextApiResponse)).then(() => res);
}

beforeEach(() => {
  vi.clearAllMocks();
  payrollRead = false;
  vi.mocked(checkPermission).mockImplementation(async (_c, _u, module, action) => !(module === 'payroll' && action === 'read') || payrollRead);
});

describe.each([['audit-log', list], ['audit-log-export', exportCsv]] as const)('%s', (_name, handler) => {
  it.each(PAYROLL_AUDIT_ENTITY_TYPES)('without Payroll read, asking for %s by name is a 403 and nothing is read', async (t) => {
    const res = await get(handler, { entity_type: t });
    expect(res.statusCode).toBe(403);
    expect(getAuditLog).not.toHaveBeenCalled();
  });
  it('without Payroll read any other request reads with payrollRead=false (the payroll types are excluded from rows and count)', async () => {
    expect((await get(handler, { entity_type: 'supplier_invoice' })).statusCode).toBe(200);
    expect((await get(handler, {})).statusCode).toBe(200);
    expect(vi.mocked(getAuditLog).mock.calls.map((c) => c[1].payrollRead)).toEqual([false, false]);
  });
  it('with Payroll read a payroll type may be asked for, and the read is made with payrollRead=true', async () => {
    payrollRead = true;
    expect((await get(handler, { entity_type: 'tax_directive' })).statusCode).toBe(200);
    expect(vi.mocked(getAuditLog).mock.calls[0]![1].payrollRead).toBe(true);
  });
});

describe('audit-log-entity', () => {
  it.each(PAYROLL_AUDIT_ENTITY_TYPES)('without Payroll read, the history of a %s is a 403', async (t) => {
    expect((await get(entity, { type: t, id: ID })).statusCode).toBe(403);
    expect(getEntityHistory).not.toHaveBeenCalled();
  });
  it('another type is read with payrollRead=false; with Payroll read a payroll type is returned', async () => {
    expect((await get(entity, { type: 'supplier_invoice', id: ID })).statusCode).toBe(200);
    expect(vi.mocked(getEntityHistory).mock.calls[0]![3]).toBe(false);
    payrollRead = true;
    expect((await get(entity, { type: 'payroll_employee', id: ID })).statusCode).toBe(200);
    expect(vi.mocked(getEntityHistory).mock.calls[1]![3]).toBe(true);
  });
});
