/**
 * bankTxUrlState - the bank-transactions page's view as a query string (WP4a): account, tab, page and every filter, so a
 * refresh, Back and a pasted link land on the same list. Pure: parse (untrusted text -> a valid partial view; anything
 * unknown or malformed is dropped, never trusted), serialize (defaults are omitted, so the plain page keeps a clean URL)
 * and merge (the keys we own are replaced, everything else - e.g. `line` of a drawer deep link - is left alone).
 */

import type { BankTxTab } from './BankTxTabs';
import type { AllocationFilter, AllocTypeFilter, HasSuggestionFilter, TxTypeFilter } from './useBankTxFilters';
import type { ReconFilter } from '@/modules/accounting/services/bank/bankTxTabCond';
import { LEDGER_MAX_YEAR, LEDGER_MIN_YEAR } from '@/modules/accounting/services/gl/ledgerDateRange';
import { AMOUNT_BOUND_RE } from '@/modules/accounting/utils/bankAmountBound';

export interface UrlFilters {
  search: string; fromDate: string; toDate: string; fromAmount: string; toAmount: string;
  sortOrder: 'asc' | 'desc'; allocationFilter: AllocationFilter; txType: TxTypeFilter;
  allocType: AllocTypeFilter; hasSuggestion: HasSuggestionFilter; reconFilter: ReconFilter;
  /** Rows per page (WP4b). A view choice, not a filter: Clear and an account switch keep it. */
  pageSize: BankTxPageSize;
}
export interface UrlView { account: string; tab: BankTxTab; page: number; filters: UrlFilters }

/** The page sizes the list offers; the first is the default. */
export const BANK_TX_PAGE_SIZES = [25, 50, 100] as const;
export type BankTxPageSize = typeof BANK_TX_PAGE_SIZES[number];

export const DEFAULT_FILTERS: UrlFilters = {
  search: '', fromDate: '', toDate: '', fromAmount: '', toAmount: '', sortOrder: 'desc',
  allocationFilter: 'all', txType: 'all', allocType: 'all', hasSuggestion: 'all', reconFilter: 'all', pageSize: 25,
};

/** The query keys this page owns (account_id is the existing deep-link name used by other pages' links). */
export const URL_KEYS = ['account_id', 'tab', 'page', 'q', 'from', 'to', 'min', 'max', 'sort', 'alloc', 'type', 'cat', 'sugg', 'recon', 'size'] as const;

const TABS: readonly BankTxTab[] = ['new', 'reviewed', 'excluded', 'provisional'];
const ALLOC: readonly AllocationFilter[] = ['unallocated', 'suggested', 'allocated'];
const TYPES: readonly TxTypeFilter[] = ['spent', 'received'];
const CATS: readonly AllocTypeFilter[] = ['account', 'supplier', 'customer', 'transfer'];
const SUGG: readonly HasSuggestionFilter[] = ['yes', 'no'];
const RECON: readonly ReconFilter[] = ['unreconciled', 'reconciled'];
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_SEARCH = 200;

type Query = Record<string, string | string[] | undefined>;
const one = (v: string | string[] | undefined): string | undefined => (typeof v === 'string' ? v : undefined);
const pick = <T extends string>(v: string | undefined, allowed: readonly T[]): T | undefined => allowed.find(a => a === v);
/** A real calendar date, checked by the calendar itself (a Date would read 2026-02-31 as March 3rd, and the API then answers 500). */
const date = (v: string | undefined): string | undefined => {
  if (!v || !ISO_DATE.test(v)) return undefined;
  const [y, m, d] = v.split('-').map(Number) as [number, number, number];
  if (y < LEDGER_MIN_YEAR || y > LEDGER_MAX_YEAR) return undefined; // the ledger's own window: Postgres refuses year 0000
  const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1];
  return days !== undefined && d >= 1 && d <= days ? v : undefined;
};
const amount = (v: string | undefined): string | undefined => (v && AMOUNT_BOUND_RE.test(v.trim()) ? v.trim() : undefined);

/** What the query says. Absent or invalid keys are simply missing from the result (the caller keeps its defaults). */
export function parseUrlView(query: Query): { account?: string; tab?: BankTxTab; page?: number; filters: Partial<UrlFilters> } {
  const page = Number(one(query.page));
  const q = one(query.q)?.trim(); // a search of only spaces is no search
  const filters: Partial<UrlFilters> = {};
  if (q) filters.search = q.slice(0, MAX_SEARCH);
  const set = <K extends keyof UrlFilters>(k: K, v: UrlFilters[K] | undefined) => { if (v !== undefined) filters[k] = v; };
  set('fromDate', date(one(query.from))); set('toDate', date(one(query.to)));
  set('fromAmount', amount(one(query.min))); set('toAmount', amount(one(query.max)));
  set('sortOrder', one(query.sort) === 'asc' ? 'asc' : undefined);
  set('allocationFilter', pick(one(query.alloc), ALLOC)); set('txType', pick(one(query.type), TYPES));
  set('allocType', pick(one(query.cat), CATS)); set('hasSuggestion', pick(one(query.sugg), SUGG));
  set('reconFilter', pick(one(query.recon), RECON));
  set('pageSize', BANK_TX_PAGE_SIZES.slice(1).find(n => String(n) === one(query.size)));
  // A range typed the wrong way round (min above max, from after to) is read the right way round, not as an empty list.
  if (filters.fromAmount !== undefined && filters.toAmount !== undefined && Number(filters.fromAmount) > Number(filters.toAmount)) {
    [filters.fromAmount, filters.toAmount] = [filters.toAmount, filters.fromAmount];
  }
  if (filters.fromDate !== undefined && filters.toDate !== undefined && filters.fromDate > filters.toDate) {
    [filters.fromDate, filters.toDate] = [filters.toDate, filters.fromDate];
  }
  return {
    account: one(query.account_id) || undefined,
    tab: pick(one(query.tab), TABS),
    page: Number.isInteger(page) && page >= 1 && page <= 100_000 ? page : undefined,
    filters,
  };
}

/** The query for a view: only what differs from the plain page. */
export function serializeUrlView(v: UrlView): Record<string, string> {
  const out: Record<string, string> = {};
  const d = DEFAULT_FILTERS, f = v.filters;
  if (v.account) out.account_id = v.account;
  if (v.tab !== 'new') out.tab = v.tab;
  if (v.page > 1) out.page = String(v.page);
  if (f.search.trim()) out.q = f.search.trim();
  if (f.fromDate) out.from = f.fromDate;
  if (f.toDate) out.to = f.toDate;
  if (f.fromAmount) out.min = f.fromAmount;
  if (f.toAmount) out.max = f.toAmount;
  if (f.sortOrder !== d.sortOrder) out.sort = f.sortOrder;
  if (f.allocationFilter !== d.allocationFilter) out.alloc = f.allocationFilter;
  if (f.txType !== d.txType) out.type = f.txType;
  if (f.allocType !== d.allocType) out.cat = f.allocType;
  if (f.hasSuggestion !== d.hasSuggestion) out.sugg = f.hasSuggestion;
  if (f.reconFilter !== d.reconFilter) out.recon = f.reconFilter;
  if (f.pageSize !== d.pageSize) out.size = String(f.pageSize);
  return out;
}

/** The part of a query this page owns, in a stable order (equal views compare equal as strings). */
export function ownedQueryKey(query: Query): string {
  return URL_KEYS.map(k => [k, one(query[k])] as const).filter(([, v]) => v !== undefined && v !== '').map(([k, v]) => `${k}=${v}`).join('&');
}

/** `query` with our keys replaced by `owned` and every other key kept. */
export function mergeOwnedQuery(query: Query, owned: Record<string, string>): Query {
  const rest: Query = {};
  for (const [k, v] of Object.entries(query)) if (!(URL_KEYS as readonly string[]).includes(k)) rest[k] = v;
  return { ...rest, ...owned };
}
