/**
 * The SDL half of the year to date (payrollSdlYearToDate), rebuilt from the lines because payroll_run_lines
 * stores no leviable amount: what was levied to date is the highest max(0, SDL-applicable pay - retirement
 * deduction) to date has reached. SDL Act s3(4); SARS SDL-GEN-01-G01 Rev 5 s6.
 */
import { describe, it, expect } from 'vitest';
import { sdlYearToDate } from '@/modules/accounting/services/payroll/payrollSdlYearToDate';

describe('sdlYearToDate (SDL Act s3(4); SDL-GEN-01-G01 Rev 5 s6)', () => {
  it('no lines: nothing to date', () => {
    expect(sdlYearToDate([], {})).toEqual({ sdlApplicable: 0, sdlLeviable: 0 });
  });

  it('pay less the deduction to date', () => {
    const r = sdlYearToDate([
      { line: 'a', sdlApplicable: 20_000, retirement: 5_500 },
      { line: 'b', sdlApplicable: 20_000, retirement: 2_500 },
    ], {});
    expect(r).toEqual({ sdlApplicable: 40_000, sdlLeviable: 32_000 });
  });

  it('a deduction floored for want of pay is not levied, and the level never falls with a reversal', () => {
    const r = sdlYearToDate([
      { line: 'a', sdlApplicable: 1_000, retirement: 5_775 },
      { line: 'b', sdlApplicable: 1_000, retirement: -5_775 },
    ], {});
    expect(r).toEqual({ sdlApplicable: 2_000, sdlLeviable: 2_000 });
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
    expect(sdlYearToDate(lines, { legacy: 1_000 })).toEqual({ sdlApplicable: 60_000, sdlLeviable: 56_000 });
    // A legacy line the retirement record has nothing for deducted nothing.
    expect(sdlYearToDate(lines, {})).toEqual({ sdlApplicable: 60_000, sdlLeviable: 57_000 });
  });
});
