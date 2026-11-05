/**
 * The SDL half of the year to date (payrollSdlYearToDate), rebuilt from the lines because payroll_run_lines
 * stores no leviable amount: what was levied to date is the highest max(0, SDL-applicable pay - retirement
 * deduction) to date has reached. SDL Act s3(4); SARS SDL-GEN-01-G01 Rev 5 s6.
 */
import { describe, it, expect } from 'vitest';
import { sdlYearToDate } from '@/modules/accounting/services/payroll/payrollSdlYearToDate';

describe('sdlYearToDate (SDL Act s3(4); SDL-GEN-01-G01 Rev 5 s6)', () => {
  it('no lines: nothing to date', () => {
    expect(sdlYearToDate([], {})).toEqual({ sdlApplicable: 0, sdlLeviable: 0, sdlExemptDeduction: 0 });
  });

  it('pay less the deduction to date', () => {
    const r = sdlYearToDate([
      { line: 'a', sdlApplicable: 20_000, retirement: 5_500 },
      { line: 'b', sdlApplicable: 20_000, retirement: 2_500 },
    ], {});
    expect(r).toEqual({ sdlApplicable: 40_000, sdlLeviable: 32_000, sdlExemptDeduction: 0 });
  });

  it('a deduction floored for want of pay is not levied, and the level never falls with a reversal', () => {
    const r = sdlYearToDate([
      { line: 'a', sdlApplicable: 1_000, retirement: 5_775 },
      { line: 'b', sdlApplicable: 1_000, retirement: -5_775 },
    ], {});
    expect(r).toEqual({ sdlApplicable: 2_000, sdlLeviable: 2_000, sdlExemptDeduction: 0 });
    // A reversal after the level was reached does not lower what was levied.
    const after = sdlYearToDate([
      { line: 'a', sdlApplicable: 20_000, retirement: 0 },
      { line: 'b', sdlApplicable: 0, retirement: 5_000 },
      { line: 'c', sdlApplicable: 0, retirement: -5_000 },
    ], {});
    expect(after.sdlLeviable).toBe(20_000);
  });

  it('a line from before migration 948 (no retirement_deduction) uses its taxable-flagged contributions', () => {
    const lines = [
      { line: 'legacy', sdlApplicable: 30_000, retirement: null },
      { line: 'new', sdlApplicable: 30_000, retirement: 3_000 },
    ];
    expect(sdlYearToDate(lines, { legacy: 1_000 })).toEqual({ sdlApplicable: 60_000, sdlLeviable: 56_000, sdlExemptDeduction: 0 });
    // A legacy line the retirement record has nothing for deducted nothing.
    expect(sdlYearToDate(lines, {})).toEqual({ sdlApplicable: 60_000, sdlLeviable: 57_000, sdlExemptDeduction: 0 });
  });

  it('an exempt line (nil levy stored where one was due) is left out of the levied pay, and keeps the deduction it absorbed', () => {
    const exempt = { line: 'a', sdlApplicable: 20_000, retirement: 5_000, sdl: 0 };
    expect(sdlYearToDate([exempt], {})).toEqual({ sdlApplicable: 0, sdlLeviable: 0, sdlExemptDeduction: 5_000 });
    // Reversed in a liable month: the exempt share goes first, nothing comes off the liable pay.
    expect(sdlYearToDate([exempt, { line: 'b', sdlApplicable: 20_000, retirement: -5_000, sdl: 200 }], {}))
      .toEqual({ sdlApplicable: 20_000, sdlLeviable: 20_000, sdlExemptDeduction: 0 });
    // A levied line, or one whose levy would round to nil, is levied as before.
    expect(sdlYearToDate([{ line: 'c', sdlApplicable: 20_000, retirement: 5_000, sdl: 150 }], {}).sdlLeviable).toBe(15_000);
    expect(sdlYearToDate([{ line: 'd', sdlApplicable: 1_000, retirement: 1_000, sdl: 0 }], {}))
      .toEqual({ sdlApplicable: 1_000, sdlLeviable: 0, sdlExemptDeduction: 0 });
  });

  it('an exempt month after a levied one keeps its own deduction: later liable pay is levied in full', () => {
    const r = sdlYearToDate([
      { line: 'a', sdlApplicable: 20_000, retirement: 5_000, sdl: 150 },
      { line: 'b', sdlApplicable: 20_000, retirement: 5_000, sdl: 0 },
      { line: 'c', sdlApplicable: 20_000, retirement: 0, sdl: 200 },
    ], {});
    // Levied: 15 000 (a) + 20 000 (c); the exempt month's R5 000 deduction never comes off levied pay.
    expect(r).toEqual({ sdlApplicable: 40_000, sdlLeviable: 35_000, sdlExemptDeduction: 5_000 });
    // A deduction levied pay could not absorb before the exempt month is still absorbed by it.
    expect(sdlYearToDate([
      { line: 'a', sdlApplicable: 1_000, retirement: 3_000, sdl: 0 },
      { line: 'b', sdlApplicable: 20_000, retirement: 1_000, sdl: 0 },
    ], {})).toEqual({ sdlApplicable: 1_000, sdlLeviable: 0, sdlExemptDeduction: 3_000 });
  });
});
