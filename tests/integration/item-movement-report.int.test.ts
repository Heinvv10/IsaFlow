/**
 * The item-movement report (pages/api/accounting/reports/item-movement.ts; Codex gate at 42de08b3, findings 1 and 2), real PostgreSQL,
 * as app_user through the real route:
 *   - a receipt from before the receipt copied its PO line's product (grn_items.product_id NULL; 1021 backfills nothing) is still
 *     shown: the product is resolved at read time through the item's own PO line (company-scoped through the PO, the product checked
 *     to be the company's), in the unfiltered report and filtered by item_id;
 *   - the running balance is per product: 10 of A then 2 of B shows B at 2, not 12, in the data and in the CSV.
 * Fixture route: isaflow_schema_fixture (assertDisposable). Never skips.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { callRoute, dropBillFixture, seedBillFixture, type BillFixture } from './helpers/budgetBillFixture';
import { callTool, dropGrnExtras, dropMaintExtras, grnArgs, seedQtyPo } from './helpers/grnHarness';
import { createGoodsReceivedTool as create } from '@/lib/mcp/tools/writeCreateGoodsReceived';
import itemMovementRoute from '../../pages/api/accounting/reports/item-movement';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
let f: BillFixture;
let other: BillFixture;
const products: string[] = [];

beforeAll(async () => { f = await seedBillFixture(pool, 'item-movement'); other = await seedBillFixture(pool, 'item-movement-other'); }, 60_000);
afterAll(async () => {
  try {
    await dropGrnExtras(pool, f);
    await dropMaintExtras(pool, f);
    await pool.query('UPDATE grn_items SET product_id = NULL WHERE product_id = ANY($1::UUID[])', [products]);
    await pool.query('UPDATE po_items SET product_id = NULL WHERE product_id = ANY($1::UUID[])', [products]);
    await pool.query('DELETE FROM products WHERE id = ANY($1::UUID[])', [products]);
    await dropBillFixture(pool, f);
    await dropBillFixture(pool, other);
  } finally { await pool.end(); }
}, 60_000);

const product = async (code: string, co = f.co) => {
  const id = crypto.randomUUID();
  products.push(id);
  await pool.query('INSERT INTO products (id, company_id, code, name) VALUES ($1, $2, $3, $4)', [id, co, code, `Item ${code}`]);
  return id;
};
type Move = { reference: string; itemCode: string; qtyIn: number; balance: number };
const report = async (query: Record<string, string> = {}) => {
  const r = await callRoute(itemMovementRoute as never, f, f.owner, '/api/accounting/reports/item-movement', undefined,
    { method: 'GET', query: { from: '2026-06-01', to: '2026-06-30', ...query } });
  expect(r.statusCode, JSON.stringify(r.body)).toBe(200);
  return r.body.data as Move[];
};

describe('a receipt from before the product copy (grn_items.product_id NULL)', () => {
  it('is resolved through its PO line, unfiltered and filtered by item_id', async () => {
    const p = await product(`OLD-${crypto.randomUUID().slice(0, 4)}`);
    const po = await seedQtyPo(pool, f, { lines: [{ qty: 5, price: 1 }] });
    await pool.query('UPDATE po_items SET product_id = $2 WHERE id = $1', [po.items[0], p]);
    const r = await callTool(pool, f, create, grnArgs(po, [[0, 3]]));
    expect(r.isError, r.text).toBe(false);
    // As the receipt wrote it before it copied the product (a live note's items may be updated by a superuser; app_user cannot).
    await pool.query('UPDATE grn_items SET product_id = NULL WHERE grn_id = $1', [r.body.grn_id]);
    for (const query of [{}, { item_id: p }]) {
      const rows = (await report(query)).filter((m) => m.reference === String(r.body.grn_number));
      expect(rows, JSON.stringify(query)).toEqual([expect.objectContaining({ qtyIn: 3, balance: 3 })]);
    }
  });
});

describe('a pre-copy receipt whose PO line names ANOTHER company\'s product', () => {
  it('is not shown, even to a user of both companies (row security admits both): the product must be this company\'s', async () => {
    const theirs = await product(`THEIRS-${crypto.randomUUID().slice(0, 4)}`, other.co);
    const po = await seedQtyPo(pool, f, { lines: [{ qty: 5, price: 1 }] });
    await pool.query('UPDATE po_items SET product_id = $2 WHERE id = $1', [po.items[0], theirs]);
    const r = await callTool(pool, f, create, grnArgs(po, [[0, 3]]));
    expect(r.isError, r.text).toBe(false);
    await pool.query('UPDATE grn_items SET product_id = NULL WHERE grn_id = $1', [r.body.grn_id]);
    await pool.query("INSERT INTO company_users (company_id, user_id, role) VALUES ($1, $2, 'owner')", [other.co, f.owner]);
    try {
      for (const query of [{}, { item_id: theirs }]) {
        expect((await report(query)).filter((m) => m.reference === String(r.body.grn_number)), JSON.stringify(query)).toEqual([]);
      }
    } finally { await pool.query('DELETE FROM company_users WHERE company_id = $1 AND user_id = $2', [other.co, f.owner]); }
  });
});

describe('the running balance is per product', () => {
  it('10 of A then 2 of B: B is 2, not 12, in the data and the CSV', async () => {
    const tag = crypto.randomUUID().slice(0, 4);
    const a = await product(`A-${tag}`);
    const b = await product(`B-${tag}`);
    const po = await seedQtyPo(pool, f, { lines: [{ qty: 10, price: 1 }, { qty: 2, price: 1 }] });
    await pool.query('UPDATE po_items SET product_id = $2 WHERE id = $1', [po.items[0], a]);
    await pool.query('UPDATE po_items SET product_id = $2 WHERE id = $1', [po.items[1], b]);
    const r = await callTool(pool, f, create, grnArgs(po, [[0, 10], [1, 2]]));
    expect(r.isError, r.text).toBe(false);
    const rows = (await report()).filter((m) => m.reference === String(r.body.grn_number));
    expect(rows.map((m) => [m.itemCode, m.qtyIn, m.balance]).sort()).toEqual([[`A-${tag}`, 10, 10], [`B-${tag}`, 2, 2]]);
    // An empty item_id (the page's "all items") is no filter, not a 400 (review of c2110f585e, L1).
    expect((await report({ item_id: '' })).filter((m) => m.reference === String(r.body.grn_number))).toHaveLength(2);
    const csv = await callRoute(itemMovementRoute as never, f, f.owner, '/api/accounting/reports/item-movement', undefined,
      { method: 'GET', query: { from: '2026-06-01', to: '2026-06-30', format: 'csv' } });
    const text = String((csv as unknown as { body: unknown }).body ?? '');
    const line = text.split('\n').find((l) => l.includes(`B-${tag}`));
    expect(line, text.slice(0, 400)).toBeDefined();
    expect(line!.split(',').at(-1)).toBe('2');
  });
});
