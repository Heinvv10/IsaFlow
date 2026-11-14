/**
 * Totals per account, month, source or status for `export_gl_lines` `group_by` (table "lines"). The lines are the
 * export's own (glLineExportScope), so the groups add up to the window's `rowCount` and Σ Amount_Excl_VAT.
 */
import { sql } from '@/lib/neon';
import {
  runGroupedSummary,
  type GroupedSummary,
  type SummaryDimension,
  type SummaryMeasure,
} from '../shared/groupedSummary';
import { glLineExportScope, type GlLineExportOptions } from './glLineExportService';

export const GL_EXPORT_GROUP_BY = ['account', 'month', 'source', 'status'] as const;
export type GlExportGroupBy = (typeof GL_EXPORT_GROUP_BY)[number];

const MEASURES: readonly SummaryMeasure[] = [
  { name: 'line_count', expr: 'COUNT(*)', kind: 'count' },
  { name: 'total_debit', expr: 'COALESCE(SUM(x.debit), 0)', kind: 'money' },
  { name: 'total_credit', expr: 'COALESCE(SUM(x.credit), 0)', kind: 'money' },
  { name: 'net', expr: 'COALESCE(SUM(x.debit - x.credit), 0)', kind: 'money' },
];

const DIMENSIONS: Record<GlExportGroupBy, SummaryDimension> = {
  account: { keyExpr: 'ga.account_code', labelExpr: 'ga.account_name', order: 'k' },
  month: { keyExpr: `to_char(x.entry_date, 'YYYY-MM')`, labelExpr: null, order: 'k' },
  source: { keyExpr: `COALESCE(x.source, '')`, labelExpr: null, order: 'm0 DESC, k' },
  status: { keyExpr: 'x.status', labelExpr: null, order: 'k' },
};

export async function summariseGlLineExport(
  companyId: string,
  opts: GlLineExportOptions,
  groupBy: GlExportGroupBy,
): Promise<GroupedSummary> {
  const from = sql`
    FROM (
      SELECT jl.gl_account_id, jl.debit, jl.credit, je.entry_date, je.status, je.source
      ${glLineExportScope(companyId, opts)}
    ) x
    LEFT JOIN gl_accounts ga ON ga.id = x.gl_account_id AND ga.company_id = ${companyId}::UUID`;
  return runGroupedSummary(from, MEASURES, DIMENSIONS[groupBy]);
}
