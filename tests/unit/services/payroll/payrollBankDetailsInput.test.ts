/**
 * What setEmployeeBankDetails accepts, judged before anything is read or written (wave 3 K1): a 4xx commits the
 * request's writes, so a refusal must come first. The database half is tests/integration/k1-employee-bank-details.int.test.ts.
 */
import { describe, expect, it } from 'vitest';
import {
  parseBankDetailsInput, PayrollBankDetailsRefusal,
} from '@/modules/accounting/services/payroll/payrollBankDetailsService';

const GOOD = { bankName: 'FNB', branchCode: '250655', accountNumber: '62000123456', accountType: 'cheque', accountHolder: 'W Test' };

function refusedFields(raw: unknown): string[] {
  try {
    parseBankDetailsInput(raw);
  } catch (err) {
    expect(err).toBeInstanceOf(PayrollBankDetailsRefusal);
    expect((err as PayrollBankDetailsRefusal).status).toBe(422);
    return Object.keys((err as PayrollBankDetailsRefusal).fieldErrors ?? {});
  }
  return [];
}

describe('parseBankDetailsInput', () => {
  it('accepts good details and strips spaces from the account number', () => {
    expect(parseBankDetailsInput({ ...GOOD, accountNumber: ' 6200 0123 456 ', bankName: ' FNB ' })).toEqual({
      bankName: 'FNB', branchCode: '250655', accountNumber: '62000123456', accountType: 'cheque', accountHolder: 'W Test',
    });
  });

  it('holder is optional, and blank means none', () => {
    const { accountHolder: _omitted, ...noHolder } = GOOD;
    expect(parseBankDetailsInput(noHolder).accountHolder).toBeNull();
    expect(parseBankDetailsInput({ ...GOOD, accountHolder: '   ' }).accountHolder).toBeNull();
    expect(parseBankDetailsInput({ ...GOOD, accountHolder: null }).accountHolder).toBeNull();
  });

  it.each([
    ['a blank bank name', { bankName: '   ' }, 'bankName'],
    ['a missing bank name', { bankName: undefined }, 'bankName'],
    ['a bank name over 100', { bankName: 'x'.repeat(101) }, 'bankName'],
    ['a 5-digit branch code', { branchCode: '25065' }, 'branchCode'],
    ['a 7-digit branch code', { branchCode: '2506550' }, 'branchCode'],
    ['letters in a branch code', { branchCode: '25065a' }, 'branchCode'],
    ['a 5-digit account', { accountNumber: '12345' }, 'accountNumber'],
    ['a 17-digit account', { accountNumber: '1'.repeat(17) }, 'accountNumber'],
    ['letters in an account', { accountNumber: '62000123A56' }, 'accountNumber'],
    ['full-width digits in an account', { accountNumber: '１２３４５６７' }, 'accountNumber'],
    ['an unknown account type', { accountType: 'current' }, 'accountType'],
    ['a holder over 100', { accountHolder: 'x'.repeat(101) }, 'accountHolder'],
  ])('refuses %s', (_name, change, field) => {
    expect(refusedFields({ ...GOOD, ...change })).toEqual([field]);
  });

  it.each([
    ['an array account number', { accountNumber: ['62000123456'] }, 'accountNumber'],
    ['a numeric account number', { accountNumber: 62000123456 }, 'accountNumber'],
    ['an object bank name', { bankName: { a: 1 } }, 'bankName'],
  ])('refuses %s, never coercing it', (_name, change, field) => {
    expect(refusedFields({ ...GOOD, ...change })).toEqual([field]);
  });

  it('accepts the bounds: 100-character names, 6 and 16 digit accounts', () => {
    expect(parseBankDetailsInput({ ...GOOD, bankName: 'x'.repeat(100), accountHolder: 'y'.repeat(100) }).bankName).toHaveLength(100);
    expect(parseBankDetailsInput({ ...GOOD, accountNumber: '123456' }).accountNumber).toBe('123456');
    expect(parseBankDetailsInput({ ...GOOD, accountNumber: '1'.repeat(16) }).accountNumber).toHaveLength(16);
  });

  it('refuses a body that is not an object, and never echoes the number in its message', () => {
    expect(() => parseBankDetailsInput(null)).toThrow(PayrollBankDetailsRefusal);
    expect(() => parseBankDetailsInput('x')).toThrow(PayrollBankDetailsRefusal);
    try {
      parseBankDetailsInput({ ...GOOD, accountNumber: '62000123A56' });
    } catch (err) {
      expect(JSON.stringify([(err as Error).message, (err as PayrollBankDetailsRefusal).fieldErrors])).not.toContain('62000123A56');
    }
  });
});
