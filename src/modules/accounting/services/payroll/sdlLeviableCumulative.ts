/**
 * The SDL leviable amount of a payroll line, cumulative over the tax year.
 *
 * SDL is levied on the balance of remuneration after the Fourth Schedule
 * para 2(4) deductions (SDL Act s3(4); SARS SDL-GEN-01-G01 Rev 5 s6). The only
 * one modelled is the employee's retirement fund contribution limited by s11F,
 * which PAYE 4c already works out cumulatively: a line records the deduction
 * inside the year to date less what the earlier lines recorded
 * (`retirementDeduction`, SIGNED: a reversal is negative). SDL takes that same
 * figure, so the two cannot disagree about it, but it is applied to the year,
 * not to the line:
 *
 *   cumulative = max(0, SDL-applicable pay to date - retirement deduction to date)
 *   this line  = max(0, cumulative - SDL leviable already levied to date)
 *
 * A deduction larger than one month's SDL-applicable pay therefore waits for
 * later pay instead of being lost, and a reversal takes back only what SDL
 * actually absorbed: the year's leviable amount is never above the year's
 * SDL-applicable pay and, when pay allows, equals pay less the deduction PAYE
 * finally allowed. Remaining limit: a deduction larger than ALL the year's
 * SDL-applicable pay, or recovered when no later month has any, is an over-levy
 * that is not refunded (no stored column carries it across years; a migration).
 *
 * An exempt employer's months (stored levy nil) are kept apart
 * (payrollSdlYearToDate): their pay is not levied later, and the deduction their
 * pay absorbed (`sdlExemptDeduction`) never comes off levied pay; a reversal of
 * it restores the exempt pay, so a reversal after the employer turns liable
 * levies only liable pay (REPRO 8). Like PAYE 4c, an over-levy is carried
 * against later levy, never refunded within a line (no negative levy).
 *
 * Remaining limits of the exempt handling (no stored per-line exempt flag; an
 * exact fix is a migration): (a) REPRO 9 - a stored nil levy cannot tell an
 * exempt month from a liable month whose deduction absorbed all its pay, so
 * exempt detection is a heuristic (`sdl === 0 && round2(leviable * 0.01) > 0`);
 * in mixed exempt/liable sequences part of an exempt-period deduction can stand
 * against levied pay and a later reversal over-levies (never under-levies).
 * (b) LIFO attribution in standingExemptDeduction: a reversal is assumed to
 * undo the most recent share of the deduction first.
 *
 * Months costed before this rule levied SDL on gross. Their year-to-date
 * leviable amount is taken as if this rule had levied them (payrollSdlYearToDate),
 * so the first month after it takes only its own deduction: no credit for the
 * earlier over-levy, which EMP201 already declared.
 */
import type { PayeYearToDate } from './payrollTypes';
import { standingExemptDeduction } from './payrollSdlYearToDate';

const round2 = (n: number): number => Math.round(n * 100) / 100;

const ytdHasEarlierLine = (ytd: PayeYearToDate): boolean =>
  ytd.periods > 0 || (ytd.retirementCapPeriods ?? 0) > 0 || ytd.periodicTaxable !== 0 || ytd.annualPayments !== 0;

export function sdlLeviableToDate(
  employeeId: string,
  /** This line's SDL-applicable earnings (earnings flagged is_sdl_applicable). */
  sdlApplicable: number,
  /** This line's s11F retirement deduction as PAYE recorded it (signed). */
  retirementDeduction: number,
  ytd: PayeYearToDate | undefined,
): number {
  // Absent SDL figures mean "no earlier line"; with an earlier line they would silently over-levy.
  if (ytd && ytdHasEarlierLine(ytd) && (ytd.sdlApplicable === undefined || ytd.sdlLeviable === undefined)) {
    throw new Error(
      `SDL cannot be calculated for employee ${employeeId}: the year to date has earlier lines but no SDL figures `
      + '(sdlApplicable / sdlLeviable; loadPayeYearToDate sets them)');
  }
  const figures = {
    retirementDeduction,
    sdlApplicable,
    ytdSdlApplicable: ytd?.sdlApplicable ?? 0,
    ytdSdlLeviable: ytd?.sdlLeviable ?? 0,
    ytdRetirementDeduction: ytd?.retirementDeduction ?? 0,
    // Absent = no exempt month to date.
    ytdSdlExemptDeduction: ytd?.sdlExemptDeduction ?? 0,
  };
  for (const [name, value] of Object.entries(figures)) {
    if (!Number.isFinite(value)) {
      throw new Error(`SDL cannot be calculated for employee ${employeeId}: ${name} is not a finite number (${value})`);
    }
  }
  // Levied pay to date less the deduction standing against it (exempt pay's share left out), less what was
  // levied, floored at nil: the inner floor is implied by the outer one (what was levied is never negative).
  const deductionToDate = figures.ytdRetirementDeduction + retirementDeduction;
  const exemptDeduction = standingExemptDeduction(figures.ytdSdlExemptDeduction, deductionToDate);
  return Math.max(
    0,
    round2(
      figures.ytdSdlApplicable + sdlApplicable
        - (deductionToDate - exemptDeduction)
        - figures.ytdSdlLeviable,
    ),
  );
}
