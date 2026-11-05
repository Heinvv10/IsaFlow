/**
 * The SDL half of an employee's year to date (sdlLeviableCumulative), from the
 * same lines loadPayeYearToDate reads. Pure.
 *
 * Only LIABLE lines count (those of runs the employer was not SDL-exempt for,
 * s4(b)); the sums are over those lines:
 * - sdlApplicable: their SDL-applicable earnings;
 * - sdlLeviable: the leviable amount they carried;
 * - sdlRetirementDeduction: the retirement deduction they recorded.
 *
 * Each line's figures are the ones the run stored (migration 957: sdl_applicable,
 * sdl_leviable, sdl_exempt). A line from before it (NULL) is read as it was
 * costed, on gross:
 * - SDL-applicable pay: rebuilt from its breakdown (the items flagged
 *   `isSdlApplicable`, else today's catalogue; in the SQL);
 * - exempt when it stored a nil levy although that pay would have carried one of
 *   a cent or more (exact for such a line: no deduction reduced its SDL);
 * - leviable amount: that pay.
 * The deduction is the line's retirement_deduction; a line from before migration
 * 948 has none stored, and its taxable-flagged contributions count instead (the
 * one rule for PAYE, payrollRetirementRecord).
 */
export interface SdlYearToDateLine {
  line: string;
  /** The levy the line stored (payroll_run_lines.sdl); nil for an exempt run. */
  sdl: number;
  /** Stored sdl_applicable; null for a line from before migration 957. */
  sdlApplicable: number | null;
  /** The pay rebuilt from the breakdown, used when sdlApplicable is null. */
  rebuiltApplicable: number;
  /** Stored sdl_leviable; null for a line from before migration 957. */
  sdlLeviable: number | null;
  /** Stored sdl_exempt; null for a line from before migration 957. */
  sdlExempt: boolean | null;
  /** The line's retirement_deduction; null for a line from before migration 948. */
  retirement: number | null;
}

export interface SdlYearToDate {
  sdlApplicable: number;
  sdlLeviable: number;
  sdlRetirementDeduction: number;
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

export function sdlYearToDate(
  lines: readonly SdlYearToDateLine[],
  legacyRetirementByLine: Readonly<Record<string, number>>,
): SdlYearToDate {
  let pay = 0;
  let leviable = 0;
  let deduction = 0;
  for (const l of lines) {
    const linePay = l.sdlApplicable == null ? Number(l.rebuiltApplicable ?? 0) : Number(l.sdlApplicable);
    const exempt = l.sdlExempt ?? (Number(l.sdl ?? 0) === 0 && round2(linePay * 0.01) > 0);
    if (exempt) continue;
    pay += linePay;
    leviable += l.sdlLeviable == null ? linePay : Number(l.sdlLeviable);
    deduction += l.retirement == null ? (legacyRetirementByLine[l.line] ?? 0) : Number(l.retirement);
  }
  return { sdlApplicable: round2(pay), sdlLeviable: round2(leviable), sdlRetirementDeduction: round2(deduction) };
}
