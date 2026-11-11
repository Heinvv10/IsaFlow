/** updatePayrollEmployee: a change of employment type waits for the company's payroll-approval lock (TS-b: it feeds the director check and the hours warning). */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const lock = vi.hoisted(() => vi.fn(async () => undefined));
const ROW = {
  id: 'e1', company_id: 'c1', employee_number: 'E1', first_name: 'A', last_name: 'B', employment_type: 'permanent',
  start_date: '2020-01-01', tax_status: 'employee', pay_basis: 'monthly',
};
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/fmtDate', () => ({ fmtDate: (d: unknown) => String(d) }));
vi.mock('@/lib/neon', () => ({
  sql: vi.fn(async () => []),
  withTransaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(vi.fn(async () => [ROW]))),
}));
vi.mock('@/modules/accounting/services/payroll/payrollCompanyLock', () => ({ lockCompanyPayrollForComponentChange: lock }));
vi.mock('@/modules/accounting/services/payroll/payrollEmployeeHistoryService', () => ({ recordEmployeeChange: vi.fn(async () => undefined) }));

import { updatePayrollEmployee } from '@/modules/accounting/services/payroll/payrollEmployeeService';

beforeEach(() => lock.mockClear());

describe('updatePayrollEmployee and the payroll-approval lock', () => {
  it('takes it for an employment type change', async () => {
    await updatePayrollEmployee('e1', 'c1', { employmentType: 'casual' });
    expect(lock).toHaveBeenCalledTimes(1);
  });
  it('does not take it for a name change', async () => {
    await updatePayrollEmployee('e1', 'c1', { firstName: 'Z' });
    expect(lock).not.toHaveBeenCalled();
  });
});
