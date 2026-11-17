/**
 * firstCardAccount (the page's default account) with WP5's pins: the saved order is `[...pinned, '~unpinned', ...rest]`.
 * The default is the first PINNED card that can be opened; the boundary key is never an account; an inactive pin is skipped
 * for the next pin before any unpinned card is considered.
 */
import { describe, expect, it } from 'vitest';
import { firstCardAccount } from '@/components/accounting/bank-transactions/firstCardAccount';
import { PIN_BOUNDARY } from '@/components/accounting/bank-transactions/bankCardPins';
import { summaryAcct } from '../helpers/bankSummaryFixture';

const ids = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
const accts = (over: Record<string, Parameters<typeof summaryAcct>[1]> = {}) => ids.map(i => summaryAcct(i, over[i]));

describe('firstCardAccount with pins', () => {
  it('opens on the first pinned card, not the first unpinned or the first the API lists', () => {
    expect(firstCardAccount(accts(), ['c', 'b', PIN_BOUNDARY, 'a', 'd'])).toBe('c');
  });
  it('the boundary key is never an account, even when it comes first or alone', () => {
    expect(ids).toContain(firstCardAccount(accts(), [PIN_BOUNDARY, 'c', 'b']));
    expect(firstCardAccount(accts(), [PIN_BOUNDARY])).toBe('a');
  });
  it('an inactive first pin is skipped for the next pin, before any unpinned card', () => {
    expect(firstCardAccount(accts({ c: { isActive: false } }), ['c', 'b', PIN_BOUNDARY, 'a'])).toBe('b');
  });
  it('every pin inactive: the first active card after the boundary', () => {
    expect(firstCardAccount(accts({ c: { isActive: false }, b: { isActive: false } }), ['c', 'b', PIN_BOUNDARY, 'e', 'a'])).toBe('e');
  });
  it('pins of accounts that are gone are ignored', () => {
    expect(firstCardAccount(accts(), ['zzz', 'd', PIN_BOUNDARY])).toBe('d');
  });
  it('no saved order: the page order, as before', () => {
    expect(firstCardAccount(accts(), null)).toBe('a');
  });
});
