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
 * sdl_leviable, sdl_exempt). A line from before it (NULL; costed on gross) is read
 * as it was costed, and the new rule starts with the first run after it:
 * - SDL-applicable pay: rebuilt from its breakdown (the items flagged
 *   `isSdlApplicable`, else today's catalogue; in the SQL);
 * - exempt when it stored a nil levy although that pay would have carried one of
 *   a cent or more (exact for such a line: no deduction reduced its SDL);
 * - leviable amount: that pay (it was levied on all of it);
 * - deduction: NONE. No deduction reduced that month's SDL and its EMP201 period
 *   stays right as filed, so the retirement deduction PAYE recorded on it is not
 *   credited against later months (Hein: no credit). A later reversal of such a
 *   contribution is capped at the liable pay (sdlLeviableCumulative).
 * A line with stored figures contributes the retirement_deduction it recorded.
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
  /** The line's retirement_deduction; counted only for a line with stored SDL figures (migration 957). */
  retirement: number | null;
}

export interface SdlYearToDate {
  sdlApplicable: number;
  sdlLeviable: number;
  sdlRetirementDeduction: number;
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

export function sdlYearToDate(lines: readonly SdlYearToDateLine[]): SdlYearToDate {
  let pay = 0;
  let leviable = 0;
  let deduction = 0;
  for (const l of lines) {
    const linePay = l.sdlApplicable == null ? Number(l.rebuiltApplicable ?? 0) : Number(l.sdlApplicable);
    const exempt = l.sdlExempt ?? (Number(l.sdl ?? 0) === 0 && round2(linePay * 0.01) > 0);
    if (exempt) continue;
    pay += linePay;
    leviable += l.sdlLeviable == null ? linePay : Number(l.sdlLeviable);
    // A line costed before 957 deducted nothing from its SDL: its recorded deduction is not credited later.
    if (l.sdlApplicable != null) deduction += Number(l.retirement ?? 0);
  }
  return { sdlApplicable: round2(pay), sdlLeviable: round2(leviable), sdlRetirementDeduction: round2(deduction) };
}
