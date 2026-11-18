/** The bank-transactions URL state, pure: untrusted text in, a valid view out; defaults omitted; foreign keys kept. */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_FILTERS, mergeOwnedQuery, ownedQueryKey, parseUrlView, serializeUrlView, URL_KEYS, type UrlView,
} from '@/components/accounting/bank-transactions/bankTxUrlState';

const view = (over: Partial<UrlView> = {}, filters: Partial<UrlView['filters']> = {}): UrlView =>
  ({ account: 'acc-1', tab: 'new', page: 1, filters: { ...DEFAULT_FILTERS, ...filters }, ...over });

describe('serializeUrlView', () => {
  it('the plain page is just the account: defaults never clutter the URL', () => {
    expect(serializeUrlView(view())).toEqual({ account_id: 'acc-1' });
  });
  it('every non-default part of the view is written', () => {
    const q = serializeUrlView(view({ tab: 'reviewed', page: 3 }, {
      search: 'rent', fromDate: '2026-01-01', toDate: '2026-02-01', fromAmount: '100', toAmount: '900.5', sortOrder: 'asc',
      allocationFilter: 'suggested', txType: 'spent', allocType: 'supplier', hasSuggestion: 'yes', reconFilter: 'reconciled',
    }));
    expect(q).toEqual({
      account_id: 'acc-1', tab: 'reviewed', page: '3', q: 'rent', from: '2026-01-01', to: '2026-02-01', min: '100', max: '900.5',
      sort: 'asc', alloc: 'suggested', type: 'spent', cat: 'supplier', sugg: 'yes', recon: 'reconciled',
    });
  });
  it('page 1 and the New tab are the defaults', () => {
    expect(serializeUrlView(view({ page: 1, tab: 'new' }))).not.toHaveProperty('page');
    expect(serializeUrlView(view({ page: 1, tab: 'new' }))).not.toHaveProperty('tab');
  });
  it('no account yet: nothing is written for it', () => {
    expect(serializeUrlView(view({ account: '' }))).toEqual({});
  });
});

describe('parseUrlView', () => {
  it('round-trips what serialize wrote', () => {
    const v = view({ tab: 'excluded', page: 7 }, { search: 'a b&c=d', fromAmount: '12.34', reconFilter: 'unreconciled' });
    const p = parseUrlView(serializeUrlView(v));
    expect(p).toMatchObject({ account: 'acc-1', tab: 'excluded', page: 7 });
    expect({ ...DEFAULT_FILTERS, ...p.filters }).toEqual(v.filters);
    // The status filter is the New tab's (WP4b): it round-trips there; another tab is read without it.
    const n = view({ tab: 'new', page: 2 }, { allocationFilter: 'allocated' });
    expect({ ...DEFAULT_FILTERS, ...parseUrlView(serializeUrlView(n)).filters }).toEqual(n.filters);
  });
  it.each([
    ['an unknown tab', { tab: 'hax' }, 'tab'],
    ['a page of zero', { page: '0' }, 'page'],
    ['a negative page', { page: '-2' }, 'page'],
    ['a fractional page', { page: '1.5' }, 'page'],
    ['a text page', { page: 'two' }, 'page'],
    ['an absurd page', { page: '99999999' }, 'page'],
  ])('%s is dropped (the caller keeps its default)', (_n, q, key) => {
    expect(parseUrlView(q as never)[key as 'tab' | 'page']).toBeUndefined();
  });
  it.each([
    ['a non-date', { from: 'yesterday' }, 'fromDate'],
    ['an impossible date', { to: '2026-13-45' }, 'toDate'],
    ['a signed amount', { min: '-5' }, 'fromAmount'],
    ['an exponent amount', { max: '1e3' }, 'toAmount'],
    ['an unknown allocation', { alloc: 'maybe' }, 'allocationFilter'],
    ['an unknown type', { type: 'x' }, 'txType'],
    ['an unknown category', { cat: 'x' }, 'allocType'],
    ['an unknown suggestion', { sugg: 'x' }, 'hasSuggestion'],
    ['an unknown reconciliation', { recon: 'x' }, 'reconFilter'],
    ['a sort that is not asc', { sort: 'sideways' }, 'sortOrder'],
  ])('%s is dropped', (_n, q, key) => {
    expect(parseUrlView(q as never).filters).not.toHaveProperty(key);
  });
  it('a repeated parameter (?tab=a&tab=b) is dropped, not guessed', () => {
    const p = parseUrlView({ tab: ['new', 'reviewed'], q: ['a', 'b'], account_id: ['x', 'y'] });
    expect(p.tab).toBeUndefined(); expect(p.account).toBeUndefined(); expect(p.filters.search).toBeUndefined();
  });
  it('an overlong search is cut', () => {
    expect(parseUrlView({ q: 'x'.repeat(500) }).filters.search).toHaveLength(200);
  });
  it('an empty query is an empty view', () => {
    expect(parseUrlView({})).toEqual({ account: undefined, tab: undefined, page: undefined, filters: {} });
  });
});

describe('parseUrlView: dates are real dates, searches are real searches, ranges are the right way round', () => {
  it.each([['2026-02-31'], ['2026-13-01'], ['2026-2-1'], ['2026-00-10'], ['2026-04-31'], ['2027-02-29'], ['26-02-01'], ['2026/02/01'], ['2026-02-01T00:00']])(
    'from=%s is not a date: dropped (the API would answer 500 to it)', (bad) => {
      expect(parseUrlView({ from: bad }).filters).not.toHaveProperty('fromDate');
      expect(parseUrlView({ to: bad }).filters).not.toHaveProperty('toDate');
    });
  it.each([['2026-02-28'], ['2024-02-29'], ['2026-12-31'], ['2026-01-01']])('%s is kept', (good) => {
    expect(parseUrlView({ from: good }).filters.fromDate).toBe(good);
  });
  it('a search of only spaces is no search, and a real one is trimmed (read and written alike)', () => {
    expect(parseUrlView({ q: '   ' }).filters).not.toHaveProperty('search');
    expect(parseUrlView({ q: '  rent ' }).filters.search).toBe('rent');
    expect(serializeUrlView(view({}, { search: '   ' }))).not.toHaveProperty('q');
    expect(serializeUrlView(view({}, { search: ' rent ' })).q).toBe('rent');
  });
  it('min above max is read the right way round (not an empty list); a range already in order is untouched', () => {
    expect(parseUrlView({ min: '900', max: '100' }).filters).toMatchObject({ fromAmount: '100', toAmount: '900' });
    expect(parseUrlView({ min: '100', max: '900' }).filters).toMatchObject({ fromAmount: '100', toAmount: '900' });
    expect(parseUrlView({ min: '9', max: '10' }).filters).toMatchObject({ fromAmount: '9', toAmount: '10' }); // numbers, not text: "9" < "10"
    expect(parseUrlView({ min: '5' }).filters).toMatchObject({ fromAmount: '5' });
  });
  it('from after to is swapped the same way', () => {
    expect(parseUrlView({ from: '2026-05-01', to: '2026-01-01' }).filters).toMatchObject({ fromDate: '2026-01-01', toDate: '2026-05-01' });
  });
});

describe('ownedQueryKey / mergeOwnedQuery', () => {
  it('the key ignores keys we do not own and the order they came in', () => {
    expect(ownedQueryKey({ page: '2', account_id: 'a', line: 'x', utm: 'y' })).toBe(ownedQueryKey({ account_id: 'a', page: '2' }));
  });
  it('an empty value counts as absent', () => {
    expect(ownedQueryKey({ q: '', account_id: 'a' })).toBe('account_id=a');
  });
  it('a merge replaces OUR keys and leaves the rest (the drawer deep link `line`)', () => {
    const merged = mergeOwnedQuery({ account_id: 'old', tab: 'reviewed', page: '4', line: 'tx-9' }, { account_id: 'new' });
    expect(merged).toEqual({ line: 'tx-9', account_id: 'new' });
  });
  it('URL_KEYS are exactly the keys serialize can write', () => {
    const all = serializeUrlView(view({ tab: 'reviewed', page: 2 }, { search: 'a', fromDate: '2026-01-01', toDate: '2026-01-02', fromAmount: '1', toAmount: '2', sortOrder: 'asc', allocationFilter: 'allocated', txType: 'spent', allocType: 'account', hasSuggestion: 'no', reconFilter: 'reconciled', pageSize: 50 }));
    expect(Object.keys(all).sort()).toEqual([...URL_KEYS].sort());
  });
});
