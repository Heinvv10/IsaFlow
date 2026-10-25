import { describe, it, expect, afterAll } from 'vitest';
import {
  formatDisplayDate, formatDisplayDateTime, formatDisplayDateLong, formatDisplayDateShort,
  formatDisplayMonthYear, formatDisplayTime, formatDateISO, formatDateTimeISO, getTodayISO,
} from '@/utils/dateFormat';

// The rule is "the calendar day in Africa/Johannesburg", whatever the device zone is. Pin the device
// to Los Angeles (UTC-7/-8) so a formatter that falls back to device-local time or to UTC is caught.
// Set at import, before any Date below is built.
const ORIGINAL_TZ = process.env.TZ;
process.env.TZ = 'America/Los_Angeles';
afterAll(() => {
  if (ORIGINAL_TZ === undefined) delete process.env.TZ;
  else process.env.TZ = ORIGINAL_TZ;
});

describe('formatDisplayDate', () => {
  it('shows a plain ISO date as dd MMM yyyy, with no timezone shift', () => {
    expect(formatDisplayDate('2026-10-21')).toBe('21 Oct 2026');
    expect(formatDisplayDate('2026-01-05')).toBe('05 Jan 2026');
    expect(formatDisplayDate('2026-12-31')).toBe('31 Dec 2026');
  });

  it('reads an instant as the SAST calendar day: 22:00Z is already tomorrow in Johannesburg', () => {
    expect(formatDisplayDate('2026-10-20T22:00:00Z')).toBe('21 Oct 2026');
    expect(formatDisplayDate('2026-10-20T21:59:59Z')).toBe('20 Oct 2026');
    expect(formatDisplayDate('2026-10-21T22:30:00.000Z')).toBe('22 Oct 2026');
    expect(formatDisplayDate(new Date('2026-10-20T22:00:00Z'))).toBe('21 Oct 2026');
    expect(formatDisplayDate(Date.parse('2026-10-20T22:00:00Z'))).toBe('21 Oct 2026');
  });

  it('keeps the calendar day of a timestamp that carries an offset or none', () => {
    expect(formatDisplayDate('2026-10-21T23:30:00+02:00')).toBe('21 Oct 2026');
    expect(formatDisplayDate('2026-10-21T00:00:00')).toBe('21 Oct 2026');
    expect(formatDisplayDate('2026-10-21 23:59:59')).toBe('21 Oct 2026');
  });

  it('shows the one "no date" mark for nothing, and the fallback you pass', () => {
    expect(formatDisplayDate(null)).toBe('—');
    expect(formatDisplayDate(undefined)).toBe('—');
    expect(formatDisplayDate('')).toBe('—');
    expect(formatDisplayDate(new Date(NaN))).toBe('—');
    expect(formatDisplayDate(null, 'n/a')).toBe('n/a');
  });

  it('shows text that is not a date as it came, so a bad value stays visible', () => {
    expect(formatDisplayDate('next week')).toBe('next week');
    expect(formatDisplayDate('2026-02-30')).toBe('2026-02-30');
    expect(formatDisplayDate('2026-02-30T10:00:00')).toBe('2026-02-30T10:00:00');
  });

  it('takes a toDate() object', () => {
    expect(formatDisplayDate({ toDate: () => new Date('2026-10-04T23:00:00Z') })).toBe('05 Oct 2026');
  });
});

describe('the other display forms are fixed strings, not ICU', () => {
  const at = '2026-10-04T23:30:00Z'; // 05 Oct 2026 01:30 in Johannesburg
  it('formats each form', () => {
    expect(formatDisplayDateTime(at)).toBe('05 Oct 2026, 01:30');
    expect(formatDisplayDateLong(at)).toBe('5 October 2026');
    expect(formatDisplayDateShort(at)).toBe('5 Oct');
    expect(formatDisplayMonthYear(at)).toBe('Oct 2026');
    expect(formatDisplayTime(at)).toBe('01:30');
  });
  it('shows the one "no date" mark', () => {
    for (const f of [formatDisplayDateTime, formatDisplayDateLong, formatDisplayDateShort, formatDisplayMonthYear, formatDisplayTime]) {
      expect(f(null)).toBe('—');
    }
  });
});

describe('ISO forms (files and APIs) use the same SAST day', () => {
  it('derives the ISO day and time from the instant', () => {
    expect(formatDateISO('2026-10-20T22:00:00Z')).toBe('2026-10-21');
    expect(formatDateISO('2026-10-21')).toBe('2026-10-21');
    expect(formatDateTimeISO('2026-10-20T22:05:00Z')).toBe('2026-10-21 00:05');
    expect(formatDateISO(null)).toBe('');
    expect(getTodayISO()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
