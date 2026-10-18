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

  it('does not trust rows that carry no balances: nothing shows that none was dropped', () => {
    expect(nativeRowsAreComplete(parsed([tx(-10), tx(-20)]))).toBe(false);
  });

  it('does not trust a result in which only some rows carry a balance, however the others chain', () => {
    expect(nativeRowsAreComplete(parsed([tx(-10, 90), tx(-5), tx(-15, 70)]))).toBe(false);
    expect(nativeRowsAreComplete(parsed([tx(-10), tx(-20, 70)]))).toBe(false);
    expect(nativeRowsAreComplete(parsed([tx(-10, 90), tx(-20, 70), tx(5)]))).toBe(false);
  });

  it('does not trust a single balance-carrying row with nothing to compare it against', () => {
    expect(nativeRowsAreComplete(parsed([tx(-10, 90)]))).toBe(false);
  });

  it('does not trust an empty result, with or without an opening balance', () => {
    expect(nativeRowsAreComplete(parsed([]))).toBe(false);
    expect(nativeRowsAreComplete(parsed([], { openingBalance: 100 }))).toBe(false);
  });
});

describe('nativeRowsAreComplete against the printed opening balance', () => {
  it('accepts rows that start where the statement opened, oldest first', () => {
    expect(nativeRowsAreComplete(parsed([tx(-10, 90), tx(-20, 70)], { openingBalance: 100 }))).toBe(true);
  });

  it('accepts rows that start where the statement opened, newest first', () => {
    expect(nativeRowsAreComplete(parsed([tx(-20, 70), tx(-10, 90)], { openingBalance: 100 }))).toBe(true);
  });

  it('refuses rows whose first row is not the first row of the statement (a dropped first row), oldest first', () => {
    expect(nativeRowsAreComplete(parsed([tx(-20, 70), tx(-5, 65)], { openingBalance: 100 }))).toBe(false);
  });

  it('refuses a dropped first row, newest first', () => {
    expect(nativeRowsAreComplete(parsed([tx(-5, 65), tx(-20, 70)], { openingBalance: 100 }))).toBe(false);
  });

  it('trusts one row that follows from the opening balance, and refuses one that does not', () => {
    expect(nativeRowsAreComplete(parsed([tx(-10, 90)], { openingBalance: 100 }))).toBe(true);
    expect(nativeRowsAreComplete(parsed([tx(-10, 80)], { openingBalance: 100 }))).toBe(false);
  });

  it('accepts a cent of rounding at the opening balance', () => {
    expect(nativeRowsAreComplete(parsed([tx(-10, 90.01)], { openingBalance: 100 }))).toBe(true);
  });
});

describe('nativeRowsAreComplete against the amount the line printed', () => {
  // ABSA's parser derives each amount from the balances, so its balances chain by construction: a dropped row
  // is absorbed into the next row's amount. The amount printed on the line is what shows it.
  const printed = (amount: number, balance: number, printedAmount: number): ParsedBankTransaction => ({ ...tx(amount, balance), printedAmount });

  it('accepts rows whose derived amount is the printed one', () => {
    expect(nativeRowsAreComplete(parsed([printed(-10, 90, 10), printed(-20, 70, 20)], { openingBalance: 100 }))).toBe(true);
  });

  it('refuses a row whose derived amount is larger than the printed one (a row dropped before it)', () => {
    expect(nativeRowsAreComplete(parsed([printed(-10, 90, 10), printed(-35, 55, 20)], { openingBalance: 100 }))).toBe(false);
  });

  it('refuses it with no opening balance too: the chain holds, the printed amount does not', () => {
    expect(nativeRowsAreComplete(parsed([printed(-10, 90, 10), printed(-35, 55, 20)]))).toBe(false);
  });
});
