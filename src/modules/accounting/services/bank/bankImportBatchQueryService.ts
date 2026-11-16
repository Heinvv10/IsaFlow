/**
 * Read side of `bank_import_batches` — the audit trail of every statement
 * import (mig 253 table, 442/446 columns). One batch = one statement file;
 * its `bank_transactions` rows carry `import_batch_id`, and `undoImportBatch`
 * deletes those that are still unallocated.
 *
 * `transactions_remaining` is counted live rather than read from the batch
 * row's `transaction_count`: the latter is what the import WROTE, and an undo
 * or a manual delete leaves it unchanged, so the two diverge exactly when an
 * agent most needs to know.
 *
 * `order: 'statement_date'` (the statement widget) puts the newest STATEMENT first, so re-importing an older month
 * does not displace the latest one; the default, `created_at`, is the import log the MCP tool lists.
 *
 * Tenant scope: `company_id` on the batch AND on the counted transactions —
 * `bank_account_id` here is a bare UUID (mig 446 dropped the FK), so it is a
 * filter, never a fence.
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { fmtDate } from '@/lib/fmtDate';
import type { BalanceSource } from '../../types/bank.types';
import { statementSourceLabel } from './bankStatementBalances';

export interface ImportBatchSummary {
  id: string;
  bankAccountId: string;
  statementDate: string | null;
  bankFormat: string | null;
  openingBalance: number | null;
  closingBalance: number | null;
  /** Where the balances came from, or why there are none (998); null for a batch imported before it. */
  balanceSource: BalanceSource | null;
  /** upload / mcp / extension / classified / statement_ocr (877); null on a legacy batch. */
  importChannel: string | null;
  /** The format chip's text (statementSourceLabel). */
  sourceLabel: string;
  /** Rows the import wrote at the time. */
  transactionCount: number;
  /** Rows still linked to the batch now (undo removes unallocated ones). */
  transactionsRemaining: number;
  /** Of the remaining rows, how many carry a posted journal line. */
  transactionsAllocated: number;
  sourceFilename: string | null;
  importedBy: string | null;
  bulkImportId: string | null;
  createdAt: string;
}

export interface ImportBatchFilters {
  bankAccountId?: string;
  limit?: number;
  /** Newest import first (default) or newest statement first (statement_date, then import time). */
  order?: 'created_at' | 'statement_date';
}

const MAX_LIMIT = 100;

function numOrNull(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function mapRow(r: DbRow): ImportBatchSummary {
  return {
    id: String(r.id),
    bankAccountId: String(r.bank_account_id),
    statementDate: r.statement_date ? fmtDate(r.statement_date) : null,
    bankFormat: r.bank_format ? String(r.bank_format) : null,
    openingBalance: numOrNull(r.opening_balance),
    closingBalance: numOrNull(r.closing_balance),
    balanceSource: r.balance_source ? (String(r.balance_source) as BalanceSource) : null,
    importChannel: r.import_channel ? String(r.import_channel) : null,
    sourceLabel: statementSourceLabel(r.bank_format ? String(r.bank_format) : null, r.import_channel ? String(r.import_channel) : null),
    transactionCount: Number(r.transaction_count ?? 0),
    transactionsRemaining: Number(r.transactions_remaining ?? 0),
    transactionsAllocated: Number(r.transactions_allocated ?? 0),
    sourceFilename: r.source_filename ? String(r.source_filename) : null,
    importedBy: r.imported_by ? String(r.imported_by) : null,
    bulkImportId: r.bulk_import_id ? String(r.bulk_import_id) : null,
    createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
  };
}

/** Newest first (see `order`). `bankAccountId` narrows; omit it for every account. */
export async function listImportBatches(
  companyId: string,
  filters: ImportBatchFilters = {},
): Promise<ImportBatchSummary[]> {
  const raw = filters.limit;
  const limit = typeof raw === 'number' && Number.isFinite(raw) && raw > 0
    ? Math.min(Math.floor(raw), MAX_LIMIT)
    : 20;
  const bankAccountId = filters.bankAccountId ?? null;
  const byStatementDate = filters.order === 'statement_date';

  const rows = (await sql`
    SELECT b.id, b.bank_account_id, b.statement_date, b.bank_format,
           b.opening_balance, b.closing_balance, b.balance_source, b.import_channel, b.transaction_count,
           b.source_filename, b.imported_by, b.bulk_import_id, b.created_at,
           COUNT(bt.id) AS transactions_remaining,
           COUNT(bt.matched_journal_line_id) AS transactions_allocated
    FROM bank_import_batches b
    LEFT JOIN bank_transactions bt
      ON bt.import_batch_id = b.id AND bt.company_id = ${companyId}::UUID
      AND bt.feed_state <> 'removed'
    WHERE b.company_id = ${companyId}::UUID
      AND (${bankAccountId}::UUID IS NULL OR b.bank_account_id = ${bankAccountId}::UUID)
    GROUP BY b.id
    ORDER BY CASE WHEN ${byStatementDate}::BOOLEAN THEN b.statement_date END DESC NULLS LAST,
             b.created_at DESC, b.id DESC
    LIMIT ${limit}::INT
  `) as DbRow[];

  return rows.map(mapRow);
}
