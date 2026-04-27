/**
 * Unit tests for src/lib/format/aging.ts — formatOverdueDaysCompact
 *
 * Covers all boundary cases specified in GAP-4 of the 2026-04-27 UI/UX audit:
 *   negative, zero, 1, 365 (upper cap boundary), 366 (first over-cap), 2268
 *   (demo data regression), NaN, undefined-cast-to-NaN, Infinity.
 */

import { describe, it, expect } from 'vitest';
import { formatOverdueDaysCompact } from '@/lib/format/aging';

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
