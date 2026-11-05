/**
 * The SDL half of an employee's year to date (sdlLeviableCumulative), from the
 * same lines loadPayeYearToDate reads, in period order. Pure.
 *
 * - sdlApplicable: the SDL-applicable earnings (the breakdown items flagged
 *   `isSdlApplicable` as costed; an item from before the flag by today's
 *   catalogue, in the SQL) of the lines SDL was LEVIED on. An exempt line's
 *   pay is left out: no levy was due on it, so none is due on it later.
 * - sdlLeviable: payroll_run_lines stores no leviable amount, only the levy
 *   (`sdl`), so it is rebuilt: a levied line's leviable amount is the rise in
 *   (levied pay to date - the deduction standing against it), never below nil,
 *   so what was levied to date is the highest that figure has reached.
 * - sdlExemptDeduction: the part of the deduction to date that exempt lines'
 *   pay absorbed: an exempt line's own deduction, and what levied pay before it
 *   had not absorbed, up to the line's pay. It never comes off levied pay,
 *   and a later reversal undoes it first, as far as the deduction to date falls
 *   below it: the reversal of a deduction taken in an exempt month restores
 *   exempt pay, not levied pay (REPRO 8).
 *
 * A line is exempt when it stores a nil levy although, levied, it would have
 * carried one of at least a cent: an employer under the s4(b) threshold, or one
 * with the levy switched off. A line whose levy would round to nil reads as
 * levied either way; it changes nothing it levies.
 *
 * The deduction is the line's retirement_deduction; a line from before
 * migration 948 has none stored, and its taxable-flagged contributions count
 * instead (the one rule for PAYE, payrollRetirementRecord). A line with no
 * stored levy (null) is read as levied, as before this rule.
 */
export interface SdlYearToDateLine {
  line: string;
  sdlApplicable: number;
  /** The line's retirement_deduction; null for a line from before migration 948. */
  retirement: number | null;
  /** The levy the line stored (payroll_run_lines.sdl); nil for an exempt employer. */
  sdl?: number | null;
}

export interface SdlYearToDate {
  sdlApplicable: number;
  sdlLeviable: number;
  sdlExemptDeduction: number;
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

/** Deduction absorbed by exempt pay, after the deduction to date has moved: never above what still stands. */
export const standingExemptDeduction = (exemptDeduction: number, deductionToDate: number): number =>
  Math.min(exemptDeduction, Math.max(0, deductionToDate));

export function sdlYearToDate(
  lines: readonly SdlYearToDateLine[],
  legacyRetirementByLine: Readonly<Record<string, number>>,
): SdlYearToDate {
  let pay = 0;
  let deduction = 0;
  let exemptDeduction = 0;
  let levied = 0;
  for (const l of lines) {
    const linePay = Number(l.sdlApplicable);
    const lineDeduction = l.retirement === null ? (legacyRetirementByLine[l.line] ?? 0) : Number(l.retirement);
    deduction += lineDeduction;
    exemptDeduction = standingExemptDeduction(exemptDeduction, deduction);
    const leviable = Math.max(0, round2(pay + linePay - (deduction - exemptDeduction) - levied));
    const exempt = l.sdl !== undefined && l.sdl !== null && Number(l.sdl) === 0 && round2(leviable * 0.01) > 0;
    if (exempt) {
      // Exempt pay absorbs its own month's deduction, plus what levied pay could not absorb before it;
      // never more than its pay, nor more than the deduction standing against levied pay.
      const own = Math.max(0, lineDeduction);
      const unabsorbed = Math.max(0, deduction - own - exemptDeduction - pay) + own;
      exemptDeduction += Math.min(linePay, unabsorbed, Math.max(0, deduction - exemptDeduction));
    } else {
      pay += linePay;
      levied += leviable;
    }
  }
  return { sdlApplicable: round2(pay), sdlLeviable: round2(levied), sdlExemptDeduction: round2(exemptDeduction) };
}
