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

// Pacific/Auckland (UTC+12/13) is AHEAD of Johannesburg: a local-field read puts 21:59:59Z on the 21st there, SAST says the 20th.
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
    expect(fmtDay('2026-10-21')).toBe('21 Oct 2026');
  });
});

describe('fmtInstantDay on input that is not a date', () => {
  it('shows it as it came instead of throwing', () => {
    expect(fmtInstantDay('not-a-date')).toBe('not-a-date');
    expect(fmtInstantDay('')).toBe('');
  });
});
