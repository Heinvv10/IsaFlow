import { describe, it, expect } from 'vitest';
import { formatOverdueDays } from '@/lib/format/aging';

describe('formatOverdueDays', () => {
  it('returns "" for -1 (not yet due)', () => {
    expect(formatOverdueDays(-1)).toBe('');
  });

  it('returns "Due today" for 0', () => {
    expect(formatOverdueDays(0)).toBe('Due today');
  });

  it('returns "1d overdue" for 1', () => {
    expect(formatOverdueDays(1)).toBe('1d overdue');
  });

  it('returns "30d overdue" for 30', () => {
    expect(formatOverdueDays(30)).toBe('30d overdue');
  });

  it('returns "90d overdue" for 90', () => {
    expect(formatOverdueDays(90)).toBe('90d overdue');
  });

  it('returns "365d overdue" for 365 (boundary, within cap)', () => {
    expect(formatOverdueDays(365)).toBe('365d overdue');
  });

  it('returns ">365d overdue" for 366 (first day over cap)', () => {
    expect(formatOverdueDays(366)).toBe('>365d overdue');
  });

  it('returns ">365d overdue" for 2268 (absurd seeded value)', () => {
    expect(formatOverdueDays(2268)).toBe('>365d overdue');
  });

  it('returns "" for NaN', () => {
    expect(formatOverdueDays(NaN)).toBe('');
  });

  it('returns "" for undefined cast to number', () => {
    // Defensive: callers may inadvertently pass undefined from API
    expect(formatOverdueDays(undefined as unknown as number)).toBe('');
  });

  it('truncates fractional days (1.9 → 1d overdue)', () => {
    expect(formatOverdueDays(1.9)).toBe('1d overdue');
  });

  it('returns "" for Infinity', () => {
    expect(formatOverdueDays(Infinity)).toBe('');
  });
});
