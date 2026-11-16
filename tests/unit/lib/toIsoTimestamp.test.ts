/**
 * toIsoTimestamp: pg returns a timestamptz column as a Date; String(Date) is Date.toString()
 * ("Mon Nov 16 2026 16:05:08 GMT+0200 (South Africa Standard Time)"), which the UI date formatters
 * cannot parse and print raw. A Date becomes ISO 8601; a string passes through; null/undefined is null.
 */
import { describe, expect, it } from 'vitest';
import { toIsoTimestamp } from '@/lib/dateUtils';

describe('toIsoTimestamp', () => {
  it('a Date becomes ISO 8601 UTC', () => {
    expect(toIsoTimestamp(new Date('2026-11-16T14:05:08.000Z'))).toBe('2026-11-16T14:05:08.000Z');
  });
  it('a string passes through unchanged', () => {
    expect(toIsoTimestamp('2026-11-16 16:05:08+02')).toBe('2026-11-16 16:05:08+02');
  });
  it('null and undefined are null', () => {
    expect(toIsoTimestamp(null)).toBeNull();
    expect(toIsoTimestamp(undefined)).toBeNull();
  });
});
