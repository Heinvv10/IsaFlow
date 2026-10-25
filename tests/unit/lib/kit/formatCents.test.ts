import { describe, it, expect } from 'vitest';
import { formatCents, formatMoney } from '@/lib/money/formatMoney';

describe('formatCents', () => {
  it.each([
    [0, 'R\xa00.00'],
    [5, 'R\xa00.05'],
    [99, 'R\xa00.99'],
    [100, 'R\xa01.00'],
    [123_456, 'R\xa01\xa0234.56'],
    [2_500_000, 'R\xa025\xa0000.00'],
    [-12_345, '-R\xa0123.45'],
    [-5, '-R\xa00.05'],
    [999_999_999_999_999, 'R\xa09\xa0999\xa0999\xa0999\xa0999.99'],
    // above the money ceiling, where cents / 100 in floating point rounds the wrong way
    [8_056_294_256_317_787, 'R\xa080\xa0562\xa0942\xa0563\xa0177.87'],
    [7_065_965_107_613_207, 'R\xa070\xa0659\xa0651\xa0076\xa0132.07'],
  ])('%i -> %s', (cents, text) => {
    expect(formatCents(cents)).toBe(text);
  });

  it('agrees with formatMoney everywhere in the storable range', () => {
    for (let cents = -2_000; cents <= 2_000; cents += 1) {
      expect(formatCents(cents)).toBe(formatMoney(cents / 100));
    }
    for (const cents of [123_456_789, 99_999_999_999, 999_999_999_999_999]) {
      expect(formatCents(cents)).toBe(formatMoney(cents / 100));
    }
  });

  it('symbol: false drops the R and keeps the sign', () => {
    expect(formatCents(2_500_000, { symbol: false })).toBe('25\xa0000.00');
    expect(formatCents(-12_345, { symbol: false })).toBe('-123.45');
    expect(formatCents(0, { symbol: false })).toBe('0.00');
  });

  it('negative zero is not negative', () => {
    expect(formatCents(-0)).toBe('R\xa00.00');
  });

  it('a non-integer falls back to formatMoney (no exact digits exist)', () => {
    expect(formatCents(150.5)).toBe(formatMoney(1.505));
    expect(formatCents(Number.NaN)).toBe(formatMoney(Number.NaN));
  });
});
