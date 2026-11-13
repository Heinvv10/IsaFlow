/**
 * The WHERE predicate of the two getBankTransactions branches the agent path reaches (an optional bank account, a
 * date window, an allocation state, a text search; no tab status). The row page, its COUNT and the MCP
 * `list_bank_transactions` summary all splice THIS fragment, so a summary cannot count a different set from the
 * rows it stands in for. The keyset is NOT part of it: a summary covers the whole set, a page only the rows after
 * its cursor.
 *
 * With `bankAccountId` the text search is not applied (the branch never applied it); without one it is. That is
 * the list's existing behaviour, kept byte for byte, and a summary inherits it.
 */
import { sql } from '@/lib/neon';
import { allocationCond } from './bankTxQueryFragments';
import type { BankTxFilters } from './bankTxFilters';

export function bankTxScopeWhere(companyId: string, filters?: BankTxFilters) {
  const fromDate = filters?.fromDate || '1900-01-01';
  const toDate = filters?.toDate || '2099-12-31';
  const alloc = allocationCond(filters);
  if (filters?.bankAccountId) {
    return sql`bt.bank_account_id = ${filters.bankAccountId}::UUID
          AND bt.company_id = ${companyId}::UUID
          AND bt.feed_state <> 'removed'
          AND bt.transaction_date >= ${fromDate} AND bt.transaction_date <= ${toDate}
          ${sql.unsafe(alloc)}`;
  }
  const statusFilter = filters?.status ?? null;
  // Null-safe search: when no term is given the condition collapses to TRUE,
  // so rows with NULL description AND NULL reference still list (unlike a
  // bare ILIKE '%', which would drop them).
  const searchPattern = filters?.search ? `%${filters.search}%` : null;
  return sql`bt.company_id = ${companyId}::UUID
          AND (${statusFilter}::text IS NULL OR bt.status = ${statusFilter}::text)
          AND bt.feed_state <> 'removed'
          AND (${searchPattern}::text IS NULL OR bt.description ILIKE ${searchPattern} OR bt.reference ILIKE ${searchPattern})
          AND bt.transaction_date >= ${fromDate} AND bt.transaction_date <= ${toDate}
          ${sql.unsafe(alloc)}`;
}
