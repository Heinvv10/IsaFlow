/**
 * AP-01: a payee's account and branch are checked before a batch is claimed or
 * sent to Netcash. Digits only, account 1-11 digits, branch exactly 6 digits.
 */
import { describe, expect, it } from 'vitest';
import { validateNetcashPayees } from '@/modules/accounting/services/ap/netcashPayeeValidation';
import type { NetcashPayment } from '@/modules/accounting/services/ap/netcashService';

const ok: NetcashPayment = { accountHolder: 'Acme', bankCode: '250655', accountNumber: '62000000001', amount: 100, reference: 'R' };
const errorsFor = (p: Partial<NetcashPayment>) => validateNetcashPayees([ok, { ...ok, ...p }]);

describe('validateNetcashPayees', () => {
  it('accepts well-formed payees, 1 and 11 digit accounts included', () => {
    expect(validateNetcashPayees([ok, { ...ok, accountNumber: '1' }, { ...ok, accountNumber: '12345678901' }])).toEqual([]);
  });

  it('refuses an account over 11 digits, naming the payment', () => {
    expect(errorsFor({ accountNumber: '123456789012' })).toEqual(['Payment 2: Account number must be 1 to 11 digits']);
  });

  it('refuses non-digits and empty values', () => {
    expect(errorsFor({ accountNumber: '62A00000001' })).toHaveLength(1);
    expect(errorsFor({ accountNumber: '' })).toEqual(['Payment 2: Account number is required']);
    expect(errorsFor({ bankCode: '' })).toEqual(['Payment 2: Branch code is required']);
  });

  it('refuses a branch code that is not exactly 6 digits', () => {
    expect(errorsFor({ bankCode: '25065' })).toEqual(['Payment 2: Branch code must be exactly 6 digits']);
    expect(errorsFor({ bankCode: '2506555' })).toHaveLength(1);
  });

  it('does not throw on non-string fields from a raw body', () => {
    expect(errorsFor({ accountNumber: 62000000001 as unknown as string })).toHaveLength(1);
    expect(errorsFor({ bankCode: null as unknown as string })).toEqual(['Payment 2: Branch code is required']);
  });
});
