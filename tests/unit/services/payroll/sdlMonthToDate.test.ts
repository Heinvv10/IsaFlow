/**
 * Wave 6 OC, review #1620 final breaker H: SDL as a month-to-date catch-up (applySdlToLines + payrollSdlMonthToDate).
 *  (1) the estimate judges the month; (2) once an earlier final run of the month was liable, this run is liable;
 *  (3) a liable run charges 1% of the month to date less what the earlier final runs charged (negative: a refund), split by its lines'
 *      leviable share (FQd's month-level ruling);
 *  (5) the month then levies 1% of its leviable pay.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/neon', () => ({ sql: Object.assign(vi.fn(async () => []), { unsafe: vi.fn(() => '') }) }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

import { applySdlToLines, type SdlLine } from '@/modules/accounting/services/payroll/sdlLeviabilityService';
import { NO_EARLIER_SDL, splitByLeviable } from '@/modules/accounting/services/payroll/payrollSdlMonthToDate';

const TAX_YEAR = 2027;
const LIABLE = 1_000_000; // an annual estimate over the R500 000 threshold
const EXEMPT = 100_000;
const lines = (...lev: number[]): SdlLine[] => lev.map((l, i) => ({ sdl: 0, sdlLeviable: l, employeeId: `e${i}` }));

describe('SDL as a month-to-date catch-up', () => {
  it('(1) no earlier final run: 1% of each line when the estimate is over the threshold, nil when not (as before)', () => {
    const liable = lines(15_000, 5_300.55);
    expect(applySdlToLines(liable, LIABLE, TAX_YEAR, NO_EARLIER_SDL)).toBeCloseTo(203.01, 2);
    expect(liable.map((l) => [l.sdl, l.sdlExempt])).toEqual([[150, false], [53.01, false]]);
    const exempt = lines(15_000);
    expect(applySdlToLines(exempt, EXEMPT, TAX_YEAR, NO_EARLIER_SDL)).toBe(0);
    expect(exempt[0]!.sdlExempt).toBe(true);
  });

  it('(2) once an earlier final run of the month was liable, this run is liable whatever its own estimate says', () => {
    const l = lines(1_000);
    applySdlToLines(l, EXEMPT, TAX_YEAR, { earlierLiable: true, earlierLeviable: 15_000, earlierLevied: 150 });
    expect(l[0]).toMatchObject({ sdl: 10, sdlExempt: false });
    expect(l[0]!.sdl).toBe(10);
  });

  it('(3) a run that tips the month carries the earlier runs\' unlevied share, by leviable share, the cents to the largest', () => {
    const l = lines(600_000, 300_000);
    // The month's earlier final (exempt) runs: R20 300 leviable, nil charged.
    const total = applySdlToLines(l, LIABLE, TAX_YEAR, { earlierLiable: false, earlierLeviable: 20_300, earlierLevied: 0 });
    expect(l.map((x) => x.sdl)).toEqual([6_000 + 135.33, 3_000 + 67.67]);
    // (5) the month: 1% of everything it paid, once.
    expect(Math.round((total + 0) * 100) / 100).toBe(9_000 + 203);
  });

  it('an exempt run carries nothing, and the split always adds up to the catch-up', () => {
    const l = lines(1_000);
    expect(applySdlToLines(l, EXEMPT, TAX_YEAR, { earlierLiable: false, earlierLeviable: 5_000, earlierLevied: 0 })).toBe(0);
    expect(splitByLeviable([{ sdlLeviable: 1 }, { sdlLeviable: 1 }, { sdlLeviable: 1 }], 1).reduce((t, x) => t + x, 0)).toBeCloseTo(1, 10);
    expect(splitByLeviable([{ sdlLeviable: 0 }, { sdlLeviable: 0 }], 7.5)).toEqual([7.5, 0]);
  });

  it('month level, never twice: what the earlier final runs already charged is taken off; the floor is the MONTH\'s', () => {
    // Earlier final runs: R10 000 leviable, R150 charged (a run they caught up was corrected down since); this run
    // R1 000: 1% of R11 000 is R110, so this run refunds R40 within the month and the month ends at exactly R110.
    const l = lines(600, 400);
    expect(applySdlToLines(l, LIABLE, TAX_YEAR, { earlierLiable: true, earlierLeviable: 10_000, earlierLevied: 150 })).toBe(-40);
    expect(l.map((x) => x.sdl)).toEqual([-24, -16]);
    expect(l[0]).toMatchObject({ sdlExempt: false });
    // Earlier final R20 000 charged R200 (1%), this run R1 000.55: 1% of R21 000.55 is R210.01, less R200 = R10.01.
    const m = lines(1_000.55);
    expect(applySdlToLines(m, LIABLE, TAX_YEAR, { earlierLiable: true, earlierLeviable: 20_000, earlierLevied: 200 })).toBe(10.01);
  });
});
