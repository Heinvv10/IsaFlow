/**
 * Section 11F retirement-fund deduction cap for SDL purposes.
 *
 * SDL is levied on the balance of remuneration after the Fourth Schedule
 * para 2(4)(a)/(b)/(bA) allowable deductions, which include retirement-fund
 * contributions LIMITED by section 11F. The allowable amount is the lesser of:
 *   (a) 27.5% of Fourth Schedule remuneration (excluding retirement lump sums,
 *       withdrawal benefits and severance benefits), and
 *   (b) the annual cap (R430 000 for 2027; R350 000 for 2026) apportioned to
 *       the period: "must not exceed an amount that bears to the amount
 *       stipulated in section 11F(2)(a) the same ratio as the period during
 *       which remuneration was paid bears to a whole year."
 *
 * Sources: SARS PAYE-GEN-01-G21 (2027) Rev 1 s7.3.1;
 *          SARS PAYE-GEN-01-G20 (2026) s7.3.1;
 *          SDL-GEN-01-G01 Rev 5 s6.
 *
 * Note: PAYE does NOT yet apply this cap (pending PR #891). SDL now uses the
 * legally capped figure. For contributions above 27.5% the PAYE base and SDL
 * base will differ temporarily until #891 lands.
 */
import { getTaxYearConfig } from './taxTables';

/**
 * Returns the s11F-limited retirement-fund deduction for a single pay period.
 *
 * @param retirementContributions - Total taxable retirement contributions for
 *   the period (SARS codes 4001 pension, 4003 provident, 4006 RA), already
 *   filtered to components flagged isTaxable. Must be ≥ 0.
 * @param fourthScheduleRemuneration - Fourth Schedule remuneration for the
 *   period (periodic taxable + annual payments, before deductions; excluding
 *   lump sums). Must be ≥ 0.
 * @param periodsPerYear - Number of pay periods in the year (12 for monthly).
 * @param taxYear - SARS tax year (e.g. 2027 = 1 March 2026 – 28 February 2027).
 */
export function cappedRetirementDeduction(
  retirementContributions: number,
  fourthScheduleRemuneration: number,
  periodsPerYear: number,
  taxYear: number,
): number {
  const config = getTaxYearConfig(taxYear); // throws UnsupportedTaxYearError if unknown
  const periodCap = config.s11fAnnualCapRands / periodsPerYear;
  const percentageCap = 0.275 * fourthScheduleRemuneration;
  const allowable = Math.min(periodCap, percentageCap);
  return Math.min(retirementContributions, allowable);
}
