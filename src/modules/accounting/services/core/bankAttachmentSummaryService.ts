/**
 * Totals and groups for `list_documents` `detail: "summary"` / `group_by` over the bank store. The rows come from
 * `bankAttachmentUnion` (the page query's own set), so the counts and sizes describe exactly the documents the list
 * would page through. `file_size` is bytes. A document sits in one group: `store` is its own, `month` is its bank
 * line's transaction month.
 */
import { sql } from '@/lib/neon';
import {
  runGroupedSummary,
  type GroupedSummary,
  type SummaryDimension,
  type SummaryMeasure,
} from '../shared/groupedSummary';
import { bankAttachmentUnion, type AttachmentFilters } from './bankAttachmentQuery';

export const BANK_DOCUMENT_GROUP_BY = ['store', 'month'] as const;
export type BankDocumentGroupBy = (typeof BANK_DOCUMENT_GROUP_BY)[number];

const MEASURES: readonly SummaryMeasure[] = [
  { name: 'count', expr: 'COUNT(*)', kind: 'count' },
  { name: 'file_size', expr: 'COALESCE(SUM(d.file_size), 0)', kind: 'count' },
];

const DIMENSIONS: Record<BankDocumentGroupBy, SummaryDimension> = {
  store: { keyExpr: 'd.store', labelExpr: null, order: 'k' },
  month: { keyExpr: `to_char(bt.transaction_date, 'YYYY-MM')`, labelExpr: null, order: 'k DESC' },
};

export async function summariseBankAttachments(
  companyId: string,
  filters: Pick<AttachmentFilters, 'from' | 'to' | 'bankTransactionId'>,
  groupBy: BankDocumentGroupBy | null,
): Promise<GroupedSummary> {
  const from = sql`
    FROM (${bankAttachmentUnion(companyId, filters)}) d
    JOIN bank_transactions bt ON bt.id = d.bank_transaction_id`;
  return runGroupedSummary(from, MEASURES, groupBy === null ? null : DIMENSIONS[groupBy]);
}
