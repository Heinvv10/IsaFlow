/**
 * bankTx/bankTxOptions: the Selection popover's option logic, moved out of BankTxTable as pure functions.
 * Same results as the closures they replace: which list a row type reads, the code/name filter, the
 * description-match ordering and the pinned suggestion.
 */
import { describe, it, expect } from 'vitest';
import {
  filterOptions, getOptionsForType, getSuggestedOption, sortByDescriptionMatch,
} from '@/components/accounting/bankTx/bankTxOptions';
import type { BankTx, SelectOption } from '@/components/accounting/bankTx/bankTxTypes';

const lists = {
  glAccounts: [{ id: 'g', name: 'GL' }],
  suppliers: [{ id: 's', name: 'Sup' }],
  customers: [{ id: 'c', name: 'Cust' }],
  transferTargets: [{ id: 't', name: 'Bank' }],
};
const tx = (over: Partial<BankTx>): BankTx => ({ id: 'x', transactionDate: '2026-06-01', amount: -1, status: 'imported', ...over });

describe('getOptionsForType', () => {
  it.each([
    ['account', 'g'], ['supplier', 's'], ['customer', 'c'], ['transfer', 't'],
  ] as const)('%s reads its own list', (type, id) => {
    expect(getOptionsForType(type, lists).map(o => o.id)).toEqual([id]);
  });
});

describe('filterOptions', () => {
  const opts: SelectOption[] = [{ id: '1', code: '6100', name: 'Entertainment' }, { id: '2', name: 'Bank Charges' }, { id: '3', code: '7000', name: 'Rent' }];
  it.each([
    ['', ['1', '2', '3']],
    ['61', ['1']],
    ['BANK', ['2']],
    ['en', ['1', '3']],
    ['zzz', []],
  ])('query %j -> %j', (q, ids) => {
    expect(filterOptions(opts, q).map(o => o.id)).toEqual(ids);
  });
});

describe('sortByDescriptionMatch', () => {
  const opts: SelectOption[] = [{ id: 'a', name: 'Rent' }, { id: 'b', name: 'Woolworths Food' }, { id: 'c', name: 'Fuel' }, { id: 'd', name: 'Engen' }];
  it.each([
    ['POS WOOLWORTHS SANDTON', ['b', 'a', 'c', 'd']],
    ['ENGEN GARAGE', ['d', 'a', 'b', 'c']],
    // reverse match only: no description word is in the name, but a name word is in the description
    ['POS*WOOLWORTHSFOOD', ['b', 'a', 'c', 'd']],
    ['', ['a', 'b', 'c', 'd']],
    ['ab cd', ['a', 'b', 'c', 'd']],
  ])('%j orders %j', (desc, ids) => {
    expect(sortByDescriptionMatch(opts, desc).map(o => o.id)).toEqual(ids);
  });
  it('does not reorder the input array', () => {
    sortByDescriptionMatch(opts, 'ENGEN');
    expect(opts.map(o => o.id)).toEqual(['a', 'b', 'c', 'd']);
  });
});

describe('getSuggestedOption', () => {
  it.each([
    ['supplier', tx({ suggestedSupplierId: 's1', suggestedSupplierName: 'Acme' }), { id: 's1', name: 'Acme', code: '' }],
    ['supplier', tx({ suggestedSupplierId: 's1' }), { id: 's1', name: 'Suggested Supplier', code: '' }],
    ['customer', tx({ suggestedClientId: 'c1', suggestedClientName: 'Bob' }), { id: 'c1', name: 'Bob', code: '' }],
    ['account', tx({ suggestedGlAccountId: 'g1', suggestedGlAccountName: 'Rent', suggestedGlAccountCode: '7000' }), { id: 'g1', name: 'Rent', code: '7000' }],
    ['account', tx({ suggestedGlAccountId: 'g1' }), { id: 'g1', name: 'Suggested Account', code: '' }],
    ['account', tx({ suggestedSupplierId: 's1' }), null],
    ['transfer', tx({ suggestedGlAccountId: 'g1' }), null],
  ] as const)('%s', (type, t, want) => {
    expect(getSuggestedOption(t, type)).toEqual(want);
  });
});
