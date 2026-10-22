/**
 * The open customer invoices the AR aging is built from — ONE query, shared by
 * `getARAging` (every customer), `getARAgingDetail` (one customer) and the
 * `ar_open_items` export, so the three cannot disagree about which invoices are
 * open, what each one owes, or how much of it is disputed.
 *
 * The rules are the aging service's and are documented there: the status
 * population (shared/documentPopulation), presence in the ledger as at the date
 * (shared/softDeleteLedgerPresence), the settlement rewind (shared/agingRewind),
 * an invoice with no due date aged from its invoice date, and open disputes
 * rewound to the same date (R-059) and carried as `disputedAmount`, which
 * `calculateAgingBuckets` takes out of the buckets.
 */

import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { fmtDate } from '@/lib/fmtDate';
import type { AgingDetailInvoice } from '../../utils/aging';
import { getOpenDisputeTotals } from './disputeService';
import { rewindAmount, effectivePaidExpr } from '@/modules/accounting/services/shared/agingRewind';
import { documentInLedgerAsAtFragment } from '@/modules/accounting/services/shared/softDeleteLedgerPresence';
import { documentInPopulationExpr } from '@/modules/accounting/services/shared/documentPopulation';

/** An open invoice as the aging sees it, plus the two header fields an export row needs. */
export interface OpenAgingInvoice extends AgingDetailInvoice {
  /** YYYY-MM-DD: invoice_date, else the day it was created. */
  invoiceDate: string;
  /** The invoice's number in the system it came from (external_document_number), when captured. */
  reference: string | null;
}

/**
 * Open customer invoices as at `asAtStr`, oldest due first. `clientId` narrows
 * to one customer; null reads every customer of the company.
 */
export async function fetchARAgingInvoices(
  companyId: string,
  asAtStr: string,
  todayStr: string,
  clientId: string | null = null,
): Promise<OpenAgingInvoice[]> {
  const rows = (await sql`
    SELECT ci.id, COALESCE(ci.client_id, ci.customer_id) AS entity_id, c.name AS entity_name,
      COALESCE(ci.due_date, ci.invoice_date, ci.created_at::date) AS due_date,
      (ci.due_date IS NULL) AS due_date_missing,
      ci.invoice_number, COALESCE(ci.invoice_date, ci.created_at::date) AS invoice_date,
      ci.external_document_number AS reference, ci.total_amount,
      ${sql.unsafe(effectivePaidExpr('ar'))} AS amount_paid,
      (ci.total_amount - ${sql.unsafe(effectivePaidExpr('ar'))}) AS balance
    FROM customer_invoices ci
    JOIN customers c ON c.id = COALESCE(ci.client_id, ci.customer_id)
    LEFT JOIN LATERAL (
      ${rewindAmount({ companyId, asAtStr, todayStr, side: 'ar' })}
    ) unpaid ON TRUE
    WHERE ci.company_id = ${companyId}
      AND (${clientId}::UUID IS NULL OR COALESCE(ci.client_id, ci.customer_id) = ${clientId}::UUID)
      -- Status rule: shared/documentPopulation (NULL-safe, one definition).
      AND ${sql.unsafe(documentInPopulationExpr('ci'))}
      -- A soft-deleted invoice leaves this report exactly when the delete's
      -- reversal reaches the ledger, and not one day earlier: the reversal is
      -- dated TODAY whenever the invoice's own period is closed, so an undated
      -- exclusion drops the document from every earlier as-at date while the
      -- control account still carries it. See shared/softDeleteLedgerPresence.
      AND ${documentInLedgerAsAtFragment('ci', asAtStr, companyId)}
      AND COALESCE(ci.invoice_date, ci.created_at::date) <= ${asAtStr}::date
      AND (ci.total_amount - ${sql.unsafe(effectivePaidExpr('ar'))}) > 0
    -- An invoice with no due date is still a debt. Filtering due_date IS NOT
    -- NULL dropped 34 invoices worth R13,908,380.43 from production's AR aging;
    -- every such row carries an invoice_date, so it is aged from that instead.
    ORDER BY COALESCE(ci.due_date, ci.invoice_date, ci.created_at::date)
  `) as DbRow[];

  // Disputes are rewound to the same date as the balances (R-059): a dispute
  // raised after asAtStr had not moved anything out of a bucket then.
  const disputed = await getOpenDisputeTotals(companyId, rows.map((r) => String(r.id)), asAtStr);

  return rows.map((r) => ({
    id: String(r.id),
    invoiceNumber: String(r.invoice_number),
    entityId: String(r.entity_id),
    entityName: String(r.entity_name),
    dueDate: String(r.due_date),
    dueDateMissing: r.due_date_missing === true,
    totalAmount: Number(r.total_amount),
    amountPaid: Number(r.amount_paid),
    balance: Number(r.balance),
    disputedAmount: disputed.get(String(r.id)) ?? 0,
    invoiceDate: fmtDate(r.invoice_date),
    reference: r.reference == null || r.reference === '' ? null : String(r.reference),
  }));
}
