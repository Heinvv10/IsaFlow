/**
 * The salary ACB file against a fixture hand-built from the bank's layout document (FNB, "Payments – Bankserv (ACB)
 * File Format", February 2023; grill F6): tests/fixtures/bank-files/payroll-acb-2-employees.txt was typed field by
 * field from the document's tables, never produced by the generator. Byte-for-byte.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import {
  AcbFileInputError, acbHashTotal, buildAcbPaymentFile, type AcbFileInput,
} from '@/modules/accounting/services/payroll/payrollAcbFile';

const FIXTURE = readFileSync(join(__dirname, '../../../fixtures/bank-files/payroll-acb-2-employees.txt'), 'latin1');

const input = (): AcbFileInput => ({
  from: { branchCode: '250655', accountNumber: '62000000001' },
  actionDate: '2026-11-25',
  payments: [
    { branchCode: '632005', accountNumber: '4071234567', accountType: 'savings', amountCents: 1_834_567, reference: 'Test Co Pty Ltd', accountName: 'Thandi Mokoena' },
    { branchCode: '470010', accountNumber: '1234567890', accountType: 'cheque', amountCents: 900_005, reference: 'Test Co Pty Ltd', accountName: 'Pieter van der Merwe' },
  ],
});

describe('buildAcbPaymentFile', () => {
  it('matches the hand-built fixture byte for byte', () => {
    const file = buildAcbPaymentFile(input());
    expect(file.content).toBe(FIXTURE);
    expect(file).toMatchObject({ lineCount: 2, totalCents: 2_734_572, hashTotal: '067305802458' });
  });

  it('every record is 180 characters and ends CR LF', () => {
    const lines = buildAcbPaymentFile(input()).content.split('\r\n');
    expect(lines.pop()).toBe('');
    expect(lines.map((l) => l.length)).toEqual([180, 180, 180, 180, 180, 180, 180]);
    expect(lines.map((l) => l.slice(0, 2))).toEqual(['02', '04', '10', '10', '12', '92', '94']);
  });

  it('reports what it cut and what it replaced', () => {
    const i = input();
    i.payments[0]!.accountName = 'Zoë Ndlovu';
    const file = buildAcbPaymentFile(i);
    expect(file.warnings).toEqual([
      'Payment 1 account name "Zoë Ndlovu" is written as "Zoe Ndlovu" (the bank file takes plain characters only)',
      'Payment 2 account name "Pieter van der Merwe" is cut to 15 characters in the bank file',
    ]);
    expect(file.content.split('\r\n')[2]!.slice(100, 115)).toBe('Zoe Ndlovu     ');
  });

  it('the hash total keeps the last 12 digits', () => {
    const big = { branchCode: '000000', accountNumber: '99999999999' };
    expect(acbHashTotal(big, [big, big])).toBe('299999999997'.padStart(12, '0'));
    expect(acbHashTotal(big, Array(20).fill(big))).toBe((99999999999n * 21n % 10n ** 12n).toString().padStart(12, '0'));
  });

  it.each([
    ['a zero amount', (i: AcbFileInput) => { i.payments[0]!.amountCents = 0; }, /amount/],
    ['a fractional amount', (i: AcbFileInput) => { i.payments[0]!.amountCents = 10.5; }, /amount/],
    ['a 12-digit account', (i: AcbFileInput) => { i.payments[1]!.accountNumber = '123456789012'; }, /account number/],
    ['a 5-digit branch', (i: AcbFileInput) => { i.payments[1]!.branchCode = '47001'; }, /branch/],
    ['a blank paying account', (i: AcbFileInput) => { i.from.accountNumber = ''; }, /paying account/],
    ['a bad date', (i: AcbFileInput) => { i.actionDate = '25/11/2026'; }, /Action date/],
    ['no payments', (i: AcbFileInput) => { i.payments = []; }, /at least one/],
  ])('refuses %s', (_name, mutate, msg) => {
    const i = input();
    mutate(i);
    expect(() => buildAcbPaymentFile(i)).toThrow(AcbFileInputError);
    expect(() => buildAcbPaymentFile(i)).toThrow(msg);
  });
});
