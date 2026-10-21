/**
 * What one Sage take-on may hold (sagePullLimits): the import runs in one
 * request, so its size is capped by measured time (see the constants). The
 * same rule refuses at pull time and again at import, so a review stored under
 * older caps cannot be imported.
 */
import { describe, expect, it } from 'vitest';
import {
  isTakenOn, MAX_CONTACTS, MAX_CONTACTS_WITH_BALANCES, MAX_OUTSTANDING_INVOICES, pullSizeRefusal, sizesOf,
} from '@/modules/accounting/services/sage/sagePullLimits';
import { sageFixture } from './sageFixture';

describe('pullSizeRefusal', () => {
  it('passes a company at every cap', () => {
    expect(pullSizeRefusal({ contacts: MAX_CONTACTS, owing: MAX_CONTACTS_WITH_BALANCES, invoices: MAX_OUTSTANDING_INVOICES })).toBeNull();
  });

  it.each([
    ['contacts', { contacts: MAX_CONTACTS + 1, owing: 0, invoices: 0 }, /customers and suppliers/],
    ['open balances', { contacts: 10, owing: MAX_CONTACTS_WITH_BALANCES + 1, invoices: 0 }, /open balances/],
    ['invoices', { contacts: 10, owing: 1, invoices: MAX_OUTSTANDING_INVOICES + 1 }, /unpaid invoices and bills/],
  ])('refuses too many %s and points at the Migration Wizard', (_n, sizes, msg) => {
    const m = pullSizeRefusal(sizes);
    expect(m).toMatch(msg);
    expect(m).toMatch(/Migration Wizard/);
  });
});

describe('sizesOf', () => {
  it('counts the contacts the take-on imports (active, or with a balance), the ones owing, and the unpaid invoices', () => {
    // Fixture: customers 11,12,14 active (13 dormant, no balance); suppliers 21,22,23 active. Owing: 11, 12, 21.
    expect(sizesOf(sageFixture())).toEqual({ contacts: 6, owing: 3, invoices: 3 });
  });

  it('isTakenOn: active, or inactive with a balance', () => {
    expect(isTakenOn({ Active: false, Balance: 0 })).toBe(false);
    expect(isTakenOn({ Active: false, Balance: -3 })).toBe(true);
    expect(isTakenOn({ Active: true, Balance: 0 })).toBe(true);
  });

  it('the caps are the measured ones', () => {
    expect([MAX_CONTACTS, MAX_CONTACTS_WITH_BALANCES, MAX_OUTSTANDING_INVOICES]).toEqual([2000, 300, 300]);
  });
});
