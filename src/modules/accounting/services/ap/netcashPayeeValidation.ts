/**
 * Payee checks run before a Netcash submission is claimed or sent (AP-01):
 * digits only, account 1-11 digits, branch exactly 6 digits - all judged by validateBankAccount (eftService), the
 * one rule the bank files use too.
 */
import { validateBankAccount } from './eftService';
import type { NetcashPayment } from './netcashService';

/** One message per bad payee ("Payment 2: ..."); empty when every payee is well-formed. */
export function validateNetcashPayees(payments: NetcashPayment[]): string[] {
  const errors: string[] = [];
  payments.forEach((p, i) => {
    // A raw body may carry anything: only strings are payee data.
    const account = typeof p.accountNumber === 'string' ? p.accountNumber : '';
    const branch = typeof p.bankCode === 'string' ? p.bankCode : '';
    const checked = validateBankAccount(account, branch);
    if (!checked.valid) errors.push(`Payment ${i + 1}: ${checked.error}`);
    // Whole cents, more than zero: a zero, negative or fractional amount is not a payment.
    if (!Number.isSafeInteger(p.amount) || p.amount <= 0) errors.push(`Payment ${i + 1}: Amount must be greater than zero`);
  });
  return errors;
}
