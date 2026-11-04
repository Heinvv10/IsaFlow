/**
 * Bank details as the create form and the profile card enter them (K2). The server (payrollBankDetailsService) decides
 * what is valid and who may write; this only stops what it would refuse for shape, so the person is told on the field.
 */
import { apiFetch, assertOk } from '@/lib/apiFetch';
import { formatDisplayDate } from '@/utils/dateFormat';

export const ACCOUNT_TYPES = [
  { value: 'cheque', label: 'Cheque / current' },
  { value: 'savings', label: 'Savings' },
  { value: 'transmission', label: 'Transmission' },
] as const;
export type AccountType = (typeof ACCOUNT_TYPES)[number]['value'];

export interface BankForm {
  bankName: string;
  branchCode: string;
  accountNumber: string;
  accountType: AccountType;
  accountHolder: string;
}
export type BankKey = 'bankName' | 'branchCode' | 'accountNumber' | 'accountType' | 'accountHolder';
export type BankErrors = Partial<Record<BankKey, string>>;

/** Top to bottom on the page: focus goes to the first that fails. */
export const BANK_FIELD_ORDER: readonly BankKey[] = ['bankName', 'branchCode', 'accountNumber', 'accountType', 'accountHolder'];

export const emptyBank = (): BankForm => ({ bankName: '', branchCode: '', accountNumber: '', accountType: 'cheque', accountHolder: '' });

/** Nothing typed: the type has a default, so it does not count. */
export const bankIsBlank = (b: BankForm): boolean =>
  !b.bankName.trim() && !b.branchCode.trim() && !b.accountNumber.trim() && !b.accountHolder.trim();

/** `holderRequired`: a change to details that already name a holder. The form never shows the current one, and a blank would clear it. */
export function validateBank(b: BankForm, opts: { holderRequired?: boolean } = {}): BankErrors {
  const errors: BankErrors = {};
  if (opts.holderRequired && !b.accountHolder.trim()) errors.accountHolder = 'Retype the account holder: these details name one, and leaving it blank would remove it.';
  if (!b.bankName.trim()) errors.bankName = 'Enter the bank name.';
  if (!/^[0-9]{6}$/.test(b.branchCode.trim())) errors.branchCode = 'Branch code must be 6 digits.';
  if (!/^[0-9]{6,16}$/.test(b.accountNumber.replace(/\s+/g, ''))) errors.accountNumber = 'Account number must be 6 to 16 digits.';
  return errors;
}

/** The PUT body. A blank holder is left out (it is optional). */
export const bankBody = (b: BankForm, opts: { clearHolder?: boolean } = {}) => ({
  bankName: b.bankName.trim(),
  branchCode: b.branchCode.trim(),
  accountNumber: b.accountNumber,
  accountType: b.accountType,
  // `null` is the explicit removal of a holder the details named; blank on a first entry is just left out.
  accountHolder: opts.clearHolder ? null : (b.accountHolder.trim() || undefined),
});

/** Enter or change an employee's bank details. Throws the server's own message on a refusal. The reply (a full number for owner / admin) is not read. */
export async function saveBankDetails(employeeId: string, bank: BankForm, opts: { clearHolder?: boolean } = {}): Promise<void> {
  const res = await apiFetch(`/api/payroll/employees/${employeeId}/bank-details`, {
    method: 'PUT',
    body: JSON.stringify(bankBody(bank, opts)),
  });
  await assertOk(res, 'Could not save the bank details - try again');
}

/** "•••• 1234" from the server's masked number ("…1234"); anything else as sent. */
export function maskedNumber(serverValue: string): string {
  const tail = serverValue.replace(/^[….•*\s]+/, '');
  return /^[0-9]{1,4}$/.test(tail) ? `•••• ${tail}` : serverValue;
}

/** "2 days ago" for a past instant; the date itself from a month on. */
export function agoText(iso: string, now: number = Date.now()): string {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return '';
  const mins = Math.floor(Math.max(0, now - then) / 60_000);
  const unit = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'} ago`;
  if (mins < 1) return 'just now';
  if (mins < 60) return unit(mins, 'minute');
  if (mins < 1440) return unit(Math.floor(mins / 60), 'hour');
  const days = Math.floor(mins / 1440);
  return days < 30 ? unit(days, 'day') : `on ${formatDisplayDate(iso)}`;
}
