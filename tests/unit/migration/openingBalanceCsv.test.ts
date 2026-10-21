/**
 * The opening-balance step read `r['debit']`, `r['code']`... case-sensitively
 * with no mapping UI, so a Sage trial balance headed "Account Code, Debit,
 * Credit" parsed as all-blank rows and the import button silently disabled.
 */
import { describe, it, expect } from 'vitest';
import {
  detectOpeningBalanceColumns,
  parseOpeningBalanceCsv,
} from '@/modules/accounting/services/core/openingBalanceCsv';

describe('detectOpeningBalanceColumns', () => {
  it.each([
    [['Account Code', 'Account Name', 'Debit', 'Credit']],
    [['account_code', 'account_name', 'debit_balance', 'credit_balance']],
    [['CODE', 'NAME', 'DR', 'CR']],
    [['Acc No', 'Description', 'Debit Balance', 'Credit Balance']],
    [['Account Number', 'Description', 'Dr', 'Cr']],
    [['Account', 'Description', 'Debit', 'Credit']],
  ])('finds code / name / debit / credit in %j', fields => {
    const cols = detectOpeningBalanceColumns(fields);
    expect(cols.code).toBe(fields[0]);
    expect(cols.name).toBe(fields[1]);
    expect(cols.debit).toBe(fields[2]);
    expect(cols.credit).toBe(fields[3]);
  });

  it('finds a single balance column', () => {
    expect(detectOpeningBalanceColumns(['Code', 'Closing Balance']).balance).toBe('Closing Balance');
    expect(detectOpeningBalanceColumns(['Code', 'Balance']).balance).toBe('Balance');
  });
});

describe('parseOpeningBalanceCsv', () => {
  it('reads debit / credit columns with SA number formats', () => {
    const data = [
      { 'Account Code': '1110', 'Account Name': 'Bank', Debit: 'R 1 234,56', Credit: '' },
      { 'Account Code': '3200', 'Account Name': 'Retained', Debit: '', Credit: '1,234.56' },
    ];
    const res = parseOpeningBalanceCsv(data, ['Account Code', 'Account Name', 'Debit', 'Credit']);
    expect(res.missingColumnsMessage).toBeNull();
    expect(res.errors).toEqual([]);
    expect(res.rows).toEqual([
      { accountCode: '1110', accountName: 'Bank', debit: 1234.56, credit: 0 },
      { accountCode: '3200', accountName: 'Retained', debit: 0, credit: 1234.56 },
    ]);
  });

  it('reads a single balance column: positive is debit, negative (or Cr) is credit', () => {
    const data = [
      { Code: '1110', Balance: '500.00' },
      { Code: '2110', Balance: '(300.00)' },
      { Code: '3200', Balance: '200.00 Cr' },
    ];
    const res = parseOpeningBalanceCsv(data, ['Code', 'Balance']);
    expect(res.rows.map(r => [r.debit, r.credit])).toEqual([[500, 0], [0, 300], [0, 200]]);
  });

  it('keeps a value written "Cr" in the credit column on the credit side', () => {
    const res = parseOpeningBalanceCsv([{ Code: '3200', Debit: '', Credit: '200.00 Cr' }], ['Code', 'Debit', 'Credit']);
    expect(res.rows[0]).toMatchObject({ debit: 0, credit: 200 });
  });

  it('reports a garbage amount as a row error instead of importing 0', () => {
    const res = parseOpeningBalanceCsv(
      [{ Code: '1110', Debit: '12x', Credit: '' }, { Code: '1120', Debit: '5', Credit: '' }],
      ['Code', 'Debit', 'Credit'],
    );
    expect(res.errors).toHaveLength(1);
    expect(res.errors[0]!.row).toBe(1);
    expect(res.errors[0]!.message).toContain('12x');
    expect(res.rows.map(r => r.accountCode)).toEqual(['1120']);
  });

  it('skips a trailing total row but reports amounts without an account code', () => {
    const res = parseOpeningBalanceCsv(
      [
        { Code: '1110', Name: 'Bank', Debit: '5', Credit: '' },
        { Code: '', Name: 'TOTAL', Debit: '5', Credit: '5' },
        { Code: '', Name: 'Mystery', Debit: '7', Credit: '' },
      ],
      ['Code', 'Name', 'Debit', 'Credit'],
    );
    expect(res.rows).toHaveLength(1);
    expect(res.errors).toHaveLength(1);
    expect(res.errors[0]!.row).toBe(3);
  });

  it('names the expected headers when the required columns are missing', () => {
    const res = parseOpeningBalanceCsv([{ Foo: '1', Bar: '2' }], ['Foo', 'Bar']);
    expect(res.rows).toEqual([]);
    expect(res.missingColumnsMessage).toMatch(/account code/i);
    expect(res.missingColumnsMessage).toMatch(/debit/i);
    expect(res.missingColumnsMessage).toMatch(/balance/i);
    expect(res.missingColumnsMessage).toContain('Foo');
  });
});
