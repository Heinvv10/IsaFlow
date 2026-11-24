/**
 * The bill page's preview of "Clear against the intercompany loan" (P4-E): READ ONLY and LOCK FREE (fix round 1 H: every read unlocked; the
 * POST re-reads everything under THE lock order). Only a writer of the company sees it: without the intercompany write role it is the 403 the
 * POST would answer first (`no_write_role`), and the bill page shows nothing. It runs the clearing's own checks for the bill's open amount
 * EXCEPT the posting date (fix round 1 E: a closed or locked period today must not disable the dialog; the date field and the POST judge the
 * date the person picks), so `blocked` is the sentence the POST would answer for a good date. `receiverReady` is the preflight's word alone
 * (`ready`), whatever else blocks, asked for the SMALLEST amount (R0.01, fix round 2 MED-3): "can the partner clear anything on its invoice
 * now". A partner invoice with less open than the bill therefore does not disable the dialog (the person may choose a smaller amount), and
 * the preview says nothing of the partner's open amount; the POST asks the preflight again for the amount chosen and refuses it
 * `receiver_not_ready` with the same generic sentence. The partner's invoice number is not shown: these books cannot read it.
 */
import { getSystemAccount } from '../gl/systemAccountResolver';
import { MissingSystemAccountError } from '../gl/systemAccountKeys';
import { todaySast } from './allocationClearDate';
import { userCanWrite } from './allocationClearReads';
import { approvedRefusal, booksRefusal, factsRefusal, receiverWord } from './payerLoanClearJudge';
import { accountLabel, loadClearingFacts, supplierName } from './payerLoanClearReads';
import { PAYER_CLEAR_SENTENCES, payerRefusal } from './payerLoanClearRefusals';
import type { LoanClearingPreview, PayerClearCode } from './payerLoanClearTypes';

/** The amount the preview asks the partner's readiness for (MED-3): one cent, so the answer is "ready for something", never "for how much". */
const READINESS_PROBE = 0.01;

export async function previewLoanClearing(companyId: string, billId: string): Promise<LoanClearingPreview> {
  if (!(await userCanWrite(companyId))) throw payerRefusal('no_write_role');
  const f = await loadClearingFacts(companyId, billId, false);
  if (!f.bill || f.bill.deleted) throw payerRefusal('bill_not_found');
  const today = await todaySast();
  const bill = f.bill;
  const open = Math.max(bill.totalCents - bill.paidCents, 0);
  const max = Math.max(open - f.pendingCents, 0);
  const linked = Boolean(f.link && f.conn && f.conn.status === 'active' && f.conn.settlementMode === 'loan');
  const loanAccountId = f.side?.loanAccountId ?? null;
  let payable: string | null = null;
  try {
    const ap = await getSystemAccount('payable', companyId);
    payable = `${ap.accountCode ?? ''} ${ap.accountName ?? ''}`.trim() || null;
  } catch (err) {
    // a chart without an AP control: the preview says so by its absence (the POST refuses it); anything else is a fault
    if (!(err instanceof MissingSystemAccountError)) throw err;
  }
  const floor = bill.date && f.cutover ? (bill.date > f.cutover ? bill.date : f.cutover) : null;
  let code: PayerClearCode | null = factsRefusal(f);
  let receiverReady = false;
  if (!code && max > 0) {
    const amount = max / 100;
    const expected = { loanAccountId: loanAccountId!, linkId: f.link!.id, amount, openAmount: open / 100, payableAccountId: f.payableAccountId ?? '' };
    code = approvedRefusal(f, { amount, expected }) ?? await booksRefusal(companyId, f, amount);
    receiverReady = (await receiverWord(companyId, f, READINESS_PROBE, 'debug')) === 'ready';
    if (!code && !receiverReady) code = 'receiver_not_ready';
  } else if (!code) {
    code = 'exceeds_open';
  }
  return {
    linked, billId: bill.id, billNumber: bill.number, billDate: bill.date, linkId: f.link?.id ?? null,
    partnerName: await supplierName(companyId, f.side?.supplierId ?? null), loanAccountId, loanAccountLabel: await accountLabel(companyId, loanAccountId),
    payableAccountId: f.payableAccountId, payableLabel: payable, openAmount: open / 100, maxAmount: max / 100, floorDate: floor,
    defaultPostingDate: today, receiverReady, blocked: code ? PAYER_CLEAR_SENTENCES[code] : null,
  };
}
