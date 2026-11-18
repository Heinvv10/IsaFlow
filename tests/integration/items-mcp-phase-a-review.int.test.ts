/**
 * Review fixes for Phase A against a real database (migration 1005 as the throwaway cluster applies it):
 *  - a writer that names no company_id still writes a company-scoped stock row (BEFORE INSERT trigger); a product with no
 *    company yields a NULL-company row only for a superuser, and the tenant policy refuses it;
 *  - items.sales_account_id / purchases_account_id are foreign keys (so the account-merge sweep sees them) and are held to the
 *    line guards' account rules; the migration re-applies idempotently and adds a missing FK when the column predates it;
 *  - items_tracked_needs_physical, the UI update path, mergeItems, the soft-delete purge, the demo wipe's stock steps;
 *  - the PO PUT, quote conversion, and item VAT on the lines.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { Pool } from 'pg';
import purchaseOrders from '../../pages/api/accounting/purchase-orders';
import purchaseOrderDetail from '../../pages/api/accounting/purchase-orders/[id]';
import quotesAction from '../../pages/api/accounting/customer-quotes-action';
import quotesRoute from '../../pages/api/accounting/customer-quotes';
import invoiceDetail from '../../pages/api/accounting/customer-invoices-detail';
import itemsRoute from '../../pages/api/accounting/items';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { as, cleanupWorld, itemsWorld, type ItemsWorld } from './helpers/itemsWorld';
import { callRoute } from './helpers/onboardingSetupFixture';
import { text } from './helpers/mcpBudgetFixture';
import { mergeEntities } from '../../src/modules/accounting/services/core/duplicateMergeService';
import { purgeExpiredDeletes } from '../../src/modules/accounting/services/core/softDeleteService';
import { findConfigurationReferences } from '../../src/modules/accounting/services/gl/accountMergeReferences';
import { WIPE_STEPS, deleteSql } from '../../scripts/lib/demoReseed/wipePlan';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });

let w: ItemsWorld;
let A: ReturnType<typeof as>;
let payable: string;
let itemId: string;
const MIGRATION = readFileSync('scripts/migrations/sql/1005_items_canonical_model.sql', 'utf8');
const idOf = async (code: string, side = A) => String(((await side.ok('get_item', { code })).item as { id: string }).id);
const upsert = async (rows: Array<Record<string, unknown>>) => A.ok('bulk_upsert_items', { items: rows });

beforeAll(async () => {
  w = await itemsWorld(pool);
  A = as(pool, w.a);
  payable = String((await pool.query(
    `INSERT INTO gl_accounts (company_id, account_code, account_name, account_type, account_subtype, normal_balance)
     VALUES ($1, 'IA-2000', 'IA Trade Payables', 'liability', 'payable', 'credit') RETURNING id`, [w.a.u.homeCompanyId])).rows[0].id);
  await upsert([{ code: 'R-1', description: 'Review item', sales_account_id: w.a.revenue, purchases_account_id: w.a.expense }]);
  itemId = await idOf('R-1');
}, 120000);
afterAll(async () => {
  try {
    await pool.query('DELETE FROM stock_levels WHERE company_id = $1 OR product_id IN (SELECT id FROM products WHERE company_id IS NULL)', [w.a.u.homeCompanyId]);
    await pool.query('DELETE FROM stock_movements WHERE company_id = $1 OR product_id IN (SELECT id FROM products WHERE company_id IS NULL)', [w.a.u.homeCompanyId]);
    await pool.query('DELETE FROM warehouses WHERE company_id = $1', [w.a.u.homeCompanyId]);
    await pool.query('DELETE FROM products WHERE company_id IS NULL AND code LIKE $1', ['IR-%']);
    await cleanupWorld(pool, w);
    await pool.query('DELETE FROM gl_accounts WHERE id = $1', [payable]);
  } finally {
    await pool.end();
  }
}, 120000);

const asAppUser = async <T>(company: string, user: string, fn: (q: (s: string, p?: unknown[]) => Promise<{ rows: any[] }>) => Promise<T>): Promise<T> => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL ROLE app_user');
    await client.query(`SELECT set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: user, role: 'authenticated', company_id: company })]);
    await client.query(`SELECT set_config('app.current_company_id', $1, true)`, [company]);
    return await fn((s, p) => client.query(s, p));
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
};

describe('stock rows: the company_id trigger (urgent fix)', () => {
  it('a writer that names no company_id gets its product\'s company (movements and levels)', async () => {
    const product = String((await pool.query(`INSERT INTO products (company_id, code, name) VALUES ($1, 'IR-P1', 'IR-P1') RETURNING id`, [w.a.u.homeCompanyId])).rows[0].id);
    const wh = String((await pool.query(`INSERT INTO warehouses (company_id, name, code) VALUES ($1, 'IR store', 'IR-W1') RETURNING id`, [w.a.u.homeCompanyId])).rows[0].id);
    const sm = await pool.query(`INSERT INTO stock_movements (product_id, movement_type, quantity) VALUES ($1, 'purchase', 3) RETURNING company_id`, [product]);
    const sl = await pool.query('INSERT INTO stock_levels (product_id, warehouse_id, quantity) VALUES ($1, $2, 3) RETURNING company_id', [product, wh]);
    expect(sm.rows[0].company_id).toBe(w.a.u.homeCompanyId);
    expect(sl.rows[0].company_id).toBe(w.a.u.homeCompanyId);
  });

  it('a product with no company gives a NULL-company row to a superuser (master\'s orphan tests), and the tenant policy refuses it', async () => {
    const orphan = String((await pool.query(`INSERT INTO products (company_id, code, name) VALUES (NULL, 'IR-ORPHAN', 'IR-ORPHAN') RETURNING id`)).rows[0].id);
    const row = await pool.query(`INSERT INTO stock_movements (product_id, movement_type, quantity) VALUES ($1, 'purchase', 1) RETURNING company_id`, [orphan]);
    expect(row.rows[0].company_id).toBeNull();
    await expect(asAppUser(w.a.u.homeCompanyId, w.a.u.userId, (q) => q(`INSERT INTO stock_movements (product_id, movement_type, quantity) VALUES ($1, 'purchase', 1)`, [orphan]))).rejects.toThrow(/row-level security/);
  });

  it('another company\'s product is invisible to the trigger under a tenant session, so the row is refused', async () => {
    const bProduct = String((await pool.query(`INSERT INTO products (company_id, code, name) VALUES ($1, 'IR-PB', 'IR-PB') RETURNING id`, [w.b.u.homeCompanyId])).rows[0].id);
    await expect(asAppUser(w.a.u.homeCompanyId, w.a.u.userId, (q) => q(`INSERT INTO stock_movements (product_id, movement_type, quantity) VALUES ($1, 'purchase', 1)`, [bProduct]))).rejects.toThrow(/row-level security/);
    await pool.query('DELETE FROM products WHERE id = $1', [bProduct]);
  });

  it('the trigger is SECURITY INVOKER (no definer-registry entry needed)', async () => {
    const r = await pool.query(`SELECT prosecdef FROM pg_proc WHERE proname = 'stock_row_fill_company'`);
    expect(r.rows).toEqual([{ prosecdef: false }]);
  });
});

describe('items: a tracked item is physical, accounts are foreign keys held to the line guards', () => {
  it('items_tracked_needs_physical refuses a tracked service in SQL; the UI update turns a tracked item into an untracked service', async () => {
    await expect(pool.query(`INSERT INTO items (company_id, code, description, item_type, inventory_tracked) VALUES ($1, 'IR-BAD', 'x', 'service', true)`, [w.a.u.homeCompanyId]))
      .rejects.toThrow(/items_tracked_needs_physical/);
    await upsert([{ code: 'R-TRK', description: 'tracked', inventory_tracked: true }]);
    const id = await idOf('R-TRK');
    const r = await callRoute(itemsRoute, w.a.u, { id, item_type: 'service' }, '/api/accounting/items', 'PUT');
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect((await pool.query('SELECT item_type, inventory_tracked FROM items WHERE id = $1', [id])).rows[0]).toEqual({ item_type: 'service', inventory_tracked: false });
  });

  it('refuses a purchases default a bill line would refuse (AP control) and a sales default that is not revenue', async () => {
    const r = await A.run('bulk_upsert_items', { items: [
      { code: 'R-A1', description: 'x', purchases_account_id: payable },
      { code: 'R-A2', description: 'x', sales_account_id: w.a.expense },
      { code: 'R-A3', description: 'x', sales_account_id: w.a.revenue, purchases_account_id: w.a.expense },
    ] });
    const refusals = JSON.parse(text(r)).refusals as Array<{ index: number; code: string; reason: string }>;
    expect(refusals.map((x) => `${x.index}:${x.code}`)).toEqual(['0:account_not_allowed', '1:account_not_allowed']);
    expect(refusals[0]!.reason).toMatch(/^purchases_account_id: A bill line cannot be coded to IA-2000/);
    expect(refusals[1]!.reason).toMatch(/^sales_account_id: An invoice line cannot be coded to IA-5000/);
  });

  it('an upper-case id is the same id: created once, then unchanged (never "updated" forever)', async () => {
    const cat = await A.ok('upsert_item_category', { name: 'Upper', code: 'upper' });
    const row = { code: 'R-UP', description: 'u', category_id: String(cat.id).toUpperCase(), sales_account_id: w.a.revenue.toUpperCase(), purchases_account_id: w.a.expense.toUpperCase() };
    expect((await upsert([row])).counts).toMatchObject({ created: 1 });
    expect((await upsert([row])).counts).toMatchObject({ unchanged: 1, updated: 0 });
    const got = await A.ok('get_item', { item_id: (await idOf('R-UP')).toUpperCase() });
    expect((got.item as { code: string }).code).toBe('R-UP');
  });

  it('the database refuses to delete an account an item names, and the merge sweep leaves items to the repoint (accountMergeDocumentRows)', async () => {
    await expect(pool.query('DELETE FROM gl_accounts WHERE id = $1', [w.a.revenue])).rejects.toThrow(/items_sales_account_id_fkey|foreign key/);
    const refs = await findConfigurationReferences(w.a.u.homeCompanyId, w.a.revenue);
    expect(refs.map((r) => r.table)).not.toContain('items');
    const purchases = await findConfigurationReferences(w.a.u.homeCompanyId, w.a.expense);
    expect(purchases.map((r) => `${r.table}.${r.column}`)).not.toContain('items.purchases_account_id');
  });
});

describe('migration 1005 re-applies and repairs', () => {
  const inTx = async (fn: (q: (s: string, p?: unknown[]) => Promise<{ rows: any[] }>) => Promise<void>) => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await fn((s, p) => client.query(s, p));
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  };
  const fk = async (q: (s: string, p?: unknown[]) => Promise<{ rows: any[] }>, table: string) => (await q(
    `SELECT convalidated FROM pg_constraint WHERE conrelid = $1::regclass AND contype = 'f' AND confrelid = 'items'::regclass`, [table])).rows;

  it('runs a second time with no error', async () => {
    await inTx(async (q) => { await q(MIGRATION); });
  });

  it('adds the FK when the column already exists without one, and validates it when no row is orphaned', async () => {
    await inTx(async (q) => {
      await q('ALTER TABLE customer_invoice_items DROP CONSTRAINT customer_invoice_items_item_id_fkey');
      expect(await fk(q, 'customer_invoice_items')).toEqual([]);
      await q(MIGRATION);
      expect(await fk(q, 'customer_invoice_items')).toEqual([{ convalidated: true }]);
    });
  });

  it('leaves the FK NOT VALID (and says so) when an existing row names no item', async () => {
    const inv = String((await A.ok('create_draft_invoice', { customer_id: w.a.customer, items: [{ description: 'orphan', unit_price: 1 }] })).id);
    await inTx(async (q) => {
      await q('ALTER TABLE customer_invoice_items DROP CONSTRAINT customer_invoice_items_item_id_fkey');
      await q('DROP TRIGGER customer_invoice_items_item_company ON customer_invoice_items'); // the migration re-creates it
      await q('UPDATE customer_invoice_items SET item_id = gen_random_uuid() WHERE invoice_id = $1', [inv]);
      await q(MIGRATION);
      expect(await fk(q, 'customer_invoice_items')).toEqual([{ convalidated: false }]);
    });
  });

  it('stops, naming the column, when item_id exists with another type', async () => {
    await inTx(async (q) => {
      await q('ALTER TABLE po_items DROP CONSTRAINT po_items_item_id_fkey');
      await q('DROP TRIGGER po_items_item_company ON po_items');
      await q('ALTER TABLE po_items ALTER COLUMN item_id TYPE TEXT');
      await expect(q(MIGRATION)).rejects.toThrow(/po_items\.item_id is text \(expected uuid\)/);
    });
  });
});

describe('merge and purge', () => {
  it('mergeItems repoints item_id on every line table and on stock movements, scoped to the company', async () => {
    await upsert([{ code: 'M-P', description: 'primary' }, { code: 'M-D', description: 'duplicate' }]);
    const [p, d] = [await idOf('M-P'), await idOf('M-D')];
    const inv = String((await A.ok('create_draft_invoice', { customer_id: w.a.customer, items: [{ description: 'l', unit_price: 1, item_id: d }] })).id);
    const bill = String((await A.ok('create_supplier_invoice', { supplier_id: w.a.supplier, invoice_number: 'MERGE-1', invoice_date: '2026-11-10', lines: [{ description: 'l', quantity: 1, unit_price: 1, item_id: d }] })).id);
    const quote = String((await A.ok('create_draft_quote', { customer_name: 'M', items: [{ description: 'l', unit_price: 1, item_id: d }] }) as { id: string }).id);
    const po = await callRoute(purchaseOrders, w.a.u, { supplierId: w.a.supplier, items: [{ description: 'l', quantity: 1, unitPrice: 1, taxRate: 15, itemId: d }] }, '/api/accounting/purchase-orders');
    const poId = String((po.body.data as { id: string }).id);
    const product = String((await pool.query(`INSERT INTO products (company_id, code, name) VALUES ($1, 'IR-MP', 'IR-MP') RETURNING id`, [w.a.u.homeCompanyId])).rows[0].id);
    await pool.query(`INSERT INTO stock_movements (product_id, item_id, movement_type, quantity) VALUES ($1, $2, 'purchase', 1)`, [product, d]);

    const result = await mergeEntities(w.a.u.homeCompanyId, 'item', p, d, w.a.u.userId);
    expect(result.reassignedTransactions).toBe(5);
    for (const [table, fkCol, id] of [['customer_invoice_items', 'invoice_id', inv], ['supplier_invoice_items', 'supplier_invoice_id', bill],
      ['customer_quote_lines', 'quote_id', quote], ['po_items', 'purchase_order_id', poId]] as const) {
      expect((await pool.query(`SELECT item_id FROM ${table} WHERE ${fkCol} = $1`, [id])).rows, table).toEqual([{ item_id: p }]);
    }
    expect((await pool.query('SELECT item_id FROM stock_movements WHERE product_id = $1', [product])).rows).toEqual([{ item_id: p }]);
    expect((await pool.query('SELECT deleted_at FROM items WHERE id = $1', [d])).rows[0].deleted_at).not.toBeNull();
  });

  it('the purge skips a deleted item a line still names, and removes one nothing names (it no longer fails the purge)', async () => {
    await upsert([{ code: 'P-USED', description: 'used' }, { code: 'P-FREE', description: 'free' }]);
    const [used, free] = [await idOf('P-USED'), await idOf('P-FREE')];
    await A.ok('create_draft_quote', { customer_name: 'P', items: [{ description: 'l', unit_price: 1, item_id: used }] });
    await pool.query(`UPDATE items SET deleted_at = NOW() - INTERVAL '1 hour' WHERE id = ANY($1)`, [[used, free]]);
    await purgeExpiredDeletes(w.a.u.homeCompanyId);
    const left = (await pool.query('SELECT id FROM items WHERE id = ANY($1)', [[used, free]])).rows.map((r) => r.id);
    expect(left).toEqual([used]);
  });
});

describe('demo wipe: stock steps', () => {
  it('a NULL-company movement and level tied to the company\'s warehouse are removed by the stock steps, so the warehouses delete is not blocked', async () => {
    const wh = String((await pool.query(`INSERT INTO warehouses (company_id, name, code) VALUES ($1, 'IR wipe', 'IR-W2') RETURNING id`, [w.a.u.homeCompanyId])).rows[0].id);
    const orphan = String((await pool.query(`SELECT id FROM products WHERE code = 'IR-ORPHAN'`)).rows[0].id);
    await pool.query(`INSERT INTO stock_movements (product_id, warehouse_id, movement_type, quantity) VALUES ($1, $2, 'purchase', 1)`, [orphan, wh]);
    await pool.query('INSERT INTO stock_levels (product_id, warehouse_id, quantity) VALUES ($1, $2, 1)', [orphan, wh]);
    await expect(pool.query('DELETE FROM warehouses WHERE id = $1', [wh])).rejects.toThrow(/foreign key/);
    for (const t of ['stock_levels', 'stock_movements']) await pool.query(deleteSql(WIPE_STEPS.find((s) => s.table === t)!), [w.a.u.homeCompanyId]);
    await pool.query('DELETE FROM warehouses WHERE id = $1', [wh]);
    expect((await pool.query('SELECT 1 FROM warehouses WHERE id = $1', [wh])).rowCount).toBe(0);
  });
});

describe('purchase order PUT and GET', () => {
  const url = (id: string) => `/api/accounting/purchase-orders/${id}`;
  const putPo = (id: string, items: Array<Record<string, unknown>>, user = w.a.u) => callRoute(purchaseOrderDetail, user, { items }, url(id), 'PUT', { id });
  const row = { description: 'po line', quantity: 2, unit_price: 10, tax_rate: 15 };
  let poId: string;
  let inactive: string;
  let foreign: string;
  const linesOf = async () => (await pool.query('SELECT item_id, gl_account_id, tax_rate FROM po_items WHERE purchase_order_id = $1 ORDER BY sort_order', [poId])).rows;

  beforeAll(async () => {
    const po = await callRoute(purchaseOrders, w.a.u, { supplierId: w.a.supplier, items: [{ description: 'seed', quantity: 1, unitPrice: 1, taxRate: 15 }] }, '/api/accounting/purchase-orders');
    poId = String((po.body.data as { id: string }).id);
    await upsert([{ code: 'PO-OFF', description: 'off', purchases_account_id: w.a.expense }]);
    inactive = await idOf('PO-OFF');
    await A.ok('deactivate_item', { item_id: inactive });
    foreign = String(((await as(pool, w.b).ok('bulk_upsert_items', { items: [{ code: 'PO-B', description: 'b' }] })).rows as Array<{ id: string }>)[0]!.id);
  });

  it('a NEW item is stored and defaults the purchases account; a re-sent line without item_id keeps it, even after the item is deactivated; null clears', async () => {
    expect((await putPo(poId, [{ ...row, item_id: itemId }])).status).toBe(200);
    expect(await linesOf()).toEqual([{ item_id: itemId, gl_account_id: w.a.expense, tax_rate: '15.00' }]);
    await A.ok('deactivate_item', { item_id: itemId });
    expect((await putPo(poId, [{ ...row, gl_account_id: w.a.expense }])).status).toBe(200);
    expect((await linesOf())[0]).toMatchObject({ item_id: itemId });
    expect((await putPo(poId, [{ ...row, gl_account_id: w.a.expense, item_id: null }])).status).toBe(200);
    expect((await linesOf())[0]).toMatchObject({ item_id: null });
    await A.ok('update_item', { item_id: itemId, is_active: true });
  });

  it('answers 400 for an inactive or another company\'s item and changes nothing; GET returns item_id', async () => {
    await putPo(poId, [{ ...row, item_id: itemId }]);
    for (const item_id of [inactive, foreign]) {
      const r = await putPo(poId, [{ ...row, item_id }]);
      expect(r.status).toBe(400);
      expect(JSON.stringify(r.body)).toMatch(/item_id is (an inactive item|not an item of your company)/);
    }
    expect((await linesOf())[0]).toMatchObject({ item_id: itemId });
    const got = await callRoute(purchaseOrderDetail, w.a.u, {}, url(poId), 'GET', { id: poId });
    expect(got.status).toBe(200);
    expect(JSON.stringify(got.body)).toContain(itemId);
  });

  it('a defaulted account a bill line would refuse (AP control) is refused on POST and PUT, naming the line', async () => {
    await upsert([{ code: 'PO-AP', description: 'ap default' }]);
    const apItem = await idOf('PO-AP');
    await pool.query('UPDATE items SET purchases_account_id = $2 WHERE id = $1', [apItem, payable]); // as the UI could have stored it
    const post = await callRoute(purchaseOrders, w.a.u, { supplierId: w.a.supplier, items: [{ description: 'x', quantity: 1, unitPrice: 1, taxRate: 15, itemId: apItem }] }, '/api/accounting/purchase-orders');
    expect(post.status).toBe(400);
    expect(JSON.stringify(post.body)).toMatch(/items\[0\]\.item_id: the item's purchases account is not acceptable on a purchase order line/);
    const put = await putPo(poId, [{ ...row, item_id: apItem }]);
    expect(put.status).toBe(400);
    expect((await linesOf())[0]).toMatchObject({ item_id: itemId });
  });
});

describe('quote to invoice conversion', () => {
  const convert = (id: string) => callRoute(quotesAction, w.a.u, { id, action: 'convert' }, '/api/accounting/customer-quotes-action');
  const accept = (id: string) => callRoute(quotesAction, w.a.u, { id, action: 'accept' }, '/api/accounting/customer-quotes-action');

  it('copies the line\'s item_id (the VALUE) onto the invoice line', async () => {
    const quote = String((await A.ok('create_draft_quote', { customer_name: 'C', customer_id: w.a.customer, items: [{ description: 'conv', unit_price: 7, item_id: itemId }] }) as { id: string }).id);
    expect((await accept(quote)).status).toBe(200);
    const r = await convert(quote);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const invoiceId = String((r.body.data as { invoiceId: string }).invoiceId);
    const lines = (await pool.query('SELECT item_id, gl_account_id FROM customer_invoice_items WHERE invoice_id = $1', [invoiceId])).rows;
    expect(lines).toEqual([{ item_id: itemId, gl_account_id: w.a.revenue }]);
  });

  it('refuses the conversion (400, nothing created) when the item was deactivated since the quote was written', async () => {
    await upsert([{ code: 'CV-OFF', description: 'soon off', sales_account_id: w.a.revenue }]);
    const off = await idOf('CV-OFF');
    const quote = String((await A.ok('create_draft_quote', { customer_name: 'C2', customer_id: w.a.customer, items: [{ description: 'conv', unit_price: 7, item_id: off }] }) as { id: string }).id);
    await accept(quote);
    await A.ok('deactivate_item', { item_id: off });
    const r = await convert(quote);
    expect(r.status).toBe(400);
    expect(JSON.stringify(r.body)).toMatch(/quote line 1\.item_id is an inactive item/);
    expect((await pool.query('SELECT status FROM customer_quotes WHERE id = $1', [quote])).rows[0].status).toBe('accepted');
  });
});

describe('item VAT on the lines', () => {
  let zero: string;
  let exempt: string;
  let standard: string;
  beforeAll(async () => {
    await upsert([
      { code: 'V-ZERO', description: 'zero', vat_on_purchases: 'zero', vat_on_sales: 'zero', purchases_account_id: w.a.expense, sales_account_id: w.a.revenue },
      { code: 'V-EX', description: 'exempt', vat_on_purchases: 'exempt', vat_on_sales: 'exempt' },
      { code: 'V-STD', description: 'std', vat_on_purchases: 'standard', vat_on_sales: 'standard' },
    ]);
    [zero, exempt, standard] = [await idOf('V-ZERO'), await idOf('V-EX'), await idOf('V-STD')];
  });
  const billLines = async (id: string) => (await pool.query('SELECT tax_rate, vat_classification, tax_amount FROM supplier_invoice_items WHERE supplier_invoice_id = $1 ORDER BY created_at', [id])).rows;

  it('a bill line with an item and no rate takes the item\'s purchases VAT; an explicit rate (line or invoice) wins', async () => {
    const lines = [{ description: 'z', quantity: 1, unit_price: 100, item_id: zero }, { description: 'e', quantity: 1, unit_price: 100, item_id: exempt },
      { description: 's', quantity: 1, unit_price: 100, item_id: standard }, { description: 'x', quantity: 1, unit_price: 100, item_id: zero, tax_rate: 15 }];
    const bill = await A.ok('create_supplier_invoice', { supplier_id: w.a.supplier, invoice_number: 'VAT-1', invoice_date: '2026-11-10', lines });
    expect(await billLines(String(bill.id))).toEqual([
      { tax_rate: '0.00', vat_classification: 'zero_rated', tax_amount: '0.00' }, { tax_rate: '0.00', vat_classification: 'exempt', tax_amount: '0.00' },
      { tax_rate: '15.00', vat_classification: 'standard', tax_amount: '15.00' }, { tax_rate: '15.00', vat_classification: 'standard', tax_amount: '15.00' },
    ]);
    const explicitHeader = await A.ok('create_supplier_invoice', { supplier_id: w.a.supplier, invoice_number: 'VAT-2', invoice_date: '2026-11-10', tax_rate: 15, lines: [lines[0]] });
    expect((await billLines(String(explicitHeader.id)))[0]).toMatchObject({ tax_rate: '15.00' });
  });

  it('a draft edit gives a NEW item line the item\'s rate; PO POST and quote lines too', async () => {
    const bill = String((await A.ok('create_supplier_invoice', { supplier_id: w.a.supplier, invoice_number: 'VAT-3', invoice_date: '2026-11-10', lines: [{ description: 'p', quantity: 1, unit_price: 10 }] })).id);
    await A.ok('update_supplier_invoice', { invoice_id: bill, lines: [{ description: 'z', quantity: 1, unit_price: 100, item_id: zero }] });
    expect((await billLines(bill))[0]).toMatchObject({ tax_rate: '0.00', vat_classification: 'zero_rated' });

    const po = await callRoute(purchaseOrders, w.a.u, { supplierId: w.a.supplier, items: [{ description: 'z', quantity: 1, unitPrice: 100, itemId: zero }, { description: 's', quantity: 1, unitPrice: 100, itemId: standard }] }, '/api/accounting/purchase-orders');
    const poId = String((po.body.data as { id: string }).id);
    expect((await pool.query('SELECT tax_rate FROM po_items WHERE purchase_order_id = $1 ORDER BY sort_order', [poId])).rows).toEqual([{ tax_rate: '0.00' }, { tax_rate: '15.00' }]);
    expect(Number((po.body.data as { tax_amount: string }).tax_amount)).toBe(15);

    const quote = String((await A.ok('create_draft_quote', { customer_name: 'V', items: [{ description: 'z', unit_price: 100, item_id: zero }, { description: 's', unit_price: 100, item_id: standard }] }) as { id: string }).id);
    expect((await pool.query('SELECT tax_rate FROM customer_quote_lines WHERE quote_id = $1 ORDER BY sort_order', [quote])).rows).toEqual([{ tax_rate: '0.00' }, { tax_rate: '15.00' }]);
  });
});

describe('1005 does not add warehouses.location_type (Phase C adds it)', () => {
  it('the column is absent and the migration text does not create it', async () => {
    expect((await pool.query(`SELECT 1 FROM information_schema.columns WHERE table_name = 'warehouses' AND column_name = 'location_type'`)).rowCount).toBe(0);
    expect(MIGRATION).not.toMatch(/location_type/);
  });
});

describe('an item named by a row belongs to the row\'s company (breaker)', () => {
  let bItem: string;
  beforeAll(async () => {
    bItem = String(((await as(pool, w.b).ok('bulk_upsert_items', { items: [{ code: 'X-B', description: 'b item' }] })).rows as Array<{ id: string }>)[0]!.id);
  });

  it('as app_user, a stock movement in company A that names company B\'s item is refused by the composite FK', async () => {
    const product = String((await pool.query(`INSERT INTO products (company_id, code, name) VALUES ($1, 'IR-XT', 'IR-XT') RETURNING id`, [w.a.u.homeCompanyId])).rows[0].id);
    await expect(asAppUser(w.a.u.homeCompanyId, w.a.u.userId, (q) => q(
      `INSERT INTO stock_movements (company_id, product_id, item_id, movement_type, quantity) VALUES ($1, $2, $3, 'purchase', 1)`, [w.a.u.homeCompanyId, product, bItem],
    ))).rejects.toThrow(/stock_movements_company_item_fkey/);
    await asAppUser(w.a.u.homeCompanyId, w.a.u.userId, (q) => q(
      `INSERT INTO stock_movements (company_id, product_id, item_id, movement_type, quantity) VALUES ($1, $2, $3, 'purchase', 1)`, [w.a.u.homeCompanyId, product, itemId]));
  });

  it('the four line tables refuse another company\'s item on INSERT-time and UPDATE-time alike', async () => {
    const inv = String((await A.ok('create_draft_invoice', { customer_id: w.a.customer, items: [{ description: 'l', unit_price: 1 }] })).id);
    const bill = String((await A.ok('create_supplier_invoice', { supplier_id: w.a.supplier, invoice_number: 'XCO-1', invoice_date: '2026-11-10', lines: [{ description: 'l', quantity: 1, unit_price: 1 }] })).id);
    const quote = String((await A.ok('create_draft_quote', { customer_name: 'X', items: [{ description: 'l', unit_price: 1 }] }) as { id: string }).id);
    const po = await callRoute(purchaseOrders, w.a.u, { supplierId: w.a.supplier, items: [{ description: 'l', quantity: 1, unitPrice: 1, taxRate: 15 }] }, '/api/accounting/purchase-orders');
    const poId = String((po.body.data as { id: string }).id);
    for (const [table, fkCol, id] of [['customer_invoice_items', 'invoice_id', inv], ['supplier_invoice_items', 'supplier_invoice_id', bill],
      ['customer_quote_lines', 'quote_id', quote], ['po_items', 'purchase_order_id', poId]] as const) {
      await expect(pool.query(`UPDATE ${table} SET item_id = $2 WHERE ${fkCol} = $1`, [id, bItem]), table).rejects.toThrow(/not the document's company's/);
      await pool.query(`UPDATE ${table} SET item_id = $2 WHERE ${fkCol} = $1`, [id, itemId]); // its own company's item is fine
      expect((await pool.query(`SELECT item_id FROM ${table} WHERE ${fkCol} = $1`, [id])).rows, table).toEqual([{ item_id: itemId }]);
    }
  });

  it('both guards are SECURITY INVOKER', async () => {
    expect((await pool.query(`SELECT proname, prosecdef FROM pg_proc WHERE proname IN ('line_item_same_company', 'stock_row_fill_company') ORDER BY 1`)).rows)
      .toEqual([{ proname: 'line_item_same_company', prosecdef: false }, { proname: 'stock_row_fill_company', prosecdef: false }]);
  });
});

describe('an empty item_id on the REST draft edits (breaker)', () => {
  it('PO PUT and quote PUT take "" as no item (stored NULL, not a 500); the invoice PUT refuses it (4xx)', async () => {
    const po = await callRoute(purchaseOrders, w.a.u, { supplierId: w.a.supplier, items: [{ description: 'e', quantity: 1, unitPrice: 1, taxRate: 15, itemId }] }, '/api/accounting/purchase-orders');
    const poId = String((po.body.data as { id: string }).id);
    const put = await callRoute(purchaseOrderDetail, w.a.u, { items: [{ description: 'e', quantity: 1, unit_price: 1, tax_rate: 15, item_id: '' }] }, `/api/accounting/purchase-orders/${poId}`, 'PUT', { id: poId });
    expect(put.status, JSON.stringify(put.body)).toBe(200);
    expect((await pool.query('SELECT item_id FROM po_items WHERE purchase_order_id = $1', [poId])).rows).toEqual([{ item_id: null }]);

    const quote = String((await A.ok('create_draft_quote', { customer_name: 'E', items: [{ description: 'e', unit_price: 1, item_id: itemId }] }) as { id: string }).id);
    const qput = await callRoute(quotesRoute, w.a.u, { id: quote, customerName: 'E', lines: [{ description: 'e', quantity: 1, unitPrice: 1, taxRate: 15, itemId: '' }] }, '/api/accounting/customer-quotes', 'PUT');
    expect(qput.status, JSON.stringify(qput.body)).toBe(200);
    expect((await pool.query('SELECT item_id FROM customer_quote_lines WHERE quote_id = $1', [quote])).rows).toEqual([{ item_id: null }]);

    const inv = String((await A.ok('create_draft_invoice', { customer_id: w.a.customer, items: [{ description: 'e', unit_price: 1, item_id: itemId }] })).id);
    const iput = await callRoute(invoiceDetail, w.a.u, { id: inv, items: [{ description: 'e', quantity: 1, unitPrice: 1, itemId: '' }] }, '/api/accounting/customer-invoices-detail', 'PUT');
    expect(iput.status).toBeGreaterThanOrEqual(400);
    expect(iput.status).toBeLessThan(500);
  });
});
