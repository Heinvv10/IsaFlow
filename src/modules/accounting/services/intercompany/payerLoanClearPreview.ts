/**
 * The bill page's preview of "Clear against the intercompany loan" (P4-E): READ ONLY (the bill unlocked; the connection, side, link and loan
 * account read with P4-D's FOR SHARE reads, which block no reader and last only this request). It runs the clearing's own checks
 * (`payerLoanClearJudge.ts`) for the bill's open amount on today's date, so `blocked` is the sentence the POST would answer, and `receiverReady`
 * is the preflight's answer (no partner detail beyond that). The partner's invoice number is not shown: these books cannot read it.
 */
import { getSystemAccount } from '../gl/systemAccountResolver';
import { MissingSystemAccountError } from '../gl/systemAccountKeys';
import { todaySast } from './allocationClearDate';
import { factsRefusal, postingRefusal, requestRefusal } from './payerLoanClearJudge';
import { accountLabel, loadClearingFacts, supplierName } from './payerLoanClearReads';
import { PAYER_CLEAR_SENTENCES, payerRefusal } from './payerLoanClearRefusals';
import type { LoanClearingPreview } from './payerLoanClearTypes';

export async function previewLoanClearing(companyId: string, billId: string): Promise<LoanClearingPreview> {
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
  let code = factsRefusal(f);
  let receiverReady = false;
  if (!code && max > 0) {
    const amount = max / 100;
    code = await requestRefusal(companyId, f, {
      billId, amount, postingDate: today, expected: { loanAccountId: loanAccountId!, linkId: f.link!.id, amount, openAmount: open / 100 },
    }) ?? await postingRefusal(companyId, f, amount);
    receiverReady = code === null;
  } else if (!code) {
    code = 'exceeds_open';
  }
  return {
    linked, billId: bill.id, billNumber: bill.number, billDate: bill.date, linkId: f.link?.id ?? null,
    partnerName: await supplierName(companyId, f.side?.supplierId ?? null), loanAccountId, loanAccountLabel: await accountLabel(companyId, loanAccountId),
    payableLabel: payable, openAmount: open / 100, maxAmount: max / 100, floorDate: floor, defaultPostingDate: today, receiverReady,
    blocked: code ? PAYER_CLEAR_SENTENCES[code] : null,
  };
}
