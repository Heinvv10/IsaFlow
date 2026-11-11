/**
 * Maps a case's fringe-benefit inputs (kept in `unmodelled` until FB) onto the engine's own entry point,
 * applyFringeBenefits, so the oracle costs a vehicle or a travel allowance the way a run does. The fixture's 3802
 * earning carries the benefit's amount as the source states it; it must equal what the engine derives from the
 * determined value (a mismatch throws, so a fixture cannot drift from the 3.5% / 3.25% rule). A 3810 earning is
 * marked non-cash, as a run does (markNonCashEmployerBenefits).
 */
import { applyFringeBenefits, type FringeBenefit, vehicleMonthlyBenefit } from '@/modules/accounting/services/payroll/fringeBenefits';
import { markNonCashEmployerBenefits } from '@/modules/accounting/services/payroll/employerContributions';
import type { EmployeeComponent } from '@/modules/accounting/services/payroll/payrollTypes';

type Unmodelled = Record<string, unknown> | undefined;
const num = (u: Unmodelled, k: string): number | undefined => (typeof u?.[k] === 'number' ? (u[k] as number) : undefined);
const bool = (u: Unmodelled, k: string): boolean | undefined => (typeof u?.[k] === 'boolean' ? (u[k] as boolean) : undefined);

export function withFringeBenefits(
  components: EmployeeComponent[], unmodelled: Unmodelled, period: { year: number; month: number },
): EmployeeComponent[] {
  const benefits: FringeBenefit[] = [];
  let rest = components;
  let vehicleComponent: EmployeeComponent['component'] | null = null;
  const value = num(unmodelled, 'vehicleDeterminedValue');
  if (value !== undefined) {
    const maintenance = bool(unmodelled, 'maintenancePlanIncluded') === true;
    const carried = components.find((c) => c.component.sarsSourceCode === '3802');
    if (!carried) throw new Error('A vehicle case needs its 3802 earning');
    const derived = vehicleMonthlyBenefit(value, maintenance);
    if (carried.amount !== derived) throw new Error(`The case's 3802 amount ${carried.amount} is not the engine's ${derived}`);
    vehicleComponent = carried.component;
    rest = components.filter((c) => c !== carried);
    benefits.push({
      id: 'oracle-vehicle', kind: 'company_vehicle', determinedValue: value, maintenancePlan: maintenance,
      businessUseAtLeast80: bool(unmodelled, 'businessUseAtLeast80Pct') === true, effectiveFrom: '2000-01-01', effectiveTo: null,
    });
  }
  const travel = bool(unmodelled, 'travelBusinessUseAtLeast80Pct');
  if (travel !== undefined) {
    benefits.push({
      id: 'oracle-travel', kind: 'travel_allowance', determinedValue: null, maintenancePlan: false,
      businessUseAtLeast80: travel, effectiveFrom: '2000-01-01', effectiveTo: null,
    });
  }
  return markNonCashEmployerBenefits(applyFringeBenefits(rest, benefits, vehicleComponent, period));
}
