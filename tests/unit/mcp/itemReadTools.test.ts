/**
 * list_items (rewritten), get_item and list_item_categories (Phase A): read:items, keyset cursor on (code, id), the
 * filters a migration needs, the canonical item shape, the company from the token only, and the refusals that stop an
 * agent's typo reaching a cast (a read tool has no savepoint).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/neon', () => {
  const sqlFn = Object.assign(vi.fn(), { transaction: vi.fn() });
  return { sql: sqlFn, withSavepoint: vi.fn(async (_n: string, cb: () => unknown) => cb()), withTransaction: vi.fn((cb: (tx: typeof sqlFn) => unknown) => cb(sqlFn)) };
});
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));

import { listItemsTool, getItemTool, listItemCategoriesTool } from '@/lib/mcp/tools/itemReadTools';
import { decodeCursor, encodeCursor } from '@/lib/mcp/contracts';
import { ACC, COMPANY, OTHER, ctxOf, installFakeSql, sqlMock, type FakeDb } from './itemToolsHarness';

let db: FakeDb;
const ctx = ctxOf(['read:items']);
const json = (r: { content: Array<{ text: string }> }) => JSON.parse(r.content[0]!.text);
const lastValues = (): unknown[] => (sqlMock as unknown as { mock: { calls: unknown[][] } }).mock.calls.flatMap((c) => c.slice(1));

const row = (n: number, over: Record<string, unknown> = {}) => ({
  id: `aaaaaaaa-0000-4000-8000-${String(n).padStart(12, '0')}`, code: `C${n}`, description: `Item ${n}`, item_type: 'physical', unit: 'each',
  category_id: null, category_code: null, category_name: null, is_active: true, cost_price: '10.00', selling_price_excl: '15.00',
  vat_on_sales: 'standard', vat_on_purchases: 'standard', sales_account_id: ACC, purchases_account_id: null, inventory_tracked: false,
  external_system: 'sage', external_ref: String(n), external_document_number: null, notes: 'n', updated_at: new Date('2026-11-18T08:00:00Z'), ...over,
});

beforeEach(() => { db = installFakeSql(); });

describe('registration', () => {
  it('all three are read-only and need read:items (not read:reports)', () => {
    for (const t of [listItemsTool, getItemTool, listItemCategoriesTool]) {
      expect(t.scope).toBe('read:items');
      expect(t.write).toBe(false);
    }
  });
});

describe('list_items', () => {
  it('returns the canonical shape: purchase_price / sales_price, accounts, tracked flag and the external reference', async () => {
    db.reads.count = [{ n: 1 }];
    db.reads.items = [row(1, { category_id: 'cat', category_code: 'optics', category_name: 'Optics' })];
    const env = json(await listItemsTool.handler({}, ctx));
    expect(env.rows).toEqual([{
      id: row(1).id, code: 'C1', description: 'Item 1', item_type: 'physical', unit: 'each', category_id: 'cat', category_code: 'optics',
      category_name: 'Optics', purchase_price: 10, sales_price: 15, vat_on_sales: 'standard', vat_on_purchases: 'standard',
      sales_account_id: ACC, purchases_account_id: null, inventory_tracked: false, is_active: true, external_system: 'sage',
      external_ref: '1', external_document_number: null,
    }]);
    expect(env.rowsTotal).toBe(1);
    expect(env.truncated).toBe(false);
    expect(env.next_cursor).toBeNull();
    expect(env.completenessFault).toBeUndefined();
  });

  it('pages by cursor: a full page names the last row served, and the cursor is sent back as (code, id)', async () => {
    db.reads.count = [{ n: 3 }];
    db.reads.items = [row(1), row(2), row(3)]; // limit + 1 rows come back when more remain
    const env = json(await listItemsTool.handler({ limit: 2 }, ctx));
    expect(env.rows.map((r: { code: string }) => r.code)).toEqual(['C1', 'C2']);
    expect(env.rowsTotal).toBe(3);
    expect(env.truncated).toBe(true);
    expect(decodeCursor(env.next_cursor, 2)).toEqual({ parts: ['C2', row(2).id] });

    sqlMock.mockClear();
    db.reads.items = [row(3)];
    const next = json(await listItemsTool.handler({ limit: 2, cursor: env.next_cursor }, ctx));
    expect(next.next_cursor).toBeNull();
    expect(lastValues()).toEqual(expect.arrayContaining(['C2', row(2).id]));
  });

  it('refuses a malformed cursor, a bad id, a bad type and non-boolean flags before any query', async () => {
    for (const args of [{ cursor: 'garbage' }, { cursor: encodeCursor({ parts: ['only-one'] }) }, { category_id: 'abc' }, { type: "x' OR '1'='1" }, { is_active: 'true' }, { inventory_tracked: 1 }, { external_ref: '5' }]) {
      sqlMock.mockClear();
      const r = await listItemsTool.handler(args, ctx);
      expect(r.isError, JSON.stringify(args)).toBe(true);
      expect(sqlMock).not.toHaveBeenCalled();
    }
  });

  it('passes the filters and the TOKEN\'s company to the query; a company_id argument is ignored', async () => {
    await listItemsTool.handler({
      q: '50%', type: 'service', category_id: ACC, is_active: false, inventory_tracked: true, external_system: 'SAGE', external_ref: '7', company_id: OTHER,
    }, ctx);
    const values = lastValues();
    expect(values).toEqual(expect.arrayContaining([COMPANY, 'service', ACC, false, true, 'sage', '7', '%50\\%%']));
    expect(values).not.toContain(OTHER);
  });

  it('detail summary returns totals only', async () => {
    db.reads.count = [{ n: 7 }];
    db.reads.items = [row(1), row(2)];
    const env = json(await listItemsTool.handler({ detail: 'summary' }, ctx));
    expect(env.rows).toEqual([]);
    expect(env.rowsTotal).toBe(7);
    expect(env.next_cursor).toBeNull();
  });

  it('keeps a worst-case page under the read result limit', async () => {
    db.reads.count = [{ n: 5000 }];
    db.reads.items = Array.from({ length: 51 }, (_, i) => row(i, {
      description: 'D'.repeat(5000), code: 'K'.repeat(50), unit: 'u'.repeat(50), category_name: 'N'.repeat(255), external_ref: 'R'.repeat(128), external_document_number: 'X'.repeat(64),
    }));
    const r = await listItemsTool.handler({ limit: 1000 }, ctx); // clamped to the maximum
    expect(json(r).rows).toHaveLength(50);
    expect(json(r).rows[0].description).toHaveLength(255);
    expect(Buffer.byteLength(r.content[0]!.text)).toBeLessThan(90_000);
  });
});

describe('get_item', () => {
  it('gets one item by id, by code or by external reference, with notes', async () => {
    db.reads.items = [row(1)];
    for (const args of [{ item_id: row(1).id }, { code: 'C1' }, { external_system: 'sage', external_ref: '1' }]) {
      const r = json(await getItemTool.handler(args, ctx));
      expect(r.item).toMatchObject({ code: 'C1', notes: 'n', purchase_price: 10 });
    }
  });

  it('wants exactly one way to name the item', async () => {
    for (const args of [{}, { item_id: row(1).id, code: 'C1' }, { external_ref: '1' }, { item_id: 'nope' }]) {
      expect((await getItemTool.handler(args, ctx)).isError, JSON.stringify(args)).toBe(true);
    }
  });

  it('answers a miss, and another company\'s item, with the same generic text', async () => {
    db.reads.items = [];
    expect((await getItemTool.handler({ item_id: row(1).id }, ctx)).content[0]!.text).toBe('Not found');
    expect(lastValues()).toContain(COMPANY);
  });
});

describe('list_item_categories', () => {
  it('lists categories with their item counts and filters by is_active', async () => {
    db.reads.categories = [
      { id: 'c1', code: 'optics', name: 'Optics', description: null, is_active: true, external_system: null, external_ref: null, item_count: 4 },
      { id: 'c2', code: null, name: 'Old', description: 'x', is_active: false, external_system: 'sage', external_ref: '9', item_count: 0 },
    ];
    const all = json(await listItemCategoriesTool.handler({}, ctx));
    expect(all.total).toBe(2);
    expect(all.categories[0]).toEqual({ id: 'c1', code: 'optics', name: 'Optics', description: null, is_active: true, external_system: null, external_ref: null, item_count: 4 });
    const inactive = json(await listItemCategoriesTool.handler({ is_active: false }, ctx));
    expect(inactive.categories.map((c: { id: string }) => c.id)).toEqual(['c2']);
    expect((await listItemCategoriesTool.handler({ is_active: 'no' }, ctx)).isError).toBe(true);
  });
});
