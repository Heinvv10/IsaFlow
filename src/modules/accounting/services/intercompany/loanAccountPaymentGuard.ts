/**
 * The shared-layer guard of intercompany P4-E (plan (j).3). With the dark flag `intercompany_loan_clearing` ON for the paying company, a bill
 * slotted in an ACTIVE intercompany link is settled from the payer side's LOAN account (the account its side names as `loan_account_id` on
 * the link's connection) only by "Clear against the intercompany loan" (`payerLoanClearService`: its minted permit and the author label
 * `system:ic_loan_clear`). Every other path that would credit that account for such a bill (MCP `settle_by_contra` on a payable, a plain
 * supplier payment processed from the loan account, applying a processed loan-account payment, a payment batch paid from it) is refused, before
 * its first write, with "use Clear against the intercompany loan": those paths skip the link, loan-class and pair cut-over checks, and with the
 * flag on their payment would send an allocation message the partner could clear. The flag cleanly OFF: nothing changes (nothing is sent
 * either). The flag that cannot be READ (fix round 1 D): fail CLOSED, a plain sentence (the senders treat that as off, so nothing would be
 * sent; but a refused payment is retried, a wrongly allowed one stands). Scope (fix round 1 F): an ACTIVE link on an ACTIVE LOAN connection
 * whose side names the credited account: the only connection the sender sends for and E clears on, so a bill on a cash or revoked connection
 * is not stranded (E refuses it `not_loan` / `not_active`). No write here.
 *
 * Fix round 1 A: applying an already processed payment that cleared a bill against the loan and SENT its allocation message (cashLegIsLoanAccount)
 * is refused whatever the bill (an unlinked one of the same supplier too) and whatever the flag: its loan credit belongs to that clearing.
 */
import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import { SupplierPaymentRefusal } from '../ap/supplierPaymentRefusal';
import { loanClearingState } from './loanClearingGate';
import { permitCovers, type LoanClearPermit } from './loanClearPermit';

type Row = Record<string, unknown>;

/** Fix round 2 (LOW-2): the guard covers every linked bill on an active loan connection (the sender sends for all of them), also ones E
 *  refuses (dated before the pair's cut-over, a connection that is not a group one, a partner not ready): the sentence does not promise E. */
export const LOAN_ACCOUNT_PAYMENT_REFUSED = 'This bill is linked to the partner\'s invoice on an intercompany connection and the account is your loan account for it: '
  + 'use Clear against the intercompany loan on the bill (it checks the link, the cut-over and the partner first). If that cannot clear it either '
  + '(for example the bill is dated before the pair\'s cut-over, or the partner cannot clear it yet), pay the bill from another account. Nothing was posted.';

export interface LoanAccountPaymentUse {
  billIds: readonly string[];
  /** The accounts the posting credits (the payment's bank leg; for an apply, its journal's credit lines too). */
  creditedAccountIds: readonly (string | null | undefined)[];
  postingAgent?: string;
  permit?: LoanClearPermit;
}

/** The flag could not be read (fix round 1 D): refused, fail closed. */
export const LOAN_FLAG_UNREADABLE = 'Could not check whether intercompany loan clearing is on for this company, and this bill is linked to the partner\'s '
  + 'invoice with your loan account as the account paid from. Try again in a moment. Nothing was posted.';

/** Fix round 1 A: a loan clearing's payment whose allocation message was sent is not applied again. */
export const LOAN_CLEARED_PAYMENT_REAPPLY = 'This payment cleared a bill against the intercompany loan (its allocation message was sent to the partner), so it '
  + 'cannot be applied to another bill. Void it to undo the clearing. Nothing was changed.';

const uniq = (xs: readonly (string | null | undefined)[]): string[] => [...new Set(xs.filter((x): x is string => typeof x === 'string' && x !== '').map((x) => x.toLowerCase()))];

/** The refusal sentence, or null (flag off, nothing linked on a side naming a credited account, or the clearing's own permit). Reads only. */
export async function loanAccountPaymentRefusal(companyId: string, use: LoanAccountPaymentUse): Promise<string | null> {
  const bills = uniq(use.billIds);
  const credited = uniq(use.creditedAccountIds);
  if (bills.length === 0 || credited.length === 0) return null;
  const flag = await loanClearingState(companyId);
  if (flag === 'off') return null;
  const rows = (await sql`
    SELECT 1 AS hit FROM intercompany_document_links k
      JOIN intercompany_connections c ON c.id = k.connection_id AND c.status = 'active' AND c.settlement_mode = 'loan'
      JOIN intercompany_connection_sides s ON s.connection_id = k.connection_id AND s.company_id = ${companyId}::UUID
     WHERE k.status = 'active' AND s.loan_account_id = ANY(${credited}::UUID[])
       AND ((k.company_a_id = ${companyId}::UUID AND k.doc_a_type = 'supplier_invoice' AND k.doc_a_id = ANY(${bills}::UUID[]))
         OR (k.company_b_id = ${companyId}::UUID AND k.doc_b_type = 'supplier_invoice' AND k.doc_b_id = ANY(${bills}::UUID[])))
     LIMIT 1
  `) as Row[];
  if (rows.length === 0) return null;
  // the clearing's own permit was minted only after E read the flag ON in this transaction
  if (permitCovers(use.permit, { companyId, billIds: bills, creditedAccountIds: credited, postingAgent: use.postingAgent })) return null;
  if (flag === 'unknown') return LOAN_FLAG_UNREADABLE;
  log.info('Payment from the intercompany loan account refused: use the loan clearing', { companyId, bills: bills.length }, 'intercompany');
  return LOAN_ACCOUNT_PAYMENT_REFUSED;
}

/** The same, thrown as the AP paths' typed pre-write refusal (routes answer 400, MCP shows the sentence). */
export async function refuseLoanAccountPayment(companyId: string, use: LoanAccountPaymentUse): Promise<void> {
  const refusal = await loanAccountPaymentRefusal(companyId, use);
  if (refusal) throw new SupplierPaymentRefusal(refusal);
}

/** Applying an already processed payment: a loan clearing that sent its message is refused (A); else what it credited (its bank leg and its
 *  standing journal's credit lines) is judged as above. */
export async function refuseLoanAccountApply(companyId: string, paymentId: string, billIds: readonly string[]): Promise<void> {
  const sent = (await sql`
    SELECT 1 AS one FROM intercompany_messages m
     WHERE m.from_company_id = ${companyId}::UUID AND m.kind = 'allocation' AND (m.payload #>> '{payment,id}') = ${paymentId}::UUID::TEXT
       AND (m.payload #>> '{payment,cashLegIsLoanAccount}') = 'true'
     LIMIT 1
  `) as Row[];
  if (sent.length > 0) throw new SupplierPaymentRefusal(LOAN_CLEARED_PAYMENT_REAPPLY);
  const rows = (await sql`
    SELECT sp.bank_account_id AS a FROM supplier_payments sp WHERE sp.id = ${paymentId}::UUID AND sp.company_id = ${companyId}::UUID
    UNION
    SELECT jl.gl_account_id FROM supplier_payments sp
      JOIN gl_journal_lines jl ON jl.journal_entry_id = sp.gl_journal_entry_id AND jl.company_id = ${companyId}::UUID AND jl.credit > 0
     WHERE sp.id = ${paymentId}::UUID AND sp.company_id = ${companyId}::UUID
  `) as Row[];
  await refuseLoanAccountPayment(companyId, { billIds, creditedAccountIds: rows.map((r) => (r.a == null ? null : String(r.a))) });
}

/** Processing a batch: its bank account against every member's bills. */
export async function refuseLoanAccountBatch(companyId: string, batchId: string): Promise<void> {
  const rows = (await sql`
    SELECT b.bank_account_id, pa.invoice_id FROM supplier_payment_batches b
      JOIN supplier_payments sp ON sp.batch_id = b.id AND sp.company_id = ${companyId}::UUID
      JOIN payment_allocations pa ON pa.payment_id = sp.id
     WHERE b.id = ${batchId}::UUID AND b.company_id = ${companyId}::UUID
  `) as Row[];
  if (rows.length === 0) return;
  await refuseLoanAccountPayment(companyId, {
    billIds: rows.map((r) => String(r.invoice_id)), creditedAccountIds: [rows[0]!.bank_account_id == null ? null : String(rows[0]!.bank_account_id)],
  });
}
