/**
 * The approval gate fails CLOSED when the caller cannot read the employee change history (888) it needs for end-date
 * and termination-detail changes after calculation (blind review 2026-11-02, L2): an unreadable history is not "no
 * change". entityChangeQuery answers null for a caller whose role RLS hides payroll_employee changes from.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/neon', () => ({
  sql: vi.fn(async (strings: TemplateStringsArray) => {
    const text = strings.join('?');
    if (text.includes('FROM payroll_run_headers WHERE id')) return [{ period_year: 2026, period_month: 3 }];
    return [];
  }),
}));
vi.mock('@/modules/accounting/services/payroll/payrollEmployeeService', () => ({
  listPayrollRunEmployees: vi.fn(async () => [{ id: '22222222-2222-4222-8222-222222222222' }]),
}));
vi.mock('@/modules/accounting/services/core/entityChanges/entityChangeQuery', () => ({
  payrollTermsChangedSinceCalculation: vi.fn(async () => null),
}));

import { runLinesRefusal } from '@/modules/accounting/services/payroll/payrollRunRecalcGate';

describe('runLinesRefusal when the employee history is unreadable', () => {
  it('refuses, saying who may approve', async () => {
    const out = await runLinesRefusal('11111111-1111-4111-8111-111111111111', '33333333-3333-4333-8333-333333333333');
    expect(out?.code).toBe('employee_history_unreadable');
    expect(out?.detail).toMatch(/owner, admin or manager/);
  });
});
