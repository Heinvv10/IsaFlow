import { describe, it, expect } from 'vitest';
import { formatAmount, formatCents, formatMoney, formatMoneyCompact, formatRate } from '@/lib/money/formatMoney';
import { parseSaAmount } from '@/lib/money/saAmountParser';

const NB = '\xa0';

describe('formatMoney', () => {
  it('groups thousands with a non-breaking space and uses a dot decimal: "R 25 000.00"', () => {
    expect(formatMoney(25000)).toBe(`R\xa025${NB}000.00`);
    expect(formatMoney(318400)).toBe(`R\xa0318${NB}400.00`);
  });

  it('never prints a comma, so a figure cannot be read as a decimal comma', () => {
    expect(formatMoney(1234567.89)).toBe(`R\xa01${NB}234${NB}567.89`);
    expect(formatMoney(1234567.89)).not.toContain(',');
  });

  it('does not group below 1 000', () => {
    expect(formatMoney(999.5)).toBe('R\xa0999.50');
    expect(formatMoney(1000)).toBe(`R\xa01${NB}000.00`);
  });

  it('formats negatives with a leading minus before the symbol', () => {
    expect(formatMoney(-2300)).toBe(`\u2212R\xa02${NB}300.00`);
    expect(formatMoney(-0.01)).toBe('\u2212R\xa00.01');
  });

  it('renders zero cleanly, and never prints a negative zero', () => {
    expect(formatMoney(0)).toBe('R\xa00.00');
    expect(formatMoney(-0)).toBe('R\xa00.00');
    expect(formatMoney(-0.004)).toBe('R\xa00.00');
  });

  it('rounds to cents half away from zero, including values a binary double stores just below the half', () => {
    expect(formatMoney(42100.5)).toBe(`R\xa042${NB}100.50`);
    expect(formatMoney(1.005)).toBe('R\xa01.01');
    expect(formatMoney(2.675)).toBe('R\xa02.68');
    expect(formatMoney(-1.005)).toBe('\u2212R\xa01.01');
    expect(formatMoney(0.994)).toBe('R\xa00.99');
    expect(formatMoney(999.995)).toBe(`R\xa01${NB}000.00`);
  });

  it('formats large amounts', () => {
    expect(formatMoney(1_410_785)).toBe(`R\xa01${NB}410${NB}785.00`);
    expect(formatMoney(9_007_199_254_740)).toBe(`R\xa09${NB}007${NB}199${NB}254${NB}740.00`);
  });

  it('can omit decimals when asked', () => {
    expect(formatMoney(1200000, { decimals: 0 })).toBe(`R\xa01${NB}200${NB}000`);
    expect(formatMoney(1234.5, { decimals: 0 })).toBe(`R\xa01${NB}235`);
  });

  it('survives a value whose String() is exponent notation', () => {
    expect(formatMoney(1e-7)).toBe('R\xa00.00');
  });

  // Non-finite inputs are pinned, not fixed: callers pass typed finite numbers.
  it('passes NaN through verbatim (caller responsibility)', () => {
    expect(formatMoney(NaN)).toBe('R\xa0NaN');
  });

  it('passes Infinity through verbatim (caller responsibility)', () => {
    expect(formatMoney(Infinity)).toBe('R\xa0Infinity');
  });
});

describe('formatAmount', () => {
  it('is the same figure without the R symbol', () => {
    expect(formatAmount(25000)).toBe(`25${NB}000.00`);
    expect(formatAmount(-2300.5)).toBe(`\u22122${NB}300.50`);
    expect(formatAmount(-0.004)).toBe('0.00');
    expect(formatAmount(1234.5, { decimals: 0 })).toBe(`1${NB}235`);
  });
});

describe('formatMoneyCompact', () => {
  it('abbreviates millions and thousands, one decimal, sign before the symbol', () => {
    expect(formatMoneyCompact(5_500_000)).toBe('R\xa05.5M');
    expect(formatMoneyCompact(-5_532_100)).toBe('\u2212R\xa05.5M');
    expect(formatMoneyCompact(-895_040)).toBe('\u2212R\xa0895.0K');
    expect(formatMoneyCompact(1000)).toBe('R\xa01.0K');
  });

  it('prints the full figure below R 1 000, with the requested decimals', () => {
    expect(formatMoneyCompact(172.5)).toBe('R\xa0172.50');
    expect(formatMoneyCompact(-172.5, { decimals: 0 })).toBe('\u2212R\xa0173');
    expect(formatMoneyCompact(0)).toBe('R\xa00.00');
  });
});

describe('formatRate', () => {
  it('keeps four to six decimals and groups the integer part', () => {
    expect(formatRate(18.333)).toBe('18.3330');
    expect(formatRate(0.054321)).toBe('0.054321');
    expect(formatRate(0.05432)).toBe('0.05432');
    expect(formatRate(1)).toBe('1.0000');
    expect(formatRate(1234.5)).toBe(`1${NB}234.5000`);
    expect(formatRate(18.1234567)).toBe('18.123457');
  });
});

describe('the display minus is U+2212 and still parses', () => {
  it('never prints an ASCII hyphen, which is a line-break opportunity between "-" and "R"', () => {
    for (const text of [formatMoney(-2450), formatAmount(-2450), formatMoneyCompact(-9_900_000), formatMoneyCompact(-9_900)]) {
      expect(text.startsWith('−')).toBe(true);
      expect(text).not.toContain('-');
    }
  });

  it('is accepted back by parseSaAmount, echo and plain, so typing over a shown negative round-trips', () => {
    expect(parseSaAmount(formatMoney(-2450))).toEqual({ ok: true, cents: -245_000 });
    expect(parseSaAmount(formatAmount(-1234567.89))).toEqual({ ok: true, cents: -123_456_789 });
    expect(parseSaAmount(formatCents(-12_345))).toEqual({ ok: true, cents: -12_345 });
    expect(parseSaAmount(formatCents(-12_345, { symbol: false }))).toEqual({ ok: true, cents: -12_345 });
  });
});
