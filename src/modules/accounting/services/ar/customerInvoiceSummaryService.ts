/**
 * Totals and groups for `list_invoices` `detail: "summary"` / `group_by`. The FROM and WHERE are the list's own
 * (customerInvoiceListFrom / customerInvoiceListWhere in ./customerInvoiceReadService), so the counts and sums
 * describe exactly the invoices the list would page through. `balance` is total - amount_paid, the expression the
 * list's aging columns use.
 */
import { sql } from '@/lib/neon';
import {
  runGroupedSummary,
  type GroupedSummary,
  type SummaryDimension,
  type SummaryMeasure,
} from '../shared/groupedSummary';
import {
  customerInvoiceListFrom,
  customerInvoiceListWhere,
  type CustomerInvoiceListFilters,
} from './customerInvoiceReadService';

export const CUSTOMER_INVOICE_GROUP_BY = ['customer', 'status', 'month'] as const;
export type CustomerInvoiceGroupBy = (typeof CUSTOMER_INVOICE_GROUP_BY)[number];

const MEASURES: readonly SummaryMeasure[] = [
  { name: 'count', expr: 'COUNT(*)', kind: 'count' },
  { name: 'total_amount', expr: 'COALESCE(SUM(ci.total_amount), 0)', kind: 'money' },
  { name: 'amount_paid', expr: 'COALESCE(SUM(ci.amount_paid), 0)', kind: 'money' },
  { name: 'balance', expr: 'COALESCE(SUM(COALESCE(ci.total_amount, 0) - COALESCE(ci.amount_paid, 0)), 0)', kind: 'money' },
];

const DIMENSIONS: Record<CustomerInvoiceGroupBy, SummaryDimension> = {
  customer: { keyExpr: 'COALESCE(ci.client_id, ci.customer_id)::text', labelExpr: 'c.name', order: 'm3 DESC, k' },
  status: { keyExpr: 'ci.status', labelExpr: null, order: 'k' },
  month: { keyExpr: `to_char(ci.invoice_date, 'YYYY-MM')`, labelExpr: null, order: 'k DESC' },
};

export async function summariseCustomerInvoices(
  companyId: string,
  filters: CustomerInvoiceListFilters,
  groupBy: CustomerInvoiceGroupBy | null,
): Promise<GroupedSummary> {
  const from = sql`${customerInvoiceListFrom()} WHERE ${customerInvoiceListWhere(companyId, filters)}`;
  return runGroupedSummary(from, MEASURES, groupBy === null ? null : DIMENSIONS[groupBy]);
}
