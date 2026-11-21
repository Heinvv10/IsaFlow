/**
 * The keys a customer note's application takes (shared/creditNoteWalkKeys, #1701 round 8 item 1; replaces the gate
 * fixer's creditNotePostingChecksKeys / creditNoteFifoCandidateKeys, whose late second acquisition this design drops):
 * ONE sorted set, the linked invoice's key and, for a walk, every open invoice of the customer, each once, lower-cased,
 * read unlocked; and approve takes them before its journal, passing them to the walk.
 */
import { describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ keys: [] as string[] }));
vi.mock('@/modules/accounting/services/ar/creditNotePostingChecks', () => ({
  lockInvoiceCreditNotes: vi.fn(async (id: string) => { h.keys.push(id); }),
}));
vi.mock('@/modules/accounting/services/ar/openCustomerInvoices', () => ({
  fetchOpenCustomerInvoices: vi.fn(async () => [{ invoiceId: 'C-3' }, { invoiceId: 'a-1' }, { invoiceId: 'L-9' }]),
}));

import { fetchOpenCustomerInvoices } from '@/modules/accounting/services/ar/openCustomerInvoices';
import { lockCustomerWalkKeys } from '@/modules/accounting/services/shared/creditNoteWalkKeys';

describe('lockCustomerWalkKeys', () => {
  it('a walk: the linked invoice and every open invoice, once each, lower-cased, in id order, read without row locks', async () => {
    h.keys = [];
    const held = await lockCustomerWalkKeys('co', 'cust', 'l-9', true);
    expect(h.keys).toEqual(['a-1', 'c-3', 'l-9']);
    expect([...held].sort()).toEqual(['a-1', 'c-3', 'l-9']);
    expect(fetchOpenCustomerInvoices).toHaveBeenCalledWith('co', 'cust', true, { forUpdate: false });
  });
  it('no walk (auto_apply linked): the linked invoice only, nothing read', async () => {
    h.keys = []; vi.mocked(fetchOpenCustomerInvoices).mockClear();
    expect([...await lockCustomerWalkKeys('co', 'cust', 'L-9', false)]).toEqual(['l-9']);
    expect(h.keys).toEqual(['l-9']);
    expect(fetchOpenCustomerInvoices).not.toHaveBeenCalled();
  });
  it('an unlinked note with no customer takes nothing', async () => {
    h.keys = [];
    expect([...await lockCustomerWalkKeys('co', null, null, true)]).toEqual([]);
    expect(h.keys).toEqual([]);
  });
});
