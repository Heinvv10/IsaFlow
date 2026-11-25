/**
 * Per-line VAT on quotes, review round 13: the standard-only ORDER of decision for an edit's line with no id
 * (quoteEditLines.standardOnly: content, place, unique, renamed, else ambiguous), ids that are not this quote's, and no
 * item inherited by an unmatched line (quoteLineTax.quoteEditItemLines passes itemEditLines no identical-line pool).
 * Round 14: a line unchanged in its own place keeps it first (cases from the reviewer's brute-force sweep), an explicit
 * null item at a place, and a unique line resent at another rate.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/modules/accounting/services/ar/invoiceLineCodingGuard', () => ({ assertLineAccountIds: vi.fn(async () => undefined) }));
vi.mock('@/modules/accounting/services/core/contactDirectoryService', () => ({ assertCustomerInCompany: vi.fn(async () => undefined) }));
vi.mock('@/modules/accounting/services/core/documentNumberRetry', () => ({
  insertWithReservedNumber: vi.fn(async (_c: string, _t: string, _s: string, _k: unknown, fn: (n: string) => unknown) => fn('QUO0000001')),
}));
vi.mock('@/modules/accounting/services/ar/sourceContentEditor', () => ({
  withSourceEditorStamp: (_c: string, _s: unknown, _e: string, edit: () => Promise<unknown>) => edit(),
}));
vi.mock('@/lib/neon', () => ({
  sql: Object.assign(vi.fn(), { transaction: vi.fn() }),
  withTransaction: vi.fn(),
  withSavepoint: vi.fn(async (_name: string, fn: () => unknown) => fn()),
}));

import { updateQuote } from '@/modules/accounting/services/ar/quoteService';
import { COMPANY_ID, ITEM_B, ITEM_ID, QUOTE_ID, inserted, resetWorld, world, wrote } from './helpers/quoteVatWorld';

beforeEach(resetWorld);

const [X, Y] = [ITEM_ID, ITEM_B];
const [GX, GY] = ['a1a1a1a1-0000-4000-8000-000000000001', 'a1a1a1a1-0000-4000-8000-000000000002'];
const storedLine = (id: string, sort: number, item: string | null, account: string, price: string) => ({
  id, quote_id: QUOTE_ID, sort_order: sort, description: 'Svc', quantity: '1.00', unit_price: price, amount: price,
  tax_rate: '15', vat_type: 'standard', tax_amount: String(Number(price) * 0.15), gl_account_id: account, item_id: item,
});
const rows = () => inserted('customer_quote_lines').map((l) => [l.item_id, l.gl_account_id]);
const put = (lines: Record<string, unknown>[]) => updateQuote(COMPANY_ID, QUOTE_ID, { customerName: 'Acme', lines } as never, 'u1');

/** A second edit in one test: the calls recorded so far cleared, the stored lines kept. */
const again = () => { const st = world.stored; resetWorld(); world.stored = st; };
const AMBIGUOUS = /more than one line of this description with different items or accounts/;

const UNKNOWN_ID = /the id sent is not a line of this quote/;
const named = (id: string, sort: number, description: string, item: string | null, account: string, price: string) => ({ ...storedLine(id, sort, item, account, price), description });
const svc = (unitPrice: number, o: Record<string, unknown> = {}) => ({ description: 'Svc', quantity: 1, unitPrice, ...o });

describe('HIGH: a line whose description another stored line holds never takes the line at its place by item', () => {
  beforeEach(() => { world.stored = [named('l0', 1, 'A', X, GX, '10.00'), named('l1', 2, 'B', X, GY, '10.00')]; });

  it('reordered [B, A] naming the shared item, unchanged or re-priced: each keeps its own account', async () => {
    await put([{ description: 'B', quantity: 1, unitPrice: 10, itemId: X }, { description: 'A', quantity: 1, unitPrice: 10, itemId: X }]);
    expect(rows()).toEqual([[X, GY], [X, GX]]);
    again();
    await put([{ description: 'B', quantity: 1, unitPrice: 12, itemId: X }, { description: 'A', quantity: 1, unitPrice: 11, itemId: X }]);
    expect(rows()).toEqual([[X, GY], [X, GX]]);
  });

  it('A deleted, [B] re-priced: B keeps its own account (Y), not A\'s', async () => {
    await put([{ description: 'B', quantity: 1, unitPrice: 12, itemId: X }]);
    expect(rows()).toEqual([[X, GY]]);
  });
});

describe('M2 / M4: content decides first, twins of different items included', () => {
  beforeEach(() => { world.stored = [storedLine('s0', 1, X, GX, '10.00'), storedLine('s1', 2, Y, GY, '20.00')]; });

  it('a twin deleted, the other resent unchanged (no itemId): it keeps its own item and account, first or second', async () => {
    await put([svc(20)]);
    expect(rows()).toEqual([[Y, GY]]);
    again();
    await put([svc(10)]);
    expect(rows()).toEqual([[X, GX]]);
  });

  it('a line inserted at the top above unchanged twins: each twin keeps its own; the new line has none', async () => {
    await put([{ description: 'New', quantity: 1, unitPrice: 5 }, svc(10), svc(20)]);
    expect(rows()).toEqual([[null, null], [X, GX], [Y, GY]]);
  });

  it('a pure reorder of twins with their itemIds sent is accepted, even at one price', async () => {
    await put([svc(20, { itemId: Y }), svc(10, { itemId: X })]);
    expect(rows()).toEqual([[Y, GY], [X, GX]]);
    again();
    world.stored = [storedLine('s0', 1, X, GX, '10.00'), storedLine('s1', 2, Y, GY, '10.00')];
    await put([svc(10, { itemId: Y }), svc(10, { itemId: X })]);
    expect(rows()).toEqual([[Y, GY], [X, GX]]);
  });

  it('a twin deleted and the other re-priced: by place (the first); one unchanged, a second new beside it: ambiguous', async () => {
    await put([svc(25)]);
    expect(rows()).toEqual([[X, GX]]);
    await expect(put([svc(20), svc(30)])).rejects.toThrow(AMBIGUOUS);
  });
});

describe('L5: an id that is not this quote\'s is never guessed', () => {
  it('another quote\'s id, or one sent twice: refused, nothing written', async () => {
    world.stored = [named('l0', 1, 'A', X, GX, '10.00'), named('l1', 2, 'B', Y, GY, '10.00')];
    await expect(put([{ id: 'ffffffff-ffff-4fff-8fff-ffffffffffff', description: 'A', quantity: 1, unitPrice: 99 }])).rejects.toThrow(UNKNOWN_ID);
    await expect(put([{ id: 'l0', description: 'A', quantity: 1, unitPrice: 10 }, { id: 'L0', description: 'B', quantity: 1, unitPrice: 10 }]))
      .rejects.toThrow(UNKNOWN_ID);
    await expect(put([{ id: 7, description: 'A', quantity: 1, unitPrice: 10 }])).rejects.toThrow(UNKNOWN_ID);
    expect(wrote()).toBe(false);
  });

  it('an empty or null id is no id: the line is matched by the rule', async () => {
    world.stored = [named('l0', 1, 'A', X, GX, '10.00')];
    await put([{ id: '', description: 'A', quantity: 1, unitPrice: 12 }]);
    await put([{ id: null, description: 'A', quantity: 1, unitPrice: 12 }]);
    expect(rows()).toEqual([[X, GX], [X, GX]]);
  });
});

describe('L6: an unmatched line inherits no item from an identical stored line', () => {
  it('the stored line claimed by id elsewhere: the identical id-less line is NEW, with no item and no account', async () => {
    world.stored = [named('w', 1, 'W', X, GX, '100.00')];
    await put([{ id: 'w', description: 'W', quantity: 1, unitPrice: 130 }, { description: 'W', quantity: 1, unitPrice: 100 }]);
    expect(rows()).toEqual([[X, GX], [null, null]]);
  });

  it('[W unchanged, W @120] against [Other, W]: the identical one keeps W\'s item and account, the other is new', async () => {
    world.stored = [named('o', 1, 'Other', null, GY, '1.00'), named('w', 2, 'W', X, GX, '100.00')];
    await put([{ description: 'W', quantity: 1, unitPrice: 100 }, { description: 'W', quantity: 1, unitPrice: 120 }]);
    expect(rows()).toEqual([[X, GX], [null, null]]);
  });
});

describe('each step\'s edges (mutation-checked)', () => {
  it('content: identical twins of different items shifted by an insert (no itemIds): saved, both twins\' items and accounts kept', async () => {
    // Round 14 (as M4): nothing tells identical twins apart, so their order among themselves is accepted (L3); neither is lost.
    world.stored = [storedLine('s0', 1, X, GX, '10.00'), storedLine('s1', 2, Y, GY, '10.00')];
    await put([{ description: 'New', quantity: 1, unitPrice: 5 }, svc(10), svc(10)]);
    const [first, ...twins] = rows();
    expect(first).toEqual([null, null]);
    expect(twins.map((r) => r.join('|')).sort()).toEqual([`${X}|${GX}`, `${Y}|${GY}`].sort());
  });

  it('content: two lines inserted above identical twins of different items and one twin deleted (which?): refused', async () => {
    world.stored = [storedLine('s0', 1, X, GX, '10.00'), storedLine('s1', 2, Y, GY, '10.00')];
    await expect(put([{ description: 'New', quantity: 1, unitPrice: 5 }, { description: 'Other', quantity: 1, unitPrice: 6 }, svc(10)]))
      .rejects.toThrow(AMBIGUOUS);
    expect(wrote()).toBe(false);
  });

  it('content: identical twins of different items, one re-priced after an insert above them: refused', async () => {
    world.stored = [storedLine('s0', 1, X, GX, '10.00'), storedLine('s1', 2, Y, GY, '10.00')];
    await expect(put([{ description: 'New', quantity: 1, unitPrice: 5 }, svc(10), svc(15)])).rejects.toThrow(AMBIGUOUS);
    expect(wrote()).toBe(false);
  });

  it('place: naming the item of a twin already claimed by id re-items the line at its place (no ambiguity left)', async () => {
    world.stored = [storedLine('s0', 1, X, GX, '10.00'), storedLine('s1', 2, Y, GY, '20.00')];
    await put([svc(10, { id: 's0' }), svc(25, { itemId: X })]);
    expect(rows()).toEqual([[X, GX], [X, GY]]);
  });

  it('place: twins of one item but different accounts, re-priced in place naming that item, keep their places', async () => {
    world.stored = [storedLine('s0', 1, X, GX, '10.00'), storedLine('s1', 2, X, GY, '20.00')];
    await put([svc(15, { itemId: X }), svc(25, { itemId: X })]);
    expect(rows()).toEqual([[X, GX], [X, GY]]);
  });

  it('twins of different items all claimed by id: one more line of the description is a new line, not refused', async () => {
    world.stored = [storedLine('s0', 1, X, GX, '10.00'), storedLine('s1', 2, Y, GY, '20.00')];
    await put([svc(10, { id: 's0' }), svc(20, { id: 's1' }), svc(30)]);
    expect(rows()).toEqual([[X, GX], [Y, GY], [null, null]]);
  });

  it('renamed: a description a stored line holds (claimed by id) never takes the line at its place by item', async () => {
    world.stored = [named('l0', 1, 'A', X, GX, '10.00'), named('l1', 2, 'B', X, GY, '10.00')];
    await put([{ description: 'B', quantity: 1, unitPrice: 12, itemId: X }, { id: 'l1', description: 'B', quantity: 1, unitPrice: 10 }]);
    expect(rows()).toEqual([[X, null], [X, GY]]);
  });
});

describe('round 14: a line unchanged in its own place keeps it (an edit making another line identical never takes it)', () => {
  it('H1: A renamed to B while B stays unchanged in place: B keeps its item and account, the renamed line is new', async () => {
    world.stored = [named('l0', 1, 'A', X, GX, '10.00'), named('l1', 2, 'B', Y, GY, '10.00')];
    await put([{ description: 'B', quantity: 1, unitPrice: 10 }, { description: 'B', quantity: 1, unitPrice: 10 }]);
    expect(rows()).toEqual([[null, null], [Y, GY]]);
    again();
    world.stored = [named('l0', 1, 'A', X, GX, '10.00'), named('l1', 2, 'B', X, GY, '10.00')];
    await put([{ description: 'B', quantity: 1, unitPrice: 10, itemId: X }, { description: 'B', quantity: 1, unitPrice: 10, itemId: X }]);
    expect(rows()).toEqual([[X, null], [X, GY]]);
  });

  it('M1: identical twins and a third, the first re-priced in place: saved, each keeps its own account', async () => {
    world.stored = [storedLine('s0', 1, X, GX, '10.00'), storedLine('s1', 2, X, GX, '10.00'), storedLine('s2', 3, X, GY, '20.00')];
    await put([svc(15, { itemId: X }), svc(10, { itemId: X }), svc(20, { itemId: X })]);
    expect(rows()).toEqual([[X, GX], [X, GX], [X, GY]]);
  });

  it('M2: the first line\'s item changed so it is identical to the third: saved, the third keeps its own', async () => {
    world.stored = [storedLine('s0', 1, X, GX, '10.00'), storedLine('s1', 2, X, GX, '20.00'), storedLine('s2', 3, Y, GY, '10.00')];
    await put([svc(10, { itemId: Y }), svc(20, { itemId: X }), svc(10, { itemId: Y })]);
    expect(rows()).toEqual([[Y, GX], [X, GX], [Y, GY]]);
  });

  it('M3: the first re-priced onto its twin\'s price: saved, each keeps its own item and account', async () => {
    world.stored = [storedLine('s0', 1, X, GX, '10.00'), storedLine('s1', 2, Y, GY, '20.00')];
    await put([svc(20), svc(20)]);
    expect(rows()).toEqual([[X, GX], [Y, GY]]);
  });

  it('L1: an explicit null item at a place where a twin with no item and another account is free: refused; same account: saved', async () => {
    world.stored = [storedLine('s0', 1, X, GX, '10.00'), storedLine('s1', 2, X, GX, '20.00'), storedLine('s2', 3, null, GY, '10.00')];
    await expect(put([svc(10, { itemId: X }), svc(15, { itemId: null })])).rejects.toThrow(AMBIGUOUS);
    await expect(put([svc(10, { itemId: X }), svc(15, { itemId: '' })])).rejects.toThrow(AMBIGUOUS);
    expect(wrote()).toBe(false);
    world.stored = [storedLine('s0', 1, X, GX, '10.00'), storedLine('s1', 2, X, GX, '20.00'), storedLine('s2', 3, null, GX, '10.00')];
    await put([svc(10, { itemId: X }), svc(15, { itemId: null })]);
    expect(rows()).toEqual([[X, GX], [null, GX]]);
  });

  it('L2: a unique legacy line resent at another rate keeps its item and account, and is re-priced at that rate', async () => {
    world.stored = [{ ...storedLine('s0', 1, X, GX, '100.00'), vat_type: null, tax_amount: null }];
    await put([{ description: 'Svc', quantity: 1, unitPrice: 100, taxRate: 0 }]);
    expect(rows()).toEqual([[X, GX]]);
    expect(inserted('customer_quote_lines').map((l) => Number(l.tax_amount))).toEqual([0]);
  });
});
