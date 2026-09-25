/**
 * Pre-filing exception: ISSUED invoices and APPROVED bills that carry VAT but
 * were never posted to the GL (no `gl_journal_entry_id`).
 *
 * WHY IT BLOCKS (Hein, 2026-09-25). The control recon ties the FILED ledger
 * VAT201 to the VAT control accounts. A document whose VAT never reached the
 * GL is in neither, so the recon ties at R0 and the return files without it —
 * on dev, R1.68m of output VAT across 180 invoices in one period. The old
 * invoice-based recon caught that as a variance; with the recon on the ledger
 * this list is what keeps catching it, and it is counted in `totalExceptions`.
 * It also feeds the recon's unposted footnote, so the two can never disagree.
 *
 * Population, as the VAT201 readers take it:
 *   - customer invoices: issued — approved / sent / partially_paid / paid /
 *     overdue. Draft, pending_approval and cancelled raise no VAT
 *     (shared/documentPopulation's exclusions).
 *   - supplier bills: `status IN ('approved','partially_paid','paid')`, the
 *     allow-list `generateVAT201` uses ("count approved bills only") —
 *     draft, pending_approval, disputed and cancelled claim nothing. VAT is
 *     Σ supplier_invoice_items.tax_amount when the bill has items (the field
 *     10 source), else the header `tax_amount`.
 *   - dated by `invoice_date` in the period (a bill with no journal cannot
 *     have a late-claim companion, so the companion dating never applies);
 *   - soft-deleted documents (`deleted_at`) are left out: a deleted document
 *     raises no VAT, and listing it would block a period nobody can clear.
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';

export const ISSUED_CUSTOMER_INVOICE_STATUSES: readonly string[] =
  ['approved', 'sent', 'partially_paid', 'paid', 'overdue'];
export const APPROVED_BILL_STATUSES: readonly string[] = ['approved', 'partially_paid', 'paid'];

/** One row per document: `kind`, `invoice_id`, `invoice_number`, `invoice_date`, `counterparty_name`, `unposted_vat`. */
export async function findUnpostedInvoiceVat(
  companyId: string, periodStart: string, periodEnd: string,
): Promise<DbRow[]> {
  return sql`
    SELECT * FROM (
      SELECT 'customer' AS kind, ci.id AS invoice_id, ci.invoice_number, ci.invoice_date,
        COALESCE(c.name, cl.name, 'Unknown') AS counterparty_name,
        COALESCE(ci.tax_amount, 0) AS unposted_vat
      FROM customer_invoices ci
      LEFT JOIN customers c ON c.id = ci.customer_id AND c.company_id = ${companyId}::UUID
      LEFT JOIN clients cl ON cl.id = ci.client_id
      WHERE ci.company_id = ${companyId}::UUID
        AND ci.gl_journal_entry_id IS NULL
        AND ci.deleted_at IS NULL
        AND ci.status = ANY(${ISSUED_CUSTOMER_INVOICE_STATUSES as string[]}::TEXT[])
        AND ci.invoice_date >= ${periodStart}::DATE AND ci.invoice_date <= ${periodEnd}::DATE
      UNION ALL
      SELECT 'supplier', si.id, si.invoice_number, si.invoice_date,
        COALESCE(s.name, 'Unknown'),
        COALESCE((SELECT SUM(sii.tax_amount) FROM supplier_invoice_items sii
                  WHERE sii.supplier_invoice_id = si.id), si.tax_amount, 0)
      FROM supplier_invoices si
      LEFT JOIN suppliers s ON s.id = si.supplier_id AND s.company_id = ${companyId}::UUID
      WHERE si.company_id = ${companyId}::UUID
        AND si.gl_journal_entry_id IS NULL
        AND si.deleted_at IS NULL
        AND si.status = ANY(${APPROVED_BILL_STATUSES as string[]}::TEXT[])
        AND si.invoice_date >= ${periodStart}::DATE AND si.invoice_date <= ${periodEnd}::DATE
    ) docs
    WHERE unposted_vat <> 0
    ORDER BY invoice_date, invoice_number
  ` as Promise<DbRow[]>;
}
