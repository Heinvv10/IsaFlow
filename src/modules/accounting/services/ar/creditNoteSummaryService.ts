/**
 * Totals and groups for `list_credit_notes` `detail: "summary"` / `group_by`. The WHERE is the list's own
 * (`creditNoteListWhere`), so the counts and sums describe exactly the notes the list would page through.
 * `party` is the customer of a customer note and the supplier of a supplier note (a note carries one of the two).
 */
import { sql } from '@/lib/neon';
import {
  runGroupedSummary,
  type GroupedSummary,
  type SummaryDimension,
  type SummaryMeasure,
} from '../shared/groupedSummary';
import { creditNoteListWhere, type CreditNoteListScope } from './creditNoteListQuery';

export const CREDIT_NOTE_GROUP_BY = ['status', 'type', 'party', 'month'] as const;
export type CreditNoteGroupBy = (typeof CREDIT_NOTE_GROUP_BY)[number];

const MEASURES: readonly SummaryMeasure[] = [
  { name: 'count', expr: 'COUNT(*)', kind: 'count' },
  { name: 'total_amount', expr: 'COALESCE(SUM(cn.total_amount), 0)', kind: 'money' },
  { name: 'tax_amount', expr: 'COALESCE(SUM(cn.tax_amount), 0)', kind: 'money' },
  { name: 'applied_amount', expr: 'COALESCE(SUM(cn.applied_amount), 0)', kind: 'money' },
];

const DIMENSIONS: Record<CreditNoteGroupBy, SummaryDimension> = {
  status: { keyExpr: 'cn.status', labelExpr: null, order: 'k' },
  type: { keyExpr: 'cn.type', labelExpr: null, order: 'k' },
  party: {
    keyExpr: 'COALESCE(cn.client_id, cn.supplier_id)::text',
    labelExpr: 'COALESCE(c.name, s.company_name, s.name)',
    order: 'm1 DESC, k',
  },
  month: { keyExpr: `to_char(cn.credit_date, 'YYYY-MM')`, labelExpr: null, order: 'k DESC' },
};

export async function summariseCreditNotes(
  companyId: string,
  filters: CreditNoteListScope,
  groupBy: CreditNoteGroupBy | null,
): Promise<GroupedSummary> {
  const from = sql`
    FROM credit_notes cn
    LEFT JOIN customers c ON c.id = cn.client_id AND c.company_id = cn.company_id
    LEFT JOIN suppliers s ON s.id = cn.supplier_id AND s.company_id = cn.company_id
    WHERE ${creditNoteListWhere(companyId, filters)}`;
  return runGroupedSummary(from, MEASURES, groupBy === null ? null : DIMENSIONS[groupBy]);
}
