/**
 * The Johannesburg day of an instant must not depend on the device: 22:00Z is the next day in SAST, and a
 * browser in UTC or New York would show the day before if it read local fields. Financial year-end change
 * dates are shown through this, so a one-day error is a wrong year end on screen.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { sastISODate } from '@/utils/dateFormat';
import { fmtDay, fmtInstantDay } from '@/components/accounting/financialYearEnd/yearEndTypes';

const ORIGINAL_TZ = process.env.TZ;
afterEach(() => {
  if (ORIGINAL_TZ === undefined) delete process.env.TZ;
  else process.env.TZ = ORIGINAL_TZ;
});

// Pacific/Auckland (UTC+12/13) is AHEAD of Johannesburg: a local-field read puts the instant 2026-10-20T21:59:59Z on the 21st there, SAST says the 20th.
const ZONES = ['UTC', 'America/New_York', 'Africa/Johannesburg', 'Pacific/Auckland'] as const;

describe.each(ZONES)('device in %s', (zone) => {
  it('gives the Johannesburg day for a Date instant, either side of 22:00Z', () => {
    process.env.TZ = zone;
    expect(sastISODate(new Date('2026-10-20T21:59:59Z'))).toBe('2026-10-20');
    expect(sastISODate(new Date('2026-10-20T22:00:00Z'))).toBe('2026-10-21');
    expect(sastISODate(new Date('2026-10-20T23:59:59Z'))).toBe('2026-10-21');
    expect(sastISODate(new Date('2026-12-31T22:00:00Z'))).toBe('2027-01-01');
  });

  it('gives the same day for the ISO string of the instant, including a Postgres "+00" offset', () => {
    process.env.TZ = zone;
    expect(sastISODate('2026-10-20T21:59:59Z')).toBe('2026-10-20');
    expect(sastISODate('2026-10-20T22:00:00Z')).toBe('2026-10-21');
    expect(sastISODate('2026-10-20 22:00:00+00')).toBe('2026-10-21');
    expect(sastISODate('2026-10-21T23:30:00+02:00')).toBe('2026-10-21');
  });

  it('returns the own day of a zone-less timestamp, whatever the device', () => {
    process.env.TZ = zone;
    expect(sastISODate('2026-10-21T23:59:00')).toBe('2026-10-21');
    expect(sastISODate('2026-10-21 00:00:00')).toBe('2026-10-21');
  });

  it('reads a plain date as itself and anything else as empty', () => {
    process.env.TZ = zone;
    expect(sastISODate('2026-10-21')).toBe('2026-10-21');
    expect(sastISODate('garbage')).toBe('');
    expect(sastISODate('')).toBe('');
    expect(sastISODate(new Date(NaN))).toBe('');
  });

  it('is what the year-end wizard shows for a change applied at that instant', () => {
    process.env.TZ = zone;
    expect(fmtInstantDay('2026-10-20T21:59:59Z')).toBe('20 Oct 2026');
    expect(fmtInstantDay('2026-10-20T22:00:00Z')).toBe('21 Oct 2026');
  });
});

describe('fmtDay on input that is not a day', () => {
  it('shows it as it came instead of throwing', () => {
    expect(fmtDay('')).toBe('');
    expect(fmtDay('garbage')).toBe('garbage');
    expect(fmtDay('2026-13-01')).toBe('2026-13-01');
    expect(fmtDay('2026-10-99')).toBe('2026-10-99');
    expect(fmtDay('2026-02-30')).toBe('2026-02-30');
    expect(fmtDay('2026-10-21-x')).toBe('2026-10-21-x');
    expect(fmtDay('2026-10')).toBe('2026-10');
    expect(fmtDay('2024-02-29')).toBe('29 Feb 2024');
    expect(fmtDay('2026-12-31')).toBe('31 Dec 2026');
    expect(fmtDay('2026-10-21')).toBe('21 Oct 2026');
  });

  // One case per guard in fmtDay, so removing any one of them turns a test red (see the PR's mutation table).
  it.each([
    ['month 00 (mo < 1)', '2026-00-10'],
    ['day 00 (d < 1)', '2026-10-00'],
    ['29 Feb in a common year', '2026-02-29'],
    ['29 Feb 1900: a century is not a leap year', '1900-02-29'],
    ['31st of a 30-day month', '2026-04-31'],
    ['31 Sep', '2026-09-31'],
    ['31 Jun', '2026-06-31'],
    ['31 Nov', '2026-11-31'],
    ['leading text (^)', 'x2026-10-21'],
    ['leading space (^)', ' 2026-10-21'],
    ['trailing text ($)', '2026-10-21 '],
    ['one-digit month and day', '2026-1-5'],
    ['five-digit year', '12026-10-21'],
    ['three-digit year', '026-10-21'],
    ['full timestamp', '2026-10-21T10:00:00Z'],
  ])('leaves %s as it came', (_why, input) => {
    expect(fmtDay(input)).toBe(input);
  });

  it('formats the leap days and month ends the guards must let through', () => {
    expect(fmtDay('2000-02-29')).toBe('29 Feb 2000'); // divisible by 400: a leap year
    expect(fmtDay('2024-02-29')).toBe('29 Feb 2024');
    expect(fmtDay('2026-02-28')).toBe('28 Feb 2026');
    expect(fmtDay('2026-04-30')).toBe('30 Apr 2026');
    expect(fmtDay('2026-01-31')).toBe('31 Jan 2026');
    expect(fmtDay('2026-01-01')).toBe('1 Jan 2026');
  });

  it('pins today\'s output for a year below 1000 (the day and year are not padded)', () => {
    expect(fmtDay('0999-12-31')).toBe('31 Dec 999');
  });
});

describe('fmtInstantDay on input that is not a date', () => {
  it('shows it as it came instead of throwing', () => {
    expect(fmtInstantDay('not-a-date')).toBe('not-a-date');
    expect(fmtInstantDay('')).toBe('');
  });
});
