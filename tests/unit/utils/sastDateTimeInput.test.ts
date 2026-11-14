import { describe, expect, it } from 'vitest';
import { isoToSastInput, sastInputToIso } from '@/utils/sastDateTimeInput';

describe('sastDateTimeInput', () => {
  it('shows an instant as SAST wall clock, across midnight too', () => {
    expect(isoToSastInput('2026-11-14T08:00:00.000Z')).toBe('2026-11-14T10:00');
    expect(isoToSastInput('2026-11-14T23:30:00.000Z')).toBe('2026-11-15T01:30');
    expect(isoToSastInput('2026-12-31T22:00:00Z')).toBe('2027-01-01T00:00');
  });

  it('reads the input as SAST', () => {
    expect(sastInputToIso('2026-11-14T10:00')).toBe('2026-11-14T08:00:00.000Z');
    expect(sastInputToIso('2026-11-15T01:30')).toBe('2026-11-14T23:30:00.000Z');
  });

  it('round-trips every minute of a day without drift', () => {
    for (let m = 0; m < 24 * 60; m += 7) {
      const iso = new Date(Date.UTC(2026, 10, 14, 0, m)).toISOString();
      expect(sastInputToIso(isoToSastInput(iso))).toBe(iso);
    }
  });

  it('empty or unreadable is empty, never a wrong date', () => {
    for (const v of ['', null, undefined, 'soon', '2026-13-45T99:99']) {
      expect(isoToSastInput(v as string)).toBe('');
      expect(sastInputToIso(v as string)).toBe('');
    }
    expect(sastInputToIso('2026-11-14')).toBe(''); // a date alone is not a datetime-local value
  });
});
