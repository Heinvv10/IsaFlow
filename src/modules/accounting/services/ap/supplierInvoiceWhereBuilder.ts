/**
 * WHERE / ORDER-BY builders for supplier invoice queries.
 *
 * Extracted from supplierInvoiceQueryService.ts to keep that file under the
 * 300-line project limit and to isolate pure SQL-composition logic for testing.
 */

import { sql } from '@/lib/neon';
import type { InvoiceFilters, SupplierInvoiceSort } from './supplierInvoiceQueryService';

// Lookahead windows used in payment-eligibility predicates.
export const PAY_RUN_LOOKAHEAD_DAYS = 14;
export const DUE_THIS_WEEK_DAYS = 7;

const SORT_COLUMNS: Record<SupplierInvoiceSort, string> = {
  invoice_number: 'si.invoice_number',
  supplier_name: 's.name',
  reference: 'si.reference',
  invoice_date: 'si.invoice_date',
  total_amount: 'si.total_amount',
  balance: 'si.balance',
  status: 'si.status',
};

export { SORT_COLUMNS };

/**
 * Escape ILIKE wildcards so a literal `%` or `_` in a user search term doesn't
 * widen the match. Combined with `ESCAPE '\\'` on the predicate.
 */
function escapeLikePattern(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/**
 * Build the AND-joined WHERE fragment for the given filters. Only active
 * predicates are emitted so Postgres can use indexes on `(company_id, status)`,
 * `(supplier_id)`, etc.
 *
 * Built as a single `sql.unsafe(text, values)` LazyQuery so callers can
 * interpolate it once into the outer query. Predicate strings are *static*
 * literals — only validated/typed values go through `$N` placeholders, so
 * the unsafe call carries no injection risk.
 */
export function buildInvoiceWhere(companyId: string, f: InvoiceFilters | undefined) {
  const values: unknown[] = [companyId];
  const conds: string[] = ['si.company_id = $1::UUID', 'si.deleted_at IS NULL'];

  function add(predicate: (n: number) => string, value: unknown) {
    values.push(value);
    conds.push(predicate(values.length));
  }

  if (f?.status) add((n) => `si.status = $${n}::text`, f.status);
  if (f?.supplierId) add((n) => `si.supplier_id = $${n}::uuid`, f.supplierId);
  if (f?.matchStatus) add((n) => `si.match_status = $${n}::text`, f.matchStatus);
  if (f?.fromDate) add((n) => `si.invoice_date >= $${n}::date`, f.fromDate);
  if (f?.toDate) add((n) => `si.invoice_date <= $${n}::date`, f.toDate);
  if (typeof f?.fromAmount === 'number') {
    add((n) => `si.total_amount >= $${n}::numeric`, f.fromAmount);
  }
  if (typeof f?.toAmount === 'number') {
    add((n) => `si.total_amount <= $${n}::numeric`, f.toAmount);
  }
  if (typeof f?.fromBalance === 'number') {
    add((n) => `si.balance >= $${n}::numeric`, f.fromBalance);
  }
  if (typeof f?.toBalance === 'number') {
    add((n) => `si.balance <= $${n}::numeric`, f.toBalance);
  }
  const trimmed = f?.search?.trim();
  if (trimmed) {
    values.push(`%${escapeLikePattern(trimmed)}%`);
    const n = values.length;
    conds.push(
      `(si.invoice_number ILIKE $${n} ESCAPE '\\' `
      + `OR si.reference ILIKE $${n} ESCAPE '\\' `
      + `OR si.notes ILIKE $${n} ESCAPE '\\' `
      + `OR s.name ILIKE $${n} ESCAPE '\\')`,
    );
  }

  // Signal filters — each uses $1 (companyId, already set) to keep subqueries tenant-scoped.
  if (f?.missingDocument) {
    conds.push('si.source_document_id IS NULL');
  }
  if (f?.possibleDuplicate) {
    conds.push(
      'EXISTS ('
      + ' SELECT 1 FROM supplier_invoices dup'
      + ' WHERE dup.company_id = $1::UUID'
      + '   AND dup.supplier_id = si.supplier_id'
      + '   AND dup.invoice_number = si.invoice_number'
      + '   AND dup.id <> si.id'
      + '   AND dup.deleted_at IS NULL'
      + ')',
    );
  }
  if (f?.dueThisWeek) {
    conds.push(
      'si.due_date IS NOT NULL'
      + ` AND si.due_date <= CURRENT_DATE + INTERVAL '${DUE_THIS_WEEK_DAYS} days'`
      + " AND si.status NOT IN ('paid', 'cancelled')",
    );
  }
  if (f?.payRunReady) {
    conds.push(
      "si.status IN ('approved', 'partially_paid')"
      + ' AND si.balance > 0'
      + ` AND (si.due_date IS NULL OR si.due_date <= CURRENT_DATE + INTERVAL '${PAY_RUN_LOOKAHEAD_DAYS} days')`,
    );
  }

  return sql.unsafe(conds.join(' AND '), values);
}

export function buildOrderBy(filters: InvoiceFilters | undefined): string {
  const sortKey: SupplierInvoiceSort = filters?.sort && SORT_COLUMNS[filters.sort]
    ? filters.sort
    : 'invoice_date';
  const sortColumn = SORT_COLUMNS[sortKey];
  const sortDir = filters?.sortOrder === 'asc' ? 'ASC' : 'DESC';
  // si.created_at as tie-breaker is monotonic (insertion order); using si.id
  // alone falls back to UUIDv4-random ordering which jitters per render.
  return `ORDER BY ${sortColumn} ${sortDir} NULLS LAST, si.created_at ${sortDir}, si.id ${sortDir}`;
}
