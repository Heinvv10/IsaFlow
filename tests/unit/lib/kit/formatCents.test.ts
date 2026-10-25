import { describe, it, expect } from 'vitest';
import { formatCents, formatMoney } from '@/lib/money/formatMoney';

describe('formatCents', () => {
  it.each([
    [0, 'R 0.00'],
    [5, 'R 0.05'],
    [99, 'R 0.99'],
    [100, 'R 1.00'],
    [123_456, 'R 1,234.56'],
    [2_500_000, 'R 25,000.00'],
    [-12_345, '-R 123.45'],
    [-5, '-R 0.05'],
    [999_999_999_999_999, 'R 9,999,999,999,999.99'],
    // above the money ceiling, where cents / 100 in floating point rounds the wrong way
    [8_056_294_256_317_787, 'R 80,562,942,563,177.87'],
    [7_065_965_107_613_207, 'R 70,659,651,076,132.07'],
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
    expect(formatCents(2_500_000, { symbol: false })).toBe('25,000.00');
    expect(formatCents(-12_345, { symbol: false })).toBe('-123.45');
    expect(formatCents(0, { symbol: false })).toBe('0.00');
  });

  it('negative zero is not negative', () => {
    expect(formatCents(-0)).toBe('R 0.00');
  });

  it('a non-integer falls back to formatMoney (no exact digits exist)', () => {
    expect(formatCents(150.5)).toBe(formatMoney(1.505));
    expect(formatCents(Number.NaN)).toBe(formatMoney(Number.NaN));
  });
});
