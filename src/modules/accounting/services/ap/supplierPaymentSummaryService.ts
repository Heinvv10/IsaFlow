/**
 * Totals and groups for `list_supplier_payments` `detail: "summary"` / `group_by`. The FROM and WHERE are the
 * list's own (`supplierPaymentFrom` / `supplierPaymentWhere`), so the counts and sums describe exactly the payments
 * the list would page through. `unapplied_amount` is payment_amount - allocated_amount, as on every row.
 */
import { sql } from '@/lib/neon';
import {
  runGroupedSummary,
  type GroupedSummary,
  type SummaryDimension,
  type SummaryMeasure,
} from '../shared/groupedSummary';
import { supplierPaymentFrom, supplierPaymentWhere, type SupplierPaymentScope } from './supplierPaymentListScope';

export const SUPPLIER_PAYMENT_GROUP_BY = ['supplier', 'status', 'month'] as const;
export type SupplierPaymentGroupBy = (typeof SUPPLIER_PAYMENT_GROUP_BY)[number];

const MEASURES: readonly SummaryMeasure[] = [
  { name: 'count', expr: 'COUNT(*)', kind: 'count' },
  { name: 'payment_amount', expr: 'COALESCE(SUM(sp.total_amount), 0)', kind: 'money' },
  { name: 'allocated_amount', expr: 'COALESCE(SUM(COALESCE(a.allocated, 0)), 0)', kind: 'money' },
  { name: 'unapplied_amount', expr: 'COALESCE(SUM(sp.total_amount - COALESCE(a.allocated, 0)), 0)', kind: 'money' },
];

const DIMENSIONS: Record<SupplierPaymentGroupBy, SummaryDimension> = {
  supplier: { keyExpr: 'sp.supplier_id::text', labelExpr: 's.name', order: 'm1 DESC, k' },
  status: { keyExpr: 'sp.status', labelExpr: null, order: 'k' },
  month: { keyExpr: `to_char(sp.payment_date, 'YYYY-MM')`, labelExpr: null, order: 'k DESC' },
};

export async function summariseSupplierPayments(
  companyId: string,
  filters: SupplierPaymentScope,
  groupBy: SupplierPaymentGroupBy | null,
): Promise<GroupedSummary> {
  const from = sql`${supplierPaymentFrom()} WHERE ${supplierPaymentWhere(companyId, filters)}`;
  return runGroupedSummary(from, MEASURES, groupBy === null ? null : DIMENSIONS[groupBy]);
}
