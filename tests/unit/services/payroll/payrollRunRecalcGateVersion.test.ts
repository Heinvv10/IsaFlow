/**
 * A run calculated before calculation version 4 (only s11F retirement contributions and s18A donations reduce PAYE,
 * para 2(4)) is refused at approval until it is recalculated (payrollRunRecalcGate.recalculateRequiredRefusal).
 */
import { describe, expect, it, vi } from 'vitest';

const stamp = vi.hoisted(() => ({ version: null as number | null }));
vi.mock('@/lib/neon', () => ({
  sql: vi.fn(async () => [{ calculation_version: stamp.version }]),
}));
vi.mock('@/modules/accounting/services/payroll/payrollEmployeeService', () => ({ listPayrollRunEmployees: vi.fn() }));
vi.mock('@/modules/accounting/services/core/entityChanges/entityChangeQuery', () => ({ payrollTermsChangedSinceCalculation: vi.fn() }));

import { recalculateRequiredRefusal } from '@/modules/accounting/services/payroll/payrollRunRecalcGate';
import { PAYROLL_CALCULATION_VERSION } from '@/modules/accounting/services/payroll/payrollCalculationVersion';

const refusal = async (version: number | null) => {
  stamp.version = version;
  return (await recalculateRequiredRefusal('11111111-1111-4111-8111-111111111111', '33333333-3333-4333-8333-333333333333'))?.code ?? null;
};

describe('calculation version 7: fringe benefits (FB) on top of hours and days (5) and which deductions reduce PAYE (4)', () => {
  it('is the current version', () => {
    expect(PAYROLL_CALCULATION_VERSION).toBe(7);
  });

  it('refuses a run calculated by version 5 or unstamped, approves one calculated by version 7', async () => {
    expect([await refusal(5), await refusal(null), await refusal(7)]).toEqual(['recalculate_required', 'recalculate_required', null]);
  });
});
