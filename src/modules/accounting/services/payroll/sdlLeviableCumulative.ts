/**
 * The SDL leviable amount of a payroll line, cumulative over the tax year's
 * LIABLE months.
 *
 * SDL is levied on the balance of remuneration after the Fourth Schedule
 * para 2(4) deductions (SDL Act s3(4); SARS SDL-GEN-01-G01 Rev 5 s6). The only
 * ones modelled are the s18A donation s18aDonation allows, and the employee's retirement fund contribution limited by s11F,
 * which PAYE 4c already works out cumulatively: a line records the deduction
 * inside the year to date less what the earlier lines recorded
 * (`retirementDeduction`, SIGNED: a reversal is negative). SDL takes that same
 * figure, so the two cannot disagree about it, but it is applied to the year,
 * not to the line:
 *
 *   to date    = clamp(liable pay to date - liable deduction to date, 0, liable pay to date)
 *   this line  = max(0, to date - leviable already carried by earlier liable lines)
 *
 * "Liable" lines are those of runs the employer was not SDL-exempt for (s4(b)):
 * an exempt run levies nothing, so its pay, its deduction and its leviable amount
 * stay out of the sums (payrollSdlYearToDate reads them from the stored
 * sdl_applicable / sdl_leviable / sdl_exempt, migration 957). Exact, no
 * heuristics: a deduction larger than one month's pay waits for later liable
 * pay instead of being lost, a reversal takes back only what the liable pay
 * absorbed, and the year's leviable amount is never above its liable pay nor
 * below that pay less every liable month's deduction.
 *
 * Limits: (1) a deduction larger than ALL the year's liable SDL-applicable pay,
 * or recovered when no later liable month has any, is an over-levy that is not
 * refunded or carried into the next tax year. (2) PAYE records one cumulative
 * deduction, not which month's contribution a reversal undoes: a reversal in a
 * liable month of a contribution made in an exempt month counts against the
 * liable months' deduction (an over-levy by that amount, never an under-levy).
 * (3) A contribution capped by s11F in an exempt (or legacy) month has its
 * catch-up recorded by PAYE on the next liable line, and SDL credits it there:
 * the only under-levy direction left (accepted by Hein as a documented limit).
 * Pinned by the "KNOWN LIMIT (3)" tests.
 *
 * Lines costed before migration 957 were levied on gross, each EMP201 period right
 * as filed: the new rule starts with the first run after them. The year to date
 * takes their SDL-applicable pay as both liable pay and the leviable amount they
 * carried, and none of their deductions, so the first new month's leviable amount
 * is its own pay less its own deduction (no credit for earlier months). A later
 * reversal of such a contribution lowers the liable deduction but is capped at the
 * liable pay.
 */
import type { PayeYearToDate } from './payrollTypes';

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
  if (ytd && ytdHasEarlierLine(ytd)
    && (ytd.sdlApplicable === undefined || ytd.sdlLeviable === undefined || ytd.sdlRetirementDeduction === undefined)) {
    throw new Error(
      `SDL cannot be calculated for employee ${employeeId}: the year to date has earlier lines but no SDL figures `
      + '(sdlApplicable / sdlLeviable / sdlRetirementDeduction; loadPayeYearToDate sets them)');
  }
  const figures = {
    retirementDeduction,
    sdlApplicable,
    ytdSdlApplicable: ytd?.sdlApplicable ?? 0,
    ytdSdlLeviable: ytd?.sdlLeviable ?? 0,
    ytdSdlRetirementDeduction: ytd?.sdlRetirementDeduction ?? 0,
  };
  for (const [name, value] of Object.entries(figures)) {
    if (!Number.isFinite(value)) {
      throw new Error(`SDL cannot be calculated for employee ${employeeId}: ${name} is not a finite number (${value})`);
    }
  }
  const pay = figures.ytdSdlApplicable + sdlApplicable;
  const toDate = Math.min(pay, Math.max(0, pay - (figures.ytdSdlRetirementDeduction + retirementDeduction)));
  return Math.max(0, round2(toDate - figures.ytdSdlLeviable));
}
