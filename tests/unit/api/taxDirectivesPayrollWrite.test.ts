/**
 * #1656 round 8 (LOW): POST /api/accounting/tax-directives (and PATCH / DELETE of one) needs Payroll WRITE, not read alone. The real
 * withPayrollDetailAccess is in the stack; only the permission answer is scripted.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

vi.mock('@/lib/auth/permissionService', async (orig) => (await import('../helpers/modulePermissionMock')).permissionServiceAllowing(await orig<object>()));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/auth', () => ({ withAuth: (h: unknown) => h }));
vi.mock('@/lib/auth/withCsrf', () => ({ withCsrf: (h: unknown) => h }));
vi.mock('@/lib/api-error-handler', () => ({ withErrorHandler: (h: unknown) => h }));
vi.mock('@/modules/accounting/services/payroll/taxDirectiveService', async (orig) => ({
  ...(await orig<object>()),
  listTaxDirectives: vi.fn(async () => []),
  createTaxDirective: vi.fn(async () => ({ id: 'd1' })),
}));

import { checkPermission } from '@/lib/auth/permissionService';
import { createTaxDirective, listTaxDirectives } from '@/modules/accounting/services/payroll/taxDirectiveService';
import handler from '../../../pages/api/accounting/tax-directives/index';

const C = '11111111-1111-4111-8111-111111111111';
const U = '99999999-9999-4999-8999-999999999999';
let perms = { read: true, write: false };

function call(method: string, body: unknown = {}) {
  const req = { method, query: {}, body, companyId: C, companyRole: 'manager', user: { id: U }, headers: {}, cookies: {} } as unknown as NextApiRequest;
  const res = { statusCode: 0, sent: undefined as unknown, setHeader() { return this; }, status(c: number) { this.statusCode = c; return this; }, json(p: unknown) { this.sent = p; return this; }, end() { return this; } };
  return Promise.resolve((handler as (a: NextApiRequest, b: NextApiResponse) => unknown)(req, res as unknown as NextApiResponse)).then(() => res);
}

beforeEach(() => {
  vi.clearAllMocks();
  perms = { read: true, write: false };
  vi.mocked(checkPermission).mockImplementation(async (_c, _u, module, action) => module !== 'payroll' || (action === 'read' ? perms.read : action === 'write' ? perms.write : true));
});

describe('/api/accounting/tax-directives', () => {
  it('POST with Payroll read but not write: 403 and nothing is created', async () => {
    const res = await call('POST', { employeeId: C });
    expect(res.statusCode).toBe(403);
    expect(checkPermission).toHaveBeenCalledWith(C, U, 'payroll', 'write');
    expect(createTaxDirective).not.toHaveBeenCalled();
  });
  it('GET with Payroll read alone lists them', async () => {
    expect((await call('GET')).statusCode).toBe(200);
    expect(listTaxDirectives).toHaveBeenCalledTimes(1);
  });
  it('POST with Payroll write passes the gate (the body is then validated, not refused 403)', async () => {
    perms.write = true;
    expect((await call('POST', {})).statusCode).not.toBe(403);
  });
});
