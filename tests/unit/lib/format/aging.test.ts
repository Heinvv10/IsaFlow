/**
 * Unit tests for src/lib/format/aging.ts
 *
 * Covers:
 *   - formatOverdueDaysCompact — GAP-4 boundary cases from 2026-04-27 UI/UX audit
 *   - computeAgingBucket — mirrors the SQL CASE WHEN ladder in
 *     pages/api/accounting/customer-invoices-list.ts; these tests are the
 *     authoritative spec for bucket boundaries.
 */

import { describe, it, expect } from 'vitest';
import { formatOverdueDaysCompact, computeAgingBucket } from '@/lib/format/aging';

describe('formatOverdueDaysCompact', () => {
  it('returns "—" for negative values', () => {
    expect(formatOverdueDaysCompact(-1)).toBe('—');
  });

  it('returns "—" for zero', () => {
    expect(formatOverdueDaysCompact(0)).toBe('—');
  });

  it('returns "1" for 1 day overdue', () => {
    expect(formatOverdueDaysCompact(1)).toBe('1');
  });

  it('returns "365" for exactly 365 days (boundary — still within cap)', () => {
    expect(formatOverdueDaysCompact(365)).toBe('365');
  });

  it('returns ">365" for 366 days (first value over the cap)', () => {
    expect(formatOverdueDaysCompact(366)).toBe('>365');
  });

  it('returns ">365" for 2268 days (demo data regression guard)', () => {
    expect(formatOverdueDaysCompact(2268)).toBe('>365');
  });

  it('returns "—" for NaN', () => {
    expect(formatOverdueDaysCompact(NaN)).toBe('—');
  });

  it('returns "—" for a non-finite number cast from undefined (Number(undefined) → NaN)', () => {
    // This guards the common JS pattern where a field is absent and coerced.
    expect(formatOverdueDaysCompact(Number(undefined))).toBe('—');
  });

  it('returns "—" for Infinity', () => {
    expect(formatOverdueDaysCompact(Infinity)).toBe('—');
  });

  it('returns "—" for -Infinity', () => {
    expect(formatOverdueDaysCompact(-Infinity)).toBe('—');
  });

  it('floors fractional days correctly (91.9 → "91")', () => {
    expect(formatOverdueDaysCompact(91.9)).toBe('91');
  });
});

describe('computeAgingBucket', () => {
  it('returns null for paid invoices regardless of days', () => {
    expect(computeAgingBucket(30, 'paid')).toBeNull();
    expect(computeAgingBucket(0, 'paid')).toBeNull();
    expect(computeAgingBucket(120, 'paid')).toBeNull();
  });

  it('returns Current when days is 0 (not yet overdue)', () => {
    expect(computeAgingBucket(0, 'sent')).toBe('Current');
  });

  it('returns Current when days is negative (paid early or same day)', () => {
    expect(computeAgingBucket(-5, 'sent')).toBe('Current');
  });

  it('returns Current when days is NaN (due_date absent, guard against runtime coercions)', () => {
    expect(computeAgingBucket(NaN, 'sent')).toBe('Current');
  });

  it('returns 1-30 for 1 day overdue (bucket lower boundary)', () => {
    expect(computeAgingBucket(1, 'sent')).toBe('1-30');
  });

  it('returns 1-30 for 30 days overdue (bucket upper boundary)', () => {
    expect(computeAgingBucket(30, 'sent')).toBe('1-30');
  });

  it('returns 31-60 for 31 days overdue (bucket lower boundary)', () => {
    expect(computeAgingBucket(31, 'sent')).toBe('31-60');
  });

  it('returns 31-60 for 60 days overdue (bucket upper boundary)', () => {
    expect(computeAgingBucket(60, 'sent')).toBe('31-60');
  });

  it('returns 61-90 for 61 days overdue (bucket lower boundary)', () => {
    expect(computeAgingBucket(61, 'sent')).toBe('61-90');
  });

  it('returns 61-90 for 90 days overdue (bucket upper boundary)', () => {
    expect(computeAgingBucket(90, 'sent')).toBe('61-90');
  });

  it('returns 90+ for 91 days overdue (worst bucket lower boundary)', () => {
    expect(computeAgingBucket(91, 'sent')).toBe('90+');
  });
});
