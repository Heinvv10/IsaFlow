/**
 * When the rows a bank's own PDF parser returned may stand in for a page-by-page read. A parser
 * that dropped lines must not win silently: any row it could not read (errors) or a running balance
 * that does not follow from the amounts (a row missing between two balances) sends the statement to
 * the page reader instead. Measured on real statements: ABSA and Standard Bank read clean (0 errors,
 * every running balance chains); two FNB statements gave errors on ~10-25% of lines and balances
 * that chain in 1 pair in 100.
 */
import { describe, expect, it } from 'vitest';
import type { BankCsvParseResult, ParsedBankTransaction } from '@/modules/accounting/types/bank.types';
import { nativeRowsAreComplete } from '@/modules/accounting/services/bank/nativeParseTrust';

const tx = (amount: number, balance?: number): ParsedBankTransaction => (
  { transactionDate: '2026-03-05', amount, description: 'x', balance });
const parsed = (transactions: ParsedBankTransaction[], over: Partial<BankCsvParseResult> = {}): BankCsvParseResult => (
  { transactions, errors: [], bankFormat: 'absa', parser: 'native', ...over });

describe('nativeRowsAreComplete', () => {
  it('accepts rows whose running balances chain, oldest first', () => {
    expect(nativeRowsAreComplete(parsed([tx(-10, 90), tx(-20, 70), tx(50, 120)]))).toBe(true);
  });

  it('accepts rows whose running balances chain, newest first', () => {
    expect(nativeRowsAreComplete(parsed([tx(50, 120), tx(-20, 70), tx(-10, 90)]))).toBe(true);
  });

  it('accepts a cent of rounding between amount and balances', () => {
    expect(nativeRowsAreComplete(parsed([tx(-10.004, 90), tx(-20, 70.01)]))).toBe(true);
  });

  it('refuses rows with a missing row between two balances (the chain breaks)', () => {
    expect(nativeRowsAreComplete(parsed([tx(-10, 90), tx(50, 120)]))).toBe(false);
  });

  it('refuses rows when only one pair in the middle breaks', () => {
    expect(nativeRowsAreComplete(parsed([tx(-10, 90), tx(-20, 70), tx(5, 999), tx(1, 1000)]))).toBe(false);
  });

  it('refuses rows when the parser could not read some line, however well the balances chain', () => {
    expect(nativeRowsAreComplete(parsed([tx(-10, 90), tx(-20, 70)], { errors: [{ row: 3, error: 'Invalid amount: ' }] }))).toBe(false);
  });

  it('accepts clean rows that carry no balances: nothing contradicts them', () => {
    expect(nativeRowsAreComplete(parsed([tx(-10), tx(-20)]))).toBe(true);
  });

  it('carries a row without a balance into the next balance rather than breaking the chain at it', () => {
    expect(nativeRowsAreComplete(parsed([tx(-10, 90), tx(-5), tx(-15, 70)]))).toBe(true);
    expect(nativeRowsAreComplete(parsed([tx(-10, 90), tx(-5), tx(-20, 70)]))).toBe(false);
  });

  it('accepts a single row and an empty result', () => {
    expect(nativeRowsAreComplete(parsed([tx(-10, 90)]))).toBe(true);
    expect(nativeRowsAreComplete(parsed([]))).toBe(true);
  });
});
