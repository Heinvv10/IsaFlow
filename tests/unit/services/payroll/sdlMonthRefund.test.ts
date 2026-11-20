/**
 * Wave 6 FQd, breaker #1622 M-E: the run's SDL is floored at the MONTH, not the run. A run may carry negative SDL (a
 * within-month refund of an over-catch-up), split by leviable share with the same largest-remainder rule, but never so
 * negative that the month's SDL goes below 0.
 */
import { describe, expect, it } from 'vitest';
import { lineSdlShares } from '@/modules/accounting/services/payroll/sdlLeviabilityService';

const up = (earlierLeviable: number, earlierSdl: number) => ({ liable: true, earlierLeviable, earlierSdl });

describe('lineSdlShares: a negative run SDL', () => {
  it('refunds what the month over-carried, by leviable share (R510 carried on R50 000; the run pays R500)', () => {
    expect(lineSdlShares([300, 200], up(50000, 510))).toEqual([-3, -2]);
  });

  it('splits negative cents to the cent by largest remainder: -97 cents over three equal lines', () => {
    const shares = lineSdlShares([1, 1, 1], up(0, 1));
    expect(shares).toEqual([-0.32, -0.32, -0.33]);
    expect(Math.round(shares.reduce((t, s) => t + s, 0) * 100)).toBe(-97);
  });

  it('never takes the month below 0: at most what the earlier runs carried comes back', () => {
    expect(lineSdlShares([-1000], up(500, 5))).toEqual([-5]);
  });

  it('a month that owes more still charges the difference (unchanged)', () => {
    expect(lineSdlShares([1000], up(50000, 500))).toEqual([10]);
  });
});
