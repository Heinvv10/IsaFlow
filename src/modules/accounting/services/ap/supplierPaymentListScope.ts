/**
 * The ONE FROM + predicate behind every read of the supplier-payment list: the page rows, the count/totals and the
 * MCP summary (`supplierPaymentSummaryService`) all splice these, so a total can never describe a different set
 * than the rows it stands in for.
 *
 * `payment_allocations` carries no company_id; it is reached only through a payment already fenced to the company.
 */
import { sql } from '@/lib/neon';

export interface SupplierPaymentScope {
  supplierId?: string | null;
  status?: string | null;
  fromDate?: string | null;
  toDate?: string | null;
  /** Matches payment number, reference or description (case-insensitive substring). */
  search?: string | null;
}

/** `supplier_payments sp`, its supplier `s` and the sum applied to bills `a.allocated`. */
export function supplierPaymentFrom() {
  return sql`
    FROM supplier_payments sp
    LEFT JOIN suppliers s ON s.id = sp.supplier_id AND s.company_id = sp.company_id
    LEFT JOIN LATERAL (
      SELECT SUM(pa.amount_allocated) AS allocated
      FROM payment_allocations pa WHERE pa.payment_id = sp.id
    ) a ON TRUE`;
}

export function supplierPaymentWhere(companyId: string, f: SupplierPaymentScope) {
  const supplierId = f.supplierId || null;
  const status = f.status || null;
  const fromDate = f.fromDate || null;
  const toDate = f.toDate || null;
  const search = f.search && f.search.trim() ? `%${f.search.trim()}%` : null;
  return sql`sp.company_id = ${companyId}::UUID
    AND (${supplierId}::UUID IS NULL OR sp.supplier_id = ${supplierId}::UUID)
    AND (${status}::TEXT IS NULL OR sp.status = ${status}::TEXT)
    AND (${fromDate}::DATE IS NULL OR sp.payment_date >= ${fromDate}::DATE)
    AND (${toDate}::DATE IS NULL OR sp.payment_date <= ${toDate}::DATE)
    AND (${search}::TEXT IS NULL OR sp.payment_number ILIKE ${search}::TEXT
         OR sp.reference ILIKE ${search}::TEXT OR sp.description ILIKE ${search}::TEXT)`;
}
