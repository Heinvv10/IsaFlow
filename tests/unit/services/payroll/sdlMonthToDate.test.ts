/**
 * Wave 6 OC, review #1620 final breaker H: SDL as a month-to-date catch-up (applySdlToLines + payrollSdlMonthToDate).
 *  (1) the estimate judges the month; (2) once an earlier final run of the month was liable, this run is liable;
 *  (3) a liable run carries what the month's earlier final runs did not levy, split by its lines' leviable share;
 *  (5) the month then levies 1% of every line's leviable amount (each rounded to the cent).
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/neon', () => ({ sql: Object.assign(vi.fn(async () => []), { unsafe: vi.fn(() => '') }) }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

import { applySdlToLines, type SdlLine } from '@/modules/accounting/services/payroll/sdlLeviabilityService';
import { NO_EARLIER_SDL, splitCatchUp } from '@/modules/accounting/services/payroll/payrollSdlMonthToDate';

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
    applySdlToLines(l, EXEMPT, TAX_YEAR, { earlierLiable: true, earlierDue: 150, earlierLevied: 150 });
    expect(l[0]).toMatchObject({ sdl: 10, sdlExempt: false });
    expect(l[0]!.sdl).toBe(10);
  });

  it('(3) a run that tips the month carries the earlier runs\' unlevied share, by leviable share, the cents to the largest', () => {
    const l = lines(600_000, 300_000);
    // The month's earlier final (exempt) runs: R20 300 leviable, R203 due, nil levied.
    const total = applySdlToLines(l, LIABLE, TAX_YEAR, { earlierLiable: false, earlierDue: 203, earlierLevied: 0 });
    expect(l.map((x) => x.sdl)).toEqual([6_000 + 135.33, 3_000 + 67.67]);
    // (5) the month: 1% of everything it paid, once.
    expect(Math.round((total + 0) * 100) / 100).toBe(9_000 + 203);
  });

  it('an exempt run carries nothing, and the split always adds up to the catch-up', () => {
    const l = lines(1_000);
    expect(applySdlToLines(l, EXEMPT, TAX_YEAR, { earlierLiable: false, earlierDue: 50, earlierLevied: 0 })).toBe(0);
    expect(splitCatchUp([{ sdlLeviable: 1 }, { sdlLeviable: 1 }, { sdlLeviable: 1 }], 1).reduce((t, x) => t + x, 0)).toBeCloseTo(1, 10);
    expect(splitCatchUp([{ sdlLeviable: 0 }, { sdlLeviable: 0 }], 7.5)).toEqual([7.5, 0]);
  });
});
