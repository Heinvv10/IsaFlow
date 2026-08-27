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
import { detectBankFormat, parseABSAStatement, parseAmount } from '@/modules/accounting/utils/bankCsvParsers';
import { parseStatement } from '@/modules/accounting/services/bank/bankStatementParseService';

const FIXTURE = readFileSync(join(__dirname, '../../fixtures/bank/absa-sample.csv'), 'utf8');

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
});
