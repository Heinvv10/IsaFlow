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

describe('calculation version 10: regular-pay directives (DR) on top of explanations (EX-core, 9), ETI by hours (ET, 8), fringe benefits (FB, 7) and tax status (TS-b, 6)', () => {
  it('is the current version', () => {
    expect(PAYROLL_CALCULATION_VERSION).toBe(10);
  });

  it('refuses a run calculated by version 9 or unstamped, approves one calculated by version 10', async () => {
    expect([await refusal(9), await refusal(null), await refusal(10)]).toEqual(['recalculate_required', 'recalculate_required', null]);
  });
});
