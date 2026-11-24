/**
 * The shared-layer guard of intercompany P4-E (plan (j).3). With the dark flag `intercompany_loan_clearing` ON for the paying company, a bill
 * slotted in an ACTIVE intercompany link is settled from the payer side's LOAN account (the account its side names as `loan_account_id` on
 * the link's connection) only by "Clear against the intercompany loan" (`payerLoanClearService`: its minted permit and the author label
 * `system:ic_loan_clear`). Every other path that would credit that account for such a bill (MCP `settle_by_contra` on a payable, a plain
 * supplier payment processed from the loan account, applying a processed loan-account payment, a payment batch paid from it) is refused, before
 * its first write, with "use Clear against the intercompany loan": those paths skip the link, loan-class and pair cut-over checks, and with the
 * flag on their payment would send an allocation message the partner could clear. The flag OFF: nothing changes (nothing is sent either).
 * The connection's mode and status are not asked: any active link on any connection whose side names the credited account counts (the safer
 * reading). No write here.
 */
import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import { SupplierPaymentRefusal } from '../ap/supplierPaymentRefusal';
import { loanClearingEnabled } from './loanClearingGate';
import { permitCovers, type LoanClearPermit } from './loanClearPermit';

type Row = Record<string, unknown>;

export const LOAN_ACCOUNT_PAYMENT_REFUSED = 'This bill is linked to the partner\'s invoice on an intercompany connection and the account is your loan account for it: '
  + 'use Clear against the intercompany loan on the bill (it checks the link, the cut-over and the partner first). Nothing was posted.';

export interface LoanAccountPaymentUse {
  billIds: readonly string[];
  /** The accounts the posting credits (the payment's bank leg; for an apply, its journal's credit lines too). */
  creditedAccountIds: readonly (string | null | undefined)[];
  postingAgent?: string;
  permit?: LoanClearPermit;
}

const uniq = (xs: readonly (string | null | undefined)[]): string[] => [...new Set(xs.filter((x): x is string => typeof x === 'string' && x !== '').map((x) => x.toLowerCase()))];

/** The refusal sentence, or null (flag off, nothing linked on a side naming a credited account, or the clearing's own permit). Reads only. */
export async function loanAccountPaymentRefusal(companyId: string, use: LoanAccountPaymentUse): Promise<string | null> {
  const bills = uniq(use.billIds);
  const credited = uniq(use.creditedAccountIds);
  if (bills.length === 0 || credited.length === 0) return null;
  if (!(await loanClearingEnabled(companyId))) return null;
  const rows = (await sql`
    SELECT 1 AS hit FROM intercompany_document_links k
      JOIN intercompany_connection_sides s ON s.connection_id = k.connection_id AND s.company_id = ${companyId}::UUID
     WHERE k.status = 'active' AND s.loan_account_id = ANY(${credited}::UUID[])
       AND ((k.company_a_id = ${companyId}::UUID AND k.doc_a_type = 'supplier_invoice' AND k.doc_a_id = ANY(${bills}::UUID[]))
         OR (k.company_b_id = ${companyId}::UUID AND k.doc_b_type = 'supplier_invoice' AND k.doc_b_id = ANY(${bills}::UUID[])))
     LIMIT 1
  `) as Row[];
  if (rows.length === 0) return null;
  if (permitCovers(use.permit, { companyId, billIds: bills, creditedAccountIds: credited, postingAgent: use.postingAgent })) return null;
  log.info('Payment from the intercompany loan account refused: use the loan clearing', { companyId, bills: bills.length }, 'intercompany');
  return LOAN_ACCOUNT_PAYMENT_REFUSED;
}

/** The same, thrown as the AP paths' typed pre-write refusal (routes answer 400, MCP shows the sentence). */
export async function refuseLoanAccountPayment(companyId: string, use: LoanAccountPaymentUse): Promise<void> {
  const refusal = await loanAccountPaymentRefusal(companyId, use);
  if (refusal) throw new SupplierPaymentRefusal(refusal);
}

/** Applying an already processed payment: what it credited (its bank leg and its standing journal's credit lines). */
export async function refuseLoanAccountApply(companyId: string, paymentId: string, billIds: readonly string[]): Promise<void> {
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
