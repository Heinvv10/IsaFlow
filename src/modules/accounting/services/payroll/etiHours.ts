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

/**
 * Hours employed and paid in the month, for ETI. An hourly or daily employee: the run's hours (HD's `runHoursOf`:
 * hours, or days x hours per day). A monthly employee: ordinary hours a week x 52 / 12, times the share of the month
 * employed (a starter or leaver is employed for part of it: s7(5) "the number of hours ... employed ... in that month").
 * Null when it cannot be told (no hours a week recorded; no run hours): never a full month by default.
 */
export function etiHoursOf(
  employee: Pick<PayrollEmployee, 'payBasis' | 'hoursPerWeek' | 'startDate' | 'endDate'>,
  period: PayrollPeriod,
  runHours: number | null,
): number | null {
  if (unitOf(employee) != null) return runHours;
  const perWeek = employee.hoursPerWeek == null ? null : Number(employee.hoursPerWeek);
  if (perWeek == null || !Number.isFinite(perWeek) || perWeek <= 0) return null;
  return round2(((perWeek * 52) / 12) * employedShareOfMonth(period, employee.startDate, employee.endDate));
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
 * The non-cash earnings left out of ETI "monthly remuneration": every item flagged non-cash and every 38xx fringe benefit
 * (3801 low-interest loan, 3802 company vehicle, 3810 employer medical contribution, ...). From 1 March 2022 the proviso
 * to the s1 definition disregards "an amount other than a cash payment to the employee" (ETI guide Issue 5, §2.4.1 p. 18).
 * Cash allowances stay in (guide §2.4 p. 17: allowances are monthly remuneration; transport allowances at their 80% or
 * 20% remuneration share).
 */
export function nonCashEarnings(components: EmployeeComponent[]): number {
  return components
    .filter((c) => c.component.componentType === 'earning'
      && (c.isNonCash === true || /^38\d\d$/.test(normaliseSarsCode(c.component.sarsSourceCode))))
    .reduce((t, c) => t + c.amount, 0);
}

/** s7(5) gross-up: the remuneration as if paid for 160 hours. A full month or more is unchanged. */
export function grossUpTo160(remuneration: number, hours: number): number {
  return hours >= ETI_FULL_MONTH_HOURS ? remuneration : (remuneration * ETI_FULL_MONTH_HOURS) / hours;
}

/** s7(5) gross-down: the share of the table value for the hours, at most 1. */
export function hoursShare(hours: number): number {
  return Math.min(1, hours / ETI_FULL_MONTH_HOURS);
}
