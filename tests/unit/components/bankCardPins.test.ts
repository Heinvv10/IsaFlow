/**
 * WP5: pins in the card-order store. Above SWITCHER_THRESHOLD accounts only the pinned cards show; the pins are the
 * keys before PIN_BOUNDARY in the saved order (an older client ignores the boundary: it matches no card).
 */
import { describe, expect, it } from 'vitest';
import {
  MAX_PINNED, PIN_BOUNDARY, SWITCHER_THRESHOLD, pinnedKeys, searchAccounts, splitName, togglePin,
} from '@/components/accounting/bank-transactions/bankCardPins';
import { applyCardOrder } from '@/components/accounting/bank-transactions/bankCardOrder';
import { groupBankAccounts } from '@/components/accounting/bank-transactions/groupBankAccounts';
import { summaryAcct } from '../helpers/bankSummaryFixture';

const keys = (n: number) => Array.from({ length: n }, (_, i) => `k${i + 1}`);

describe('pinnedKeys', () => {
  it('without a saved boundary the first MAX_PINNED cards in their usual order are pinned', () => {
    expect(MAX_PINNED).toBe(6);
    expect(SWITCHER_THRESHOLD).toBe(6);
    expect(pinnedKeys(keys(10), null)).toEqual(keys(6));
    expect(pinnedKeys(keys(10), ['k9', 'k2'])).toEqual(['k9', 'k2', 'k1', 'k3', 'k4', 'k5']);
  });

  it('the saved boundary splits pinned from the rest, in the saved order', () => {
    expect(pinnedKeys(keys(10), ['k8', 'k3', PIN_BOUNDARY, 'k1'])).toEqual(['k8', 'k3']);
  });

  it('keys for cards that are gone are dropped, and never more than MAX_PINNED survive', () => {
    expect(pinnedKeys(keys(3), ['gone', 'k2', PIN_BOUNDARY])).toEqual(['k2']);
    expect(pinnedKeys(keys(12), [...keys(9), PIN_BOUNDARY])).toEqual(keys(6));
  });

  it('the boundary never reaches the card order an older client applies', () => {
    expect(applyCardOrder(keys(4), ['k3', PIN_BOUNDARY, 'k1'])).toEqual(['k3', 'k1', 'k2', 'k4']);
  });
});

describe('togglePin', () => {
  it('pins into a free slot and unpins', () => {
    const afterUnpin = togglePin(keys(10), null, 'k2');
    expect(afterUnpin.order).toEqual(['k1', 'k3', 'k4', 'k5', 'k6', PIN_BOUNDARY, 'k2', 'k7', 'k8', 'k9', 'k10']);
    const afterPin = togglePin(keys(10), afterUnpin.order, 'k9');
    expect(afterPin.refused).toBeNull();
    expect(afterPin.order).toEqual(['k1', 'k3', 'k4', 'k5', 'k6', 'k9', PIN_BOUNDARY, 'k2', 'k7', 'k8', 'k10']);
  });

  it('refuses unpinning the last pin (the row is never empty), saying why, and changes nothing', () => {
    const one = ['k1', PIN_BOUNDARY, 'k2', 'k3'];
    const r = togglePin(keys(3), one, 'k1');
    expect(r.order).toBe(one);
    expect(r.refused).toMatch(/at least one/);
  });

  it('a boundary stored with no live pins falls back to the first card, never an empty row', () => {
    expect(pinnedKeys(keys(4), [PIN_BOUNDARY, 'k2'])).toEqual(['k1']);
    expect(pinnedKeys(keys(4), ['gone', PIN_BOUNDARY, 'k2'])).toEqual(['k1']);
  });

  it('refuses a seventh pin, naming the limit, and changes nothing', () => {
    const full = [...keys(6), PIN_BOUNDARY, ...keys(10).slice(6)];
    const r = togglePin(keys(10), full, 'k9');
    expect(r.order).toBe(full);
    expect(r.refused).toMatch(/up to 6/);
  });
});

describe('searchAccounts', () => {
  const accts = [
    summaryAcct('a', { accountName: 'FNB Cheque', accountCode: '1000', bankAccountNumber: '62001234567' }),
    summaryAcct('b', { accountName: 'Savings', accountCode: '1010', bankAccountNumber: '99887766' }),
    summaryAcct('c', { accountName: 'Sipho Dlamini', accountCode: '1021', bankAccountNumber: '5555', groupId: 'g', groupName: 'Paycards', groupCode: '1020' }),
    summaryAcct('d', { accountName: 'Thandi Nkosi', accountCode: '1022', bankAccountNumber: '6666', groupId: 'g', groupName: 'Paycards', groupCode: '1020' }),
  ];
  const { primaries, groups } = groupBankAccounts(accts);
  const ids = (q: string) => searchAccounts(primaries, groups, q).flatMap(r => (r.kind === 'account' ? [r.account.id] : []));

  it('an empty query lists everything, groups followed by their sub-accounts', () => {
    const rows = searchAccounts(primaries, groups, '');
    expect(rows.map(r => (r.kind === 'group' ? `G:${r.group.groupId}` : r.account.id))).toEqual(['a', 'b', 'G:g', 'c', 'd']);
  });

  it('finds by name, by code and by account number (whole or last four), ignoring case and spacing', () => {
    expect(ids('cheque')).toEqual(['a']);
    expect(ids('1010')).toEqual(['b']);
    expect(ids('62001234567')).toEqual(['a']);
    expect(ids('4567')).toEqual(['a']);
    expect(ids('  SAVINGS ')).toEqual(['b']);
  });

  it('a paycard sub-account is found, shown under its group', () => {
    const rows = searchAccounts(primaries, groups, 'thandi');
    expect(rows.map(r => (r.kind === 'group' ? 'G' : r.account.id))).toEqual(['G', 'd']);
  });

  it('matching the group name lists the group with all its sub-accounts', () => {
    expect(ids('paycards')).toEqual(['c', 'd']);
  });

  it('nothing matches: no rows', () => {
    expect(searchAccounts(primaries, groups, 'zzz')).toEqual([]);
  });
});

describe('splitName', () => {
  it('a short name is whole', () => {
    expect(splitName('Main')).toEqual({ head: 'Main', tail: '' });
  });
  it('a long name keeps its ending (the distinguishing suffix) in the tail', () => {
    const n = 'First National Bank Business Current Account ****4567';
    const { head, tail } = splitName(n);
    expect(head + tail).toBe(n);
    expect(tail.endsWith('****4567')).toBe(true);
    expect(tail.length).toBeLessThanOrEqual(18);
  });
});
