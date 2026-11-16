/** The page shell's pure decisions: which filters narrow the list, when "n shown" may be said, which account is selected, who can receive a transfer. */
import { describe, expect, it } from 'vitest';
import { awaitingShown, defaultBankId, filtersActive, keepOrDefault, transferTargetsFor } from '@/components/accounting/bank-transactions/bankTxPageView';
import { summaryAcct } from '../helpers/bankSummaryFixture';

const none = { search: '', fromDate: '', toDate: '', fromAmount: '', toAmount: '', allocationFilter: 'all', txType: 'all', allocType: 'all', hasSuggestion: 'all' };

describe('filtersActive', () => {
  it('no filter set: not active', () => expect(filtersActive(none)).toBe(false));
  for (const [name, patch] of [
    ['search', { search: 'woolies' }], ['from date', { fromDate: '2026-01-01' }], ['to date', { toDate: '2026-01-31' }],
    ['from amount', { fromAmount: '10' }], ['to amount', { toAmount: '10' }], ['allocation', { allocationFilter: 'suggested' }],
    ['type', { txType: 'spent' }], ['alloc type', { allocType: 'supplier' }], ['has suggestion', { hasSuggestion: 'yes' }],
  ] as const) it(`${name} set: active`, () => expect(filtersActive({ ...none, ...patch })).toBe(true));
});

describe('awaitingShown', () => {
  const ok = { tab: 'new' as const, filtersActive: true, error: '', isLoading: false, total: 7 };
  it('the New tab, filtered, loaded: the list total', () => expect(awaitingShown(ok)).toBe(7));
  it('not on New: null', () => expect(awaitingShown({ ...ok, tab: 'reviewed' })).toBeNull());
  it('no filters: null', () => expect(awaitingShown({ ...ok, filtersActive: false })).toBeNull());
  it('a list error: null, never "0 shown"', () => expect(awaitingShown({ ...ok, error: 'boom', total: 0 })).toBeNull());
  it('still loading: null', () => expect(awaitingShown({ ...ok, isLoading: true })).toBeNull());
});

describe('selection and transfer targets', () => {
  const inactive = summaryAcct('a', { isActive: false });
  const active = summaryAcct('b');
  const other = summaryAcct('c', { groupId: 'g', groupName: 'Cards', accountName: 'Card 1' });
  it('the default is the first ACTIVE account, else the first', () => {
    expect(defaultBankId([inactive, active])).toBe('b');
    expect(defaultBankId([inactive])).toBe('a');
  });
  it('a selection that still exists is kept (even inactive); one that vanished falls back to the default', () => {
    expect(keepOrDefault([inactive, active], 'a')).toBe('a');
    expect(keepOrDefault([inactive, active], 'gone')).toBe('b');
    expect(keepOrDefault([inactive, active], '')).toBe('b');
  });
  it('transfer targets exclude the selected and every inactive account; sub-accounts carry their group', () => {
    expect(transferTargetsFor([inactive, active, other], 'b')).toEqual([{ id: 'c', code: 'c', name: 'Cards › Card 1' }]);
  });
});
