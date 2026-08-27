/**
 * `isRealCalendarDate` guards values that are about to be cast as `$n::DATE`.
 * Postgres rejects an overflowing date with 22008, and on a read path there is
 * no savepoint to contain it — the whole request transaction aborts. So the
 * bar here is Postgres's bar, not Date.parse's.
 */
import { describe, it, expect } from 'vitest';
import { isRealCalendarDate, isValidDate } from '@/lib/validation';

describe('isRealCalendarDate', () => {
  it('accepts ordinary dates', () => {
    for (const d of ['2026-03-05', '1900-01-01', '2099-12-31', '2026-01-31']) {
      expect(isRealCalendarDate(d)).toBe(true);
    }
  });

  it('accepts a real leap day and rejects a fake one', () => {
    expect(isRealCalendarDate('2028-02-29')).toBe(true);
    expect(isRealCalendarDate('2026-02-29')).toBe(false);
    expect(isRealCalendarDate('2100-02-29')).toBe(false); // century, not a leap year
    expect(isRealCalendarDate('2000-02-29')).toBe(true); // but 2000 is
  });

  it('rejects an overflowing day or month', () => {
    for (const d of ['2026-02-31', '2026-13-05', '2026-01-45', '2026-00-10', '2026-01-00']) {
      expect(isRealCalendarDate(d)).toBe(false);
    }
  });

  it('rejects anything that is not exactly YYYY-MM-DD', () => {
    for (const d of ['', '2026-3-5', '26-03-05', '2026/03/05', '2026-03-05T00:00:00Z', 'junk']) {
      expect(isRealCalendarDate(d)).toBe(false);
    }
  });

  // Date.UTC(1, 0, 1) is 1901-01-01: years 0–99 are mapped into the 20th
  // century, so a Date.UTC-based round-trip rejects every year below 100 as a
  // mismatch. Postgres accepts 0001-01-01 perfectly well.
  it('accepts years below 100, which Date.UTC would silently shift to 1900+', () => {
    for (const d of ['0001-01-01', '0099-12-31', '0050-06-15', '0004-02-29']) {
      expect(isRealCalendarDate(d)).toBe(true);
    }
  });

  // JavaScript HAS a year 0 (1 BC under ISO 8601 astronomical numbering) and
  // every component round-trips cleanly, so the round-trip alone accepts it.
  // Postgres's calendar goes 1 BC straight to 1 AD — no year 0 — so
  // '0000-01-01' is a 22008 there. Verified against the dev database.
  it('rejects year 0, which JS accepts and Postgres does not', () => {
    expect(isRealCalendarDate('0000-01-01')).toBe(false);
    expect(isRealCalendarDate('0000-12-31')).toBe(false);
    // The year immediately after it is a real Postgres date and must survive.
    expect(isRealCalendarDate('0001-01-01')).toBe(true);
  });

  it('is stricter than isValidDate, which is the reason it exists', () => {
    // Date.parse rolls 31 February forward to 3 March and returns a timestamp;
    // Postgres throws 22008 on the same literal.
    expect(isValidDate('2026-02-31')).toBe(true);
    expect(isRealCalendarDate('2026-02-31')).toBe(false);
  });
});
