import { describe, it, expect, afterAll } from 'vitest';
import { formatSaDateValue } from '@/lib/saDateParser';

// SAST is UTC+2: pin it so the midnight edge is exercised on any machine. Set at import,
// before any Date below is built.
const ORIGINAL_TZ = process.env.TZ;
process.env.TZ = 'Africa/Johannesburg';
afterAll(() => {
  if (ORIGINAL_TZ === undefined) delete process.env.TZ;
  else process.env.TZ = ORIGINAL_TZ;
});

describe('formatSaDateValue', () => {
  it('shows a plain ISO date as dd MMM yyyy, with no timezone shift', () => {
    expect(formatSaDateValue('2026-10-21')).toBe('21 Oct 2026');
    expect(formatSaDateValue('2026-01-05')).toBe('05 Jan 2026');
    expect(formatSaDateValue('2026-12-31')).toBe('31 Dec 2026');
  });

  it('reads a Date at local SAST midnight as that same day (toISOString would say the day before)', () => {
    const midnight = new Date(2026, 9, 21, 0, 0, 0);
    expect(midnight.toISOString().slice(0, 10)).toBe('2026-10-20');
    expect(formatSaDateValue(midnight)).toBe('21 Oct 2026');
  });

  it('reads a UTC timestamp in local time: 22:00Z is already tomorrow in SAST', () => {
    expect(formatSaDateValue('2026-10-20T22:00:00Z')).toBe('21 Oct 2026');
    expect(formatSaDateValue('2026-10-20T21:59:59Z')).toBe('20 Oct 2026');
    expect(formatSaDateValue('2026-10-21T22:30:00.000Z')).toBe('22 Oct 2026');
  });

  it('keeps the calendar day of a timestamp that carries an offset or none', () => {
    expect(formatSaDateValue('2026-10-21T23:30:00+02:00')).toBe('21 Oct 2026');
    expect(formatSaDateValue('2026-10-21T00:00:00')).toBe('21 Oct 2026');
    expect(formatSaDateValue('2026-10-21 23:59:59')).toBe('21 Oct 2026');
  });

  it('is empty for nothing', () => {
    expect(formatSaDateValue(null)).toBe('');
    expect(formatSaDateValue(undefined)).toBe('');
    expect(formatSaDateValue('')).toBe('');
    expect(formatSaDateValue(new Date(NaN))).toBe('');
  });

  it('shows an unparseable string as it came, so a bad value stays visible', () => {
    expect(formatSaDateValue('next week')).toBe('next week');
    expect(formatSaDateValue('2026-02-30')).toBe('2026-02-30');
  });
});
