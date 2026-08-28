// tests/unit/bank/bankCsvParserAbsa.test.ts
//
// ABSA CSV statement import. Two layouts exist in the wild:
//   legacy  Account Number,Date,Description1,Description2,Amount,Balance
//   current Account Number,Transaction Date,Description,Amount,Balance
// Only the legacy one was recognised, so a current-layout export was rejected
// outright ("Unable to detect bank format"). These tests pin both, plus the
// real-file noise around them: BOM, CRLF, a title row above the header,
// a trailing total row, and SA-formatted amounts ("1 234,56").
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  detectBankFormat,
  parseABSAStatement,
  parseAmount,
  normalizeDateFlexible,
} from '@/modules/accounting/utils/bankCsvParsers';
import { parseStatement } from '@/modules/accounting/services/bank/bankStatementParseService';

const FIXTURE = readFileSync(join(__dirname, '../../fixtures/bank/absa-sample.csv'), 'utf8');
const COMPACT_DATE_FIXTURE = readFileSync(
  join(__dirname, '../../fixtures/bank/absa-compact-dates.csv'),
  'utf8',
);

const LEGACY = [
  'Account Number,Date,Description1,Description2,Amount,Balance',
  '4055123456,2026/03/01,"POS PURCHASE","WOOLWORTHS",-1234.56,48765.44',
  '4055123456,2026/03/02,"SALARY","ACME PTY LTD",25000.00,73765.44',
].join('\n');

describe('ABSA CSV detection', () => {
  it('detects the current 5-column layout through a BOM, title row and CRLF', () => {
    expect(detectBankFormat(FIXTURE)).toBe('absa');
  });

  it('still detects the legacy Description1/Description2 layout', () => {
    expect(detectBankFormat(LEGACY)).toBe('absa');
  });

  it('leaves a debit/credit layout alone even when it names the account', () => {
    // The ABSA rule keys off "Account Number", so these two pin the guard that
    // stops it claiming a statement that splits money across Debit and Credit.
    const nedbankish =
      'Account Number,Transaction Date,Value Date,Transaction Description,Debit Amount,Credit Amount,Balance\n';
    expect(detectBankFormat(nedbankish)).toBe('nedbank');

    // "Debit Amount"/"Credit Amount" rather than "Debit"/"Credit": the header
    // then contains "amount" too, so only the debit/credit guard keeps this out
    // of the ABSA branch. Both assertions here go red if that guard is removed.
    const standardish = 'Account Number,Date,Description,Debit Amount,Credit Amount,Balance\n';
    expect(detectBankFormat(standardish)).toBe('standard_bank');
  });

  it('does not misfire on other SA bank layouts', () => {
    expect(detectBankFormat('"Date","Amount","Balance","Description","Reference"\n')).toBe('fnb');
    expect(
      detectBankFormat('Transaction Date,Value Date,Transaction Description,Debit Amount,Credit Amount,Balance\n'),
    ).toBe('nedbank');
    expect(detectBankFormat('Date,Description,Debit,Credit,Balance\n')).toBe('capitec');
    expect(detectBankFormat('Date,Description,Debit,Credit,Balance,Extra\n')).toBe('standard_bank');
    expect(detectBankFormat('!Type:Bank\nD01/03/2026\n')).toBe('qif');
    expect(detectBankFormat('OFXHEADER:100\n')).toBe('ofx');
  });
});

describe('parseABSAStatement', () => {
  it('parses the current layout, skipping the title and total rows', () => {
    const result = parseABSAStatement(FIXTURE);

    expect(result.errors).toEqual([]);
    expect(result.transactions).toHaveLength(3);

    const first = result.transactions[0]!;
    expect(first.transactionDate).toBe('2026-03-01');
    expect(first.amount).toBe(-1234.56);
    expect(first.description).toBe('POS PURCHASE WOOLWORTHS SANDTON');
    expect(first.balance).toBe(48765.44);

    expect(result.transactions[1]!.amount).toBe(25000);
    expect(result.transactions[2]!.transactionDate).toBe('2026-03-03');
    expect(result.transactions[2]!.amount).toBe(-99);
  });

  it('parses the legacy layout, joining both description columns', () => {
    const result = parseABSAStatement(LEGACY);
    expect(result.errors).toEqual([]);
    expect(result.transactions).toHaveLength(2);
    expect(result.transactions[0]!.description).toBe('POS PURCHASE WOOLWORTHS');
    expect(result.transactions[0]!.amount).toBe(-1234.56);
  });

  it('accepts DD/MM/YYYY dates as well as YYYY/MM/DD', () => {
    const csv = [
      'Account Number,Transaction Date,Description,Amount,Balance',
      '4055123456,01/03/2026,FEE,-25.00,100.00',
    ].join('\n');
    const result = parseABSAStatement(csv);
    expect(result.transactions[0]!.transactionDate).toBe('2026-03-01');
  });

  it('accepts ABSA compact YYYYMMDD dates, zero errors, dates normalised', () => {
    const result = parseABSAStatement(COMPACT_DATE_FIXTURE);

    expect(result.errors).toEqual([]);
    expect(result.transactions).toHaveLength(3);
    expect(result.transactions[0]!.transactionDate).toBe('2026-08-01');
    expect(result.transactions[1]!.transactionDate).toBe('2026-08-02');
    expect(result.transactions[2]!.transactionDate).toBe('2026-08-03');
  });

  it('rejects an impossible compact date (20261301) as an error, not a crash', () => {
    const csv = [
      'Account Number,Transaction Date,Description,Amount,Balance',
      '4055123456,20261301,FEE,-25.00,100.00',
    ].join('\n');
    const result = parseABSAStatement(csv);
    expect(result.transactions).toHaveLength(0);
    expect(result.errors).toEqual([{ row: 2, error: 'Invalid date: 20261301' }]);
  });
});

describe('parseAmount', () => {
  it('reads a comma decimal separator with a space thousands separator', () => {
    expect(parseAmount('1 234,56')).toBe(1234.56);
    expect(parseAmount('-1 234,56')).toBe(-1234.56);
    expect(parseAmount('12,50')).toBe(12.5);
  });

  it('still reads a comma thousands separator with a dot decimal', () => {
    expect(parseAmount('1,234.56')).toBe(1234.56);
    expect(parseAmount('-1234.56')).toBe(-1234.56);
    expect(parseAmount('1,234')).toBe(1234);
  });

  it('resolves the "1,00" ambiguity as a decimal comma, by design', () => {
    // No dot + exactly two trailing digits ⇒ decimal comma. So "1,00" is R1.00,
    // not R100. SA exports always carry cents, and nothing in the string itself
    // separates the two readings — this pins the tradeoff so a later change to
    // the heuristic has to be deliberate.
    expect(parseAmount('1,00')).toBe(1);
    expect(parseAmount('100,00')).toBe(100);
  });

  it('rejects currency-prefixed and parenthesised amounts rather than guessing', () => {
    // Documented non-support: null makes the caller raise an "Invalid amount"
    // parse error, which is visible, instead of silently importing a wrong
    // figure. Change these only with the corresponding parser change.
    expect(parseAmount('R 1,234.56')).toBeNull();
    expect(parseAmount('R1234.56')).toBeNull();
    expect(parseAmount('(123.45)')).toBeNull();
  });
});

describe('normalizeDateFlexible', () => {
  it('reads a trailing four-digit year as DD/MM/YYYY, not MM/DD/YYYY', () => {
    // 3 April, not 4 March — SA exports are day-first. Ambiguous below the 13th
    // of the month, so this pins the assumption rather than a detection.
    expect(normalizeDateFlexible('03/04/2026')).toBe('2026-04-03');
    expect(normalizeDateFlexible('03-04-2026')).toBe('2026-04-03');
  });

  it('reads a leading four-digit year as YYYY/MM/DD', () => {
    expect(normalizeDateFlexible('2026/04/03')).toBe('2026-04-03');
    expect(normalizeDateFlexible('2026-04-03')).toBe('2026-04-03');
  });

  it('returns null when neither end carries a four-digit year', () => {
    expect(normalizeDateFlexible('03/04/26')).toBeNull();
  });

  it('reads an 8-digit compact date (YYYYMMDD) with no separators', () => {
    expect(normalizeDateFlexible('20260801')).toBe('2026-08-01');
  });

  it('rejects an 8-digit value that is not a real calendar date', () => {
    expect(normalizeDateFlexible('20261301')).toBeNull();
    // Year plausibility: a DDMMYYYY token or an account number must not pass as a date.
    expect(normalizeDateFlexible('01082026')).toBeNull();
    expect(normalizeDateFlexible('99990101')).toBeNull();
    expect(normalizeDateFlexible('40551234')).toBeNull();
    expect(normalizeDateFlexible('20260231')).toBeNull();
  });

  it('does not treat a non-8-digit numeric string as a compact date', () => {
    expect(normalizeDateFlexible('123456')).toBeNull();
    expect(normalizeDateFlexible('123456789')).toBeNull();
  });
});

describe('parseStatement (shared MCP + UI import path)', () => {
  it('imports the ABSA fixture as CSV without a bank_format hint', async () => {
    const result = await parseStatement({ fileType: 'csv', csvContent: FIXTURE });
    expect(result.bankFormat).toBe('absa');
    expect(result.transactions).toHaveLength(3);
  });

  it('imports the QIF fixture with all three records', async () => {
    const qif = readFileSync(join(__dirname, '../../fixtures/bank/sample.qif'), 'utf8');
    const result = await parseStatement({ fileType: 'qif', csvContent: qif });
    expect(result.transactions).toHaveLength(3);
  });

  it('imports the ABSA compact-date (YYYYMMDD) fixture without a bank_format hint', async () => {
    const result = await parseStatement({ fileType: 'csv', csvContent: COMPACT_DATE_FIXTURE });
    expect(result.bankFormat).toBe('absa');
    expect(result.transactions).toHaveLength(3);
    expect(result.transactions[0]!.transactionDate).toBe('2026-08-01');
  });
});
