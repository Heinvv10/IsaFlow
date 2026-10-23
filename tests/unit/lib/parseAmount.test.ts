/**
 * parseAmount reads the money formats South African ledgers actually export.
 * The migration parser used to strip every comma, so "1234,56" (decimal comma)
 * became 123456, and the wizard pages used parseFloat(...) || 0, so a garbage
 * cell silently imported as zero. Garbage must come back as NaN so the caller
 * reports the row.
 */
import { describe, it, expect } from 'vitest';
import { parseAmount } from '@/lib/parseAmount';

describe('parseAmount', () => {
  it.each([
    ['1234.56', 1234.56],
    ['1,234.56', 1234.56],
    ['1 234,56', 1234.56],
    ['1234,56', 1234.56],
    ['R1,234.00', 1234],
    ['R 1 234,56', 1234.56],
    ['(1 234.00)', -1234],
    ['1234.00 Cr', -1234],
    ['1234.00 CR', -1234],
    ['1234.00cr', -1234],
    ['1234.00 Dr', 1234],
    ['-1234', -1234],
    ['1.234.567,89', 1234567.89],
    ['1,234,567', 1234567],
    ['  42  ', 42],
    ['0', 0],
    ['0.5', 0.5],
    ['-R 100.00', -100],
    ['R-100.00', -100],
  ])('reads %j as %d', (input, expected) => {
    expect(parseAmount(input)).toBeCloseTo(expected, 6);
  });

  it('treats non-breaking and narrow no-break spaces as thousands separators', () => {
    expect(parseAmount('1 234,56')).toBeCloseTo(1234.56, 6);
    expect(parseAmount('R 12 345.10')).toBeCloseTo(12345.1, 6);
  });

  it('reads empty and missing as 0', () => {
    expect(parseAmount('')).toBe(0);
    expect(parseAmount('   ')).toBe(0);
    expect(parseAmount(undefined)).toBe(0);
    expect(parseAmount(null)).toBe(0);
  });

  it('passes finite numbers through', () => {
    expect(parseAmount(12.5)).toBe(12.5);
    expect(Number.isNaN(parseAmount(Number.NaN))).toBe(true);
  });

  // A comma followed by three digits groups thousands — unless the whole
  // number before it is 0, which no thousands grouping produces.
  it.each([
    ['1,234', 1234],
    ['1,23', 1.23],
    ['0,500', 0.5],
    ['0,5', 0.5],
    ['1 234,56 Cr', -1234.56],
    ['12.345.678', 12345678],
  ])('pins the separator rule: %j is %d', (input, expected) => {
    expect(parseAmount(input)).toBeCloseTo(expected, 6);
  });

  // Thousands groups after the first are exactly three digits; anything else
  // is not a number a ledger exports, so it is refused rather than guessed.
  it.each(['1,234,56', '1,23,456', '12,34.5', '1.23.456', '1234,567,890', '1.234,5,6'])(
    'returns NaN for a malformed grouping %j',
    input => {
      expect(Number.isNaN(parseAmount(input))).toBe(true);
    },
  );

  it.each(['abc', '12x', '1-2', '--5', '1.2.3,4,5', 'R', '()', '12 Cr Dr', '1e5'])(
    'returns NaN for garbage %j, never 0',
    input => {
      expect(Number.isNaN(parseAmount(input))).toBe(true);
    },
  );

  // Deliberate: a lone dot is the decimal point, and a leading "+" is refused.
  it('reads "1.234" as 1.234 (not 1234) and "+100" as NaN', () => {
    expect(parseAmount('1.234')).toBe(1.234);
    expect(Number.isNaN(parseAmount('+100'))).toBe(true);
  });
});
