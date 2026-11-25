/**
 * Per-line VAT on quotes, the EDIT's item and account per line (quoteLineTax.lineRefs; review round 10, split from
 * quoteServiceVatEdit.test.ts at the 300-line cap): on a standard-only quote twins of different items re-priced and
 * reordered are refused unless ids are sent (round 12; the round-13 order is in quoteServiceVatOrder.test), and a matched
 * line's "new item" is judged against THE MATCHED stored line, so the account written is the matched line's or its new
 * item's default.
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
import { ItemLineRefusal } from '@/modules/accounting/services/items/itemLineDefaults';

beforeEach(resetWorld);

const [X, Y] = [ITEM_ID, ITEM_B];
const [GX, GY, DX, DY] = ['a1a1a1a1-0000-4000-8000-000000000001', 'a1a1a1a1-0000-4000-8000-000000000002',
  'a1a1a1a1-0000-4000-8000-000000000003', 'a1a1a1a1-0000-4000-8000-000000000004'];
const storedLine = (id: string, sort: number, item: string | null, account: string, price: string) => ({
  id, quote_id: QUOTE_ID, sort_order: sort, description: 'Svc', quantity: '1.00', unit_price: price, amount: price,
  tax_rate: '15', vat_type: 'standard', tax_amount: String(Number(price) * 0.15), gl_account_id: account, item_id: item,
});
const rows = () => inserted('customer_quote_lines').map((l) => [l.item_id, l.gl_account_id]);
const put = (lines: Record<string, unknown>[]) => updateQuote(COMPANY_ID, QUOTE_ID, { customerName: 'Acme', lines } as never, 'u1');

const AMBIGUOUS = /more than one line of this description with different items or accounts/;

describe('round 12 structural rule: twins of different items pair only by place, id, or an explicit itemId + accountId', () => {
  it.each([[false], [true]])('twins reordered and re-priced with no ids: refused, nothing written (item defaults: %s)', async (defaults) => {
    if (defaults) { world.itemAccount = DX; world.itemBAccount = DY; }
    world.stored = [storedLine('s0', 1, X, GX, '100.00'), storedLine('s1', 2, Y, GY, '200.00')];
    await expect(put([{ description: 'Svc', quantity: 1, unitPrice: 250, itemId: Y }, { description: 'Svc', quantity: 1, unitPrice: 150, itemId: X }]))
      .rejects.toThrow(AMBIGUOUS);
    expect(wrote()).toBe(false);
  });

  it('the same edit by id keeps each line\'s own item and account', async () => {
    world.stored = [storedLine('s0', 1, X, GX, '100.00'), storedLine('s1', 2, Y, GY, '200.00')];
    await put([{ id: 's1', description: 'Svc', quantity: 1, unitPrice: 250, itemId: Y }, { id: 's0', description: 'Svc', quantity: 1, unitPrice: 150, itemId: X }]);
    expect(rows()).toEqual([[Y, GY], [X, GX]]);
  });

  it('twins re-priced in their own places keep their items and accounts; an explicit itemId + accountId is never refused', async () => {
    world.stored = [storedLine('s0', 1, X, GX, '100.00'), storedLine('s1', 2, Y, GY, '200.00')];
    await put([{ description: 'Svc', quantity: 1, unitPrice: 110 }, { description: 'svc ', quantity: 1, unitPrice: 210 }]);
    expect(rows()).toEqual([[X, GX], [Y, GY]]);
    resetWorld();
    world.stored = [storedLine('s0', 1, X, GX, '100.00'), storedLine('s1', 2, Y, GY, '200.00')];
    await put([{ description: 'Svc', quantity: 1, unitPrice: 250, itemId: Y, accountId: GY }, { description: 'Svc', quantity: 1, unitPrice: 150, itemId: X, accountId: GX }]);
    expect(rows()).toEqual([[Y, GY], [X, GX]]);
  });

  it('MEDIUM: [no item 110, itemId X 210] against s0 X / s1 Y: line 1 names the item its twin carries: refused', async () => {
    world.stored = [storedLine('s0', 1, X, GX, '100.00'), storedLine('s1', 2, Y, GY, '200.00')];
    await expect(put([{ description: 'Svc', quantity: 1, unitPrice: 110 }, { description: 'Svc', quantity: 1, unitPrice: 210, itemId: X }])).rejects.toThrow(AMBIGUOUS);
    await expect(put([{ description: 'Svc', quantity: 1, unitPrice: 110, itemId: null }, { description: 'Svc', quantity: 1, unitPrice: 210, itemId: X }])).rejects.toThrow(AMBIGUOUS);
    expect(wrote()).toBe(false);
  });

  it('Cases A / B (a line naming the item its twin carries, by place): refused', async () => {
    world.stored = [storedLine('s0', 1, X, GX, '100.00'), storedLine('s1', 2, Y, GY, '200.00')];
    await expect(put([{ description: 'Svc', quantity: 1, unitPrice: 250, itemId: Y }, { description: 'Svc', quantity: 1, unitPrice: 150 }])).rejects.toThrow(AMBIGUOUS);
    world.stored = [storedLine('s0', 1, null, GX, '100.00'), storedLine('s1', 2, Y, GY, '200.00')];
    await expect(put([{ description: 'Svc', quantity: 1, unitPrice: 250, itemId: Y }, { description: 'Svc', quantity: 1, unitPrice: 150, itemId: null }])).rejects.toThrow(AMBIGUOUS);
    expect(wrote()).toBe(false);
  });

  it('three twins [X, Y, Y]: resent re-priced in place keep theirs; sent [Y, Y, X] is refused', async () => {
    world.stored = [storedLine('s0', 1, X, GX, '100.00'), storedLine('s1', 2, Y, GY, '100.00'), storedLine('s2', 3, Y, GY, '100.00')];
    const three = (items: (string | undefined)[], price: number) => items.map((itemId) => ({ description: 'Svc', quantity: 1, unitPrice: price, ...(itemId ? { itemId } : {}) }));
    await put(three([undefined, undefined, undefined], 120));
    expect(rows()).toEqual([[X, GX], [Y, GY], [Y, GY]]);
    await expect(put(three([Y, Y, X], 120))).rejects.toThrow(AMBIGUOUS);
  });

  it('not at their places (a line deleted above): twins of different items are refused; interchangeable twins pair freely', async () => {
    const other = { ...storedLine('o', 1, null, GX, '1.00'), description: 'Other' };
    const two = [{ description: 'Svc', quantity: 1, unitPrice: 120 }, { description: 'Svc', quantity: 1, unitPrice: 130 }];
    world.stored = [other, storedLine('s1', 2, X, GX, '100.00'), storedLine('s2', 3, Y, GY, '100.00')];
    await expect(put(two)).rejects.toThrow(AMBIGUOUS);
    world.stored = [other, storedLine('s1', 2, X, GX, '100.00'), storedLine('s2', 3, X, GY, '100.00')];
    await expect(put(two)).rejects.toThrow(AMBIGUOUS); // one item, different accounts: still told apart by nothing
    world.stored = [other, storedLine('s1', 2, X, GX, '100.00'), storedLine('s2', 3, X, GX, '100.00')];
    await put(two);
    expect(rows()).toEqual([[X, GX], [X, GX]]);
  });

  it('a line renamed at its place naming the item a twin of that place carries is a new line, not refused', async () => {
    world.stored = [storedLine('s0', 1, X, GX, '100.00'), storedLine('s1', 2, Y, GY, '200.00')];
    await put([{ description: 'Other', quantity: 1, unitPrice: 100, itemId: Y }, { description: 'Svc', quantity: 1, unitPrice: 210 }]);
    expect(rows()).toEqual([[Y, null], [Y, GY]]);
  });

  it('a unique description pairs anywhere (moved); a line renamed at its place naming the place\'s own item keeps its account', async () => {
    world.stored = [{ ...storedLine('h', 1, null, GY, '50.00'), description: 'Hosting' }, storedLine('s1', 2, X, GX, '100.00')];
    await put([{ description: 'Svc', quantity: 1, unitPrice: 120 }, { description: 'Hosting', quantity: 1, unitPrice: 60 }]);
    expect(rows()).toEqual([[X, GX], [null, GY]]);
    resetWorld();
    world.stored = [storedLine('s0', 1, X, GX, '100.00')];
    await put([{ description: 'Svc (Nov)', quantity: 1, unitPrice: 100, itemId: X }]);
    expect(rows()).toEqual([[X, GX]]);
  });
});

describe('a matched line\'s new item is judged against the MATCHED stored line', () => {
  const twins = () => [storedLine('s0', 1, X, GX, '100.00'), storedLine('s1', 2, Y, GY, '100.00')];

  it('S1 (item Y) sent by id naming X: X is new to S1, so X\'s default account; with none, S1\'s account', async () => {
    world.itemAccount = DX;
    world.stored = twins();
    await put([{ id: 's1', description: 'Svc', quantity: 1, unitPrice: 100, itemId: X }]);
    expect(rows()).toEqual([[X, DX]]);
    resetWorld();
    world.stored = twins();
    await put([{ id: 's1', description: 'Svc', quantity: 1, unitPrice: 100, itemId: X }]);
    expect(rows()).toEqual([[X, GY]]);
  });

  it('S1 sent by id naming its own item Y (Y has default DY): not new, S1\'s account GY stays', async () => {
    world.itemBAccount = DY;
    world.stored = twins();
    await put([{ id: 's1', description: 'Svc', quantity: 1, unitPrice: 100, itemId: Y }]);
    expect(rows()).toEqual([[Y, GY]]);
  });
});

describe('by place: an item-less line or stored line pairs at its own place', () => {
  const G0 = 'a1a1a1a1-0000-4000-8000-000000000010';
  const G2 = 'a1a1a1a1-0000-4000-8000-000000000012';
  it('two item-less lines re-priced against [none, X, none]: the second keeps s1 (X, GX) by place, not the item-less s2', async () => {
    world.stored = [storedLine('s0', 1, null, G0, '100.00'), storedLine('s1', 2, X, GX, '100.00'), storedLine('s2', 3, null, G2, '100.00')];
    await put([{ description: 'Svc', quantity: 1, unitPrice: 250 }, { description: 'Svc', quantity: 1, unitPrice: 150 }]);
    expect(rows()).toEqual([[null, G0], [X, GX]]);
  });
  it('a line naming a new item fits an item-less stored line at its place (its account kept: X has no default)', async () => {
    world.stored = [storedLine('s0', 1, null, G0, '100.00'), storedLine('s1', 2, null, G2, '100.00')];
    await put([{ description: 'Svc', quantity: 1, unitPrice: 250 }, { description: 'Svc', quantity: 1, unitPrice: 150, itemId: X }]);
    expect(rows()).toEqual([[null, G0], [X, G2]]);
  });
});

describe('round 11: the item check judges "new" against the matched stored line too', () => {
  it('LOW 1: s1 sent by id naming its own item Y, Y deactivated since, saves (not re-checked), item Y and GY', async () => {
    world.inactiveItems.add(Y);
    world.stored = [storedLine('s0', 1, X, GX, '100.00'), storedLine('s1', 2, Y, GY, '100.00')];
    await put([{ id: 's1', description: 'Svc', quantity: 1, unitPrice: 100, itemId: Y }]);
    expect(rows()).toEqual([[Y, GY]]);
  });

  it('LOW 1 (round 12): s1 sent by id naming X, which only its twin s0 carries: X is NEW to s1 and checked (inactive: refused)', async () => {
    world.inactiveItems.add(X);
    world.stored = [storedLine('s0', 1, X, GX, '100.00'), storedLine('s1', 2, Y, GY, '100.00')];
    await expect(put([{ id: 's1', description: 'Svc', quantity: 1, unitPrice: 100, itemId: X, accountId: GY }])).rejects.toThrow(/inactive item/);
    expect(wrote()).toBe(false);
  });

  it('a genuinely NEW item is still checked: inactive, another company\'s, or with an inactive default account: refused, nothing written', async () => {
    const edit = () => put([{ description: 'Svc', quantity: 1, unitPrice: 100, itemId: Y }]);
    for (const [arrange, why] of [
      [() => world.inactiveItems.add(Y), /inactive item/],
      [() => world.foreignItems.add(Y), /not an item of your company/],
      [() => { world.itemBAccount = DY; world.inactiveAccounts.add(DY); }, /not an active account/],
    ] as const) {
      resetWorld();
      world.stored = [storedLine('s0', 1, X, GX, '100.00')];
      arrange();
      await expect(edit()).rejects.toThrow(ItemLineRefusal);
      await expect(edit()).rejects.toThrow(why);
      expect(wrote()).toBe(false);
    }
  });
});

