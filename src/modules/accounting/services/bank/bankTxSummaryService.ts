/**
 * Totals and groups for `list_bank_transactions` `detail: "summary"` / `group_by`. The FROM and WHERE are the
 * list's own (./bankTxScopeWhere), so the counts and sums describe exactly the rows the list would page through.
 *
 * `allocation` groups are the line buckets (./bankLineBucket LINE_BUCKET_SQL; the tool's compact rows use its mirror
 * lineBucketOf, and allocation_filter selects one bucket): pending, excluded, allocated, suggested, unallocated —
 * the bank card's definition (WP1, 2026-11-15).
 */
import { sql } from '@/lib/neon';
import {
  runGroupedSummary,
  type GroupedSummary,
  type SummaryDimension,
  type SummaryMeasure,
} from '../shared/groupedSummary';
import type { BankTxFilters } from './bankTxFilters';
import { LINE_BUCKET_SQL } from './bankLineBucket';
import { bankTxScopeWhere } from './bankTxScopeWhere';

export const BANK_TX_GROUP_BY = ['account', 'month', 'allocation'] as const;
export type BankTxGroupBy = (typeof BANK_TX_GROUP_BY)[number];

const MEASURES: readonly SummaryMeasure[] = [
  { name: 'count', expr: 'COUNT(*)', kind: 'count' },
  { name: 'money_in', expr: 'COALESCE(SUM(bt.amount) FILTER (WHERE bt.amount > 0), 0)', kind: 'money' },
  { name: 'money_out', expr: 'COALESCE(SUM(bt.amount) FILTER (WHERE bt.amount < 0), 0)', kind: 'money' },
  { name: 'net', expr: 'COALESCE(SUM(bt.amount), 0)', kind: 'money' },
];

const DIMENSIONS: Record<BankTxGroupBy, SummaryDimension> = {
  account: {
    keyExpr: 'bt.bank_account_id::text',
    labelExpr: 'ga.account_name',
    order: 'm0 DESC, k',
  },
  month: {
    keyExpr: `to_char(bt.transaction_date, 'YYYY-MM')`,
    labelExpr: null,
    order: 'k DESC',
  },
  allocation: {
    keyExpr: LINE_BUCKET_SQL,
    labelExpr: null,
    order: 'k',
  },
};

export async function summariseBankTransactions(
  companyId: string,
  filters: BankTxFilters,
  groupBy: BankTxGroupBy | null,
): Promise<GroupedSummary> {
  const from = sql`
    FROM bank_transactions bt
    LEFT JOIN gl_accounts ga ON ga.id = bt.bank_account_id AND ga.company_id = bt.company_id
    WHERE ${bankTxScopeWhere(companyId, filters)}`;
  return runGroupedSummary(from, MEASURES, groupBy === null ? null : DIMENSIONS[groupBy]);
}
