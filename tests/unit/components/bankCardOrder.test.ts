/**
 * bankCardOrder — the user's own order of the cards in the bank-transactions
 * row (primary accounts and sub-account groups), kept in user_preferences.
 */

import { describe, expect, it } from 'vitest';
import {
  applyCardOrder, cardOrderPrefKey, moveCard, moveCardBy, parseCardOrder,
} from '@/components/accounting/bank-transactions/bankCardOrder';

describe('applyCardOrder', () => {
  it('no saved order keeps the original order', () => {
    expect(applyCardOrder(['a', 'b', 'c'], null)).toEqual(['a', 'b', 'c']);
  });
  it('saved keys come first in their saved order, new cards after in their original order', () => {
    expect(applyCardOrder(['a', 'b', 'c', 'd'], ['c', 'a'])).toEqual(['c', 'a', 'b', 'd']);
  });
  it('a saved key for a card that no longer exists is ignored', () => {
    expect(applyCardOrder(['a', 'b'], ['gone', 'b', 'a'])).toEqual(['b', 'a']);
  });
  it('a duplicated saved key does not duplicate the card', () => {
    expect(applyCardOrder(['a', 'b'], ['b', 'b', 'a'])).toEqual(['b', 'a']);
  });
});

describe('moveCard (drop on a card: take its place)', () => {
  it('moving right lands at the target position', () => {
    expect(moveCard(['a', 'b', 'c', 'd'], 'a', 'c')).toEqual(['b', 'c', 'a', 'd']);
  });
  it('moving left lands at the target position', () => {
    expect(moveCard(['a', 'b', 'c', 'd'], 'd', 'b')).toEqual(['a', 'd', 'b', 'c']);
  });
  it('dropping on itself or an unknown id changes nothing', () => {
    expect(moveCard(['a', 'b'], 'a', 'a')).toEqual(['a', 'b']);
    expect(moveCard(['a', 'b'], 'a', 'zz')).toEqual(['a', 'b']);
    expect(moveCard(['a', 'b'], 'zz', 'a')).toEqual(['a', 'b']);
  });
});

describe('moveCardBy (keyboard)', () => {
  it('one step left or right, clamped at the ends', () => {
    expect(moveCardBy(['a', 'b', 'c'], 'b', -1)).toEqual(['b', 'a', 'c']);
    expect(moveCardBy(['a', 'b', 'c'], 'b', 1)).toEqual(['a', 'c', 'b']);
    expect(moveCardBy(['a', 'b', 'c'], 'a', -1)).toEqual(['a', 'b', 'c']);
    expect(moveCardBy(['a', 'b', 'c'], 'c', 1)).toEqual(['a', 'b', 'c']);
  });
});

describe('stored value', () => {
  it('is keyed per company', () => {
    expect(cardOrderPrefKey('co-1')).toBe('bank_card_order:co-1');
  });
  it('parses a JSON array of strings; anything else reads as no order', () => {
    expect(parseCardOrder('["a","group:g"]')).toEqual(['a', 'group:g']);
    expect(parseCardOrder(undefined)).toBeNull();
    expect(parseCardOrder('not json')).toBeNull();
    expect(parseCardOrder('{"a":1}')).toBeNull();
    expect(parseCardOrder('[1,2]')).toBeNull();
  });
});
