/**
 * A draft edit REPLACES every line (supplier bill, customer invoice, quote). Item links (migration 1005) must survive that
 * the way the create paths set them (src: items/itemEditLines.ts):
 *  - a line that names an item the stored line did not carry is CHECKED (this company's, active) and, with no account of
 *    its own, takes the item's default account (purchases for a bill, sales for an invoice / quote);
 *  - a line sent WITHOUT item_id inherits the item of an identical stored line (description, quantity, unit price; each
 *    stored line used once) and is NOT re-checked: an item deactivated since must not refuse every save of the draft;
 *  - item_id null clears the link; a changed line loses its link.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/neon', () => ({ sql: vi.fn() }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));

import { sql } from '@/lib/neon';
import { ItemLineRefusal } from '@/modules/accounting/services/items/itemLineDefaults';
import { resolveEditLineItems } from '@/modules/accounting/services/items/itemEditLines';

const COMPANY = '22222222-2222-4222-8222-222222222222';
const ITEM_A = '33333333-3333-4333-8333-333333333333';
const ITEM_B = '44444444-4444-4444-8444-444444444444';
const ACC_S = '55555555-5555-4555-8555-555555555555';
const ACC_P = '66666666-6666-4666-8666-666666666666';
const OWN = '77777777-7777-4777-8777-777777777777';
const label = (i: number) => `lines[${i}]`;
const sqlMock = vi.mocked(sql) as unknown as ReturnType<typeof vi.fn>;

function db(items: Array<Record<string, unknown>>) {
  sqlMock.mockReset();
  sqlMock.mockImplementation(async (strings: ReadonlyArray<string>, ...values: unknown[]) => {
    const text = strings.join('?');
    if (text.includes('FROM items')) return items;
    if (text.includes('FROM gl_accounts')) return (values[1] as string[]).map((id) => ({ id, is_active: true }));
    return [];
  });
}
const item = (id: string, over: Record<string, unknown> = {}) => ({ id, is_active: true, sales_account_id: ACC_S, purchases_account_id: ACC_P, ...over });
const stored = (itemId: string | null, description = 'Fibre', quantity = 2, unitPrice = 10) => ({ itemId, description, quantity, unitPrice });
const line = (over: Record<string, unknown> = {}) => ({ description: 'Fibre', quantity: 2, unitPrice: 10, ...over });
const itemReads = () => sqlMock.mock.calls.filter((c: unknown[]) => (c[0] as string[]).join('?').includes('FROM items')).length;

beforeEach(() => db([item(ITEM_A), item(ITEM_B)]));

describe('resolveEditLineItems', () => {
  it('a line that names a NEW item takes its default account (sales / purchases) and is checked', async () => {
    const [s] = await resolveEditLineItems(COMPANY, 'sales', [line({ itemId: ITEM_A })], [], label);
    expect(s).toMatchObject({ itemId: ITEM_A, glAccountId: ACC_S });
    const [p] = await resolveEditLineItems(COMPANY, 'purchase', [line({ itemId: ITEM_A })], [], label);
    expect(p).toMatchObject({ itemId: ITEM_A, glAccountId: ACC_P });
  });

  it('the account the line names itself wins', async () => {
    const [l] = await resolveEditLineItems(COMPANY, 'sales', [line({ itemId: ITEM_A, glAccountId: OWN })], [], label);
    expect(l!.glAccountId).toBe(OWN);
  });

  it('a line sent without item_id inherits the item of an identical stored line, and is NOT re-checked', async () => {
    db([item(ITEM_A, { is_active: false })]); // deactivated since: a re-save of the unchanged draft must still work
    const out = await resolveEditLineItems(COMPANY, 'sales', [line()], [stored(ITEM_A)], label);
    expect(out[0]).toMatchObject({ itemId: ITEM_A });
    expect(out[0]!.glAccountId).toBeUndefined();
    expect(itemReads()).toBe(0);
  });

  it('each stored line is used once: two identical sent lines, one stored link -> one inherits', async () => {
    const out = await resolveEditLineItems(COMPANY, 'sales', [line(), line()], [stored(ITEM_A)], label);
    expect(out.map((l) => l.itemId)).toEqual([ITEM_A, undefined]);
  });

  it('a changed line (price, quantity or description) loses the link; a null item_id clears it', async () => {
    const out = await resolveEditLineItems(COMPANY, 'sales',
      [line({ unitPrice: 11 }), line({ quantity: 3 }), line({ description: 'Other' }), line({ itemId: null })],
      [stored(ITEM_A), stored(ITEM_A), stored(ITEM_A), stored(ITEM_A)], label);
    expect(out.map((l) => l.itemId)).toEqual([undefined, undefined, undefined, null]);
  });

  it('re-sending the item the identical stored line already carries is not re-checked either', async () => {
    db([item(ITEM_A, { is_active: false })]);
    const out = await resolveEditLineItems(COMPANY, 'purchase', [line({ itemId: ITEM_A.toUpperCase() })], [stored(ITEM_A)], label);
    expect(out[0]!.itemId?.toLowerCase()).toBe(ITEM_A);
    expect(itemReads()).toBe(0);
  });

  it('refuses an inactive item, another company\'s item (read is company-scoped) and a changed-to item', async () => {
    db([item(ITEM_B, { is_active: false })]);
    await expect(resolveEditLineItems(COMPANY, 'sales', [line({ itemId: ITEM_B })], [stored(ITEM_A)], label)).rejects.toThrow(/lines\[0\]\.item_id is an inactive item/);
    db([]);
    await expect(resolveEditLineItems(COMPANY, 'sales', [line({ itemId: ITEM_B })], [], label)).rejects.toThrow(ItemLineRefusal);
    expect(sqlMock.mock.calls[0]!.slice(1)).toContain(COMPANY);
  });

  it('numbers compare as the columns hold them (quantity 4 places, price 2)', async () => {
    const out = await resolveEditLineItems(COMPANY, 'sales', [line({ quantity: '2.0000', unitPrice: 10.004 })], [stored(ITEM_A, 'Fibre', 2, 10)], label);
    expect(out[0]!.itemId).toBe(ITEM_A);
  });
});

describe('item VAT on an edit', () => {
  it('a NEW item line with no rate takes the item\'s rate; an inherited line, and a line with a rate, keep theirs', async () => {
    db([item(ITEM_B, { vat_on_purchases: 'zero' })]);
    const out = await resolveEditLineItems(COMPANY, 'purchase',
      [line({ itemId: ITEM_B }), line({ itemId: ITEM_B, taxRate: 15, description: 'b' }), line({ description: 'c' })],
      [stored(ITEM_A, 'c')], label, { deriveTax: true });
    expect(out[0]).toMatchObject({ itemId: ITEM_B, taxRate: 0, vatClassification: 'zero_rated' });
    expect(out[1]).toMatchObject({ taxRate: 15 });
    expect(out[2]).toMatchObject({ itemId: ITEM_A });
    expect(out[2]!.taxRate).toBeUndefined();
  });
});

describe('an empty item_id on a draft edit', () => {
  it('is no item: it clears like null instead of being cast to a uuid', async () => {
    const out = await resolveEditLineItems(COMPANY, 'purchase', [line({ itemId: '' })], [stored(ITEM_A)], label);
    expect(out[0]!.itemId).toBeNull();
  });
});
