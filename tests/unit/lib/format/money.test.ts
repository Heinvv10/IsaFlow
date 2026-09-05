import { describe, it, expect } from 'vitest';
import { formatMoney, formatPct, signOf } from '@/lib/format/money';

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
