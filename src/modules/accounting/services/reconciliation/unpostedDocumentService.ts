/**
 * Open subledger documents whose value never reached a control account.
 *
 * This was not in the specification. It was found by running the reconciliation
 * over real books and looking at what it could not explain: on isaflow_dev, 169
 * of ISAFlow Demo's open customer invoices carry no `gl_journal_entry_id` at
 * all — R10,664,575.43 of receivable that the subledger counts and the general
 * ledger has never heard of. Reported as `unexplained_difference` that is a
 * number; reported here it is a list of invoice numbers.
 *
 * EVERY document is scanned — every status, cancelled included, because a
 * cancelled invoice's journal and its reversal both sit on the control account
 * and only cancel each other if both are counted — and the control amount a
 * document is credited with includes the postings of the PAYMENTS ALLOCATED TO
 * IT and of the CREDIT NOTES APPLIED TO IT. Both were learned the hard way. A settled invoice has a balance of zero
 * and a pair of postings on the control account that cancel; scanning only open
 * documents counts the payment leg (which the payment partition sees) without
 * the invoice leg, and drops exactly that much into `unexplained_difference`.
 *
 * TWO reasons, kept apart because the remedy differs:
 *   `document_not_linked_to_journal`  — the document carries no
 *       `gl_journal_entry_id`. It names exactly that and NOT "never posted":
 *       on isaflow_dev, 385 `auto_supplier_invoice` journals exist while the
 *       bills they came from carry no link back, so the value IS on the control
 *       account and the document simply cannot say which journal put it there.
 *       Those postings are picked up from the ledger side instead, as
 *       `posting_with_no_document`, and the two partitions do not overlap.
 *   `document_not_on_control_account`  — a journal IS linked, and the amount it
 *       put on a control account differs from the document's balance.
 *
 * The control amount is computed in a CORRELATED SUBQUERY, not in a
 * `LEFT JOIN … ON`. A predicate in an outer join's ON clause restricts nothing:
 * unmatched rows survive with NULLs and get summed anyway, which is how
 * `kpiChartsService` came to chart every transaction in the company.
 */

import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { log } from '@/lib/logger';
import { fmtDate } from '@/lib/fmtDate';
import { AP_OPEN_STATUSES, AR_OPEN_STATUSES } from '@/lib/constants/invoiceStatuses';
import type { SubledgerRole } from '../gl/controlAccountService';
import { round2 } from './reconciliationMath';

export interface UnpostedDocument {
  id: string;
  documentNumber: string | null;
  entityName: string | null;
  documentDate: string;
  /**
   * The document's balance MINUS what its journal put on a control account.
   * Signed: positive when the ledger is short of the document, negative when
   * the ledger carries more than the document does. Both directions have to be
   * reported or the decomposition cannot close.
   */
  amount: number;
  reason: 'document_not_linked_to_journal' | 'document_not_on_control_account';
}

/**
 * @param controlAccountIds every candidate control account. An EMPTY array
 *   short-circuits — with no control account, "not on the control account" is
 *   not a finding about the document, and `no_control_account` already says so.
 */
export async function getUnpostedSubledgerDocuments(
  companyId: string,
  role: SubledgerRole,
  asAtDate: string,
  controlAccountIds: readonly string[],
): Promise<UnpostedDocument[]> {
  if ((role !== 'ar' && role !== 'ap') || controlAccountIds.length === 0) return [];

  try {
    const ids = [...controlAccountIds];
    const isAr = role === 'ar';
    // The SAME population the subledger snapshot counts. A settled document
    // contributes zero to the subledger, so it must contribute zero here too —
    // its own posting and its payments' postings cancel on the control account
    // and neither belongs in a reconciling item.
    const openStatuses = isAr ? Array.from(AR_OPEN_STATUSES) : Array.from(AP_OPEN_STATUSES);

    // AR and AP are SEPARATE queries, not one query branching on a boolean
    // parameter: that form type-checked, ran without error and returned nothing
    // on data where a manual join found the rows.
    const rows = (await (isAr
      ? sql`
        SELECT ci.id, ci.invoice_number AS document_number, c.name AS entity_name,
               ci.invoice_date AS document_date,
               CASE WHEN ci.status = ANY(${openStatuses}::text[])
                    THEN (ci.total_amount - COALESCE(ci.amount_paid, 0)) ELSE 0 END AS balance,
               (ci.gl_journal_entry_id IS NOT NULL) AS has_journal,
               COALESCE((
                 SELECT SUM(jl.debit - jl.credit)
                 FROM gl_journal_lines jl
                 JOIN gl_journal_entries je ON je.id = jl.journal_entry_id
                                           AND je.company_id = ${companyId}::UUID
                                           AND je.status = 'posted'
                                           AND je.entry_date <= ${asAtDate}::DATE
                 WHERE jl.journal_entry_id = ci.gl_journal_entry_id
                   AND jl.company_id = ${companyId}::UUID
                   AND jl.gl_account_id = ANY(${ids}::uuid[])
               ), 0)
               + COALESCE((
                 SELECT SUM(jl.debit - jl.credit)
                 FROM customer_payment_allocations a
                 JOIN customer_payments p ON p.id = a.payment_id
                                         AND p.company_id = ${companyId}::UUID
                 JOIN gl_journal_entries je ON je.id = p.gl_journal_entry_id
                                           AND je.company_id = ${companyId}::UUID
                                           AND je.status = 'posted'
                                           AND je.entry_date <= ${asAtDate}::DATE
                 JOIN gl_journal_lines jl ON jl.journal_entry_id = je.id
                                         AND jl.company_id = ${companyId}::UUID
                                         AND jl.gl_account_id = ANY(${ids}::uuid[])
                 WHERE a.invoice_id = ci.id
               ), 0)
               + COALESCE((
                 SELECT SUM(jl.debit - jl.credit)
                 FROM credit_notes cn
                 JOIN gl_journal_entries je ON je.id = cn.gl_journal_entry_id
                                           AND je.company_id = ${companyId}::UUID
                                           AND je.status = 'posted'
                                           AND je.entry_date <= ${asAtDate}::DATE
                 JOIN gl_journal_lines jl ON jl.journal_entry_id = je.id
                                         AND jl.company_id = ${companyId}::UUID
                                         AND jl.gl_account_id = ANY(${ids}::uuid[])
                 WHERE cn.company_id = ${companyId}::UUID
                   AND cn.customer_invoice_id = ci.id
               ), 0) AS control_amount
        FROM customer_invoices ci
        JOIN customers c ON c.id = COALESCE(ci.client_id, ci.customer_id)
                        AND c.company_id = ${companyId}::UUID
        WHERE ci.company_id = ${companyId}::UUID
        ORDER BY ci.invoice_date, ci.id
      `
      : sql`
        SELECT si.id, si.invoice_number AS document_number, s.name AS entity_name,
               si.invoice_date AS document_date,
               CASE WHEN si.status = ANY(${openStatuses}::text[])
                    THEN (si.total_amount - COALESCE(si.amount_paid, 0)) ELSE 0 END AS balance,
               (si.gl_journal_entry_id IS NOT NULL) AS has_journal,
               COALESCE((
                 SELECT SUM(jl.credit - jl.debit)
                 FROM gl_journal_lines jl
                 JOIN gl_journal_entries je ON je.id = jl.journal_entry_id
                                           AND je.company_id = ${companyId}::UUID
                                           AND je.status = 'posted'
                                           AND je.entry_date <= ${asAtDate}::DATE
                 WHERE jl.journal_entry_id = si.gl_journal_entry_id
                   AND jl.company_id = ${companyId}::UUID
                   AND jl.gl_account_id = ANY(${ids}::uuid[])
               ), 0)
               + COALESCE((
                 SELECT SUM(jl.credit - jl.debit)
                 FROM payment_allocations a
                 JOIN supplier_payments p ON p.id = a.payment_id
                                         AND p.company_id = ${companyId}::UUID
                 JOIN gl_journal_entries je ON je.id = p.gl_journal_entry_id
                                           AND je.company_id = ${companyId}::UUID
                                           AND je.status = 'posted'
                                           AND je.entry_date <= ${asAtDate}::DATE
                 JOIN gl_journal_lines jl ON jl.journal_entry_id = je.id
                                         AND jl.company_id = ${companyId}::UUID
                                         AND jl.gl_account_id = ANY(${ids}::uuid[])
                 WHERE a.invoice_id = si.id
               ), 0) AS control_amount
        FROM supplier_invoices si
        JOIN suppliers s ON s.id = si.supplier_id AND s.company_id = ${companyId}::UUID
        WHERE si.company_id = ${companyId}::UUID
        ORDER BY si.invoice_date, si.id
      `)) as DbRow[];

    const out: UnpostedDocument[] = [];
    for (const r of rows) {
      const shortfall = round2(Number(r.balance ?? 0) - Number(r.control_amount ?? 0));
      // A document exactly represented on a control account is not a finding.
      // A document the ledger OVER-states is, so both signs are kept.
      if (shortfall === 0) continue;
      out.push({
        id: String(r.id),
        documentNumber: r.document_number == null ? null : String(r.document_number),
        entityName: r.entity_name == null ? null : String(r.entity_name),
        documentDate: fmtDate(r.document_date as string | Date),
        amount: shortfall,
        reason:
          r.has_journal === true ? 'document_not_on_control_account' : 'document_not_linked_to_journal',
      });
    }
    return out;
  } catch (err) {
    log.error('Failed to find unposted subledger documents', { role, error: err }, 'accounting');
    throw err;
  }
}
