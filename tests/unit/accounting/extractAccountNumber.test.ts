/**
 * Tests for the two-pass extractAccountNumber helper used by bank
 * statement parsers.
 *
 * Covers:
 *   - Pass 1: labelled patterns (Account Number, Acc No, A/C)
 *   - Pass 2: unlabelled header fallback (Standard Bank style)
 *   - Negative cases: text without any plausible account number
 *   - Boundary: labels must win over a stray number earlier in the text
 *   - Boundary: counterparty numbers in transaction rows must not be
 *     picked up when no header candidate exists
 */

import { describe, it, expect } from 'vitest';
import { extractAccountNumber } from '@/modules/accounting/utils/bankPdfParserUtils';

describe('extractAccountNumber — labelled Pass 1', () => {
  it('finds "Account Number: 12345678"', () => {
    expect(extractAccountNumber('Holder: J. Smith\nAccount Number: 12345678\nBranch: ...')).toBe('12345678');
  });

  it('finds "Acc No 40-696-2589-5" and strips separators', () => {
    expect(extractAccountNumber('Acc No 40-696-2589-5')).toBe('4069625895');
  });

  it('finds "A/C: 4069625895"', () => {
    expect(extractAccountNumber('Branch 632005 A/C: 4069625895')).toBe('4069625895');
  });

  it('is case-insensitive on labels', () => {
    expect(extractAccountNumber('ACCOUNT NUMBER 12345678')).toBe('12345678');
    expect(extractAccountNumber('account no: 12345678')).toBe('12345678');
  });

  it('prefers the labelled match even if an earlier unlabelled number exists', () => {
    // Without Pass 1, Pass 2 would pick 9988776655 (first 9-13 digit hit).
    // With Pass 1 in place, the labelled "Account Number: ..." must win.
    const text = 'Invoice 9988776655 dated 2024-01-01\nAccount Number: 4069625895';
    expect(extractAccountNumber(text)).toBe('4069625895');
  });
});

describe('extractAccountNumber — unlabelled Pass 2 fallback', () => {
  it('finds a Standard Bank-style unlabelled number in the header region', () => {
    // Real-world sample: "ISINDA 029 4069625895 0196 Date Transaction ..."
    const text = 'Private Bag X18, Johannesburg\nT/A Monyetla Projects\n'
      + 'Classic Business Acc 21 Jan 2024\n'
      + 'Balance Brought Forward 19 427,30\n'
      + 'Date Transaction Description\n'
      + 'ISINDA 029 4069625895 0196 21/01/2024 ABSA Bank ...';
    expect(extractAccountNumber(text)).toBe('4069625895');
  });

  it('returns the FIRST plausible 9-13 digit token in the header', () => {
    // If multiple candidates exist, the first one wins.
    const text = 'Header line\n4069625895 0196\n2024-01-15 POS Purchase 9988776655';
    expect(extractAccountNumber(text)).toBe('4069625895');
  });

  it('ignores obvious non-account numbers outside the header region', () => {
    // If the only long digit sequence is BEYOND the ~3000 char header
    // window, we return null rather than guess from transaction rows.
    const filler = 'a'.repeat(3200);
    const text = `${filler} 4069625895 end`;
    expect(extractAccountNumber(text)).toBe(null);
  });

  it('does not match 8-digit SARS tax numbers in the header', () => {
    // 8 digits is below the 9-digit minimum, so it should NOT match.
    // Only a 9+ digit sequence qualifies.
    const text = 'Tax Ref 98765432\nHolder Name';
    expect(extractAccountNumber(text)).toBe(null);
  });
});

describe('extractAccountNumber — negative cases', () => {
  it('returns null for empty string', () => {
    expect(extractAccountNumber('')).toBe(null);
  });

  it('returns null for text with no digit sequences', () => {
    expect(extractAccountNumber('No numbers here at all, just text.')).toBe(null);
  });

  it('returns null when all digit sequences are too short', () => {
    expect(extractAccountNumber('Branch 12345 Code 678')).toBe(null);
  });
});
