/**
 * Filter contract for getBankTransactions. Lives in its own module so the SQL
 * fragment helpers can depend on it without importing the service (and so the
 * service file stays under the 300-line limit).
 */
export interface BankTxFilters {
  bankAccountId?: string;
  reconciliationId?: string;
  status?: string;
  fromDate?: string;
  toDate?: string;
  fromAmount?: string;
  toAmount?: string;
  search?: string;
  sortOrder?: 'asc' | 'desc';
  allocationFilter?: 'all' | 'unallocated' | 'suggested' | 'allocated';
  txType?: 'all' | 'spent' | 'received';
  allocType?: 'all' | 'account' | 'supplier' | 'customer' | 'transfer';
  hasSuggestion?: 'all' | 'yes' | 'no';
  limit?: number;
  /** UI paging. The MCP/agent path uses `cursor` instead — an offset page over
   *  a live import double-reads rows. */
  offset?: number;
  /** Opaque keyset cursor from a prior page's `nextCursor` (PRD-11 §3). */
  cursor?: string;
}
