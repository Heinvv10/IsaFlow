/**
 * Tests for the bank statement → account number security gate.
 *
 * Scenarios covered:
 *   - Exact match across both sides (digits only)
 *   - Formatting tolerance (spaces, dashes, country prefix, mask)
 *   - Genuine mismatch (different accounts)
 *   - Indeterminate (one or both sides missing)
 *   - Edge cases: short numbers, all-zero, whitespace-only
 */

import { describe, it, expect } from 'vitest';
import { compareBankAccountNumbers } from '@/modules/accounting/utils/bankAccountNumberMatch';

describe('compareBankAccountNumbers', () => {
  // ── Exact match ─────────────────────────────────────────────────────────────
  it('returns match when both are identical plain digits', () => {
    expect(compareBankAccountNumbers('12345678', '12345678')).toBe('match');
  });

  it('returns match when one has spaces and the other has dashes', () => {
    expect(compareBankAccountNumbers('1234 5678', '1234-5678')).toBe('match');
  });

  it('returns match when stored has a country prefix and statement has raw digits', () => {
    // ZA40 ABSA = non-digits, so prefix gets stripped. Both collapse to 12345678.
    expect(compareBankAccountNumbers('12345678', 'ZA-ABSA/12345678')).toBe('match');
  });

  it('returns match when both have heavy formatting', () => {
    expect(compareBankAccountNumbers('40 6962 5895', '4069625895')).toBe('match');
  });

  // ── Prefix / mask tolerance ─────────────────────────────────────────────────
  it('returns match when the longer digit run ends with the shorter (masked UI)', () => {
    // User stored last 4 in a masked field, statement has full number.
    expect(compareBankAccountNumbers('4069625895', '5895')).toBe('match');
  });

  it('returns match when statement has a bank routing prefix', () => {
    // Some banks print "632005 4069625895" (branch + account).
    expect(compareBankAccountNumbers('632005 4069625895', '4069625895')).toBe('match');
  });

  it('does NOT match on a 3-digit suffix (too permissive)', () => {
    // 3 digits are too few to be a reliable last-4 match.
    expect(compareBankAccountNumbers('4069625895', '895')).toBe('mismatch');
  });

  // ── Mismatch ────────────────────────────────────────────────────────────────
  it('returns mismatch for two different accounts of the same length', () => {
    expect(compareBankAccountNumbers('12345678', '87654321')).toBe('mismatch');
  });

  it('returns mismatch when only the first few digits overlap', () => {
    expect(compareBankAccountNumbers('1234567890', '1234999999')).toBe('mismatch');
  });

  it('returns mismatch when the shorter number appears inside (not at end) of the longer', () => {
    expect(compareBankAccountNumbers('123456789', '34567')).toBe('mismatch');
  });

  // ── Indeterminate ───────────────────────────────────────────────────────────
  it('returns indeterminate when statement side is null', () => {
    expect(compareBankAccountNumbers(null, '12345678')).toBe('indeterminate');
  });

  it('returns indeterminate when stored side is null', () => {
    expect(compareBankAccountNumbers('12345678', null)).toBe('indeterminate');
  });

  it('returns indeterminate when both sides are null / empty', () => {
    expect(compareBankAccountNumbers(null, null)).toBe('indeterminate');
    expect(compareBankAccountNumbers('', '')).toBe('indeterminate');
    expect(compareBankAccountNumbers('    ', '-----')).toBe('indeterminate');
  });

  it('returns indeterminate when only non-digit chars are present', () => {
    expect(compareBankAccountNumbers('N/A', '12345678')).toBe('indeterminate');
  });

  // ── Edge cases ──────────────────────────────────────────────────────────────
  it('does not treat all-zero as a wildcard', () => {
    expect(compareBankAccountNumbers('00000000', '12345678')).toBe('mismatch');
    expect(compareBankAccountNumbers('00000000', '00000000')).toBe('match');
  });

  it('handles leading zeros consistently', () => {
    expect(compareBankAccountNumbers('00001234', '1234')).toBe('match');
    expect(compareBankAccountNumbers('0001234', '001234')).toBe('match');
  });
});
