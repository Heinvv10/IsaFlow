/** Original pure validation assertions retained verbatim from journalEntryService.test.ts. */
import {describe,it,expect} from 'vitest';
import {validateJournalEntry,validateJournalLine,formatJournalEntryNumber,roundToCents} from '@/modules/accounting/utils/doubleEntry';
import type {JournalLineInput} from '@/modules/accounting/types/gl.types';
const ACCOUNT_A='dddddddd-0000-0000-0000-000000000004',ACCOUNT_B='eeeeeeee-0000-0000-0000-000000000005';
const balancedLines:JournalLineInput[]=[{glAccountId:ACCOUNT_A,debit:1000,credit:0},{glAccountId:ACCOUNT_B,debit:0,credit:1000}];
describe('validateJournalLine', () => {
  it('accepts a valid debit line', () => {
    const result = validateJournalLine({ glAccountId: ACCOUNT_A, debit: 500, credit: 0 });
    expect(result.valid).toBe(true);
  });

  it('accepts a valid credit line', () => {
    const result = validateJournalLine({ glAccountId: ACCOUNT_B, debit: 0, credit: 500 });
    expect(result.valid).toBe(true);
  });

  it('rejects a line with no account id', () => {
    const result = validateJournalLine({ glAccountId: '', debit: 500, credit: 0 });
    expect(result.valid).toBe(false);
    expect(result.error).toContain('account ID');
  });

  it('rejects a line where both debit and credit are set', () => {
    const result = validateJournalLine({ glAccountId: ACCOUNT_A, debit: 100, credit: 100 });
    expect(result.valid).toBe(false);
    expect(result.error).toContain('not both');
  });

  it('rejects a line where both debit and credit are zero', () => {
    const result = validateJournalLine({ glAccountId: ACCOUNT_A, debit: 0, credit: 0 });
    expect(result.valid).toBe(false);
    expect(result.error).toContain('non-zero');
  });

  it('rejects negative debit', () => {
    const result = validateJournalLine({ glAccountId: ACCOUNT_A, debit: -100, credit: 0 });
    expect(result.valid).toBe(false);
    expect(result.error).toContain('negative');
  });

  it('rejects negative credit', () => {
    const result = validateJournalLine({ glAccountId: ACCOUNT_A, debit: 0, credit: -50 });
    expect(result.valid).toBe(false);
    expect(result.error).toContain('negative');
  });
});

// ── validateJournalEntry (pure function, no mocks needed) ─────────────────────

describe('validateJournalEntry', () => {
  it('accepts a balanced two-line entry', () => {
    const result = validateJournalEntry(balancedLines);
    expect(result.valid).toBe(true);
    expect(result.totalDebit).toBe(1000);
    expect(result.totalCredit).toBe(1000);
    expect(result.difference).toBe(0);
    expect(result.errors).toHaveLength(0);
  });

  it('rejects an empty lines array', () => {
    const result = validateJournalEntry([]);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('at least'))).toBe(true);
  });

  it('rejects a single-line entry (no double-entry)', () => {
    const result = validateJournalEntry([
      { glAccountId: ACCOUNT_A, debit: 1000, credit: 0 },
    ]);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('2 lines'))).toBe(true);
  });

  it('rejects unbalanced entries', () => {
    const unbalanced: JournalLineInput[] = [
      { glAccountId: ACCOUNT_A, debit: 1000, credit: 0 },
      { glAccountId: ACCOUNT_B, debit: 0, credit: 500 },
    ];
    const result = validateJournalEntry(unbalanced);
    expect(result.valid).toBe(false);
    expect(result.difference).toBeCloseTo(500, 2);
    expect(result.errors.some(e => e.includes('not balanced'))).toBe(true);
  });

  it('accepts a multi-line entry where totals balance', () => {
    const multiLine: JournalLineInput[] = [
      { glAccountId: ACCOUNT_A, debit: 300, credit: 0 },
      { glAccountId: ACCOUNT_A, debit: 700, credit: 0 },
      { glAccountId: ACCOUNT_B, debit: 0, credit: 1000 },
    ];
    const result = validateJournalEntry(multiLine);
    expect(result.valid).toBe(true);
    expect(result.totalDebit).toBe(1000);
    expect(result.totalCredit).toBe(1000);
  });

  it('surfaces individual line errors alongside balance errors', () => {
    const badLines: JournalLineInput[] = [
      { glAccountId: '', debit: 500, credit: 0 },
      { glAccountId: ACCOUNT_B, debit: 0, credit: 500 },
    ];
    const result = validateJournalEntry(badLines);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('Line 1'))).toBe(true);
  });
});

// ── formatJournalEntryNumber (pure function) ──────────────────────────────────

describe('formatJournalEntryNumber', () => {
  it('formats correctly with zero-padded sequence', () => {
    expect(formatJournalEntryNumber(2026, 1)).toBe('JE-2026-00001');
    expect(formatJournalEntryNumber(2026, 99999)).toBe('JE-2026-99999');
  });
});

// ── roundToCents (pure function) ──────────────────────────────────────────────

describe('roundToCents', () => {
  it('rounds 0.005 up to 0.01', () => {
    expect(roundToCents(0.005)).toBeCloseTo(0.01, 5);
  });

  it('preserves exact cent values', () => {
    expect(roundToCents(123.45)).toBe(123.45);
  });

  it('handles zero', () => {
    expect(roundToCents(0)).toBe(0);
  });

  it('handles negative values', () => {
    expect(roundToCents(-10.999)).toBeCloseTo(-11, 2);
  });
});

