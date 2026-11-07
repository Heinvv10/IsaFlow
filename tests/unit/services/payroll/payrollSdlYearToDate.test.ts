/**
 * The SDL half of the year to date (payrollSdlYearToDate): sums over the lines the employer was LIABLE for, from the
 * figures each run stored (migration 957: sdl_applicable, sdl_leviable, sdl_exempt), and for a line from before it
 * the reading it was costed under (SDL on gross). SDL Act s3(3); SARS SDL-GEN-01-G01 Rev 5 s6 and s4(b).
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

describe('sdlYearToDate (SDL Act s3(3); SDL-GEN-01-G01 Rev 5 s6; s4(b))', () => {
  it('no lines: nothing to date', () => {
    expect(sdlYearToDate([])).toEqual({ sdlApplicable: 0, sdlLeviable: 0, sdlRetirementDeduction: 0, sdlDonationDeduction: 0 });
  });

  it('sums the liable lines: pay, the leviable amount they carried, the deduction they recorded', () => {
    const r = sdlYearToDate([stored('a', 20_000, 14_500, 5_500, false), stored('b', 20_000, 17_500, 2_500, false)]);
    expect(r).toEqual({ sdlApplicable: 40_000, sdlLeviable: 32_000, sdlRetirementDeduction: 8_000, sdlDonationDeduction: 0 });
  });

  it('an exempt line is left out of every sum, whatever it stored; a liable line that stored a nil levy is not exempt (REPRO 9)', () => {
    const exempt = stored('a', 20_000, 15_000, 5_000, true);
    expect(sdlYearToDate([exempt])).toEqual({ sdlApplicable: 0, sdlLeviable: 0, sdlRetirementDeduction: 0, sdlDonationDeduction: 0 });
    // Liable, but its deduction absorbed all its pay: levy nil, leviable nil: still a liable line.
    const absorbed: SdlYearToDateLine = { ...stored('b', 1_000, 0, 1_000, false), sdl: 0 };
    expect(sdlYearToDate([absorbed])).toEqual({ sdlApplicable: 1_000, sdlLeviable: 0, sdlRetirementDeduction: 1_000, sdlDonationDeduction: 0 });
  });

  it('a deduction is signed: a reversal on a liable line lowers the deduction to date', () => {
    const r = sdlYearToDate([stored('a', 20_000, 15_000, 5_000, false), stored('b', 20_000, 25_000, -5_000, false)]);
    expect(r.sdlRetirementDeduction).toBe(0);
  });

  it('a line from before migration 957 is read as costed: rebuilt pay, exempt when a nil levy was due, leviable amount = that pay, NO deduction', () => {
    // Levied on gross: R20 000 pay, levy R200 -> liable, carried R20 000. The R5 000 PAYE recorded on it reduced no SDL
    // and is not credited later (Hein: no credit).
    expect(sdlYearToDate([legacy('a', 20_000, 200, 5_000)]))
      .toEqual({ sdlApplicable: 20_000, sdlLeviable: 20_000, sdlRetirementDeduction: 0, sdlDonationDeduction: 0 });
    // Nil levy although R20 000 would carry R200: exempt, left out.
    expect(sdlYearToDate([legacy('b', 20_000, 0, 5_000)]))
      .toEqual({ sdlApplicable: 0, sdlLeviable: 0, sdlRetirementDeduction: 0, sdlDonationDeduction: 0 });
    // Pay whose levy would round to nil (R0.40): read as liable, as costed.
    expect(sdlYearToDate([legacy('c', 0.4, 0, 0)])).toEqual({ sdlApplicable: 0.4, sdlLeviable: 0.4, sdlRetirementDeduction: 0, sdlDonationDeduction: 0 });
    // Beside a line with stored figures, only the stored line's deduction counts.
    expect(sdlYearToDate([legacy('d', 20_000, 200, 5_000), stored('e', 20_000, 18_000, 2_000, false)]))
      .toEqual({ sdlApplicable: 40_000, sdlLeviable: 38_000, sdlRetirementDeduction: 2_000, sdlDonationDeduction: 0 });
  });

  it('a stored sdl_exempt decides over the stored levy, and a stored pay over the rebuilt one', () => {
    const line: SdlYearToDateLine = { ...stored('a', 20_000, 20_000, 0, false), sdl: 0, rebuiltApplicable: 999 };
    expect(sdlYearToDate([line]).sdlApplicable).toBe(20_000);
  });

  it('donations count in line order and above nil: a reversal of what never reduced SDL does not eat a later credit', () => {
    const at = (line: string, donation: number): SdlYearToDateLine => ({
      line, sdl: 200, sdlApplicable: 20_000, rebuiltApplicable: 20_000, sdlLeviable: 20_000, sdlExempt: false, retirement: 0, donation,
    });
    expect(sdlYearToDate([at('a', -1_000), at('b', 500)])).toMatchObject({ sdlRetirementDeduction: 500, sdlDonationDeduction: 500 });
    expect(sdlYearToDate([at('a', 500), at('b', -200)])).toMatchObject({ sdlRetirementDeduction: 300, sdlDonationDeduction: 300 });
  });
});
