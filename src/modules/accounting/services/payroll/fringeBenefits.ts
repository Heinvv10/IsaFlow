/**
 * Taxable fringe benefits that depend on facts about the employee rather than on a pay component: the company
 * vehicle (SARS 3802) and the travel allowance (3701). Pure: no database, no clock.
 *
 * Sources, each checked against the published text:
 *  - Company vehicle: 3.5% of the vehicle's determined value a month, 3.25% where a maintenance plan was included in
 *    the purchase price. Seventh Schedule para 7; PAYE-GEN-01-G21 (2027 tax year) Rev 1 p. 5 (PDF page 5), "Fringe
 *    benefit: employer - owned provided motor vehicles".
 *  - Travel allowance: 80% of it is remuneration for employees' tax; where the employer is satisfied that at least
 *    80% of the use of the vehicle for the year of assessment will be for business, only 20%. G21 p. 5,
 *    "Travelling allowance"; Fourth Schedule para 7 (the PAYE inclusion rule the guide restates).
 *  - The same 80 / 20 on the vehicle benefit: SARS e@syFile Employer Reconciliation BRS V25.3.0 code 4582, p. 105
 *    ("The portion (80 or 20%) of the allowance and benefit which is subject to PAYE", listing 3802). NAMED LIMIT:
 *    G21 itself states the 80 / 20 rule only for the travel allowance; the vehicle benefit rests on the BRS wording
 *    and the Seventh Schedule, which were not re-fetched in this PR (MEDIUM confidence, the oracle fixture says so).
 *
 * The full benefit is the IRP5 figure (code 3802 / 3701); only the PAYE inclusion is reduced. UIF and SDL on a
 * benefit follow its component's flags, as for any earning (payrollCalculator's non-cash design note).
 */
import { normaliseSarsCode } from './payeAnnualPayment';
import type { EmployeeComponent, PayrollComponent, PayrollPeriod } from './payrollTypes';

export type FringeKind = 'company_vehicle' | 'travel_allowance';

export interface FringeBenefit {
  id: string;
  kind: FringeKind;
  /** The vehicle's determined value (Seventh Schedule para 7); null for a travel allowance. */
  determinedValue: number | null;
  maintenancePlan: boolean;
  /** The employer is satisfied that at least 80% of the use will be for business: PAYE takes 20%, not 80%. */
  businessUseAtLeast80: boolean;
  /** YYYY-MM-DD. */
  effectiveFrom: string;
  effectiveTo: string | null;
}

export const VEHICLE_CODE = '3802';
export const TRAVEL_CODE = '3701';
/** G21 p. 5: the monthly fringe benefit rate of the determined value. */
export const VEHICLE_BENEFIT_RATE = 0.035;
/** G21 p. 5: with a maintenance plan included in the purchase price. */
export const VEHICLE_BENEFIT_RATE_MAINTENANCE_PLAN = 0.0325;
/** G21 p. 5: the share of the allowance or benefit that is remuneration. */
export const PAYE_INCLUSION_DEFAULT = 0.8;
/** G21 p. 5: where the employer is satisfied that at least 80% of the use is business. */
export const PAYE_INCLUSION_BUSINESS_USE = 0.2;

/** A real calendar day, YYYY-MM-DD (2026-02-31 is not). */
export function isRealIsoDay(s: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return false;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.getUTCFullYear() === Number(m[1]) && d.getUTCMonth() === Number(m[2]) - 1 && d.getUTCDate() === Number(m[3]);
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

/** The monthly vehicle fringe benefit (the IRP5 figure, code 3802). */
export function vehicleMonthlyBenefit(determinedValue: number, maintenancePlan: boolean): number {
  return round2(determinedValue * (maintenancePlan ? VEHICLE_BENEFIT_RATE_MAINTENANCE_PLAN : VEHICLE_BENEFIT_RATE));
}

export function payeInclusionRate(businessUseAtLeast80: boolean): number {
  return businessUseAtLeast80 ? PAYE_INCLUSION_BUSINESS_USE : PAYE_INCLUSION_DEFAULT;
}

/**
 * The PAYE inclusion of an earning, by its code: an explicit rate wins; a travel allowance (3701) with none is 80%
 * (G21 p. 5, Hein 2026-11-08: every existing 3701 earning); every other code has none (taxed whole). The one place the
 * default lives: the calculator and applyFringeBenefits both read it.
 */
export function effectiveInclusionRate(code: string | null | undefined, given: number | undefined): number | undefined {
  return given ?? (normaliseSarsCode(code) === TRAVEL_CODE ? payeInclusionRate(false) : undefined);
}

/** The part of an amount that is remuneration for PAYE, to the cent. */
export function includedInPaye(amount: number, share: number): number {
  return round2(amount * share);
}

/** A benefit counts for a whole month if its dates touch the month (para 7 values the use "per month"). */
export function benefitActiveInPeriod(b: Pick<FringeBenefit, 'effectiveFrom' | 'effectiveTo'>, period: PayrollPeriod): boolean {
  const mm = String(period.month).padStart(2, '0');
  const first = `${period.year}-${mm}-01`;
  const last = `${period.year}-${mm}-${String(new Date(Date.UTC(period.year, period.month, 0)).getUTCDate()).padStart(2, '0')}`;
  return b.effectiveFrom <= last && (b.effectiveTo === null || b.effectiveTo >= first);
}

/** A recorded benefit that cannot be put on the payslip: the caller says so on the line, never drops it silently. */
export class FringeBenefitConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FringeBenefitConfigError';
  }
}

type RatedComponent = EmployeeComponent & { payeInclusionRate?: number };

/**
 * The components a run costs with the employee's fringe benefits applied: a non-cash 3802 earning at the monthly
 * vehicle benefit, and the PAYE inclusion rate on a 3701 travel allowance. Input is not mutated. Throws, rather than
 * leaving a benefit off the payslip, when a vehicle is recorded and the company has no 3802 earning to carry it, or
 * when the employee already has an assigned 3802 earning (the benefit would be counted twice).
 */
export function applyFringeBenefits(
  components: readonly EmployeeComponent[],
  benefits: readonly FringeBenefit[],
  vehicleComponent: PayrollComponent | null,
  period: PayrollPeriod,
): EmployeeComponent[] {
  const active = benefits.filter((b) => benefitActiveInPeriod(b, period));
  const travel = active.find((b) => b.kind === 'travel_allowance');
  const rated: RatedComponent[] = components.map((c) =>
    travel && c.component.componentType === 'earning' && normaliseSarsCode(c.component.sarsSourceCode) === TRAVEL_CODE
      ? { ...c, payeInclusionRate: payeInclusionRate(travel.businessUseAtLeast80) }
      : c);
  for (const v of active.filter((b) => b.kind === 'company_vehicle')) {
    if (v.determinedValue === null) throw new FringeBenefitConfigError('A company vehicle benefit has no determined value');
    if (!vehicleComponent) {
      throw new FringeBenefitConfigError('A company vehicle is recorded but the company has no active taxable earning coded 3802 to carry the benefit');
    }
    if (rated.some((c) => c.component.componentType === 'earning' && normaliseSarsCode(c.component.sarsSourceCode) === VEHICLE_CODE)) {
      throw new FringeBenefitConfigError('A company vehicle is recorded and a 3802 earning is already assigned: remove one, the benefit would be counted twice');
    }
    rated.push({
      component: vehicleComponent,
      amount: vehicleMonthlyBenefit(v.determinedValue, v.maintenancePlan),
      isNonCash: true,
      payeInclusionRate: payeInclusionRate(v.businessUseAtLeast80),
    });
  }
  return rated;
}
