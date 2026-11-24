/**
 * Pure rules of the PAYER's "Clear against the intercompany loan" (intercompany P4-E): the request body, the fixed sentence and HTTP status of
 * every refusal, and the "what is approved is what posts" comparison. No database import: the service (`payerLoanClearService.ts`) reads, this
 * decides. Every sentence is generic: no id, no figure, never database text.
 */
import { cents, isRealDate } from './allocationClearRefusals';
import { PayerClearRefusal, type LoanClearInput, type PayerClearCode } from './payerLoanClearTypes';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** (j).7: the R-035 refusal of the AP contra path, as a person reads it. */
export const R035_SENTENCE = 'Not cleared: an approval rule applies to payments of this size: use the normal payment route (create the payment and submit it for approval). Nothing was posted.';

export const PAYER_CLEAR_SENTENCES: Readonly<Record<PayerClearCode, string>> = Object.freeze({
  not_own_session: 'Clearing a bill against the intercompany loan needs your own signed-in session (not a token or an automated run). Nothing was posted.',
  no_write_role: 'You need a write role in this company to clear a bill against the intercompany loan. Nothing was posted.',
  no_approve: 'Clearing a bill against the intercompany loan needs Approve permission on Suppliers & AP. Nothing was posted.',
  bill_not_found: 'The supplier bill was not found',
  bill_not_open: 'This bill is not approved (a draft, awaiting approval, disputed or cancelled), so it cannot be cleared. Nothing was posted.',
  bill_paid: 'This bill is already paid: there is nothing open to clear. Nothing was posted.',
  no_link: 'This bill is not linked to a partner invoice (no active link on an intercompany connection), so it cannot be cleared against the loan. Nothing was posted.',
  not_active: 'The intercompany connection of this bill is not active. Nothing was posted.',
  not_loan: 'The intercompany connection of this bill does not settle through a loan account (it is in cash mode). Nothing was posted.',
  not_group: 'Only a bill on a group connection can be cleared against the intercompany loan. Nothing was posted.',
  pre_cutover_bill: "This bill is dated before the pair's cut-over (or the cut-over is not set up on both sides): settle it through the pairing, not by clearing. Nothing was posted.",
  pre_cutover_payment: "The posting date is before the pair's cut-over. Choose a later date. Nothing was posted.",
  payer_loan_not_set_up: 'Your side of the connection names no usable loan account (an active loan or intercompany balance-sheet account; not a bank, control or system account). Set one on the connection, then try again. Nothing was posted.',
  currency: 'Only a bill in rand can be cleared against the intercompany loan. Nothing was posted.',
  wrong_supplier: "This bill is not on the partner's supplier account linked on the connection. Nothing was posted.",
  exceeds_open: 'The amount is more than what is still open on this bill (draft and approved payments on it count). Nothing was posted.',
  stale: 'The bill, its link or your loan account changed since the preview. Nothing was posted: review the clearing again.',
  busy: 'This bill is being paid or cleared right now. Try again in a moment. Nothing was posted.',
  date_before_bill: "The posting date must be on or after the bill's date. Nothing was posted.",
  date_after_today: 'The posting date cannot be after today. Nothing was posted.',
  no_period: 'No financial period covers the posting date. Create the financial year or choose another date. Nothing was posted.',
  period_locked: 'The posting date is in a closed or locked financial period. Choose a date in an open period. Nothing was posted.',
  vat_locked: 'The posting date is in a locked VAT period. Choose a date outside it. Nothing was posted.',
  receiver_not_ready: 'The partner company cannot clear this against its loan account yet (its side of the connection, its invoice or its settings are not ready). Ask the partner to check, then try again. Nothing was posted.',
  approval_rule: R035_SENTENCE,
  contra_refused: 'Your loan account cannot take this clearing (it is inactive, a header, a bank or a control account). Nothing was posted.',
});

const DATE_CODES: ReadonlySet<PayerClearCode> = new Set(['date_before_bill', 'date_after_today', 'no_period', 'period_locked', 'vat_locked', 'pre_cutover_payment']);
const PERSON_CODES: ReadonlySet<PayerClearCode> = new Set(['not_own_session', 'no_write_role', 'no_approve']);

/** The person 403, the bill 404, the person's date 400, the books 409. */
export const PAYER_CLEAR_STATUS: Readonly<Record<PayerClearCode, 400 | 403 | 404 | 409>> = Object.freeze(Object.fromEntries(
  (Object.keys(PAYER_CLEAR_SENTENCES) as PayerClearCode[]).map((code) => [
    code, PERSON_CODES.has(code) ? 403 : code === 'bill_not_found' ? 404 : DATE_CODES.has(code) ? 400 : 409,
  ]),
) as Record<PayerClearCode, 400 | 403 | 404 | 409>);

export const payerRefusal = (code: PayerClearCode): PayerClearRefusal => new PayerClearRefusal(code, PAYER_CLEAR_STATUS[code], PAYER_CLEAR_SENTENCES[code]);

/** The words `intercompany_receiver_loan_ready` (migration 1029) answers; anything else is treated as not ready. */
export const RECEIVER_READY_REASONS: ReadonlySet<string> = new Set([
  'ready', 'not_found', 'receiver_flag_off', 'receiver_loan_not_set_up', 'loan_class_mismatch', 'invoice_gone', 'invoice_not_open', 'currency',
  'wrong_customer', 'invoice_pre_cutover', 'exceeds_open',
]);

export type ParsedLoanClearBody = { ok: true; value: LoanClearInput } | { ok: false; error: string };

const BODY_KEYS = new Set(['billId', 'amount', 'postingDate', 'expected']);
const EXPECTED_KEYS = new Set(['loanAccountId', 'linkId', 'amount', 'openAmount']);
const wholeCents = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && cents(n) / 100 === n;
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** The POST body: the bill, the amount, the date the person chose and what the preview showed. Strict: nothing else. */
export function parseLoanClearBody(body: unknown): ParsedLoanClearBody {
  if (!isObject(body)) return { ok: false, error: 'The body must be an object' };
  const extra = Object.keys(body).find((k) => !BODY_KEYS.has(k));
  if (extra) return { ok: false, error: `Unexpected field ${extra.slice(0, 40)}` };
  if (typeof body.billId !== 'string' || !UUID.test(body.billId)) return { ok: false, error: 'billId must be a UUID' };
  if (!wholeCents(body.amount) || body.amount <= 0) return { ok: false, error: 'amount must be a positive amount in whole cents' };
  if (typeof body.postingDate !== 'string' || !isRealDate(body.postingDate)) return { ok: false, error: 'postingDate must be a real date (YYYY-MM-DD)' };
  const e = body.expected;
  if (!isObject(e)) return { ok: false, error: 'expected must be what the preview showed' };
  const extraExpected = Object.keys(e).find((k) => !EXPECTED_KEYS.has(k));
  if (extraExpected) return { ok: false, error: `Unexpected field expected.${extraExpected.slice(0, 40)}` };
  if (typeof e.loanAccountId !== 'string' || !UUID.test(e.loanAccountId)) return { ok: false, error: 'expected.loanAccountId must be a UUID' };
  if (typeof e.linkId !== 'string' || !UUID.test(e.linkId)) return { ok: false, error: 'expected.linkId must be a UUID' };
  if (!wholeCents(e.amount) || e.amount <= 0) return { ok: false, error: 'expected.amount must be a positive amount in whole cents' };
  if (!wholeCents(e.openAmount) || e.openAmount < 0) return { ok: false, error: 'expected.openAmount must be an amount in whole cents' };
  return {
    ok: true,
    value: {
      billId: body.billId.toLowerCase(), amount: body.amount, postingDate: body.postingDate,
      expected: { loanAccountId: e.loanAccountId.toLowerCase(), linkId: e.linkId.toLowerCase(), amount: e.amount, openAmount: e.openAmount },
    },
  };
}

export type PayerMismatch = 'loan_account' | 'link' | 'amount' | 'open_amount';

/** What the transaction read under its locks, against what the person approved: the first that differs, or null. */
export function payerExpectedMismatch(
  input: Pick<LoanClearInput, 'amount' | 'expected'>,
  read: { loanAccountId: string | null; linkId: string; openAmount: number },
): PayerMismatch | null {
  if (!read.loanAccountId || input.expected.loanAccountId.toLowerCase() !== read.loanAccountId.toLowerCase()) return 'loan_account';
  if (input.expected.linkId.toLowerCase() !== read.linkId.toLowerCase()) return 'link';
  if (cents(input.amount) !== cents(input.expected.amount)) return 'amount';
  if (cents(input.expected.openAmount) !== cents(read.openAmount)) return 'open_amount';
  return null;
}
