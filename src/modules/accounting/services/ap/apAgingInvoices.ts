/**
 * The open supplier bills the AP aging is built from — ONE query, shared by
 * `getAPAging` (every supplier), `getAPAgingDetail` (one supplier) and the
 * `ap_open_items` export, so the three cannot disagree about which bills are
 * open or what each one owes.
 *
 * The rules are the aging service's and are documented there: the status
 * population (shared/documentPopulation), presence in the ledger as at the date
 * (shared/softDeleteLedgerPresence), the settlement rewind anchored on
 * amount_paid (shared/agingRewind), and a bill with no due date aged from its
 * invoice date rather than dropped.
 */

import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { fmtDate } from '@/lib/fmtDate';
import type { AgingDetailInvoice } from '../../utils/aging';
import { rewindAmount, effectivePaidExpr } from '@/modules/accounting/services/shared/agingRewind';
import { documentInLedgerAsAtFragment } from '@/modules/accounting/services/shared/softDeleteLedgerPresence';
import { documentInPopulationExpr } from '@/modules/accounting/services/shared/documentPopulation';

/** An open bill as the aging sees it, plus the two header fields an export row needs. */
export interface OpenAgingInvoice extends AgingDetailInvoice {
  /** YYYY-MM-DD. */
  invoiceDate: string;
  /** The supplier's own reference on the bill, when captured. */
  reference: string | null;
}

/**
 * Open bills as at `asAtStr`, oldest due first. `supplierId` narrows to one
 * supplier; null reads every supplier of the company.
 */
export async function fetchAPAgingInvoices(
  companyId: string,
  asAtStr: string,
  todayStr: string,
  supplierId: string | null = null,
): Promise<OpenAgingInvoice[]> {
  const rows = (await sql`
    SELECT si.id, si.supplier_id AS entity_id, s.name AS entity_name,
      COALESCE(si.due_date, si.invoice_date) AS due_date,
      (si.due_date IS NULL) AS due_date_missing,
      si.invoice_number, si.invoice_date, si.reference, si.total_amount,
      ${sql.unsafe(effectivePaidExpr('ap'))} AS amount_paid,
      (si.total_amount - ${sql.unsafe(effectivePaidExpr('ap'))}) AS balance
    FROM supplier_invoices si
    JOIN suppliers s ON s.id = si.supplier_id
    LEFT JOIN LATERAL (
      ${rewindAmount({ companyId, asAtStr, todayStr, side: 'ap' })}
    ) unpaid ON TRUE
    WHERE si.company_id = ${companyId}::UUID
      AND (${supplierId}::UUID IS NULL OR si.supplier_id = ${supplierId}::UUID)
      -- Status rule: shared/documentPopulation (NULL-safe, one definition).
      AND ${sql.unsafe(documentInPopulationExpr('si'))}
      -- A soft-deleted bill leaves this report exactly when the delete's
      -- reversal reaches the ledger, and not one day earlier: the reversal is
      -- dated TODAY whenever the bill's own period is closed, so an undated
      -- exclusion drops the document from every earlier as-at date while the
      -- control account still carries it. See shared/softDeleteLedgerPresence.
      AND ${documentInLedgerAsAtFragment('si', asAtStr, companyId)}
      AND si.invoice_date <= ${asAtStr}::date
      AND (si.total_amount - ${sql.unsafe(effectivePaidExpr('ap'))}) > 0
    -- 357 supplier invoices worth R37,703,816.94 — a third of all open
    -- payables — were once absent from the aging because they carry no due
    -- date. Aged from invoice_date instead.
    ORDER BY COALESCE(si.due_date, si.invoice_date)
  `) as DbRow[];

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
    invoiceDate: fmtDate(r.invoice_date),
    reference: r.reference == null || r.reference === '' ? null : String(r.reference),
  }));
}
