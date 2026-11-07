/** Wave 4 B: the employee record carries payment_method (mig 455) so the profile can tell cash from EFT. */
import { describe, it, expect } from 'vitest';
import { mapPayrollEmployeeRow } from '@/modules/accounting/services/payroll/payrollEmployeeService';

const row = (over: Record<string, unknown> = {}) => ({
  id: 'e1', company_id: 'c1', employee_number: 'E-1', first_name: 'A', last_name: 'B', employment_type: 'permanent',
  start_date: '2026-01-01', uif_excluded: false, medical_aid_main_member: false, medical_aid_dependants_count: 0, ...over,
});

describe('mapPayrollEmployeeRow paymentMethod', () => {
  it('maps cash and eft', () => {
    expect(mapPayrollEmployeeRow(row({ payment_method: 'cash' })).paymentMethod).toBe('cash');
    expect(mapPayrollEmployeeRow(row({ payment_method: 'eft' })).paymentMethod).toBe('eft');
  });
  it('defaults to eft when the column is absent', () => {
    expect(mapPayrollEmployeeRow(row()).paymentMethod).toBe('eft');
  });
});
