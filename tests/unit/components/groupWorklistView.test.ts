/**
 * groupWorklistView — the sort, filter chips and header totals of a bank
 * sub-account group's worklist (paycards). "Stale" = last imported
 * transaction more than 7 days before today; no statements is its own chip.
 */

import { describe, it, expect } from 'vitest';
import { isStale, worklistSummary, worklistView } from '@/components/accounting/bank-transactions/groupWorklistView';
import { summaryAcct } from '../helpers/bankSummaryFixture';
import type { BankAccountSummary as BankAcct } from '@/modules/accounting/services/bank/bankAccountSummaryService';

const TODAY = '2026-10-26';

type Seed = Partial<BankAcct> & { toCode?: number };
function acct(id: string, { toCode, ...o }: Seed = {}): BankAcct {
  return summaryAcct(id, { accountName: `Card ${id}`, accountCode: `C-${id}`, lastDate: TODAY, ...(toCode === undefined ? {} : { counts: { unallocated: toCode } }), ...o });
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
      acct('busy', { toCode: 3 }),
      acct('old', { lastDate: '2026-09-01' }),
      acct('none', { lastDate: null }),
      acct('busier', { toCode: 9 }),
      acct('fresh2', { accountName: 'B fresh' }),
    ];
    expect(ids(view(accounts).rows)).toEqual(['busier', 'busy', 'none', 'old', 'fresh', 'fresh2']);
  });

  it('name: alphabetical, case-insensitive', () => {
    const accounts = [acct('1', { accountName: 'zed' }), acct('2', { accountName: 'Alpha' }), acct('3', { accountName: 'beta' })];
    expect(ids(view(accounts, { sort: 'name' }).rows)).toEqual(['2', '3', '1']);
  });

  it('ledger: largest first', () => {
    const accounts = [acct('1', { ledgerCents: 500 }), acct('2', { ledgerCents: 50000 }), acct('3', { ledgerCents: -2000 })];
    expect(ids(view(accounts, { sort: 'balance' }).rows)).toEqual(['2', '1', '3']);
  });

  it('does not reorder the input array', () => {
    const accounts = [acct('a'), acct('b', { toCode: 1 })];
    view(accounts);
    expect(ids(accounts)).toEqual(['a', 'b']);
  });
});

describe('worklistView filters', () => {
  const accounts = [
    acct('open', { toCode: 2, accountName: 'Jody' }),
    acct('stale', { lastDate: '2026-10-01', accountName: 'Stephan' }),
    acct('openstale', { toCode: 1, lastDate: '2026-09-01', accountName: 'Jody 2' }),
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
  it('totals ledger cents (exact) and to-code lines, and counts stale accounts', () => {
    const accounts = [
      acct('1', { ledgerCents: 10050, toCode: 2 }),
      acct('2', { ledgerCents: -50, toCode: 3, lastDate: '2026-01-01' }),
      acct('3', { lastDate: null }),
    ];
    expect(worklistSummary(accounts, TODAY)).toEqual({ ledgerCents: 10000, open: 5, stale: 1 });
  });
});
