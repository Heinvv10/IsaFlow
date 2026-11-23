/**
 * Pure rules of the receiver's clearing of an allocation message (P4-D): the request body, the fixed sentence each refusal stores on the
 * message, what an error raised under the clearing's savepoint counts as, the "what is approved is what posts" comparison and the loan classes.
 * No database import: the service (`allocationClearService.ts`) reads, this decides. (The caps are the liveness definer's own answer since fix
 * round 1: it counts every receiver's clearings, which no session can read.)
 */
import type { AcceptAllocationInput, ClearRefusalCode } from './allocationClearTypes';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export const cents = (n: number): number => Math.round(n * 100);

/** The sentence stored in the message's `error` for each refusal. Generic: no figure of the receiver's books, no id, no database text. */
export const CLEAR_REFUSAL_SENTENCES: Readonly<Record<ClearRefusalCode, string>> = Object.freeze({
  malformed: 'This payment message cannot be read, so it cannot be cleared. Nothing was posted.',
  not_live: "The payer's books no longer show this payment as it was sent (it was changed, unapplied or reversed, or the link or the loan connection ended). Nothing was posted.",
  no_loan_account: 'Your side of the connection names no loan account to clear against. Set one on the connection, then try again. Nothing was posted.',
  loan_account_unusable: 'Your loan account cannot take this clearing (it is inactive, a header, or not a loan or intercompany balance-sheet account). Nothing was posted.',
  invoice_gone: 'Your invoice for this payment is no longer in your books (deleted or cancelled). Nothing was posted.',
  invoice_not_open: 'Your invoice is not open (a draft, awaiting approval or already paid), so nothing can be cleared against it. Nothing was posted.',
  wrong_customer: "Your invoice is not on the payer's customer account linked on the connection. Nothing was posted.",
  currency: 'Only a payment in rand against an invoice in rand can be cleared. Nothing was posted.',
  pre_cutover_invoice: "Your invoice is dated before the pair's cut-over (or the cut-over is not set up on both sides): settle it through the pairing, not by clearing. Nothing was posted.",
  pre_cutover_payment: "The payment is dated before the pair's cut-over (or the cut-over is not set up on both sides). Nothing was posted.",
  exceeds_open: 'The payment is more than what is still open on your invoice (draft receipts on it count). Nothing was posted.',
  cash_not_through_loan: "The payer's cash did not go through the loan account: clear it by matching the bank receipt. Nothing was posted.",
  already_cleared: 'This payment is already cleared. Nothing was posted.',
  no_period: 'No financial period covers the posting date. Create the financial year or choose another date. Nothing was posted.',
  period_locked: 'The posting date is in a closed or locked financial period. Choose a date in an open period. Nothing was posted.',
  vat_locked: 'The posting date is in a locked VAT period. Choose a date outside it. Nothing was posted.',
  busy: 'Your invoice is busy (another receipt is being recorded on it or is pending). Try again in a moment. Nothing was posted.',
  refused: 'The clearing was refused by a check on your loan account or your invoice. Nothing was posted.',
  not_group: 'Only a payment on a group connection can be cleared here. Nothing was posted.',
  loan_class_mismatch: "Your loan account and the payer's are of the same kind (both assets or both liabilities), so one of them is not the other's side of the loan. Fix the loan account on the connection. Nothing was posted.",
});

export type ParsedAcceptBody = { ok: true; value: AcceptAllocationInput } | { ok: false; error: string };

const BODY_KEYS = new Set(['expectedLoanAccountId', 'invoiceId', 'amount', 'postingDate']);

/** The Accept body: what the preview showed (loan account, invoice, amount) and the posting date the person chose. Strict: nothing else. */
export function parseAcceptBody(body: unknown): ParsedAcceptBody {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return { ok: false, error: 'The body must be an object' };
  const b = body as Record<string, unknown>;
  const extra = Object.keys(b).find((k) => !BODY_KEYS.has(k));
  if (extra) return { ok: false, error: `Unexpected field ${extra.slice(0, 40)}` };
  if (typeof b.expectedLoanAccountId !== 'string' || !UUID.test(b.expectedLoanAccountId)) return { ok: false, error: 'expectedLoanAccountId must be a UUID' };
  if (typeof b.invoiceId !== 'string' || !UUID.test(b.invoiceId)) return { ok: false, error: 'invoiceId must be a UUID' };
  if (typeof b.amount !== 'number' || !Number.isFinite(b.amount) || b.amount <= 0 || cents(b.amount) / 100 !== b.amount) {
    return { ok: false, error: 'amount must be a positive amount in whole cents' };
  }
  if (typeof b.postingDate !== 'string' || !isRealDate(b.postingDate)) return { ok: false, error: 'postingDate must be a real date (YYYY-MM-DD)' };
  return { ok: true, value: { expectedLoanAccountId: b.expectedLoanAccountId.toLowerCase(), invoiceId: b.invoiceId.toLowerCase(), amount: b.amount, postingDate: b.postingDate } };
}

export function isRealDate(s: string): boolean {
  if (!ISO_DATE.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

/** What the transaction read under its locks, against what the person approved: the first that differs, or null. */
export function expectedMismatch(
  input: Pick<AcceptAllocationInput, 'expectedLoanAccountId' | 'invoiceId' | 'amount'>,
  read: { loanAccountId: string; invoiceId: string; amount: number },
): 'loan_account' | 'invoice' | 'amount' | null {
  if (input.expectedLoanAccountId.toLowerCase() !== read.loanAccountId.toLowerCase()) return 'loan_account';
  if (input.invoiceId.toLowerCase() !== read.invoiceId.toLowerCase()) return 'invoice';
  if (cents(input.amount) !== cents(read.amount)) return 'amount';
  return null;
}

export const MISMATCH_SENTENCE: Readonly<Record<'loan_account' | 'invoice' | 'amount', string>> = Object.freeze({
  loan_account: 'Your loan account on the connection changed since the preview. Nothing was posted: review the clearing again.',
  invoice: 'The invoice changed since the preview. Nothing was posted: review the clearing again.',
  amount: 'The amount changed since the preview. Nothing was posted: review the clearing again.',
});

/**
 * What an error raised under the clearing's savepoint counts as. A refusal code of the services the clearing composes (a receipt refusal,
 * a lock that ran out, a contra guard, a locked VAT period, a missing system account) and a lock wait or deadlock are `failed` with a sentence;
 * a receipt refusal is `busy` only when it is retryable (a held row, contention: `ReceiptRefusal.retryable` / `held`), any other one is
 * `refused`; `forbidden` is the approver check (a 403, not stored); null is anything else, which propagates (a 5xx: the transaction rolls back).
 */
export function refusalOfCode(
  code: string | null, opts: { contraRefusal?: boolean; missingSystemAccount?: boolean; retryable?: boolean } = {},
): ClearRefusalCode | 'forbidden' | null {
  if (code === 'APPROVE_PERMISSION_REFUSED') return 'forbidden';
  if (opts.contraRefusal || opts.missingSystemAccount) return 'refused';
  switch (code) {
    case 'RECEIPT_REFUSED':
      return opts.retryable === true ? 'busy' : 'refused';
    case 'CUSTOMER_INVOICE_LOCK_TIMEOUT':
    case 'ROW_LOCK_TIMEOUT':
    case '55P03':
    case '40P01':
      return 'busy';
    case 'VAT_PERIOD_LOCKED':
      return 'vat_locked';
    case 'CONTRA_SETTLEMENT_REFUSED':
      return 'refused';
    default:
      return null;
  }
}

/** The loan account classes a clearing may touch: a balance-sheet loan or intercompany position (never a control, bank, cash, VAT, tax,
 *  payroll, inventory, fixed-asset or equity account, never income or expense, and never a system account: the seeded charts carry their
 *  controls, bank, VAT, payroll and 2215 as system accounts). By type, subtype and the system flag, never by name. The database's twin is
 *  `intercompany_is_loan_class` (1027); the side form refuses any other loan account. */
const LOAN_CLASSES: Readonly<Record<string, readonly string[]>> = Object.freeze({
  asset: ['other_current_asset', 'other'],
  liability: ['current_liability', 'other_current_liability', 'long_term_liability', 'other'],
});

export function isLoanClass(accountType: string | null, accountSubtype: string | null, isSystem: boolean): boolean {
  if (!accountType || !accountSubtype || isSystem) return false;
  if (!Object.prototype.hasOwnProperty.call(LOAN_CLASSES, accountType)) return false;
  return (LOAN_CLASSES[accountType] ?? []).includes(accountSubtype);
}
