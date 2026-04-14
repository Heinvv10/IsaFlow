import { describe, it, expect } from 'vitest';
import { toISODate } from '@/lib/dateUtils';

describe('toISODate', () => {
  it('converts a JS Date to YYYY-MM-DD', () => {
    expect(toISODate(new Date('2027-01-01T00:00:00.000Z'))).toBe('2027-01-01');
  });
  it('passes through an ISO 8601 string', () => {
    expect(toISODate('2027-01-01T00:00:00.000Z')).toBe('2027-01-01');
  });
  it('converts a JS Date .toString() representation', () => {
    const s = new Date('2027-01-01T00:00:00.000Z').toString();
    expect(toISODate(s)).toBe('2027-01-01');
  });
  it('passes through plain YYYY-MM-DD', () => {
    expect(toISODate('2027-01-01')).toBe('2027-01-01');
  });
  it('returns null for null/undefined/invalid', () => {
    expect(toISODate(null)).toBeNull();
    expect(toISODate(undefined)).toBeNull();
    expect(toISODate('not a date')).toBeNull();
  });
});
