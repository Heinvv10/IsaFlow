import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { localISODate, monthEndISO, monthStartISO, prevMonthRange } from '@/lib/dateUtils';

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
});
