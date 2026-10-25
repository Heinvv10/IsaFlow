/**
 * The same readings on the far side of the date line: Kiritimati is UTC+14, 12 hours ahead of
 * Johannesburg, so a formatter that reads a zoned timestamp in device time shows a different day here
 * than in Los Angeles (formatDisplayDate.test.ts, UTC-8). Both must show the SAST day.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { formatDateISO, formatDateTimeISO, formatDisplayDate, formatDisplayDateTime } from '@/utils/dateFormat';

const ORIGINAL_TZ = process.env.TZ;
process.env.TZ = 'Pacific/Kiritimati';
afterAll(() => {
  if (ORIGINAL_TZ === undefined) delete process.env.TZ;
  else process.env.TZ = ORIGINAL_TZ;
});

describe('device in Kiritimati (UTC+14)', () => {
  it('shows the SAST day of a zoned timestamp, in display and in files', () => {
    expect(formatDisplayDate('2026-10-20T22:00:00Z')).toBe('21 Oct 2026');
    expect(formatDisplayDate('2026-10-20T21:59:59Z')).toBe('20 Oct 2026');
    expect(formatDisplayDateTime('2026-10-20T22:00:00Z')).toBe('21 Oct 2026, 00:00');
    expect(formatDateISO('2026-10-20T22:00:00Z')).toBe('2026-10-21');
    expect(formatDateISO('2026-10-20T21:59:59Z')).toBe('2026-10-20');
    expect(formatDateTimeISO('2026-10-20 22:30:00+00')).toBe('2026-10-21 00:30');
  });

  it('reads a Date from its own local fields, and a plain date as itself', () => {
    expect(formatDisplayDate(new Date(2026, 9, 21, 0, 0))).toBe('21 Oct 2026');
    expect(formatDateISO(new Date(2026, 9, 21, 23, 59))).toBe('2026-10-21');
    expect(formatDateISO('2026-10-21')).toBe('2026-10-21');
    expect(formatDisplayDate('2026-10-21')).toBe('21 Oct 2026');
  });

  it('never turns a non-date into a day', () => {
    expect(formatDateISO('INV-001')).toBe('');
    expect(formatDateISO('123')).toBe('');
    expect(formatDateISO('2026-02')).toBe('');
    expect(formatDisplayDate('INV-001')).toBe('INV-001');
  });
});
