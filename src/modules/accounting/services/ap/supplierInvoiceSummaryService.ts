/**
 * Totals and groups for `list_supplier_invoices` `detail: "summary"` / `group_by`. The FROM and WHERE are the
 * list's own (INVOICE FROM/JOIN as in supplierInvoiceQueryService, predicate from buildInvoiceWhere), so the counts
 * and sums describe exactly the bills the list would page through. `balance` is the stored column the rows carry.
 */
import { sql } from '@/lib/neon';
import {
  runGroupedSummary,
  type GroupedSummary,
  type SummaryDimension,
  type SummaryMeasure,
} from '../shared/groupedSummary';
import type { InvoiceFilters } from './supplierInvoiceQueryService';
import { buildInvoiceWhere } from './supplierInvoiceWhereBuilder';

export const SUPPLIER_INVOICE_GROUP_BY = ['supplier', 'status', 'month'] as const;
export type SupplierInvoiceGroupBy = (typeof SUPPLIER_INVOICE_GROUP_BY)[number];

const MEASURES: readonly SummaryMeasure[] = [
  { name: 'count', expr: 'COUNT(*)', kind: 'count' },
  { name: 'total_amount', expr: 'COALESCE(SUM(si.total_amount), 0)', kind: 'money' },
  { name: 'amount_paid', expr: 'COALESCE(SUM(si.amount_paid), 0)', kind: 'money' },
  { name: 'balance', expr: 'COALESCE(SUM(si.balance), 0)', kind: 'money' },
];

const DIMENSIONS: Record<SupplierInvoiceGroupBy, SummaryDimension> = {
  supplier: { keyExpr: 'si.supplier_id::text', labelExpr: 's.name', order: 'm3 DESC, k' },
  status: { keyExpr: 'si.status', labelExpr: null, order: 'k' },
  month: { keyExpr: `to_char(si.invoice_date, 'YYYY-MM')`, labelExpr: null, order: 'k DESC' },
};

export async function summariseSupplierInvoices(
  companyId: string,
  filters: InvoiceFilters,
  groupBy: SupplierInvoiceGroupBy | null,
): Promise<GroupedSummary> {
  const from = sql`
    FROM supplier_invoices si
    LEFT JOIN suppliers s ON s.id = si.supplier_id AND s.company_id = si.company_id
    WHERE ${buildInvoiceWhere(companyId, filters)}`;
  return runGroupedSummary(from, MEASURES, groupBy === null ? null : DIMENSIONS[groupBy]);
}
