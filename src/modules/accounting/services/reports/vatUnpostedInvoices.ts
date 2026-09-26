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
 *   - a document marked "VAT declared outside IsaFlow" (migration 705,
 *     vatDeclaredElsewhereService) is left out here and appears instead in
 *     `findVatDeclaredElsewhere` below — NON-blocking, but still visible.
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';

// Not exported: no caller outside this file reads them (checked 2026-09-25).
// If one needs to, test it against shared/documentPopulation's own lists
// rather than assuming the two never drift.
const ISSUED_CUSTOMER_INVOICE_STATUSES: readonly string[] =
  ['approved', 'sent', 'partially_paid', 'paid', 'overdue'];
const APPROVED_BILL_STATUSES: readonly string[] = ['approved', 'partially_paid', 'paid'];

/**
 * A document counts as unposted invoice VAT not only when it has NO journal
 * (`reason: 'no_journal'`), but also when its linked journal is not posted
 * (`'journal_not_posted'`) or has a POSTED reversal dated on or before the
 * period end (`'journal_reversed'`, B3). A reversal nets the original's VAT
 * out of the filed ledger (vatEntryMembership) while `status = 'sent'` etc.
 * on the invoice itself is untouched — reverseJournalEntry carries no
 * document guard — so without this an issued invoice's output VAT vanishes
 * from both the ledger AND this exception, filing R0 with zero exceptions. A
 * reversal dated in a LATER period is left alone: the invoice's VAT is still
 * filed, correctly, in the reversed journal's own period.
 */
export async function findUnpostedInvoiceVat(
  companyId: string, periodStart: string, periodEnd: string,
): Promise<DbRow[]> {
  return sql`
    SELECT * FROM (
      SELECT 'customer' AS kind, ci.id AS invoice_id, ci.invoice_number, ci.invoice_date,
        COALESCE(c.name, cl.name, 'Unknown') AS counterparty_name,
        COALESCE(ci.tax_amount, 0) AS unposted_vat,
        CASE
          WHEN ci.gl_journal_entry_id IS NULL THEN 'no_journal'
          WHEN je.status IS DISTINCT FROM 'posted' THEN 'journal_not_posted'
          ELSE 'journal_reversed'
        END AS reason
      FROM customer_invoices ci
      LEFT JOIN customers c ON c.id = ci.customer_id AND c.company_id = ${companyId}::UUID
      LEFT JOIN clients cl ON cl.id = ci.client_id
      LEFT JOIN gl_journal_entries je
        ON je.id = ci.gl_journal_entry_id AND je.company_id = ${companyId}::UUID
      WHERE ci.company_id = ${companyId}::UUID
        AND ci.deleted_at IS NULL
        AND ci.vat_declared_elsewhere_at IS NULL
        AND ci.status = ANY(${ISSUED_CUSTOMER_INVOICE_STATUSES as string[]}::TEXT[])
        AND ci.invoice_date >= ${periodStart}::DATE AND ci.invoice_date <= ${periodEnd}::DATE
        AND (
          ci.gl_journal_entry_id IS NULL
          OR je.status IS DISTINCT FROM 'posted'
          OR EXISTS (
            SELECT 1 FROM gl_journal_entries rev
            WHERE rev.reversal_of_id = ci.gl_journal_entry_id
              AND rev.company_id = ${companyId}::UUID
              AND rev.status = 'posted'
              AND rev.entry_date <= ${periodEnd}::DATE
          )
        )
      UNION ALL
      SELECT 'supplier', si.id, si.invoice_number, si.invoice_date,
        COALESCE(s.name, 'Unknown'),
        -- supplier_invoice_items carries no company_id of its own (same as
        -- vat201Service.ts:138) — scoped explicitly via si.company_id here
        -- too, not merely by si.id already being a company-scoped row.
        COALESCE((SELECT SUM(sii.tax_amount) FROM supplier_invoice_items sii
                  WHERE sii.supplier_invoice_id = si.id AND si.company_id = ${companyId}::UUID), si.tax_amount, 0),
        CASE
          WHEN si.gl_journal_entry_id IS NULL THEN 'no_journal'
          WHEN je.status IS DISTINCT FROM 'posted' THEN 'journal_not_posted'
          ELSE 'journal_reversed'
        END
      FROM supplier_invoices si
      LEFT JOIN suppliers s ON s.id = si.supplier_id AND s.company_id = ${companyId}::UUID
      LEFT JOIN gl_journal_entries je
        ON je.id = si.gl_journal_entry_id AND je.company_id = ${companyId}::UUID
      WHERE si.company_id = ${companyId}::UUID
        AND si.deleted_at IS NULL
        AND si.vat_declared_elsewhere_at IS NULL
        AND si.status = ANY(${APPROVED_BILL_STATUSES as string[]}::TEXT[])
        AND si.invoice_date >= ${periodStart}::DATE AND si.invoice_date <= ${periodEnd}::DATE
        AND (
          si.gl_journal_entry_id IS NULL
          OR je.status IS DISTINCT FROM 'posted'
          OR EXISTS (
            SELECT 1 FROM gl_journal_entries rev
            WHERE rev.reversal_of_id = si.gl_journal_entry_id
              AND rev.company_id = ${companyId}::UUID
              AND rev.status = 'posted'
              AND rev.entry_date <= ${periodEnd}::DATE
          )
        )
    ) docs
    WHERE unposted_vat <> 0
    ORDER BY invoice_date, invoice_number
  ` as Promise<DbRow[]>;
}

/**
 * Issued invoices / approved bills marked "VAT declared outside IsaFlow"
 * (migration 705) that would otherwise appear in `findUnpostedInvoiceVat` —
 * i.e. still carrying VAT with no live journal, but the block has been
 * lifted. NON-blocking; kept visible rather than dropped so the mark is
 * auditable from the exceptions panel itself. Population dates and statuses
 * mirror `findUnpostedInvoiceVat` exactly — the same document must appear in
 * exactly one of the two lists, never both and never neither.
 *
 * `marked_by_name` resolves `vat_declared_elsewhere_by` (users.id) to a
 * display name via the same LEFT JOIN users + CONCAT_WS(first_name,
 * last_name), falling back to email, pattern as
 * vatPeriodLockService.listVatPeriodLocks's `locked_by_name`. `users` is a
 * platform table, not company-scoped, so the join carries no company_id.
 */
export async function findVatDeclaredElsewhere(
  companyId: string, periodStart: string, periodEnd: string,
): Promise<DbRow[]> {
  return sql`
    SELECT * FROM (
      SELECT 'customer' AS kind, ci.id AS invoice_id, ci.invoice_number, ci.invoice_date,
        COALESCE(c.name, cl.name, 'Unknown') AS counterparty_name,
        COALESCE(ci.tax_amount, 0) AS unposted_vat,
        ci.vat_declared_elsewhere_at AS marked_at, ci.vat_declared_elsewhere_by AS marked_by,
        COALESCE(NULLIF(TRIM(CONCAT_WS(' ', mu.first_name, mu.last_name)), ''), mu.email) AS marked_by_name,
        ci.vat_declared_elsewhere_reason AS marked_reason
      FROM customer_invoices ci
      LEFT JOIN customers c ON c.id = ci.customer_id AND c.company_id = ${companyId}::UUID
      LEFT JOIN clients cl ON cl.id = ci.client_id
      LEFT JOIN users mu ON mu.id::TEXT = ci.vat_declared_elsewhere_by::TEXT
      WHERE ci.company_id = ${companyId}::UUID
        AND ci.deleted_at IS NULL
        AND ci.vat_declared_elsewhere_at IS NOT NULL
        AND ci.status = ANY(${ISSUED_CUSTOMER_INVOICE_STATUSES as string[]}::TEXT[])
        AND ci.invoice_date >= ${periodStart}::DATE AND ci.invoice_date <= ${periodEnd}::DATE
      UNION ALL
      SELECT 'supplier', si.id, si.invoice_number, si.invoice_date,
        COALESCE(s.name, 'Unknown'),
        -- Same explicit company scoping as the query above (item 12).
        COALESCE((SELECT SUM(sii.tax_amount) FROM supplier_invoice_items sii
                  WHERE sii.supplier_invoice_id = si.id AND si.company_id = ${companyId}::UUID), si.tax_amount, 0),
        si.vat_declared_elsewhere_at, si.vat_declared_elsewhere_by,
        COALESCE(NULLIF(TRIM(CONCAT_WS(' ', mu.first_name, mu.last_name)), ''), mu.email),
        si.vat_declared_elsewhere_reason
      FROM supplier_invoices si
      LEFT JOIN suppliers s ON s.id = si.supplier_id AND s.company_id = ${companyId}::UUID
      LEFT JOIN users mu ON mu.id::TEXT = si.vat_declared_elsewhere_by::TEXT
      WHERE si.company_id = ${companyId}::UUID
        AND si.deleted_at IS NULL
        AND si.vat_declared_elsewhere_at IS NOT NULL
        AND si.status = ANY(${APPROVED_BILL_STATUSES as string[]}::TEXT[])
        AND si.invoice_date >= ${periodStart}::DATE AND si.invoice_date <= ${periodEnd}::DATE
    ) docs
    WHERE unposted_vat <> 0
    ORDER BY invoice_date, invoice_number
  ` as Promise<DbRow[]>;
}
