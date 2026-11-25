/**
 * Per-line VAT on quotes, the EDIT's item and account per line (quoteLineTax.lineRefs; review round 10, split from
 * quoteServiceVatEdit.test.ts at the 300-line cap): on a standard-only quote twins of different items re-priced and
 * reordered pair by item, and a matched line's "new item" is judged against THE MATCHED stored line, never against
 * itemEditLines' first identical one, so the account written is the matched line's or its new item's default.
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
import { COMPANY_ID, ITEM_B, ITEM_ID, QUOTE_ID, inserted, resetWorld, world } from './helpers/quoteVatWorld';

beforeEach(resetWorld);

const [X, Y] = [ITEM_ID, ITEM_B];
const [GX, GY, DX, DY] = ['a1a1a1a1-0000-4000-8000-000000000001', 'a1a1a1a1-0000-4000-8000-000000000002',
  'a1a1a1a1-0000-4000-8000-000000000003', 'a1a1a1a1-0000-4000-8000-000000000004'];
const storedLine = (id: string, sort: number, item: string, account: string, price: string) => ({
  id, quote_id: QUOTE_ID, sort_order: sort, description: 'Svc', quantity: '1.00', unit_price: price, amount: price,
  tax_rate: '15', vat_type: 'standard', tax_amount: String(Number(price) * 0.15), gl_account_id: account, item_id: item,
});
const rows = () => inserted('customer_quote_lines').map((l) => [l.item_id, l.gl_account_id]);
const put = (lines: Record<string, unknown>[]) => updateQuote(COMPANY_ID, QUOTE_ID, { customerName: 'Acme', lines } as never, 'u1');

describe('a standard-only quote\'s twins of different items, reordered and re-priced, pair by item', () => {
  it.each([[false], [true]])('each line keeps its own item\'s account (items with default accounts: %s)', async (defaults) => {
    if (defaults) { world.itemAccount = DX; world.itemBAccount = DY; }
    world.stored = [storedLine('s0', 1, X, GX, '100.00'), storedLine('s1', 2, Y, GY, '200.00')];
    await put([{ description: 'Svc', quantity: 1, unitPrice: 250, itemId: Y }, { description: 'Svc', quantity: 1, unitPrice: 150, itemId: X }]);
    expect(rows()).toEqual([[Y, GY], [X, GX]]);
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
