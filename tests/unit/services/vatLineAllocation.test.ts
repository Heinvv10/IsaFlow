/**
 * The printed VAT column must foot to the printed VAT total WITHOUT restating
 * any line's own rate.
 *
 * Round 4 review, HIGH-1: sharing the header out in proportion to the line
 * weights made the column foot by silently misstating a line — a R100 line the
 * same page labels 15% printed R30.00 of VAT, and nothing said so. A visible
 * non-footing had been turned into an invisibly wrong tax-invoice line, which
 * is the worse failure on a document SARS reads.
 *
 * MEDIUM-2: the same proportional divisor exploded on mixed-sign lines — a
 * discount line nearly cancelling a positive one sent the divisor to zero while
 * the weights stayed large, allocating R1,500,000,003.79 against R100.
 *
 * Both are the same mistake: dividing by `Σ weights`. Nothing here does.
 */
import { describe, expect, it } from 'vitest';
import { allocateVatToLines } from '@/modules/accounting/services/ar/vatLineAllocation';

/** The column plus the disclosure is what foots to the header. Always. */
function assertFoots(headerVat: number, weights: number[]): ReturnType<typeof allocateVatToLines> {
  const out = allocateVatToLines(headerVat, weights);
  const printed = out.lineVats.reduce((s, v) => s + Math.round(v * 100), 0);
  expect(printed + Math.round(out.unattributed * 100)).toBe(Math.round(headerVat * 100));
  return out;
}

describe('allocateVatToLines', () => {
  it('absorbs pure rounding: seven R14.29 lines at 15% foot to the R15.00 header', () => {
    const weights = Array.from({ length: 7 }, () => 14.29 * 0.15);
    const { lineVats, unattributed } = assertFoots(15, weights);

    expect(unattributed).toBe(0);
    expect(lineVats.reduce((s, v) => s + v, 0)).toBeCloseTo(15, 10);
    // Every line stays within a cent of its own rate — 2.14 or 2.15, never 2.16.
    for (const v of lineVats) expect(Math.abs(v - 2.1435)).toBeLessThanOrEqual(0.01);
  });

  it('does NOT absorb a header/line disagreement into a rated line', () => {
    // R100 at 15% and R100 at 0% under a R30 header: the header-default drift
    // the conversion paths produce. Printing R30.00 against the 15% line is a
    // 30% line on a tax invoice.
    const { lineVats, unattributed } = assertFoots(30, [15, 0]);

    expect(lineVats).toEqual([15, 0]);
    expect(unattributed).toBeCloseTo(15, 10);
  });

  it('never moves a cent onto a zero-rated line', () => {
    // One rated line, one zero-rated, header a cent above the rated line.
    expect(assertFoots(15.01, [15, 0]).lineVats[1]).toBe(0);

    // The sharp case: the rated line rounded UP (drift −0.4) and the zero-rated
    // line's drift is 0, so an unfiltered largest-drift sort hands the spare
    // cent to the ZERO-rated line and prints R0.01 of VAT under a 0% label.
    const { lineVats, unattributed } = assertFoots(15.01, [14.996, 0]);
    expect(lineVats[1]).toBe(0);
    expect(lineVats[0]).toBeCloseTo(15.01, 10);
    expect(unattributed).toBe(0);
  });

  it('discloses a header wildly above the only line rather than inflating it', () => {
    const { lineVats, unattributed } = assertFoots(1000, [15]);

    expect(lineVats).toEqual([15]);
    expect(unattributed).toBeCloseTo(985, 10);
  });

  it('keeps mixed-sign lines at their own VAT instead of exploding', () => {
    // MEDIUM-2's exact input. `Σ weights` is ~0; nothing may divide by it.
    const { lineVats, unattributed } = assertFoots(15, [100, -99.999999]);

    expect(lineVats[0]).toBeCloseTo(100, 2);
    expect(lineVats[1]).toBeCloseTo(-100, 2);
    expect(unattributed).toBeCloseTo(15, 10);
    for (const v of lineVats) expect(Math.abs(v)).toBeLessThan(1000);
  });

  it('handles a credit note: uniformly negative weights foot exactly', () => {
    const { lineVats, unattributed } = assertFoots(-15, [-7.5, -7.5]);

    expect(lineVats).toEqual([-7.5, -7.5]);
    expect(unattributed).toBe(0);
  });

  it('takes a cent BACK when the header is a cent under the lines', () => {
    // Three lines of R3.335 of VAT round up to R10.01 against a R10.00 header.
    const { lineVats, unattributed } = assertFoots(10, [3.335, 3.335, 3.33]);

    expect(unattributed).toBe(0);
    expect(lineVats.reduce((s, v) => s + v, 0)).toBeCloseTo(10, 10);
  });

  it('attributes nothing when no line carries a rate', () => {
    const { lineVats, unattributed } = assertFoots(15, [0, 0]);

    expect(lineVats).toEqual([0, 0]);
    expect(unattributed).toBeCloseTo(15, 10);
  });

  it('attributes nothing on a lineless document', () => {
    const { lineVats, unattributed } = assertFoots(15, []);

    expect(lineVats).toEqual([]);
    expect(unattributed).toBeCloseTo(15, 10);
  });

  it('foots for every shape, including the ones no fixture thought of', () => {
    const cases: Array<[number, number[]]> = [
      [0, []], [0, [0]], [0, [1.5, -1.5]], [15, [5, 5, 5]], [15.007, [5, 5, 5]],
      [-30, [-15, -15]], [-30, [-15, 0]], [0.01, [0]], [0.01, [0.004]],
      [123.45, [40, 40, 43.45]], [100, [33.333, 33.333, 33.333]],
      [1, [0.333, 0.333, 0.334]], [15, [-100, 100]], [7.77, [2.59, 2.59, 2.59]],
    ];
    for (const [hdr, weights] of cases) assertFoots(hdr, weights);
  });
});
