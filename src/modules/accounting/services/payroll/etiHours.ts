/**
 * ETI by hours, and the minimum-wage condition (master plan wave 5, ET). Pure.
 *
 * Sources (SARS Guide to the Employment Tax Incentive, Issue 5, 27 July 2026; ETI Act 26 of 2013 as amended):
 *  - Part-month apportionment, ETI Act s7(5) and the definition of "monthly remuneration" (b) in s1: for fewer than 160
 *    hours employed and paid in a month, the remuneration is grossed up to 160 hours, the table is applied to the
 *    grossed-up figure, and the result is multiplied by hours / 160 (guide §2.4.1 p. 18, §5.3 pp. 40-41, Examples 15
 *    and 16: R2 100 for 70 h grosses up to R4 800, R1 500 x 70/160 = R656.25). The 160 hours of s7(5) are not limited to
 *    ordinary hours (§5.3, footnote 147).
 *  - Minimum wage, ETI Act s4(1)(a): no ETI for a month whose wage is below the national minimum wage (guide §4.1 pp. 29-31).
 *    "Wage" is the money paid for ordinary hours of work (guide §2.7 p. 20, the BCEA definition); the National Minimum
 *    Wage Act 9 of 2018 s5(1) excludes allowances that enable work, payment in kind, and gratuities including bonuses.
 *    "In most circumstances amounts paid in the form of a bonus, overtime or car and subsistence allowances will not
 *    constitute amounts paid in respect of ordinary hours" (guide §2.7 p. 21).
 */
import { normaliseSarsCode } from './payeAnnualPayment';
import { employedShareOfMonth } from './employmentTerms';
import { unitOf } from './payrollRunHours';
import type { EmployeeComponent, PayrollEmployee, PayrollPeriod } from './payrollTypes';

/** ETI Act s7(5): the full month for ETI. */
export const ETI_FULL_MONTH_HOURS = 160;

const round2 = (n: number): number => Math.round(n * 100) / 100;

/** ETI's hours for a month: s7(5)'s hours (ordinary + overtime) and the ordinary hours the minimum wage is tested on. */
export interface EtiHours {
  /** Hours employed and paid in the month (s7(5)): ordinary plus overtime. Null when they cannot be told. */
  hours: number | null;
  /** Ordinary hours paid (s4(4): "hours" are ordinary hours): the minimum-wage divisor. Null: no test. */
  ordinaryHours: number | null;
  /** True when the hours are the R-B assumption (40 a week), not recorded: ETI_HOURS_UNKNOWN still warns. */
  assumed: boolean;
}

/** Hein's ruling R-B (wave 5 ET round 1): a monthly starter or leaver with no hours a week recorded works 40 a week. */
export const ASSUMED_HOURS_PER_WEEK = 40;
const UNKNOWN: EtiHours = { hours: null, ordinaryHours: null, assumed: false };

/**
 * Overtime hours paid (SARS 3607): a row's own quantity in hours, else its amount / (1.5 x the ordinary hourly rate) (BCEA
 * s10(2): overtime at one and a half times the wage). The guide §5.3 fn 147: the 160 hours of s7(5) are not limited to
 * ordinary hours, so paid overtime counts. NAMED LIMIT: overtime paid at double time (Sundays, BCEA s16) without a
 * quantity is read as 1.5x, so its hours are overstated.
 */
export function overtimeHours(components: EmployeeComponent[], ordinaryRate: number): number {
  return components
    .filter((c) => c.component.componentType === 'earning' && normaliseSarsCode(c.component.sarsSourceCode) === '3607')
    .reduce((h, c) => h + (c.quantity != null && c.quantityUnit === 'hour'
      ? Number(c.quantity)
      : ordinaryRate > 0 ? c.amount / (1.5 * ordinaryRate) : 0), 0);
}

/**
 * Hours employed and paid in the month, for ETI.
 *  - Hourly or daily: the run's hours (HD's `runHoursOf`: hours, or days x hours per day) are the ordinary hours.
 *  - Monthly: ordinary hours a week x 52 / 12, times the share of the month employed (a starter or leaver).
 *  - Overtime hours paid are added for s7(5), never for the minimum-wage test.
 *  - Unknown: null, never a full month. Except R-B: a monthly starter or leaver with no hours a week is taken at 40 a
 *    week x the share employed, for the apportionment only (no minimum-wage test on assumed hours).
 * NAMED LIMIT: unpaid leave is not recorded, so a monthly employee's paid hours are the contracted ones. The guide treats
 * an unpaid-leave month as a full month, with no gross-up (§4.1 p. 31), which this follows; but the minimum-wage test then
 * divides a short month's pay by the full month's hours (ETI_MINIMUM_WAGE_FAILED says so).
 */
export function etiHoursOf(
  employee: Pick<PayrollEmployee, 'payBasis' | 'hoursPerWeek' | 'startDate' | 'endDate'>,
  period: PayrollPeriod,
  runHours: number | null,
  components: EmployeeComponent[],
): EtiHours {
  let ordinary: number;
  if (unitOf(employee) != null) {
    if (runHours == null) return UNKNOWN;
    ordinary = runHours;
  } else {
    const perWeek = employee.hoursPerWeek == null ? null : Number(employee.hoursPerWeek);
    const share = employedShareOfMonth(period, employee.startDate, employee.endDate);
    if (perWeek == null || !Number.isFinite(perWeek) || perWeek <= 0) {
      return share < 1 ? { hours: round2(((ASSUMED_HOURS_PER_WEEK * 52) / 12) * share), ordinaryHours: null, assumed: true } : UNKNOWN;
    }
    ordinary = round2(((perWeek * 52) / 12) * share);
  }
  const wage = ordinaryWageCents(components) / 100;
  const overtime = overtimeHours(components, ordinary > 0 ? wage / ordinary : 0);
  return { hours: round2(ordinary + overtime), ordinaryHours: ordinary, assumed: false };
}

/**
 * The wage for ordinary hours, in cents: cash basic pay (SARS 3601) only. Overtime (3607), the annual bonus (3605),
 * commission, allowances (37xx) and non-cash benefits are left out (NMW Act s5(1); guide §2.7).
 * NAMED LIMIT: back pay for an earlier month paid on 3601 is counted, though the guide (§4.1 p. 30, Example 8) leaves it
 * out; nothing marks it.
 */
export function ordinaryWageCents(components: EmployeeComponent[]): number {
  return components
    .filter((c) => c.component.componentType === 'earning' && !c.isNonCash && normaliseSarsCode(c.component.sarsSourceCode) === '3601')
    .reduce((cents, c) => cents + Math.round(c.amount * 100), 0);
}

/**
 * True when the wage is below the minimum for the hours: wage < rate x hours, compared exactly in whole cents and
 * hundredths of an hour (R4 606.39 for 160 h at R28.79 is 1c below; R4 606.40 is not).
 */
export function belowMinimumWage(wageCents: number, hours: number, centsPerHour: number): boolean {
  return wageCents * 100 < centsPerHour * Math.round(hours * 100);
}

/**
 * ETI "monthly remuneration": the Fourth Schedule para 1 remuneration paid in cash (ETI Act s1; guide §2.4 pp. 15-17).
 *  - Only taxable earnings: a reimbursive allowance within the prescribed rate (3703) and other non-taxable payments are not
 *    remuneration (guide §2.4 p. 17-18).
 *  - A fixed travel allowance (3701) at 80%, the share para 1 includes (guide §2.4 p. 17). NAMED LIMIT: the 20% share for
 *    business use above 80% is not recorded until FB, so 80% is used.
 *  - No non-cash payment: every item flagged non-cash and every 38xx fringe benefit (3801 loan, 3802 vehicle, 3810
 *    medical) is left out; from 1 March 2022 the proviso disregards "an amount other than a cash payment" (§2.4.1 p. 18).
 */
export function etiRemunerationOf(components: EmployeeComponent[]): number {
  return components.reduce((t, c) => {
    const code = normaliseSarsCode(c.component.sarsSourceCode);
    if (c.component.componentType !== 'earning' || !c.component.isTaxable || c.isNonCash === true || /^38\d\d$/.test(code)) return t;
    return t + (code === '3701' ? c.amount * 0.8 : c.amount);
  }, 0);
}

/** s7(5) gross-up: the remuneration as if paid for 160 hours. A full month or more is unchanged. */
export function grossUpTo160(remuneration: number, hours: number): number {
  return hours >= ETI_FULL_MONTH_HOURS ? remuneration : (remuneration * ETI_FULL_MONTH_HOURS) / hours;
}

/** s7(5) gross-down: the share of the table value for the hours, at most 1. */
export function hoursShare(hours: number): number {
  return Math.min(1, hours / ETI_FULL_MONTH_HOURS);
}
