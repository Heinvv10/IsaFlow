/**
 * The keys a customer note's application takes (shared/creditNoteWalkKeys, #1701 rounds 8-9): ONE sorted set, the
 * linked invoice's key and, for a walk, the open invoices in the walk's order until what they can take (outstanding,
 * capped at a typed invoice's capacity) covers the amount: the bound. Each once, lower-cased, read unlocked.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ keys: [] as string[], caps: {} as Record<string, number | null> }));
vi.mock('@/modules/accounting/services/ar/creditNotePostingChecks', () => ({
  lockInvoiceCreditNotes: vi.fn(async (id: string) => { h.keys.push(id); }),
}));
vi.mock('@/modules/accounting/services/ar/openCustomerInvoices', () => ({
  fetchOpenCustomerInvoices: vi.fn(async () => [
    { invoiceId: 'C-3', outstanding: 115 }, { invoiceId: 'a-1', outstanding: 115 }, { invoiceId: 'L-9', outstanding: 115 }, { invoiceId: 'd-4', outstanding: 115 },
  ]),
}));
vi.mock('@/modules/accounting/services/ar/creditNoteTypedApplication', () => ({
  typedCreditCapacity: vi.fn(async (_c: string, id: string) => (h.caps[id] == null ? null : { cap: h.caps[id], net: 0, vat: 0 })),
}));

import { fetchOpenCustomerInvoices } from '@/modules/accounting/services/ar/openCustomerInvoices';
import { lockCustomerWalkKeys, walkKeyInvoices } from '@/modules/accounting/services/shared/creditNoteWalkKeys';

beforeEach(() => { h.keys = []; h.caps = {}; vi.mocked(fetchOpenCustomerInvoices).mockClear(); });

describe('lockCustomerWalkKeys', () => {
  it('a walk: the linked invoice and the covering prefix, once each, lower-cased, in id order, read without row locks', async () => {
    const held = await lockCustomerWalkKeys('co', 'cust', 'l-9', true, 230);
    expect(h.keys).toEqual(['a-1', 'c-3', 'l-9']);                     // c-3 + a-1 cover 230; the linked one is not counted
    expect([...held].sort()).toEqual(['a-1', 'c-3', 'l-9']);
    expect(fetchOpenCustomerInvoices).toHaveBeenCalledWith('co', 'cust', true, { forUpdate: false });
  });
  it('the bound: a typed invoice counts what it can take (its capacity), so the walk reaches further only when it must', async () => {
    h.caps = { 'c-3': 0, 'a-1': 5000 };                                // nothing left on c-3, 50 on a-1
    expect(await walkKeyInvoices('co', 'cust', null, true, 115)).toEqual(['c-3', 'a-1', 'l-9']);
    expect(await walkKeyInvoices('co', 'cust', null, true, 50)).toEqual(['c-3', 'a-1']);
    expect(await walkKeyInvoices('co', 'cust', null, true, 10_000)).toEqual(['c-3', 'a-1', 'l-9', 'd-4']); // never past the open invoices
  });
  it('no walk (auto_apply linked): the linked invoice only, nothing read', async () => {
    expect([...await lockCustomerWalkKeys('co', 'cust', 'L-9', false, 115)]).toEqual(['l-9']);
    expect(h.keys).toEqual(['l-9']);
    expect(fetchOpenCustomerInvoices).not.toHaveBeenCalled();
  });
  it('an unlinked note with no customer takes nothing', async () => {
    expect([...await lockCustomerWalkKeys('co', null, null, true, 115)]).toEqual([]);
    expect(h.keys).toEqual([]);
  });
});
