/**
 * The checks of "Clear against the intercompany loan" (P4-E, plan (c) and (j)), in their order, over the facts `loadClearingFacts` read: the
 * service asks them under its locks before the posting, the preview asks the same ones (unlocked) to say why the action cannot post now. The
 * first refusal wins; null = the clearing may post. Reads only: nothing here writes.
 */
import { BALANCE_DERIVED } from '../ar/invoiceStatusRecompute';
import { agentNewSupplierPaymentRefusal } from '../gl/approvalUnattended';
import { assertContraAccountUsable, ContraGuardRefusal } from '../core/contraSettlementService';
import { MissingSystemAccountError } from '../gl/systemAccountKeys';
import { log } from '@/lib/logger';
import { cents } from './allocationClearRefusals';
import { postingDateRefusal, todaySast } from './allocationClearDate';
import { payerExpectedMismatch } from './payerLoanClearRefusals';
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

/** The person's request against the facts: what they approved (409), the amount (409), the date (400). Facts first: `factsRefusal` passed. */
export async function requestRefusal(companyId: string, f: ClearingFacts, input: LoanClearInput): Promise<PayerClearCode | null> {
  const bill = f.bill!;
  const open = bill.totalCents - bill.paidCents;
  if (payerExpectedMismatch(input, { loanAccountId: f.side?.loanAccountId ?? null, linkId: f.link!.id, openAmount: open / 100 })) return 'stale';
  if (cents(input.amount) > open - f.pendingCents) return 'exceeds_open';
  if (bill.date && input.postingDate < bill.date) return 'date_before_bill';
  if (input.postingDate > await todaySast()) return 'date_after_today';
  if (!f.cutover || input.postingDate < f.cutover) return 'pre_cutover_payment';
  return postingDateRefusal(companyId, input.postingDate);
}

/**
 * What the composed services would refuse, asked first so the person gets a sentence (R-035 (j).7; the contra account), then the
 * receiver-readiness preflight ((j).5: the partner's flag, loan account, invoice), last because it is the only cross-company question.
 */
export async function postingRefusal(companyId: string, f: ClearingFacts, amount: number): Promise<PayerClearCode | null> {
  if (await agentNewSupplierPaymentRefusal(companyId, amount)) return 'approval_rule';
  try {
    await assertContraAccountUsable(companyId, 'ap', f.side!.loanAccountId!);
  } catch (err) {
    if (err instanceof ContraGuardRefusal || err instanceof MissingSystemAccountError) return 'contra_refused';
    throw err;
  }
  const ready = await receiverReadiness(f.link!.id, f.bill!.id, amount);
  if (ready !== 'ready') {
    // the word stays in the log (it names the partner's state); the person reads one generic sentence
    log.info('Intercompany loan clearing refused: the partner is not ready', { companyId, billId: f.bill!.id, reason: ready }, 'intercompany');
    return 'receiver_not_ready';
  }
  return null;
}
