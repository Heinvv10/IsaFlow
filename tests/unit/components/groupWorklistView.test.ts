/**
 * groupWorklistView — the sort, filter chips and header totals of a bank
 * sub-account group's worklist (paycards). "Stale" = last imported
 * transaction more than 7 days before today; no statements is its own chip.
 */

import { describe, it, expect } from 'vitest';
import { isStale, worklistSummary, worklistView } from '@/components/accounting/bank-transactions/groupWorklistView';
import type { BankAcct } from '@/components/accounting/bank-transactions/BankTxBankCards';

const TODAY = '2026-10-26';

function acct(id: string, o: Partial<BankAcct> = {}): BankAcct {
  return {
    id, accountCode: `C-${id}`, accountName: `Card ${id}`, balance: 0, reconciledBalance: 0,
    unreconciledBalance: 0, unreconciledCount: 0, allocatedCount: 0, unallocatedCount: 0,
    lastDate: TODAY, ...o,
  };
}

const ids = (rows: BankAcct[]) => rows.map(r => r.id);
const view = (accounts: BankAcct[], o: Partial<Parameters<typeof worklistView>[1]> = {}) =>
  worklistView(accounts, { search: '', filter: 'all', sort: 'attention', today: TODAY, ...o });

describe('isStale', () => {
  it('is stale only when the last import is MORE than 7 days old', () => {
    expect(isStale('2026-10-19', TODAY)).toBe(false);
    expect(isStale('2026-10-18', TODAY)).toBe(true);
    expect(isStale(TODAY, TODAY)).toBe(false);
  });
  it('no statements is not stale (it has its own chip)', () => {
    expect(isStale(null, TODAY)).toBe(false);
    expect(isStale(undefined, TODAY)).toBe(false);
  });
});

describe('worklistView sort', () => {
  it('attention: most open first, then oldest import (no statements first), then name', () => {
    const accounts = [
      acct('fresh', { accountName: 'A fresh' }),
      acct('busy', { unallocatedCount: 3 }),
      acct('old', { lastDate: '2026-09-01' }),
      acct('none', { lastDate: null }),
      acct('busier', { unallocatedCount: 9 }),
      acct('fresh2', { accountName: 'B fresh' }),
    ];
    expect(ids(view(accounts).rows)).toEqual(['busier', 'busy', 'none', 'old', 'fresh', 'fresh2']);
  });

  it('name: alphabetical, case-insensitive', () => {
    const accounts = [acct('1', { accountName: 'zed' }), acct('2', { accountName: 'Alpha' }), acct('3', { accountName: 'beta' })];
    expect(ids(view(accounts, { sort: 'name' }).rows)).toEqual(['2', '3', '1']);
  });

  it('balance: largest first', () => {
    const accounts = [acct('1', { balance: 5 }), acct('2', { balance: 500 }), acct('3', { balance: -20 })];
    expect(ids(view(accounts, { sort: 'balance' }).rows)).toEqual(['2', '1', '3']);
  });

  it('does not reorder the input array', () => {
    const accounts = [acct('a'), acct('b', { unallocatedCount: 1 })];
    view(accounts);
    expect(ids(accounts)).toEqual(['a', 'b']);
  });
});

describe('worklistView filters', () => {
  const accounts = [
    acct('open', { unallocatedCount: 2, accountName: 'Jody' }),
    acct('stale', { lastDate: '2026-10-01', accountName: 'Stephan' }),
    acct('openstale', { unallocatedCount: 1, lastDate: '2026-09-01', accountName: 'Jody 2' }),
    acct('none', { lastDate: null, accountName: 'Dieter' }),
    acct('ok', { accountName: 'Harvey' }),
  ];

  it('each chip narrows to its accounts', () => {
    expect(ids(view(accounts, { filter: 'open' }).rows).sort()).toEqual(['open', 'openstale']);
    expect(ids(view(accounts, { filter: 'stale' }).rows).sort()).toEqual(['openstale', 'stale']);
    expect(ids(view(accounts, { filter: 'none' }).rows)).toEqual(['none']);
    expect(view(accounts).rows).toHaveLength(5);
  });

  it('counts every chip over the search-matched accounts', () => {
    expect(view(accounts).counts).toEqual({ all: 5, open: 2, stale: 2, none: 1 });
    expect(view(accounts, { search: 'jody' }).counts).toEqual({ all: 2, open: 2, stale: 1, none: 0 });
  });

  it('search and chip combine; search matches name or code', () => {
    expect(ids(view(accounts, { search: 'jody', filter: 'stale' }).rows)).toEqual(['openstale']);
    expect(ids(view(accounts, { search: 'c-none' }).rows)).toEqual(['none']);
  });
});

describe('worklistSummary', () => {
  it('totals balance and open, and counts stale accounts', () => {
    const accounts = [
      acct('1', { balance: 100.5, unallocatedCount: 2 }),
      acct('2', { balance: -0.5, unallocatedCount: 3, lastDate: '2026-01-01' }),
      acct('3', { lastDate: null }),
    ];
    expect(worklistSummary(accounts, TODAY)).toEqual({ balance: 100, open: 5, stale: 1 });
  });
});
