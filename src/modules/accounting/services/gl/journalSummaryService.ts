/**
 * Totals and groups for `list_journals` `detail: "summary"` / `group_by`. The predicate is the list's own
 * (journalListWhere, minus its keyset), so the counts describe every journal the cursor walk would serve.
 *
 * `count` is journals, `total_debit` the sum of their line debits (what each row calls `amount`). A journal sits in
 * exactly one group, so the distinct counts add up. `status` groups are draft | posted | reversed: a reversed journal
 * is counted under `reversed`, not `posted` (its status never flips; reversed_at is the signal).
 */
import { sql } from '@/lib/neon';
import {
  runGroupedSummary,
  type GroupedSummary,
  type SummaryDimension,
  type SummaryMeasure,
} from '../shared/groupedSummary';
import { journalListWhere, type JournalListFilters } from './journalEntryListService';

export const JOURNAL_GROUP_BY = ['source', 'month', 'status'] as const;
export type JournalGroupBy = (typeof JOURNAL_GROUP_BY)[number];

const MEASURES: readonly SummaryMeasure[] = [
  { name: 'count', expr: 'COUNT(DISTINCT je.id)', kind: 'count' },
  { name: 'total_debit', expr: 'COALESCE(SUM(jl.debit), 0)', kind: 'money' },
];

const DIMENSIONS: Record<JournalGroupBy, SummaryDimension> = {
  source: { keyExpr: `COALESCE(je.source, '')`, labelExpr: null, order: 'm0 DESC, k' },
  month: { keyExpr: `to_char(je.entry_date, 'YYYY-MM')`, labelExpr: null, order: 'k DESC' },
  status: {
    keyExpr: `CASE WHEN je.reversed_at IS NOT NULL THEN 'reversed' ELSE je.status END`,
    labelExpr: null,
    order: 'k',
  },
};

export async function summariseJournals(
  companyId: string,
  filters: JournalListFilters,
  groupBy: JournalGroupBy | null,
): Promise<GroupedSummary> {
  const from = sql`
    FROM gl_journal_entries je
    LEFT JOIN gl_journal_lines jl
      ON jl.journal_entry_id = je.id AND jl.company_id = ${companyId}::UUID
    WHERE ${journalListWhere(companyId, filters)}`;
  return runGroupedSummary(from, MEASURES, groupBy === null ? null : DIMENSIONS[groupBy]);
}
