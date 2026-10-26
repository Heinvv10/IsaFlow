/** The query string of GET /api/accounting/bank-transactions for the page's tab, filters and page. */

import type { BankTxTab } from './BankTxTabs';

export interface BankTxQuery {
  bankAccountId: string; tab: BankTxTab; page: number; pageSize: number;
  fromDate: string; toDate: string; fromAmount: string; toAmount: string; search: string;
  sortOrder: 'desc' | 'asc';
  allocationFilter: 'all' | 'unallocated' | 'suggested' | 'allocated';
  txType: 'all' | 'spent' | 'received';
  allocType: 'all' | 'account' | 'supplier' | 'customer' | 'transfer';
  hasSuggestion: 'all' | 'yes' | 'no';
}

export function tabToStatus(tab: BankTxTab): string {
  if (tab === 'new') return 'imported';
  if (tab === 'excluded') return 'excluded';
  return 'matched';
}

export function bankTxQueryParams(q: BankTxQuery): URLSearchParams {
  const params = new URLSearchParams({ bank_account_id: q.bankAccountId, status: tabToStatus(q.tab), limit: String(q.pageSize), offset: String((q.page - 1) * q.pageSize) });
  if (q.fromDate) params.set('from_date', q.fromDate);
  if (q.toDate) params.set('to_date', q.toDate);
  if (q.fromAmount) params.set('from_amount', q.fromAmount);
  if (q.toAmount) params.set('to_amount', q.toAmount);
  if (q.search) params.set('search', q.search);
  if (q.sortOrder !== 'desc') params.set('sort_order', q.sortOrder);
  if (q.allocationFilter !== 'all') params.set('allocation_filter', q.allocationFilter);
  if (q.txType !== 'all') params.set('tx_type', q.txType);
  if (q.allocType !== 'all') params.set('alloc_type', q.allocType);
  if (q.hasSuggestion !== 'all') params.set('has_suggestion', q.hasSuggestion);
  return params;
}
