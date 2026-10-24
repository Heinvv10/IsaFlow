import { describe, it, expect } from 'vitest';
import { parseSaAmount, formatCentsEcho, formatCentsPlain } from '@/lib/money/saAmountParser';

const NB = '\u00A0';

describe('parseSaAmount accepts', () => {
  const accepted: Array<[string, number]> = [
    // The SimplePay R25 bug: a thousands comma read as a decimal point.
    ['25,000.00', 2_500_000],
    ['25 000,00', 2_500_000],
    [`25${NB}000,00`, 2_500_000],
    ['25\u202F000,00', 2_500_000],
    ['25\u2009000.00', 2_500_000],
    ['R 1 234.56', 123_456],
    ['R1234.56', 123_456],
    ['r 1234,56', 123_456],
    ['ZAR 1 234.56', 123_456],
    [`R${NB}1${NB}234.56`, 123_456],
    ['1234.5', 123_450],
    ['1234,5', 123_450],
    ['1234', 123_400],
    ['0', 0],
    ['0.00', 0],
    ['-0', 0],
    ['0,05', 5],
    ['.5', 50],
    [',5', 50],
    ['1,234,567.89', 123_456_789],
    ['1.234.567,89', 123_456_789],
    ['1 234 567,89', 123_456_789],
    ['1,234,567', 123_456_700],
    ['1.234.567', 123_456_700],
    ['999', 99_900],
    ['1,234.5', 123_450],
    ['1.234,5', 123_450],
    ['1 234.56', 123_456],
    ['  12.30  ', 1_230],
    ['12.3', 1_230],
    ['12.34', 1_234],
    ['0.1', 10],
    ['1005', 100_500],
    ['10.05', 1_005],
    ['19.99', 1_999],
    ['0.29', 29],
    ['1.15', 115],
    // negatives
    ['(123.45)', -12_345],
    ['(R 1 234,56)', -123_456],
    ['-123.45', -12_345],
    ['\u2212123.45', -12_345],
    ['-R 123.45', -12_345],
    ['R -123.45', -12_345],
    ['R(123.45)', -12_345],
    ['-25 000,00', -2_500_000],
  ];
  it.each(accepted)('%j -> %i cents', (input, cents) => {
    const r = parseSaAmount(input);
    expect(r).toEqual({ ok: true, cents });
  });

  it('never returns negative zero', () => {
    const r = parseSaAmount('-0.00');
    expect(r.ok && Object.is(r.cents, -0)).toBe(false);
  });
});

describe('parseSaAmount rejects with a reason', () => {
  const rejected: Array<[string, string]> = [
    ['', 'empty'],
    ['   ', 'empty'],
    ['R', 'empty'],
    ['-', 'empty'],
    // ambiguous: 1234 or 1.234
    ['1,234', 'ambiguous'],
    ['1.234', 'ambiguous'],
    ['12,345', 'ambiguous'],
    ['123,456', 'ambiguous'],
    ['R 1,234', 'ambiguous'],
    ['(1,234)', 'ambiguous'],
    ['-1.234', 'ambiguous'],
    // malformed
    ['1.234,56,7', 'malformed'],
    ['1,234.56.7', 'malformed'],
    ['1,23,456', 'malformed'],
    ['2,50,000.00', 'malformed'],
    ['1,,234', 'malformed'],
    ['1..5', 'malformed'],
    ['12,34.56', 'malformed'],
    ['1.234,567.89', 'malformed'],
    ['1 234,567.89', 'malformed'],
    ['1 23 456', 'malformed'],
    ['1,234 567', 'decimals'],
    ['5.', 'malformed'],
    ['5,', 'malformed'],
    ['.', 'malformed'],
    ['(', 'malformed'],
    ['(1.00', 'malformed'],
    ['1.00)', 'malformed'],
    ['(-1.00)', 'malformed'],
    ['--1', 'malformed'],
    ['1-', 'malformed'],
    ['+5', 'malformed'],
    // too many decimals (would lose a fraction of a cent)
    ['1234.567', 'decimals'],
    ['0.125', 'decimals'],
    ['1 234,567', 'decimals'],
    ['1.2345', 'decimals'],
    // not a number
    ['abc', 'chars'],
    ['12a', 'chars'],
    ['1e5', 'chars'],
    ['25R', 'chars'],
    ['R25R', 'chars'],
    ['$25', 'chars'],
    ['NaN', 'chars'],
    ['Infinity', 'chars'],
    // too large for a safe integer of cents
    ['90071992547409.92', 'too_large'],
    ['999999999999999999', 'too_large'],
  ];
  it.each(rejected)('%j -> %s', (input, code) => {
    const r = parseSaAmount(input);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe(code);
      expect(r.reason.length).toBeGreaterThan(8);
    }
  });

  it('explains both readings of an ambiguous input', () => {
    const r = parseSaAmount('1,234');
    expect(!r.ok && r.reason).toMatch(/1 234\.00/);
    expect(!r.ok && r.reason).toMatch(/three places/);
  });
});

describe('formatCentsEcho', () => {
  it('groups thousands with a non-breaking space and keeps a dot decimal', () => {
    expect(formatCentsEcho(2_500_000)).toBe(`R 25${NB}000.00`);
    expect(formatCentsEcho(123_456)).toBe(`R 1${NB}234.56`);
    expect(formatCentsEcho(5)).toBe('R 0.05');
    expect(formatCentsEcho(-12_345)).toBe('-R 123.45');
    expect(formatCentsEcho(0)).toBe('R 0.00');
  });
  it('plain form has no currency marker', () => {
    expect(formatCentsPlain(2_500_000)).toBe(`25${NB}000.00`);
    expect(formatCentsPlain(-12_345)).toBe('-123.45');
  });
  it('round-trips through the parser', () => {
    for (const c of [0, 5, 99, 1_005, 123_456, 2_500_000, -2_500_000, 123_456_789]) {
      expect(parseSaAmount(formatCentsEcho(c))).toEqual({ ok: true, cents: c });
      expect(parseSaAmount(formatCentsPlain(c))).toEqual({ ok: true, cents: c });
    }
  });
});
