/**
 * Employee routes, work terms (mig 967): the request log masks every term (maskBodyKeys, proven through the real
 * sanitizer), the priced terms (status, basis, rates) are owner/admin only (a manager gets 403 and nothing is written),
 * and every answer, refusals included, is no-store.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

const masks = vi.hoisted(() => [] as Array<readonly string[] | undefined>);
type H = (req: NextApiRequest, res: NextApiResponse) => unknown;
vi.mock('@/lib/auth', () => ({ withAuth: (h: H) => h }));
vi.mock('@/lib/auth/withCsrf', () => ({ withCsrf: (h: H) => h }));
vi.mock('@/lib/auth/withWriteAccess', () => ({ withWriteAccess: (h: H) => h }));
vi.mock('@/lib/apiDocumentLock', () => ({ respondIfLockTimeout: () => false }));
vi.mock('@/lib/api-error-handler', () => ({
  withErrorHandler: (h: H, o?: { maskBodyKeys?: readonly string[] }) => { masks.push(o?.maskBodyKeys); return h; },
}));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/neon', async (importOriginal) => ({ ...await importOriginal<object>(), sql: vi.fn().mockResolvedValue([]), withSavepoint: (_n: string, f: () => unknown) => f() }));
const current = {
  id: 'e1', companyId: 'c1', employeeNumber: 'E1', firstName: 'A', lastName: 'B', employmentType: 'permanent', startDate: new Date(2020, 0, 1),
  taxStatus: 'employee', payBasis: 'monthly',
};
vi.mock('@/modules/accounting/services/payroll/payrollEmployeeService', () => ({
  listPayrollEmployees: vi.fn().mockResolvedValue([]),
  createPayrollEmployee: vi.fn().mockResolvedValue({ id: 'e1' }),
  getPayrollEmployee: vi.fn(async () => current),
  updatePayrollEmployee: vi.fn(async () => current),
}));
vi.mock('@/lib/apiResponse', () => ({
  apiResponse: { success: vi.fn(), created: vi.fn(), badRequest: vi.fn(), forbidden: vi.fn(), notFound: vi.fn(), methodNotAllowed: vi.fn() },
}));

import { apiResponse } from '@/lib/apiResponse';
import { sanitizeRequestBody, maskedKeySet } from '@/lib/sanitizeRequestBody';
import { createPayrollEmployee, updatePayrollEmployee } from '@/modules/accounting/services/payroll/payrollEmployeeService';
import { EMPLOYEE_TERM_LOG_KEYS } from '@/modules/accounting/services/payroll/payrollEmployeeTerms';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — pages/ is outside src/ so the @/ alias won't resolve; relative path needed
import indexHandler from '../../../pages/api/payroll/employees/index';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore
import idHandler from '../../../pages/api/payroll/employees/[id]';

const BASE = { firstName: 'A', lastName: 'B', employeeNumber: 'E1', employmentType: 'permanent', startDate: '2026-11-01' };
function call(handler: unknown, method: string, role: string, body: Record<string, unknown>) {
  const req = { method, query: { id: 'e1' }, body, companyId: 'c1', companyRole: role, user: { id: 'u1' } } as unknown as NextApiRequest;
  const res = { setHeader: vi.fn() };
  return (handler as (r: NextApiRequest, s: NextApiResponse) => Promise<void>)(req, res as unknown as NextApiResponse).then(() => res);
}

beforeEach(() => vi.clearAllMocks());

describe('the request log', () => {
  it('both routes mask every term, and the real sanitizer hides each value', () => {
    expect(masks).toHaveLength(2);
    for (const m of masks) {
      expect(m).toEqual(EMPLOYEE_TERM_LOG_KEYS);
      const body = { firstName: 'A', taxStatus: 'director', payBasis: 'hourly', hoursPerWeek: 40, hoursPerDay: 8, hourlyRate: 120, dailyRate: 900, occupation: 'Welder' };
      const logged = sanitizeRequestBody(body, 1, maskedKeySet(m)) as Record<string, unknown>;
      expect(logged.firstName).toBe('A');
      for (const k of ['taxStatus', 'payBasis', 'hoursPerWeek', 'hoursPerDay', 'hourlyRate', 'dailyRate', 'occupation']) {
        expect(String(logged[k]), k).toMatch(/^\[omitted/);
      }
    }
  });
});

describe('priced terms: owner and admin only', () => {
  it.each([{ taxStatus: 'director' }, { payBasis: 'hourly', hourlyRate: 100 }, { dailyRate: 5 }])('a manager creating with %j is 403 and writes nothing', async (over) => {
    const res = await call(indexHandler, 'POST', 'manager', { ...BASE, ...over });
    expect(apiResponse.forbidden).toHaveBeenCalled();
    expect(createPayrollEmployee).not.toHaveBeenCalled();
    expect(res.setHeader).toHaveBeenCalledWith('Cache-Control', 'no-store');
  });

  it('an admin creating a director succeeds', async () => {
    await call(indexHandler, 'POST', 'admin', { ...BASE, taxStatus: 'director' });
    expect(createPayrollEmployee).toHaveBeenCalledTimes(1);
  });

  it('a manager PATCHing a rate is 403 and nothing is updated; an occupation is fine', async () => {
    const res = await call(idHandler, 'PATCH', 'manager', { hourlyRate: 80 });
    expect(apiResponse.forbidden).toHaveBeenCalled();
    expect(updatePayrollEmployee).not.toHaveBeenCalled();
    expect(res.setHeader).toHaveBeenCalledWith('Cache-Control', 'no-store');
    await call(idHandler, 'PATCH', 'manager', { occupation: 'Clerk' });
    expect(updatePayrollEmployee).toHaveBeenCalledTimes(1);
  });

  it('a refused body (hours 200) is a 400, no-store, nothing updated', async () => {
    const res = await call(idHandler, 'PATCH', 'owner', { hoursPerWeek: 200 });
    expect(apiResponse.badRequest).toHaveBeenCalled();
    expect(updatePayrollEmployee).not.toHaveBeenCalled();
    expect(res.setHeader).toHaveBeenCalledWith('Cache-Control', 'no-store');
  });
});
