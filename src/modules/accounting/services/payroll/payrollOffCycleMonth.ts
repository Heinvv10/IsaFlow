/**
 * An off-cycle line's month (wave 6 OC). A bonus or termination run supplements its month's regular run, and two of the
 * statutory figures are MONTHLY figures that the month's runs share, so the off-cycle line carries only what the month
 * adds to what its earlier final lines (the regular run, any earlier off-cycle run) already took:
 *
 *  - UIF: UIC Act 4 of 2002 s6(1): 1% each of the remuneration paid "during the month"; s6(2): not on remuneration
 *    above the ceiling "during any month". So the month's contributions together never pass 1% of the monthly ceiling:
 *    this line pays its own 1%, but at most the cap less what the month's earlier lines contributed, never below nil.
 *    (That equals 1% × min(month's remuneration, ceiling) less the earlier contributions, to within the cent rounding
 *    of each line.) Spec F12: this cross-run cap is for a monthly employee's off-cycle runs only.
 *  - ETI: Employment Tax Incentive Act 26 of 2013 s7(1)-(3): the incentive is a monthly amount on the employee's
 *    "monthly remuneration" (s1: the remuneration paid in the month), and s7(5) apportions it by the hours of the
 *    month. So the month's ETI is recomputed on everything the month paid (the earlier lines' earnings, rebuilt from
 *    their stored breakdown, plus this line's) and the line carries the difference from what the earlier lines
 *    claimed. Above the s7 table's flat band the incentive falls as remuneration rises, so a bonus can make the
 *    difference NEGATIVE: the month's over-claim reversed on this line (the EMP201 nets it in the month's ETI).
 *
 * Pure. The earlier lines are read by payrollOffCycleMonthRead.ts.
 */
import { getTaxYearConfig } from './taxTables';
import { UIF_RATE } from './uifEngine';
import type { EmployeeComponent, UifResult } from './payrollTypes';

/** What the month's earlier final lines of the employee hold (all of them summed; none = zeros and no components). */
export interface MonthEarlierLines {
  uifEmployee: number;
  uifEmployer: number;
  eti: number;
  /** The earnings those lines paid, rebuilt from their stored breakdown: the month's ETI base, hours and wage. */
  etiComponents: EmployeeComponent[];
}

export const NO_EARLIER_LINES: MonthEarlierLines = { uifEmployee: 0, uifEmployer: 0, eti: 0, etiComponents: [] };

const round2 = (n: number): number => Math.round(n * 100) / 100;

/** The most UIF the month's lines may contribute between them, each of employee and employer. */
export function monthUifCap(taxYear: number): number {
  return round2(getTaxYearConfig(taxYear).uifCeiling * UIF_RATE);
}

/** This line's UIF, after the month's earlier lines: its own contribution, at most the cap's room left, never below nil. */
export function capUifToMonth(own: UifResult, earlier: MonthEarlierLines, taxYear: number): UifResult & { room: { employee: number; employer: number } } {
  const cap = monthUifCap(taxYear);
  const room = { employee: Math.max(0, round2(cap - earlier.uifEmployee)), employer: Math.max(0, round2(cap - earlier.uifEmployer)) };
  const employeeContribution = Math.max(0, Math.min(own.employeeContribution, room.employee));
  const employerContribution = Math.max(0, Math.min(own.employerContribution, room.employer));
  return {
    employeeContribution, employerContribution, room,
    isCapped: own.isCapped || employeeContribution < own.employeeContribution || employerContribution < own.employerContribution,
  };
}

/** This line's ETI: the month's, on everything the month paid, less what the earlier lines claimed (may be negative). */
export function offCycleEti(monthEti: number, earlier: MonthEarlierLines): number {
  return round2(monthEti - earlier.eti);
}
