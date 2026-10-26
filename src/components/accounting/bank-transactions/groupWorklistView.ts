/**
 * groupWorklistView — what a bank sub-account group's worklist shows: search,
 * one filter chip, and a sort. Pure, so the order a bookkeeper works through
 * 45 paycards in is unit-tested rather than read off a screenshot.
 *
 * "Needs attention" first: most unallocated transactions, then the account
 * whose statements are oldest (never imported first), then name.
 */

import type { BankAcct } from './BankTxBankCards';

export type WorklistSort = 'attention' | 'name' | 'balance';
export type WorklistFilter = 'all' | 'open' | 'stale' | 'none';

/** An account is stale when its last imported transaction is more than this many days old. */
export const STALE_DAYS = 7;

export interface WorklistQuery {
  search: string;
  filter: WorklistFilter;
  sort: WorklistSort;
  /** YYYY-MM-DD, the day staleness is measured from. */
  today: string;
}

export interface WorklistView {
  rows: BankAcct[];
  /** Per chip, over the accounts the search matches. */
  counts: Record<WorklistFilter, number>;
}

const DAY_MS = 86_400_000;
const dayNumber = (ymd: string) => Math.floor(Date.UTC(+ymd.slice(0, 4), +ymd.slice(5, 7) - 1, +ymd.slice(8, 10)) / DAY_MS);

export function isStale(lastDate: string | null | undefined, today: string): boolean {
  if (!lastDate) return false;
  return dayNumber(today) - dayNumber(lastDate) > STALE_DAYS;
}

function matches(a: BankAcct, filter: WorklistFilter, today: string): boolean {
  if (filter === 'open') return a.unallocatedCount > 0;
  if (filter === 'stale') return isStale(a.lastDate, today);
  if (filter === 'none') return !a.lastDate;
  return true;
}

const byName = (a: BankAcct, b: BankAcct) => a.accountName.localeCompare(b.accountName, undefined, { sensitivity: 'base' });

function byAttention(a: BankAcct, b: BankAcct): number {
  if (a.unallocatedCount !== b.unallocatedCount) return b.unallocatedCount - a.unallocatedCount;
  if (a.lastDate !== b.lastDate) {
    if (!a.lastDate) return -1;
    if (!b.lastDate) return 1;
    return a.lastDate < b.lastDate ? -1 : 1;
  }
  return byName(a, b);
}

const COMPARE: Record<WorklistSort, (a: BankAcct, b: BankAcct) => number> = {
  attention: byAttention,
  name: byName,
  balance: (a, b) => b.balance - a.balance || byName(a, b),
};

export function worklistView(accounts: BankAcct[], q: WorklistQuery): WorklistView {
  const term = q.search.trim().toLowerCase();
  const searched = term
    ? accounts.filter(a => a.accountName.toLowerCase().includes(term) || a.accountCode.toLowerCase().includes(term))
    : accounts;
  const count = (f: WorklistFilter) => searched.filter(a => matches(a, f, q.today)).length;
  return {
    rows: searched.filter(a => matches(a, q.filter, q.today)).sort(COMPARE[q.sort]),
    counts: { all: searched.length, open: count('open'), stale: count('stale'), none: count('none') },
  };
}

/** The worklist header: group balance, open transactions, stale accounts. */
export function worklistSummary(accounts: BankAcct[], today: string): { balance: number; open: number; stale: number } {
  return {
    balance: accounts.reduce((s, a) => s + a.balance, 0),
    open: accounts.reduce((s, a) => s + a.unallocatedCount, 0),
    stale: accounts.filter(a => isStale(a.lastDate, today)).length,
  };
}
