/**
 * The SDL half of an employee's year to date (sdlLeviableCumulative), from the
 * same lines loadPayeYearToDate reads, in period order. Pure.
 *
 * - sdlApplicable: the lines' SDL-applicable earnings (the breakdown items
 *   flagged `isSdlApplicable` as costed; an item from before the flag by
 *   today's catalogue, in the SQL);
 * - sdlLeviable: payroll_run_lines stores no leviable amount, only the levy
 *   (`sdl`, nil for an exempt employer), so it is rebuilt: each line's
 *   leviable amount is the rise in max(0, pay to date - deduction to date),
 *   so what was levied to date is the highest that figure has reached. The
 *   deduction is the line's retirement_deduction; a line from before migration
 *   948 has none stored, and its taxable-flagged contributions count instead
 *   (the one rule for PAYE, payrollRetirementRecord).
 */
export interface SdlYearToDateLine {
  line: string;
  sdlApplicable: number;
  /** The line's retirement_deduction; null for a line from before migration 948. */
  retirement: number | null;
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

export function sdlYearToDate(
  lines: readonly SdlYearToDateLine[],
  legacyRetirementByLine: Readonly<Record<string, number>>,
): { sdlApplicable: number; sdlLeviable: number } {
  let pay = 0;
  let deduction = 0;
  let levied = 0;
  for (const l of lines) {
    pay += Number(l.sdlApplicable);
    deduction += l.retirement === null ? (legacyRetirementByLine[l.line] ?? 0) : Number(l.retirement);
    levied = Math.max(levied, Math.max(0, round2(pay - deduction)));
  }
  return { sdlApplicable: round2(pay), sdlLeviable: round2(levied) };
}
