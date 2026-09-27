/**
 * `findVatDeclaredElsewhere` — split out of vatUnpostedInvoices.ts (2026-09-27,
 * file-size limit). Re-exported from there so no caller's import path
 * changes; behaviour-preserving, same SQL text.
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { APPROVED_BILL_STATUSES, ISSUED_CUSTOMER_INVOICE_STATUSES } from './vatUnpostedInvoices';

/**
 * Issued invoices / approved bills marked "VAT declared outside IsaFlow"
 * (migration 705) that would otherwise appear in `findUnpostedInvoiceVat` —
 * i.e. still carrying VAT with no live journal, but the block has been
 * lifted. NON-blocking; kept visible rather than dropped so the mark is
 * auditable from the exceptions panel itself. Population dates and statuses
 * mirror `findUnpostedInvoiceVat`, further restricted to documents whose VAT
 * has NEVER reached the GL — `gl_journal_entry_id IS NULL`, or the journal is
 * not posted and carries no posted reversal (dated on or before the period
 * end, same bound the blocking query uses). A marked document whose journal
 * is later posted (unreversed) is on NEITHER list — its VAT is correctly in
 * the ledger, so it is not an exception at all, stale mark or not. A marked
 * document whose journal was posted then reversed is on the BLOCKING list
 * ONLY (`findUnpostedInvoiceVat`'s mark-ignoring branch). So: the two lists
 * together cover exactly the documents whose VAT is not currently in the GL
 * — never both, but a properly-filed marked document is neither, on purpose.
 * This still holds for the CUSTOMER-only `journal_dated_after_period` reason
 * added the same day: a mark on a document whose journal later posts, dated
 * after the period end, is likewise on the BLOCKING list ONLY (that reason's
 * own mark-ignoring branch in `findUnpostedInvoiceVat`) — its condition here
 * requires the journal to NOT be posted, which excludes it just the same.
 *
 * `marked_by_name` resolves `vat_declared_elsewhere_by` (users.id) to a
 * display name with the LEFT JOIN users + CONCAT_WS(first_name, last_name)
 * that vatPeriodLockService.listVatPeriodLocks uses for `locked_by_name`;
 * unlike that one, the email fallback is done here in SQL. `users` is a
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
      LEFT JOIN gl_journal_entries je
        ON je.id = ci.gl_journal_entry_id AND je.company_id = ${companyId}::UUID
      WHERE ci.company_id = ${companyId}::UUID
        AND ci.deleted_at IS NULL
        AND ci.vat_declared_elsewhere_at IS NOT NULL
        AND ci.status = ANY(${ISSUED_CUSTOMER_INVOICE_STATUSES as string[]}::TEXT[])
        AND ci.invoice_date >= ${periodStart}::DATE AND ci.invoice_date <= ${periodEnd}::DATE
        -- Round 3 fix (2026-09-26): a marked document is listed here only
        -- while its VAT has NEVER reached the GL. A document whose journal
        -- was posted then reversed shows in the BLOCKING list instead (see
        -- findUnpostedInvoiceVat's mark-ignoring branch); a document whose
        -- journal is posted and UNREVERSED is on neither list — its VAT is
        -- correctly filed, so the stale mark is not an exception at all.
        AND (
          ci.gl_journal_entry_id IS NULL
          OR (
            je.status IS DISTINCT FROM 'posted'
            AND NOT EXISTS (
              SELECT 1 FROM gl_journal_entries rev
              WHERE rev.reversal_of_id = ci.gl_journal_entry_id
                AND rev.company_id = ${companyId}::UUID
                AND rev.status = 'posted'
                AND rev.entry_date <= ${periodEnd}::DATE
            )
          )
        )
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
      LEFT JOIN gl_journal_entries je
        ON je.id = si.gl_journal_entry_id AND je.company_id = ${companyId}::UUID
      WHERE si.company_id = ${companyId}::UUID
        AND si.deleted_at IS NULL
        AND si.vat_declared_elsewhere_at IS NOT NULL
        AND si.status = ANY(${APPROVED_BILL_STATUSES as string[]}::TEXT[])
        AND si.invoice_date >= ${periodStart}::DATE AND si.invoice_date <= ${periodEnd}::DATE
        -- Same reasoning as the customer branch above.
        AND (
          si.gl_journal_entry_id IS NULL
          OR (
            je.status IS DISTINCT FROM 'posted'
            AND NOT EXISTS (
              SELECT 1 FROM gl_journal_entries rev
              WHERE rev.reversal_of_id = si.gl_journal_entry_id
                AND rev.company_id = ${companyId}::UUID
                AND rev.status = 'posted'
                AND rev.entry_date <= ${periodEnd}::DATE
            )
          )
        )
    ) docs
    WHERE unposted_vat <> 0
    ORDER BY invoice_date, invoice_number
  ` as Promise<DbRow[]>;
}
