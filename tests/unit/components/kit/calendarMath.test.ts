import { describe, it, expect } from 'vitest';
import { monthGrid, moveByKey, clampToBounds, monthLabel, shiftMonth } from '@/components/ui/calendarMath';

describe('monthGrid', () => {
  it('is Monday-first and covers the month in whole weeks', () => {
    const g = monthGrid(2026, 10); // 1 Oct 2026 is a Thursday
    expect(g.length % 7).toBe(0);
    expect(g[0]).toBe('2026-09-28'); // Monday
    expect(g.includes('2026-10-01')).toBe(true);
    expect(g.includes('2026-10-31')).toBe(true);
    expect(g[g.length - 1]).toBe('2026-11-08'); // six Monday-first weeks, always
  });
  it('a month starting on a Monday has no leading days', () => {
    expect(monthGrid(2026, 6)[0]).toBe('2026-06-01');
  });
  it('February 2028 has 29 days', () => {
    expect(monthGrid(2028, 2).includes('2028-02-29')).toBe(true);
  });
  it('is always 6 rows so the popup does not jump in height', () => {
    expect(monthGrid(2026, 2).length).toBe(42);
    expect(monthGrid(2026, 10).length).toBe(42);
  });
});

describe('moveByKey (W3C date picker dialog keys)', () => {
  const from = '2026-10-15'; // Thursday
  it('arrows: day and week', () => {
    expect(moveByKey(from, 'ArrowRight', false)).toBe('2026-10-16');
    expect(moveByKey(from, 'ArrowLeft', false)).toBe('2026-10-14');
    expect(moveByKey(from, 'ArrowDown', false)).toBe('2026-10-22');
    expect(moveByKey(from, 'ArrowUp', false)).toBe('2026-10-08');
  });
  it('Home / End: Monday / Sunday of the week', () => {
    expect(moveByKey(from, 'Home', false)).toBe('2026-10-12');
    expect(moveByKey(from, 'End', false)).toBe('2026-10-18');
    expect(moveByKey('2026-10-18', 'Home', false)).toBe('2026-10-12'); // a Sunday belongs to the week before
  });
  it('PageUp / PageDown: a month, keeping the day or clamping it', () => {
    expect(moveByKey(from, 'PageDown', false)).toBe('2026-11-15');
    expect(moveByKey(from, 'PageUp', false)).toBe('2026-09-15');
    expect(moveByKey('2026-01-31', 'PageDown', false)).toBe('2026-02-28');
    expect(moveByKey('2026-12-10', 'PageDown', false)).toBe('2027-01-10');
  });
  it('Shift+PageUp / PageDown: a year, clamping 29 Feb', () => {
    expect(moveByKey(from, 'PageDown', true)).toBe('2027-10-15');
    expect(moveByKey('2028-02-29', 'PageUp', true)).toBe('2027-02-28');
  });
  it('returns null for a key it does not own', () => {
    expect(moveByKey(from, 'a', false)).toBeNull();
    expect(moveByKey(from, 'Tab', false)).toBeNull();
  });
});

describe('clampToBounds', () => {
  it('keeps a date inside inclusive min / max', () => {
    expect(clampToBounds('2026-10-15', '2026-10-01', '2026-10-31')).toBe('2026-10-15');
    expect(clampToBounds('2026-09-30', '2026-10-01', '2026-10-31')).toBe('2026-10-01');
    expect(clampToBounds('2026-11-02', '2026-10-01', '2026-10-31')).toBe('2026-10-31');
    expect(clampToBounds('2026-11-02', undefined, undefined)).toBe('2026-11-02');
  });
});

describe('labels', () => {
  it('shiftMonth wraps the year', () => {
    expect(shiftMonth({ year: 2026, month: 12 }, 1)).toEqual({ year: 2027, month: 1 });
    expect(shiftMonth({ year: 2026, month: 1 }, -1)).toEqual({ year: 2025, month: 12 });
  });
  it('monthLabel is the long month and year', () => {
    expect(monthLabel(2026, 10)).toMatch(/October 2026/);
  });
});
