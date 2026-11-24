/**
 * The checks of "Clear against the intercompany loan" (P4-E, plan (c) and (j)), in their order, over the facts `loadClearingFacts` read: the
 * service asks them under its locks before the posting (`factsRefusal`, then `requestRefusal`); the preview asks the same ones (unlocked) but
 * the date (`dateRefusal`) to say why the action cannot post now. The first refusal wins; null = the clearing may post. Reads only.
 */
import { BALANCE_DERIVED } from '../ar/invoiceStatusRecompute';
import { agentNewSupplierPaymentRefusal } from '../gl/approvalUnattended';
import { assertContraAccountUsable, ContraGuardRefusal } from '../core/contraSettlementService';
import { MissingSystemAccountError } from '../gl/systemAccountKeys';
import { log } from '@/lib/logger';
import { cents } from './allocationClearRefusals';
import { postingDateRefusal, todaySast } from './allocationClearDate';
import { RECEIVER_READY_REASONS, payerExpectedMismatch } from './payerLoanClearRefusals';
import { receiverReadiness, type ClearingFacts } from './payerLoanClearReads';
import type { LoanClearInput, PayerClearCode } from './payerLoanClearTypes';

/** The bill statuses a payment may touch: `assertBillAllocatable`'s allow-list (the balance-derived set). */
const ALLOCATABLE: ReadonlySet<string> = new Set(BALANCE_DERIVED);

/** The bill, the relationship, the loan account, currency and supplier: the facts of the books, before the person's request is compared. */
export function factsRefusal(f: ClearingFacts): PayerClearCode | null {
  const bill = f.bill;
  if (!bill || bill.deleted) return 'bill_not_found';
  if (!ALLOCATABLE.has(bill.status)) return 'bill_not_open';
  if (bill.status === 'paid' || bill.totalCents - bill.paidCents <= 0) return 'bill_paid';
  if (!f.link || !f.conn) return 'no_link';
  if (f.conn.status !== 'active') return 'not_active';
  if (f.conn.settlementMode !== 'loan') return 'not_loan';
  if (f.conn.kind !== 'group') return 'not_group';
  if (!f.cutover || !bill.date || bill.date < f.cutover) return 'pre_cutover_bill';
  if (!f.side?.loanAccountId || !f.loan || !f.loan.isActive || f.loan.isParent || !f.loan.loanClass) return 'payer_loan_not_set_up';
  if (bill.currency !== 'ZAR') return 'currency';
  if (!f.side.supplierId || !bill.supplierId || f.side.supplierId.toLowerCase() !== bill.supplierId.toLowerCase()) return 'wrong_supplier';
  return null;
}

/** The person's request against the facts, the date-independent part: what they approved (409), the amount (409). Facts first. */
export function approvedRefusal(f: ClearingFacts, input: Pick<LoanClearInput, 'amount' | 'expected'>): PayerClearCode | null {
  const open = f.bill!.totalCents - f.bill!.paidCents;
  const read = { loanAccountId: f.side?.loanAccountId ?? null, linkId: f.link!.id, openAmount: open / 100, payableAccountId: f.payableAccountId };
  if (payerExpectedMismatch(input, read)) return 'stale';
  if (cents(input.amount) > open - f.pendingCents) return 'exceeds_open';
  return null;
}

/** The posting date (400): on or after the bill and the pair's cut-over, not after today, an open period outside a locked VAT period. The POST
 *  asks it; the preview does not (fix round 1 E: a closed period today must not disable the dialog; the date field and the POST judge it). */
export async function dateRefusal(companyId: string, f: ClearingFacts, postingDate: string): Promise<PayerClearCode | null> {
  const bill = f.bill!;
  if (bill.date && postingDate < bill.date) return 'date_before_bill';
  if (postingDate > await todaySast()) return 'date_after_today';
  if (!f.cutover || postingDate < f.cutover) return 'pre_cutover_payment';
  return postingDateRefusal(companyId, postingDate);
}

/** What the composed services would refuse, asked first so the person gets a sentence: R-035 ((j).7) and the contra account. */
export async function booksRefusal(companyId: string, f: ClearingFacts, amount: number): Promise<PayerClearCode | null> {
  if (await agentNewSupplierPaymentRefusal(companyId, amount)) return 'approval_rule';
  try {
    await assertContraAccountUsable(companyId, 'ap', f.side!.loanAccountId!);
  } catch (err) {
    if (err instanceof ContraGuardRefusal || err instanceof MissingSystemAccountError) return 'contra_refused';
    throw err;
  }
  return null;
}

/** (j).5 the receiver-readiness preflight, the only cross-company question (last): its word, logged when it is not `ready` (at info for the
 *  POST's refusal; the preview, a page view, logs at debug: fix round 2 8f). Only a word the definer is known to answer is logged
 *  (RECEIVER_READY_REASONS); anything else is logged as `unknown` and is not ready. */
export async function receiverWord(companyId: string, f: ClearingFacts, amount: number, level: 'info' | 'debug' = 'info'): Promise<string> {
  const word = await receiverReadiness(f.link!.id, f.bill!.id, amount);
  if (word !== 'ready') {
    // the word stays in the log (it names the partner's state); the person reads one generic sentence
    log[level]('Intercompany loan clearing: the partner is not ready', {
      companyId, billId: f.bill!.id, reason: RECEIVER_READY_REASONS.has(word) ? word : 'unknown',
    }, 'intercompany');
  }
  return word;
}

/** Everything after the facts, in order, for the POST: the request, the date, the books, the partner. */
export async function requestRefusal(companyId: string, f: ClearingFacts, input: LoanClearInput): Promise<PayerClearCode | null> {
  const refusal = approvedRefusal(f, input) ?? await dateRefusal(companyId, f, input.postingDate) ?? await booksRefusal(companyId, f, input.amount);
  if (refusal) return refusal;
  return (await receiverWord(companyId, f, input.amount)) === 'ready' ? null : 'receiver_not_ready';
}
