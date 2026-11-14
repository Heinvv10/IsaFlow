/**
 * Totals per account, month, source or account type for `general_ledger` `group_by`. The lines are the stream's own
 * (matchedLinesFromWhere), so the groups add up to the `totalDebit` / `totalCredit` / `lineCount` the same call reports.
 */
import { sql } from '@/lib/neon';
import {
  runGroupedSummary,
  type GroupedSummary,
  type SummaryDimension,
  type SummaryMeasure,
} from '../shared/groupedSummary';
import { matchedLinesFromWhere } from './generalLedgerMatched';
import type { GeneralLedgerQuery } from './generalLedgerStreamTypes';

export const GENERAL_LEDGER_GROUP_BY = ['account', 'month', 'source', 'account_type'] as const;
export type GeneralLedgerGroupBy = (typeof GENERAL_LEDGER_GROUP_BY)[number];

const MEASURES: readonly SummaryMeasure[] = [
  { name: 'line_count', expr: 'COUNT(*)', kind: 'count' },
  { name: 'total_debit', expr: 'COALESCE(SUM(jl.debit), 0)', kind: 'money' },
  { name: 'total_credit', expr: 'COALESCE(SUM(jl.credit), 0)', kind: 'money' },
];

const DIMENSIONS: Record<GeneralLedgerGroupBy, SummaryDimension> = {
  account: { keyExpr: 'ga.account_code', labelExpr: 'ga.account_name', order: 'k' },
  month: { keyExpr: `to_char(je.entry_date, 'YYYY-MM')`, labelExpr: null, order: 'k' },
  source: { keyExpr: `COALESCE(je.source, 'manual')`, labelExpr: null, order: 'm0 DESC, k' },
  account_type: { keyExpr: 'ga.account_type', labelExpr: null, order: 'k' },
};

export async function summariseGeneralLedger(
  query: Omit<GeneralLedgerQuery, 'limit' | 'after'>,
  groupBy: GeneralLedgerGroupBy,
): Promise<GroupedSummary> {
  const from = sql`${matchedLinesFromWhere(query)}`;
  return runGroupedSummary(from, MEASURES, DIMENSIONS[groupBy]);
}
