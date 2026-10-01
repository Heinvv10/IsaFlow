import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addDaysISO, localISODate, monthEndISO, monthStartISO, prevMonthRange, shiftYearISO } from '@/lib/dateUtils';

// SAST is UTC+2: a local-midnight Date is 22:00 UTC the previous day, which is
// exactly what `.toISOString().split('T')[0]` used to name.
const ORIGINAL_TZ = process.env.TZ;
beforeAll(() => { process.env.TZ = 'Africa/Johannesburg'; });
afterAll(() => {
  if (ORIGINAL_TZ === undefined) delete process.env.TZ; else process.env.TZ = ORIGINAL_TZ;
});

describe('local-calendar date helpers (TZ=Africa/Johannesburg)', () => {
  it('runs in SAST (a local midnight is the previous UTC day)', () => {
    expect(new Date(2026, 8, 1).toISOString().slice(0, 10)).toBe('2026-08-31');
  });
  it('localISODate names the local calendar day', () => {
    expect(localISODate(new Date(2026, 8, 1))).toBe('2026-09-01');
    expect(localISODate(new Date(2026, 0, 1, 0, 30))).toBe('2026-01-01');
  });
  it('monthStartISO / monthEndISO', () => {
    expect(monthStartISO(new Date(2026, 8, 30))).toBe('2026-09-01');
    expect(monthEndISO(new Date(2026, 8, 30))).toBe('2026-09-30');
    expect(monthEndISO(new Date(2028, 1, 10))).toBe('2028-02-29');
  });
  it('prevMonthRange gives the whole previous month', () => {
    expect(prevMonthRange(new Date(2026, 8, 30))).toEqual({ start: '2026-08-01', end: '2026-08-31' });
    expect(prevMonthRange(new Date(2026, 0, 15))).toEqual({ start: '2025-12-01', end: '2025-12-31' });
    expect(prevMonthRange(new Date(2026, 2, 1))).toEqual({ start: '2026-02-01', end: '2026-02-28' });
  });
  it('localISODate names an instant by its SAST day', () => {
    expect(localISODate(new Date('2026-09-30T22:30:00Z'))).toBe('2026-10-01');
  });
  it('monthStartISO / prevMonthRange do not overflow from the 31st', () => {
    expect(monthStartISO(new Date(2026, 2, 31))).toBe('2026-03-01');
    expect(prevMonthRange(new Date(2026, 2, 31))).toEqual({ start: '2026-02-01', end: '2026-02-28' });
    expect(prevMonthRange(new Date(2026, 7, 31))).toEqual({ start: '2026-07-01', end: '2026-07-31' });
  });
  it('shiftYearISO clamps 29 Feb instead of overflowing into March', () => {
    expect(shiftYearISO('2028-02-29', -1)).toBe('2027-02-28');
    expect(shiftYearISO('2028-02-29', 4)).toBe('2032-02-29');
    expect(shiftYearISO('2026-09-30', -1)).toBe('2025-09-30');
  });
  it('addDaysISO is pure calendar arithmetic (the time-entry / bulk-range offsetDate)', () => {
    expect(addDaysISO('2026-03-31', 1)).toBe('2026-04-01');
    expect(addDaysISO('2026-01-01', -1)).toBe('2025-12-31');
    expect(addDaysISO('2026-09-30', 7)).toBe('2026-10-07');
  });
  it('shiftYearISO and addDaysISO throw RangeError on malformed or impossible dates', () => {
    for (const bad of ['', 'not-a-date', '2026-9-1', '2026-13-01', '2026-02-30', '2026-09-30T10:00:00Z']) {
      expect(() => shiftYearISO(bad, -1), bad).toThrow(RangeError);
      expect(() => addDaysISO(bad, 1), bad).toThrow(RangeError);
    }
  });
  it('rejects years below 1000 explicitly (not by the 19xx Date quirk)', () => {
    for (const bad of ['0000-01-01', '0099-06-15', '0999-12-31']) {
      expect(() => addDaysISO(bad, 1), bad).toThrow(/year/i);
      expect(() => shiftYearISO(bad, 1), bad).toThrow(/year/i);
    }
  });
  it('shiftYearISO throws when the target year falls below 1000', () => {
    expect(() => shiftYearISO('1000-06-15', -1)).toThrow(RangeError);
    expect(() => shiftYearISO('2026-06-15', -1100)).toThrow(RangeError);
    expect(shiftYearISO('1001-06-15', -1)).toBe('1000-06-15');
  });
});
