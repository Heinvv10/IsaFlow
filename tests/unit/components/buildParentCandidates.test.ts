/**
 * buildParentCandidates — derives group-parent options for the bank-account
 * Add/Edit modals: known umbrellas (from children's groupId/groupName, since
 * the list API returns leaves only) plus ungrouped, transaction-free leaves.
 */

import { describe, it, expect } from 'vitest';
import { buildParentCandidates, type BankAccountRow } from '@/components/accounting/bank/parentCandidates';

function row(overrides: Partial<BankAccountRow> & { id: string }): BankAccountRow {
  return { accountCode: overrides.id, accountName: `Account ${overrides.id}`, ...overrides };
}

describe('buildParentCandidates', () => {
  it('returns empty for empty input', () => {
    expect(buildParentCandidates([])).toEqual([]);
  });

  it('derives umbrellas from memberships and dedupes across leaves', () => {
    const accounts = [
      row({ id: 'pc1', groupId: 'g1', groupName: 'Paycards' }),
      row({ id: 'pc2', groupId: 'g1', groupName: 'Paycards' }),
    ];
    expect(buildParentCandidates(accounts)).toEqual([{ id: 'g1', label: 'Paycards' }]);
  });

  it('offers ungrouped transaction-free leaves, labelled code — name', () => {
    const accounts = [row({ id: 'a', accountCode: '1110', accountName: 'Main', txnCount: 0 })];
    expect(buildParentCandidates(accounts)).toEqual([{ id: 'a', label: '1110 — Main' }]);
  });

  it('excludes leaves that carry their own transactions', () => {
    const accounts = [
      row({ id: 'busy', txnCount: 42 }),
      row({ id: 'idle', accountCode: '1115', accountName: 'Spare', txnCount: 0 }),
    ];
    expect(buildParentCandidates(accounts).map(c => c.id)).toEqual(['idle']);
  });

  it('excludes the account being edited from both umbrella and leaf lists', () => {
    const accounts = [
      row({ id: 'pc1', groupId: 'edit-me', groupName: 'Old Group' }),
      row({ id: 'edit-me' }),
      row({ id: 'other' }),
    ];
    expect(buildParentCandidates(accounts, 'edit-me').map(c => c.id)).toEqual(['other']);
  });

  it('does not list an umbrella id twice when it also appears as a leaf row', () => {
    const accounts = [
      row({ id: 'umb' }), // umbrella somehow present in the leaf list
      row({ id: 'pc1', groupId: 'umb', groupName: 'Floats' }),
    ];
    const ids = buildParentCandidates(accounts).map(c => c.id);
    expect(ids).toEqual(['umb']);
    expect(buildParentCandidates(accounts)[0]!.label).toBe('Floats');
  });

  it('treats missing txnCount as transaction-free (field is optional)', () => {
    expect(buildParentCandidates([row({ id: 'a' })])).toHaveLength(1);
  });
});
