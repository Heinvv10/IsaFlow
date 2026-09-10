/**
 * PRD-060: FibreFlow Accounting Module — Phase 4
 * Bank Transaction Query Service — queries and status mutations.
 *
 * Row mappers live in ./bankTxRowMapper, static SQL fragments in
 * ./bankTxQueryFragments, the keyset cursor in ./bankTxCursor. Both mappers are
 * re-exported here: several callers import them from this module.
 */

import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { log } from '@/lib/logger';
import type { BankTransaction } from '../../types/bank.types';
import { fmtDate, mapTxRow } from './bankTxRowMapper';
import { TX_SELECT, allocationCond } from './bankTxQueryFragments';
import {
  decodeBankTxCursor,
  encodeBankTxCursor,
  bankTxKeysetCond,
  InvalidCursorError,
} from './bankTxCursor';
import type { BankTxFilters } from './bankTxFilters';

type Row = DbRow;

export { fmtDate, mapTxRow };
export type { BankTxFilters };

export interface BankTxPage {
  transactions: BankTransaction[];
  total: number;
  /** Opaque cursor for the next page; absent on the last page. */
  nextCursor?: string;
}

// ── Query ─────────────────────────────────────────────────────────────────────

export async function getBankTransactions(
  companyId: string,
  filters?: BankTxFilters
): Promise<BankTxPage> {
  // Decoding happens BEFORE any query: a malformed cursor is a caller error,
  // not a database one. Throws InvalidCursorError.
  const cursor = filters?.cursor ? decodeBankTxCursor(filters.cursor) : undefined;
  // Cursor and offset are mutually exclusive. Combined they compose — the keyset
  // narrows, THEN the offset skips inside what is left — which silently drops
  // `offset` rows from every page after the first. Refusing is the only honest
  // answer: there is no reading of "page 3 of the rows after this cursor" that a
  // caller passing both actually wants.
  if (cursor && typeof filters?.offset === 'number' && filters.offset > 0) {
    throw new InvalidCursorError('cursor and offset cannot be combined');
  }
  try {
    // BL-11: Cap list limit at 100. Export paths have their own dedicated endpoints.
    // Sanitise: NaN / negative values from query-string coercion become safe defaults.
    const rawLimit = filters?.limit;
    const rawOffset = filters?.offset;
    const limit = typeof rawLimit === 'number' && Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 100) : 50;
    const offset = typeof rawOffset === 'number' && Number.isFinite(rawOffset) && rawOffset >= 0 ? rawOffset : 0;
    // `LIMIT $n::INT + 1` fetches one row past the page so a next page can be
    // detected without a second count; the probe row is trimmed before return.
    let rows: Row[];
    let countRows: Row[];

    if (filters?.reconciliationId) {
      // BL-81: must scope by company_id to prevent cross-tenant data reads
      const keyset = bankTxKeysetCond(cursor, 'DESC');
      rows = (await sql`${sql.unsafe(TX_SELECT)}
        WHERE bt.reconciliation_id = ${filters.reconciliationId}::UUID
          AND bt.company_id = ${companyId}::UUID
          ${keyset}
        ORDER BY bt.transaction_date DESC, bt.amount DESC, bt.id DESC
        LIMIT ${limit}::INT + 1 OFFSET ${offset}`) as Row[];
      countRows = (await sql`SELECT COUNT(*) AS cnt FROM bank_transactions
        WHERE reconciliation_id = ${filters.reconciliationId}::UUID
          AND company_id = ${companyId}::UUID`) as Row[];
    } else if (filters?.bankAccountId && filters?.status) {
      const searchPattern = filters.search ? `%${filters.search}%` : '%';
      const fromDate = filters.fromDate || '1900-01-01';
      const toDate = filters.toDate || '2099-12-31';
      const fromAmt = filters.fromAmount || '-999999999';
      const toAmt = filters.toAmount || '999999999';
      // For "New Transactions" tab always include both imported + allocated statuses
      const statusArr = filters.status === 'imported'
        ? ['imported', 'allocated']
        : [filters.status];
      // SAFETY INVARIANT: all condition strings below are built from fixed string
      // literals keyed on validated enum values — no user input is interpolated
      // directly. The final `extra` fragment is therefore safe.
      const txTypeCond = filters.txType === 'spent' ? 'AND bt.amount < 0'
        : filters.txType === 'received' ? 'AND bt.amount > 0' : '';
      const validAllocTypes = ['account', 'supplier', 'customer', 'transfer'] as const;
      const safeAllocType = filters.allocType && validAllocTypes.includes(filters.allocType as typeof validAllocTypes[number])
        ? filters.allocType : null;
      const allocTypeCond = safeAllocType ? `AND bt.allocation_type = '${safeAllocType}'` : '';
      const hasSuggCond = filters.hasSuggestion === 'yes'
        ? 'AND (bt.suggested_gl_account_id IS NOT NULL OR bt.suggested_supplier_id IS NOT NULL OR bt.suggested_client_id IS NOT NULL)'
        : filters.hasSuggestion === 'no'
          ? 'AND bt.suggested_gl_account_id IS NULL AND bt.suggested_supplier_id IS NULL AND bt.suggested_client_id IS NULL'
          : '';
      // sortDir is strictly validated — only 'ASC' or 'DESC' are possible
      const sortDir = filters.sortOrder === 'asc' ? 'ASC' : 'DESC';
      if (sortDir !== 'ASC' && sortDir !== 'DESC') throw new Error('Invalid sort direction');
      const extra = [txTypeCond, allocTypeCond, hasSuggCond, allocationCond(filters)].filter(Boolean).join(' ');
      // The keyset must track sortDir — the date leg flips with the ORDER BY.
      const keyset = bankTxKeysetCond(cursor, sortDir);
      rows = (await sql`${sql.unsafe(TX_SELECT)}
        WHERE bt.bank_account_id = ${filters.bankAccountId}::UUID
          AND bt.company_id = ${companyId}::UUID
          AND bt.status = ANY(${statusArr}::TEXT[])
          AND bt.transaction_date >= ${fromDate} AND bt.transaction_date <= ${toDate}
          AND bt.amount >= ${fromAmt}::NUMERIC AND bt.amount <= ${toAmt}::NUMERIC
          AND (bt.description ILIKE ${searchPattern} OR bt.reference ILIKE ${searchPattern})
          ${sql.unsafe(extra)}
          ${keyset}
        ORDER BY bt.transaction_date ${sql.unsafe(sortDir)}, bt.amount DESC, bt.id DESC
        LIMIT ${limit}::INT + 1 OFFSET ${offset}`) as Row[];
      countRows = (await sql`SELECT COUNT(*) AS cnt FROM bank_transactions bt
        WHERE bt.bank_account_id = ${filters.bankAccountId}::UUID
          AND bt.company_id = ${companyId}::UUID
          AND bt.status = ANY(${statusArr}::TEXT[])
          AND bt.transaction_date >= ${fromDate} AND bt.transaction_date <= ${toDate}
          AND bt.amount >= ${fromAmt}::NUMERIC AND bt.amount <= ${toAmt}::NUMERIC
          AND (bt.description ILIKE ${searchPattern} OR bt.reference ILIKE ${searchPattern})
          ${sql.unsafe(extra)}`) as Row[];
    } else if (filters?.bankAccountId) {
      const fromDate = filters.fromDate || '1900-01-01';
      const toDate = filters.toDate || '2099-12-31';
      const alloc = allocationCond(filters);
      const keyset = bankTxKeysetCond(cursor, 'DESC');
      rows = (await sql`${sql.unsafe(TX_SELECT)}
        WHERE bt.bank_account_id = ${filters.bankAccountId}::UUID
          AND bt.company_id = ${companyId}::UUID
          AND bt.transaction_date >= ${fromDate} AND bt.transaction_date <= ${toDate}
          ${sql.unsafe(alloc)}
          ${keyset}
        ORDER BY bt.transaction_date DESC, bt.amount DESC, bt.id DESC
        LIMIT ${limit}::INT + 1 OFFSET ${offset}`) as Row[];
      countRows = (await sql`SELECT COUNT(*) AS cnt FROM bank_transactions bt
        WHERE bt.bank_account_id = ${filters.bankAccountId}::UUID
          AND bt.company_id = ${companyId}::UUID
          AND bt.transaction_date >= ${fromDate} AND bt.transaction_date <= ${toDate}
          ${sql.unsafe(alloc)}`) as Row[];
    } else {
      const statusFilter = filters?.status ?? null;
      // Null-safe search: when no term is given the condition collapses to TRUE,
      // so rows with NULL description AND NULL reference still list (unlike a
      // bare ILIKE '%', which would drop them).
      const searchPattern = filters?.search ? `%${filters.search}%` : null;
      const fromDate = filters?.fromDate || '1900-01-01';
      const toDate = filters?.toDate || '2099-12-31';
      const alloc = allocationCond(filters);
      const keyset = bankTxKeysetCond(cursor, 'DESC');
      rows = (await sql`${sql.unsafe(TX_SELECT)}
        WHERE bt.company_id = ${companyId}::UUID
          AND (${statusFilter}::text IS NULL OR bt.status = ${statusFilter}::text)
          AND (${searchPattern}::text IS NULL OR bt.description ILIKE ${searchPattern} OR bt.reference ILIKE ${searchPattern})
          AND bt.transaction_date >= ${fromDate} AND bt.transaction_date <= ${toDate}
          ${sql.unsafe(alloc)}
          ${keyset}
        ORDER BY bt.transaction_date DESC, bt.amount DESC, bt.id DESC
        LIMIT ${limit}::INT + 1 OFFSET ${offset}`) as Row[];
      countRows = (await sql`SELECT COUNT(*) AS cnt FROM bank_transactions bt
        WHERE bt.company_id = ${companyId}::UUID
          AND (${statusFilter}::text IS NULL OR bt.status = ${statusFilter}::text)
          AND (${searchPattern}::text IS NULL OR bt.description ILIKE ${searchPattern} OR bt.reference ILIKE ${searchPattern})
          AND bt.transaction_date >= ${fromDate} AND bt.transaction_date <= ${toDate}
          ${sql.unsafe(alloc)}`) as Row[];
    }

    const hasMore = rows.length > limit;
    const pageRows = hasMore ? rows.slice(0, limit) : rows;
    const transactions = pageRows.map(mapTxRow);
    const last = transactions[transactions.length - 1];
    const nextCursor = hasMore && last
      ? encodeBankTxCursor({ d: last.transactionDate, a: last.amount, id: last.id })
      : undefined;
    return { transactions, total: Number(countRows[0]!.cnt), ...(nextCursor ? { nextCursor } : {}) };
  } catch (err) {
    log.error('Failed to get bank transactions', { error: err }, 'accounting');
    throw err;
  }
}

// ── Status Mutations ──────────────────────────────────────────────────────────
//
// match / unmatch / exclude live in ./bankTxStatusMutations — they take the row
// lock and refuse on an already-posted row, and the guard pushed this file past
// the 300-line limit. Re-exported because every caller imports them from here.

export {
  matchTransaction,
  unmatchTransaction,
  excludeTransaction,
  BankTransactionAllocatedError,
} from './bankTxStatusMutations';

/** Delete bank transactions — only imported (unallocated) transactions can be deleted. */
export async function deleteTransactions(companyId: string, bankTxIds: string[]): Promise<number> {
  if (bankTxIds.length === 0) return 0;
  try {
    const result = (await sql`
      DELETE FROM bank_transactions
      WHERE id = ANY(${bankTxIds}::UUID[]) AND status = 'imported'
        AND company_id = ${companyId}::UUID
      RETURNING id`) as Row[];
    // RETURNING is required for an accurate count: lib/neon only ever exposes
    // res.rows, never res.rowCount, so a DELETE without it returns [] and the
    // count was always 0 (`0 ?? fallback` short-circuits on 0, not just null).
    // Callers report this number to a user — bank-transactions-action.ts and
    // undo_bank_import both do.
    const deleted = result.length;
    log.info('Deleted bank transactions', { count: deleted, ids: bankTxIds }, 'accounting');
    return deleted;
  } catch (err) {
    log.error('Failed to delete bank transactions', { bankTxIds, error: err }, 'accounting');
    throw err;
  }
}

/** Mark a batch of imported/allocated transactions as matched without creating journal entries. */
export async function bulkAcceptTransactions(companyId: string, ids: string[]): Promise<number> {
  if (ids.length === 0) return 0;
  try {
    const result = (await sql`
      UPDATE bank_transactions SET status = 'matched', updated_at = NOW()
      WHERE id = ANY(${ids}::UUID[]) AND status IN ('imported', 'allocated')
        AND company_id = ${companyId}::UUID
      RETURNING id`) as Row[];
    // Same reason as deleteTransactions above: without RETURNING this resolved
    // to [], `.count` was always undefined and the fallback reported ids.length
    // — success for every id the operator sent, including ones the status
    // predicate never matched.
    const count = result.length;
    log.info('Bulk accepted bank transactions', { count, ids }, 'accounting');
    return count;
  } catch (err) {
    log.error('Failed to bulk accept bank transactions', { ids, error: err }, 'accounting');
    throw err;
  }
}
