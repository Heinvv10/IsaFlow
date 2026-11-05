/**
 * The SDL half of the year to date (payrollSdlYearToDate): sums over the lines the employer was LIABLE for, from the
 * figures each run stored (migration 957: sdl_applicable, sdl_leviable, sdl_exempt), and for a line from before it
 * the reading it was costed under (SDL on gross). SDL Act s3(4); SARS SDL-GEN-01-G01 Rev 5 s6 and s4(b).
 */
import { describe, it, expect } from 'vitest';
import { sdlYearToDate, type SdlYearToDateLine } from '@/modules/accounting/services/payroll/payrollSdlYearToDate';

/** A line as the run writer stores it (migration 957 on). */
const stored = (line: string, pay: number, leviable: number, retirement: number | null, exempt: boolean): SdlYearToDateLine => ({
  line, sdl: exempt ? 0 : Math.round(leviable) / 100, sdlApplicable: pay, rebuiltApplicable: pay,
  sdlLeviable: leviable, sdlExempt: exempt, retirement,
});
/** A line from before migration 957: the columns are NULL; the pay is rebuilt from the breakdown. */
const legacy = (line: string, rebuilt: number, sdl: number, retirement: number | null): SdlYearToDateLine => ({
  line, sdl, sdlApplicable: null, rebuiltApplicable: rebuilt, sdlLeviable: null, sdlExempt: null, retirement,
});

describe('sdlYearToDate (SDL Act s3(4); SDL-GEN-01-G01 Rev 5 s6; s4(b))', () => {
  it('no lines: nothing to date', () => {
    expect(sdlYearToDate([], {})).toEqual({ sdlApplicable: 0, sdlLeviable: 0, sdlRetirementDeduction: 0 });
  });

  it('sums the liable lines: pay, the leviable amount they carried, the deduction they recorded', () => {
    const r = sdlYearToDate([stored('a', 20_000, 14_500, 5_500, false), stored('b', 20_000, 17_500, 2_500, false)], {});
    expect(r).toEqual({ sdlApplicable: 40_000, sdlLeviable: 32_000, sdlRetirementDeduction: 8_000 });
  });

  it('an exempt line is left out of every sum, whatever it stored; a liable line that stored a nil levy is not exempt (REPRO 9)', () => {
    const exempt = stored('a', 20_000, 15_000, 5_000, true);
    expect(sdlYearToDate([exempt], {})).toEqual({ sdlApplicable: 0, sdlLeviable: 0, sdlRetirementDeduction: 0 });
    // Liable, but its deduction absorbed all its pay: levy nil, leviable nil: still a liable line.
    const absorbed: SdlYearToDateLine = { ...stored('b', 1_000, 0, 1_000, false), sdl: 0 };
    expect(sdlYearToDate([absorbed], {})).toEqual({ sdlApplicable: 1_000, sdlLeviable: 0, sdlRetirementDeduction: 1_000 });
  });

  it('a deduction is signed: a reversal on a liable line lowers the deduction to date', () => {
    const r = sdlYearToDate([stored('a', 20_000, 15_000, 5_000, false), stored('b', 20_000, 25_000, -5_000, false)], {});
    expect(r.sdlRetirementDeduction).toBe(0);
  });

  it('a line from before migration 948 (no retirement_deduction) uses its taxable-flagged contributions', () => {
    const lines = [{ ...stored('legacy', 30_000, 30_000, null, false) }, stored('new', 30_000, 27_000, 3_000, false)];
    expect(sdlYearToDate(lines, { legacy: 1_000 }).sdlRetirementDeduction).toBe(4_000);
    // A legacy line the retirement record has nothing for deducted nothing.
    expect(sdlYearToDate(lines, {}).sdlRetirementDeduction).toBe(3_000);
  });

  it('a line from before migration 957 is read as costed: rebuilt pay, leviable amount = that pay, exempt when a levy was due and nil', () => {
    // Levied on gross: R20 000 pay, levy R200 -> liable, carried R20 000 (not pay less its recorded deduction).
    expect(sdlYearToDate([legacy('a', 20_000, 200, 5_000)], {}))
      .toEqual({ sdlApplicable: 20_000, sdlLeviable: 20_000, sdlRetirementDeduction: 5_000 });
    // Nil levy although R20 000 would carry R200: exempt, left out.
    expect(sdlYearToDate([legacy('b', 20_000, 0, 5_000)], {}))
      .toEqual({ sdlApplicable: 0, sdlLeviable: 0, sdlRetirementDeduction: 0 });
    // Pay whose levy would round to nil (R0.40): read as liable, as costed.
    expect(sdlYearToDate([legacy('c', 0.4, 0, 0)], {})).toEqual({ sdlApplicable: 0.4, sdlLeviable: 0.4, sdlRetirementDeduction: 0 });
  });

  it('a stored sdl_exempt decides over the stored levy, and a stored pay over the rebuilt one', () => {
    const line: SdlYearToDateLine = { ...stored('a', 20_000, 20_000, 0, false), sdl: 0, rebuiltApplicable: 999 };
    expect(sdlYearToDate([line], {}).sdlApplicable).toBe(20_000);
  });
});
