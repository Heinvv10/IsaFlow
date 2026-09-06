import { describe, it, expect } from 'vitest';
import { formatMoney, formatPct, formatPctMagnitude, signOf, MONEY_SCALES, toMoneyScale } from '@/lib/format/money';

describe('formatMoney', () => {
  it('uses thousands separators and no decimals by default', () => {
    expect(formatMoney(4812345.67)).toBe('4 812 346');
  });
  it('shows negatives in parentheses, never a minus', () => {
    expect(formatMoney(-2190000)).toBe('(2 190 000)');
    expect(formatMoney(-2190000)).not.toContain('-');
  });
  it('shows cents when asked', () => {
    expect(formatMoney(53787.07, { cents: true })).toBe('53 787.07');
  });
  it('prefixes the rand symbol when asked', () => {
    expect(formatMoney(1000, { symbol: true })).toBe('R 1 000');
    expect(formatMoney(-1000, { symbol: true })).toBe('(R 1 000)');
  });
  it('renders zero as a dash', () => {
    expect(formatMoney(0)).toBe('–');
  });
  it('treats -0.004 as zero, not a negative', () => {
    expect(formatMoney(-0.004)).toBe('–');
  });
});

describe('formatPct', () => {
  it('signs positive and negative, one decimal', () => {
    expect(formatPct(6.94)).toBe('+6.9%');
    expect(formatPct(-8.1)).toBe('−8.1%');
    expect(formatPct(0)).toBe('0.0%');
  });
});

describe('formatPctMagnitude', () => {
  it('matches formatPct rounding with no sign', () => {
    expect(formatPctMagnitude(6.94)).toBe('6.9%');
    expect(formatPctMagnitude(-8.1)).toBe('8.1%');
    expect(formatPctMagnitude(0)).toBe('0.0%');
  });
  it('renders a dash for a non-finite figure, never 0.0%', () => {
    expect(formatPctMagnitude(NaN)).toBe('–');
    expect(formatPctMagnitude(Infinity)).toBe('–');
  });
});

describe('signOf', () => {
  it('classifies', () => {
    expect(signOf(5)).toBe('pos'); expect(signOf(-5)).toBe('neg'); expect(signOf(0)).toBe('zero');
  });
});

describe('non-finite figures', () => {
  // A statement column is the last place a "NaN" should surface. Before this
  // guard signOf fell through to 'pos' and the grid printed "NaN" and
  // "+NaN%" in a money column, which reads as a figure.
  it('signOf treats a non-finite number as zero', () => {
    expect(signOf(NaN)).toBe('zero');
    expect(signOf(Infinity)).toBe('zero');
    expect(signOf(-Infinity)).toBe('zero');
  });

  it('formatMoney renders a dash rather than the word NaN', () => {
    expect(formatMoney(NaN)).toBe('–');
    expect(formatMoney(NaN, { cents: true, symbol: true })).toBe('–');
    expect(formatMoney(Infinity)).toBe('–');
  });

  it('formatPct renders a dash rather than 0.0% or +NaN%', () => {
    // Not "0.0%": a percentage that could not be computed must not read as a
    // percentage of zero.
    expect(formatPct(NaN)).toBe('–');
    expect(formatPct(Infinity)).toBe('–');
    expect(formatPct(0)).toBe('0.0%');
  });
});


describe('formatMoney scaling', () => {
  // The defect this pins: a table headed "R'000" whose cells were formatted
  // unscaled printed R4 200 000 as `4 200 000`, which a director reads as
  // R4.2bn. Nothing caught it because no assertion read a cell against its
  // own header.
  it("prints a thousands-scaled figure under an R'000 header", () => {
    expect(formatMoney(4_200_000, { scale: "R'000" })).toBe('4 200');
  });

  it('leaves every existing caller byte-identical when no scale is given', () => {
    for (const n of [4_200_000, -1_234, 0, 999.4]) {
      expect(formatMoney(n, { scale: undefined })).toBe(formatMoney(n));
    }
  });

  it('keeps the sign convention after scaling', () => {
    expect(formatMoney(-4_200_000, { scale: "R'000" })).toBe('(4 200)');
  });

  it('distinguishes a figure that rounds to nothing from an actual zero', () => {
    // R400 is less than half a thousand, so under an R'000 header it rounds
    // to `0` — the same thing an unscaled sub-rand figure already does. An
    // ACTUAL zero still prints the dash, so the two readings stay distinct:
    // "too small to show at this scale" is not "nothing".
    expect(formatMoney(400, { scale: "R'000" })).toBe('0');
    expect(formatMoney(0.4)).toBe('0');
    expect(formatMoney(0, { scale: "R'000" })).toBe('–');
  });

  it('scales millions too', () => {
    expect(formatMoney(4_200_000, { scale: "R'm" })).toBe('4');
    expect(MONEY_SCALES["R'm"]).toBe(1_000_000);
  });

  it('narrows a known scale string and refuses an unknown one', () => {
    expect(toMoneyScale("R'000")).toBe("R'000");
    expect(toMoneyScale('thousands')).toBeNull();
  });
});
