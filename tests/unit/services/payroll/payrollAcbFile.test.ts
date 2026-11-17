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

  // Review #1524 (format): what the layout's "must contain" rules refuse, each naming whose field it was.
  it.each([
    ['an all-zero homing account (p.4 f7 + p.8 f18: no account)', (i: AcbFileInput) => { i.payments[1]!.accountNumber = '00000000000'; }, /all zeros/, { kind: 'payment', index: 1 }],
    ['an all-zero paying account', (i: AcbFileInput) => { i.from.accountNumber = '0'; }, /all zeros/, { kind: 'from' }],
    ['homing branch 000000 (the public-recipient code, p.4 f6)', (i: AcbFileInput) => { i.payments[0]!.branchCode = '000000'; }, /public-recipient/, { kind: 'payment', index: 0 }],
    ['paying branch 000000', (i: AcbFileInput) => { i.from.branchCode = '000000'; }, /public-recipient/, { kind: 'from' }],
    ['a name that folds to nothing (p.7 f16)', (i: AcbFileInput) => { i.payments[0]!.accountName = '王小明'; }, /no characters/, { kind: 'payment', index: 0 }],
    ['a whitespace-only name', (i: AcbFileInput) => { i.payments[1]!.accountName = '   '; }, /no characters/, { kind: 'payment', index: 1 }],
    ['a reference that folds to nothing (p.7 f14)', (i: AcbFileInput) => { i.payments[0]!.reference = 'Ωμέγα'; }, /no characters/, { kind: 'payment', index: 0 }],
    ['an unknown account type, even an inherited key', (i: AcbFileInput) => { (i.payments[0] as { accountType: string }).accountType = 'toString'; }, /unknown account type/, { kind: 'payment', index: 0 }],
  ])('refuses %s, naming its owner', (_name, mutate, msg, owner) => {
    const i = input();
    mutate(i);
    let err: unknown;
    try { buildAcbPaymentFile(i); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(AcbFileInputError);
    expect((err as AcbFileInputError).message).toMatch(msg);
    expect((err as AcbFileInputError).owner).toEqual(owner);
  });

  it('writes the transmission account type as 3 (p.5)', () => {
    const i = input();
    i.payments[0]!.accountType = 'transmission';
    expect(buildAcbPaymentFile(i).content.split('\r\n')[2]!.slice(46, 47)).toBe('3');
  });

  it('every field lands at its page position (pp.3-12)', () => {
    const lines = buildAcbPaymentFile(input()).content.split('\r\n');
    const t = lines[2]!;
    expect([t.slice(0, 2), t.slice(2, 8), t.slice(8, 19), t.slice(23, 29), t.slice(29, 35), t.slice(35, 46), t.slice(46, 47), t.slice(47, 58)])
      .toEqual(['10', '250655', '62000000001', '000001', '632005', '04071234567', '2', '00001834567']);
    expect([t.slice(58, 70), t.slice(70, 90), t.slice(100, 115), t.slice(130, 150)])
      .toEqual(['0'.repeat(12), 'Test Co Pty Ltd     ', 'Thandi Mokoena ', '0'.repeat(20)]);
    expect([lines[4]!.slice(0, 19), lines[4]!.slice(19, 58), lines[4]!.slice(58, 64)]).toEqual(['1225065562000000001', '0'.repeat(39), '261125']);
  });

  it('100 000 payments keep a 6-digit ascending sequence; 100 001 are refused', () => {
    const i = input();
    i.payments = Array(100_000).fill(i.payments[0]);
    expect(buildAcbPaymentFile(i).content.split('\r\n')[100_001]!.slice(23, 29)).toBe('100000');
    i.payments = Array(100_001).fill(i.payments[0]);
    expect(() => buildAcbPaymentFile(i)).toThrow(/at most 100000/);
  });
});
