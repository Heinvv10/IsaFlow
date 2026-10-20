/**
 * Payee checks run before a Netcash submission is claimed or sent (AP-01):
 * digits only, account 1-11 digits, branch exactly 6 digits. validateBankAccount
 * (eftService) owns the digit and branch rules; the account length is added here.
 */
import { validateBankAccount } from './eftService';
import type { NetcashPayment } from './netcashService';

const MAX_ACCOUNT_DIGITS = 11;

/** One message per bad payee ("Payment 2: ..."); empty when every payee is well-formed. */
export function validateNetcashPayees(payments: NetcashPayment[]): string[] {
  const errors: string[] = [];
  payments.forEach((p, i) => {
    // A raw body may carry anything: only strings are payee data.
    const account = typeof p.accountNumber === 'string' ? p.accountNumber : '';
    const branch = typeof p.bankCode === 'string' ? p.bankCode : '';
    const checked = validateBankAccount(account, branch);
    if (!checked.valid) errors.push(`Payment ${i + 1}: ${checked.error}`);
    else if (account.length > MAX_ACCOUNT_DIGITS) errors.push(`Payment ${i + 1}: Account number must be 1 to ${MAX_ACCOUNT_DIGITS} digits`);
  });
  return errors;
}
