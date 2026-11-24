/**
 * Pure rules of the receiver's accept of a `payment` message (F): the request body, the refusal ORDER over facts the service read under its
 * locks (every refusal is decided from reads, before any write: a plain 4xx), the fixed sentences and the state words as sentences. No
 * database import: `paymentAcceptService.ts` reads, this decides.
 */
import { isRealCalendarDate } from '@/lib/validation';
import type { PaymentState } from './paymentInboxTypes';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const cents = (n: number): number => Math.round(n * 100);
const isWholeCents = (n: number): boolean => Math.abs(n * 100 - Math.round(n * 100)) < 1e-6;

export type AcceptPaymentInput =
  | { outcome: 'existing'; receiptId: string; expected: { amount: number; state: string } }
  | { outcome: 'draft'; bankAccountId: string; paymentDate: string; allocations: { invoiceId: string; amount: number }[];
      expected: { amount: number; state: string; invoiceIds: string[] } };

export type PaymentRefusalCode =
  | 'not_enabled' | 'not_own_session' | 'impersonating' | 'no_write_role' | 'no_create_right' | 'no_approve' | 'not_found' | 'not_pending'
  | 'state' | 'expected_mismatch' | 'busy' | 'receipt_not_candidate' | 'receipt_short' | 'draft_refused_exact' | 'bank_account'
  | 'invoice_not_yours' | 'invoice_wrong_customer' | 'invoice_not_open' | 'invoice_currency' | 'pre_cutover_invoice' | 'amount_cents'
  | 'amount_sum' | 'exceeds_open' | 'date_before_payment' | 'date_after_today' | 'no_period' | 'period_locked' | 'vat_locked'
  | 'not_target' | 'not_ic_draft' | 'not_draft';

type Status = 403 | 404 | 409 | 422;
const r = (status: Status, sentence: string) => ({ status, sentence });

/** Each refusal's status and sentence. Generic: no figure of anyone's books, no id, no database text. */
export const PAYMENT_REFUSALS: Readonly<Record<PaymentRefusalCode, { status: Status; sentence: string }>> = Object.freeze({
  not_enabled: r(403, 'Intercompany payment messages are not enabled for this company.'),
  not_own_session: r(403, 'Matching a payment needs your own signed-in session (not a token or an automated run).'),
  impersonating: r(403, 'A Login-as session cannot match intercompany payments.'),
  no_write_role: r(403, 'You need a write role in this company to match an intercompany payment.'),
  no_create_right: r(403, 'You need permission to create customer receipts to match an intercompany payment.'),
  no_approve: r(403, 'You do not have permission to approve customer receipts. An owner or admin can grant "Approve" on Customers & AR in User Access.'),
  not_found: r(404, 'Message not found'),
  not_pending: r(409, 'This payment message is already handled, so it cannot be matched.'),
  state: r(409, 'This payment message cannot be matched now.'),
  expected_mismatch: r(409, 'This payment or your invoices changed since you opened it. Reload and check again. Nothing was written.'),
  busy: r(409, 'This payment message is being handled right now. Try again in a moment.'),
  receipt_not_candidate: r(422, "That receipt is not one this payment can be matched to (it must be a confirmed receipt of the payer's customer account, dated on or after the payment, not a contra, with enough of it left). Nothing was written."),
  receipt_short: r(422, 'Too little of that receipt is left for this payment (other payment messages already took it). Nothing was written.'),
  draft_refused_exact: r(422, 'A receipt you already have matches this payment: use that receipt instead of drafting another one (it would count the cash twice). Nothing was written.'),
  bank_account: r(422, 'Choose one of your active bank accounts for the receipt. Nothing was written.'),
  invoice_not_yours: r(422, 'An invoice you picked is not one of your invoices. Nothing was written.'),
  invoice_wrong_customer: r(422, "An invoice you picked is not on the payer's customer account linked on the connection. Nothing was written."),
  invoice_not_open: r(422, 'An invoice you picked is not open (a draft, awaiting approval, paid or cancelled). Nothing was written.'),
  invoice_currency: r(422, 'Only invoices in rand can take an intercompany payment. Nothing was written.'),
  pre_cutover_invoice: r(422, "An invoice you picked is dated before the connection's cut-over: settle it through the pairing, not here. Nothing was written."),
  amount_cents: r(422, 'Each amount must be in whole cents. Nothing was written.'),
  amount_sum: r(422, 'The amounts must add up to exactly the payment (no part payments). Nothing was written.'),
  exceeds_open: r(422, 'An amount is more than what is still open on that invoice (draft receipts on it count). Nothing was written.'),
  date_before_payment: r(422, 'The receipt date must be on or after the payment date. Nothing was written.'),
  date_after_today: r(422, 'The receipt date cannot be after today. Nothing was written.'),
  no_period: r(422, 'No financial period covers the receipt date. Create the financial year or choose another date. Nothing was written.'),
  period_locked: r(422, 'The receipt date is in a closed or locked financial period. Choose a date in an open period. Nothing was written.'),
  vat_locked: r(422, 'The receipt date is in a locked VAT period. Choose a date outside it. Nothing was written.'),
  not_target: r(409, 'That receipt is not the draft this payment message was matched to. Nothing was written.'),
  not_ic_draft: r(409, 'That receipt is not a draft created from this payment message. Nothing was written.'),
  not_draft: r(409, 'That receipt is no longer a draft (it was confirmed or cancelled), so it cannot be discarded here. Nothing was written.'),
});

/** A refusal decided before any write: the routes answer its status and sentence (422 as a business-rule refusal). */
export class PaymentRefusal extends Error {
  readonly status: Status;
  constructor(readonly code: PaymentRefusalCode, sentence?: string) {
    super(sentence ?? PAYMENT_REFUSALS[code].sentence);
    this.status = PAYMENT_REFUSALS[code].status;
    this.name = 'PaymentRefusal';
  }
}

const STATE_SENTENCES: Readonly<Record<PaymentState, string>> = Object.freeze({
  open: '',
  connection_gone: 'The intercompany connection with the payer is no longer active (revoked, or the companies are no longer in one group).',
  not_enabled: 'Intercompany payment messages are not enabled for this company.',
  future_dated: 'The payment is dated after today: it can be matched from its date.',
  before_cutover: "The payment is dated before the connection's cut-over.",
  payer_gone: "The payer's books no longer show this payment as it was sent (it was voided, unapplied or reversed).",
  link_gone: "The link between the payer's bill and your invoice is no longer active.",
  currency: 'The payment is not in rand: match it by hand.',
  target_cancelled: 'The receipt this payment was matched to was cancelled.',
  target_ok: 'This payment is matched.',
  not_found: 'Message not found',
  check_failed: 'Could not check this payment message right now.',
});

export const stateSentence = (s: PaymentState): string => STATE_SENTENCES[s] ?? STATE_SENTENCES.check_failed;

export type ParsedAcceptPayment = { ok: true; value: AcceptPaymentInput } | { ok: false; error: string };

const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const obj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

export function parsePaymentAcceptBody(body: unknown): ParsedAcceptPayment {
  const no = (error: string): ParsedAcceptPayment => ({ ok: false, error });
  if (!obj(body)) return no('A body is required');
  const e = body.expected;
  if (!obj(e) || !num(e.amount) || typeof e.state !== 'string') return no('expected { amount, state } is required');
  if (body.outcome === 'existing') {
    if (typeof body.receiptId !== 'string' || !UUID.test(body.receiptId)) return no('receiptId must be a valid UUID');
    return { ok: true, value: { outcome: 'existing', receiptId: body.receiptId.toLowerCase(), expected: { amount: e.amount, state: e.state } } };
  }
  if (body.outcome !== 'draft') return no("outcome must be 'existing' or 'draft'");
  if (typeof body.bankAccountId !== 'string' || !UUID.test(body.bankAccountId)) return no('bankAccountId must be a valid UUID');
  if (typeof body.paymentDate !== 'string' || !isRealCalendarDate(body.paymentDate)) return no('paymentDate must be a YYYY-MM-DD date');
  const ids = e.invoiceIds;
  if (!Array.isArray(ids) || ids.length > 200 || !ids.every((x) => typeof x === 'string' && UUID.test(x))) return no('expected.invoiceIds must be invoice ids');
  const allocs = body.allocations;
  if (!Array.isArray(allocs) || allocs.length === 0 || allocs.length > 50) return no('allocations must list between 1 and 50 invoices');
  const seen = new Set<string>();
  const out: { invoiceId: string; amount: number }[] = [];
  for (const a of allocs) {
    if (!obj(a) || typeof a.invoiceId !== 'string' || !UUID.test(a.invoiceId) || !num(a.amount) || !(a.amount > 0)) return no('each allocation needs an invoiceId and a positive amount');
    const id = a.invoiceId.toLowerCase();
    if (seen.has(id)) return no('an invoice is listed twice');
    seen.add(id);
    out.push({ invoiceId: id, amount: a.amount });
  }
  return {
    ok: true,
    value: {
      outcome: 'draft', bankAccountId: body.bankAccountId.toLowerCase(), paymentDate: body.paymentDate, allocations: out,
      expected: { amount: e.amount, state: e.state, invoiceIds: (ids as string[]).map((x) => x.toLowerCase()) },
    },
  };
}

export interface ExistingFacts {
  expected: { amount: number; state: string };
  amount: number;
  state: PaymentState;
  /** the receipt is in the MED-2 candidate set (as H2 judges it) */
  candidate: boolean;
  unconsumedCents: number;
}

export interface DraftInvoiceFacts {
  id: string; amountCents: number; wholeCents: boolean; own: boolean; customer: boolean; open: boolean; zar: boolean; onOrAfterCutover: boolean;
  openLessDraftsCents: number;
}

export interface DraftFacts {
  expected: { amount: number; state: string; invoiceIds: string[] };
  amount: number;
  state: PaymentState;
  offeredInvoiceIds: string[];
  draftBlock: string | null;
  bankAccountOk: boolean;
  paymentDate: string;
  payloadDate: string;
  today: string;
  invoices: DraftInvoiceFacts[];
  dateRefusal: 'no_period' | 'period_locked' | 'vat_locked' | null;
}

const sawState = (f: { expected: { amount: number; state: string }; amount: number; state: string }) =>
  cents(f.expected.amount) === cents(f.amount) && f.expected.state === f.state;

export function judgeExisting(f: ExistingFacts): PaymentRefusalCode | null {
  if (f.state !== 'open') return 'state';
  if (!sawState(f)) return 'expected_mismatch';
  if (!f.candidate) return 'receipt_not_candidate';
  if (f.unconsumedCents < cents(f.amount)) return 'receipt_short';
  return null;
}

export function judgeDraft(f: DraftFacts): PaymentRefusalCode | null {
  if (f.state !== 'open') return 'state';
  if (!sawState(f)) return 'expected_mismatch';
  if (f.draftBlock) return 'draft_refused_exact';
  if (!f.bankAccountOk) return 'bank_account';
  for (const [check, code] of [
    ['own', 'invoice_not_yours'], ['customer', 'invoice_wrong_customer'], ['open', 'invoice_not_open'], ['zar', 'invoice_currency'],
    ['onOrAfterCutover', 'pre_cutover_invoice'],
  ] as const) {
    if (f.invoices.some((i) => !i[check])) return code;
  }
  if (f.invoices.some((i) => !i.wholeCents)) return 'amount_cents';
  if (f.invoices.reduce((s, i) => s + i.amountCents, 0) !== cents(f.amount)) return 'amount_sum';
  if (f.invoices.some((i) => i.amountCents > i.openLessDraftsCents)) return 'exceeds_open';
  if (f.paymentDate < f.payloadDate) return 'date_before_payment';
  if (f.paymentDate > f.today) return 'date_after_today';
  if (f.dateRefusal) return f.dateRefusal;
  // what the person saw: every invoice offered now was offered to them (one that appeared since is a reload)
  const saw = new Set(f.expected.invoiceIds.map((x) => x.toLowerCase()));
  if (f.offeredInvoiceIds.some((x) => !saw.has(x.toLowerCase()))) return 'expected_mismatch';
  return null;
}

/** An amount as the reads hold it: whole cents or not. */
export const wholeCents = isWholeCents;
