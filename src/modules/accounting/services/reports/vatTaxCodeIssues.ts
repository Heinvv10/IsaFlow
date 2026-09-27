/**
 * Pre-filing exception: a document with no tax rate, or a rate but zero VAT
 * recorded — split by kind because the two halves are no longer the same
 * exception (Hein, 2026-09-27):
 *
 *   - CUSTOMER invoices (`findCustomerTaxCodeIssues`) stay BLOCKING — the
 *     record problem can only mean under-declared output VAT, wrong in
 *     SARS's favour against the vendor.
 *   - SUPPLIER bills (`findSupplierTaxCodeIssues`) are NOT blocking — the
 *     record problem can only mean LESS input VAT was claimed than the
 *     bill's own rate supports, never more. `potential_vat_total` is a
 *     window SUM (`subtotal * tax_rate / 100`) over EVERY matching row,
 *     computed before `LIMIT`, so it is the true total across the whole
 *     population, not just the capped page `vatExceptionsService.ts` keeps.
 *
 * Split out of vatExceptionsService.ts (file-size limit, Hein 2026-09-27) —
 * each function makes exactly ONE `sql` call and returns its raw rows, same
 * as `vatUnpostedInvoices.findUnpostedInvoiceVat` / `vatInputSupport`: the
 * unit tests mock `sql` as a positional queue keyed to the number and order
 * of calls `getVatExceptions` makes, so a query built from more than one
 * `sql` call (or spliced from a shared fragment) would consume an extra
 * queued result and desync every query after it.
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';

const LIST_CAP = 100;

/** Customer invoices with no tax rate, or a rate but zero VAT — BLOCKING. */
export async function findCustomerTaxCodeIssues(
  companyId: string, periodStart: string, periodEnd: string,
): Promise<DbRow[]> {
  return sql`
    SELECT ci.id AS invoice_id, ci.invoice_number, ci.invoice_date,
      ci.subtotal, ci.tax_rate, ci.tax_amount,
      COALESCE(c.name, cl.name, 'Unknown') AS counterparty_name,
      COUNT(*) OVER() AS total_count
    FROM customer_invoices ci
    LEFT JOIN customers c ON c.id = ci.customer_id
    LEFT JOIN clients cl ON cl.id = ci.client_id
    WHERE ci.company_id = ${companyId}::UUID
      AND ci.invoice_date >= ${periodStart}::DATE
      AND ci.invoice_date <= ${periodEnd}::DATE
      AND ci.status != 'cancelled'
      AND (ci.tax_rate IS NULL
        OR (ci.tax_rate > 0 AND COALESCE(ci.tax_amount, 0) = 0 AND ci.subtotal > 0))
    ORDER BY ci.invoice_date, ci.invoice_number
    LIMIT ${LIST_CAP}
  ` as Promise<DbRow[]>;
}

/** Supplier bills with the same record problem — NOT blocking. */
export async function findSupplierTaxCodeIssues(
  companyId: string, periodStart: string, periodEnd: string,
): Promise<DbRow[]> {
  return sql`
    SELECT si.id AS invoice_id, si.invoice_number, si.invoice_date,
      si.subtotal, si.tax_rate, si.tax_amount,
      COALESCE(s.name, 'Unknown') AS counterparty_name,
      COUNT(*) OVER() AS total_count,
      COALESCE(SUM(CASE WHEN si.tax_rate IS NOT NULL THEN si.subtotal * si.tax_rate / 100 ELSE 0 END)
        OVER(), 0) AS potential_vat_total
    FROM supplier_invoices si
    LEFT JOIN suppliers s ON s.id = si.supplier_id
    WHERE si.company_id = ${companyId}::UUID
      AND si.invoice_date >= ${periodStart}::DATE
      AND si.invoice_date <= ${periodEnd}::DATE
      AND si.status != 'cancelled'
      AND (si.tax_rate IS NULL
        OR (si.tax_rate > 0 AND COALESCE(si.tax_amount, 0) = 0 AND si.subtotal > 0))
    ORDER BY si.invoice_date, si.invoice_number
    LIMIT ${LIST_CAP}
  ` as Promise<DbRow[]>;
}
