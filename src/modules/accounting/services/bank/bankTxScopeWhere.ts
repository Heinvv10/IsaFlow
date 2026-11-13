/**
 * The WHERE predicate of the two getBankTransactions branches the agent path reaches (an optional bank account, a
 * date window, an allocation state, a text search; no tab status). The row page, its COUNT and the MCP
 * `list_bank_transactions` summary all splice THIS fragment, so a summary cannot count a different set from the
 * rows it stands in for. The keyset is NOT part of it: a summary covers the whole set, a page only the rows after
 * its cursor.
 *
 * Both branches apply the text search null-safely (no term collapses to TRUE, so lines with a NULL description AND
 * reference still list). The account branch ignored it until #1341 (MCP description_contains, 2026-11-13).
 */
import { sql } from '@/lib/neon';
import { allocationCond } from './bankTxQueryFragments';
import type { BankTxFilters } from './bankTxFilters';

export function bankTxScopeWhere(companyId: string, filters?: BankTxFilters) {
  const fromDate = filters?.fromDate || '1900-01-01';
  const toDate = filters?.toDate || '2099-12-31';
  const alloc = allocationCond(filters);
  const searchPattern = filters?.search ? `%${filters.search}%` : null;
  if (filters?.bankAccountId) {
    return sql`bt.bank_account_id = ${filters.bankAccountId}::UUID
          AND bt.company_id = ${companyId}::UUID
          AND bt.feed_state <> 'removed'
          AND bt.transaction_date >= ${fromDate} AND bt.transaction_date <= ${toDate}
          AND (${searchPattern}::text IS NULL OR bt.description ILIKE ${searchPattern} OR bt.reference ILIKE ${searchPattern})
          ${sql.unsafe(alloc)}`;
  }
  const statusFilter = filters?.status ?? null;
  return sql`bt.company_id = ${companyId}::UUID
          AND (${statusFilter}::text IS NULL OR bt.status = ${statusFilter}::text)
          AND bt.feed_state <> 'removed'
          AND (${searchPattern}::text IS NULL OR bt.description ILIKE ${searchPattern} OR bt.reference ILIKE ${searchPattern})
          AND bt.transaction_date >= ${fromDate} AND bt.transaction_date <= ${toDate}
          ${sql.unsafe(alloc)}`;
}
