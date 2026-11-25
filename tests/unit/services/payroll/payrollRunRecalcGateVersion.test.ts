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

describe('calculation version 23: the year to date counted in the current pay frequency after a mid-year change (FQe) on top of the 53rd weekly / 27th fortnightly pay day warns (W53, W1) on top of recurring earnings apportioned inside employment (PRA, W29) on top of monthly off-cycle bonus and termination runs (OC) on top of weekly and fortnightly runs and the month-level SDL (FQd, 19), overtime and travel km (RI, 18), defined-benefit fund values (DBF, 17), personal service providers (PSP, 16), garnishee orders (GA, 15), weekly and fortnightly (FQc, 14), days-based annualisation (AN, 13), UIF floored at nil (UF, 12), regular-pay directives (DR, 11), RF (10), explanations (EX-core, 9), ETI by hours (ET, 8), fringe benefits (FB, 7) and tax status (TS-b, 6)', () => {
  it('is the current version', () => {
    expect(PAYROLL_CALCULATION_VERSION).toBe(23);
  });

  it('refuses a run calculated by version 22 or unstamped, approves one calculated by version 23', async () => {
    expect([await refusal(22), await refusal(null), await refusal(23)]).toEqual(['recalculate_required', 'recalculate_required', null]);
  });
});
