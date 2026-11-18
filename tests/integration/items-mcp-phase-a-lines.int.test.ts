/**
 * Document lines that name a catalogue item (Phase A, migration 1002), against a real database: a bill, an invoice and a
 * quote line created over MCP, and a purchase-order line created through the REST route, store `item_id` and, with no
 * account of their own, default their GL account from the item (purchases account for bills and POs, sales account for
 * invoices and quotes). A line's own account wins; an inactive item or another company's is refused before anything is
 * written (all or nothing in the bulk tools).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import purchaseOrders from '../../pages/api/accounting/purchase-orders';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { as, cleanupWorld, itemsWorld, type ItemsWorld } from './helpers/itemsWorld';
import { callRoute } from './helpers/onboardingSetupFixture';
import { text } from './helpers/mcpBudgetFixture';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });

let w: ItemsWorld;
let A: ReturnType<typeof as>;
let B: ReturnType<typeof as>;
let item: string;
let inactiveItem: string;
let foreignItem: string;
let bareItem: string;
let otherExpense: string;
let otherRevenue: string;

beforeAll(async () => {
  w = await itemsWorld(pool);
  A = as(pool, w.a);
  B = as(pool, w.b);
  const upsert = async (s: ReturnType<typeof as>, code: string, extra: Record<string, unknown>) => {
    const r = await s.ok('bulk_upsert_items', { items: [{ code, description: `Item ${code}`, ...extra }] });
    return String((r.rows as Array<{ id: string }>)[0]!.id);
  };
  item = await upsert(A, 'L-1', { sales_account_id: w.a.revenue, purchases_account_id: w.a.expense });
  bareItem = await upsert(A, 'L-2', {});
  inactiveItem = await upsert(A, 'L-3', { sales_account_id: w.a.revenue, purchases_account_id: w.a.expense });
  await A.ok('deactivate_item', { item_id: inactiveItem });
  foreignItem = await upsert(B, 'L-B', { sales_account_id: w.b.revenue, purchases_account_id: w.b.expense });
  const account = async (code: string, type: string, subtype: string) => String((await pool.query(
    `INSERT INTO gl_accounts (company_id, account_code, account_name, account_type, account_subtype, normal_balance)
     VALUES ($1, $2, $2, $3, $4, $5) RETURNING id`, [w.a.u.homeCompanyId, code, type, subtype, type === 'revenue' ? 'credit' : 'debit'])).rows[0].id);
  otherExpense = await account('IA-5100', 'expense', 'operating_expense');
  otherRevenue = await account('IA-4100', 'revenue', 'revenue');
}, 120000);
afterAll(async () => {
  try { await cleanupWorld(pool, w); } finally { await pool.end(); }
}, 120000);

const bill = (lines: Array<Record<string, unknown>>, n: string) => ({
  supplier_id: w.a.supplier, invoice_number: `ITEMS-${n}`, invoice_date: '2026-11-10', lines,
});
const invoice = (items: Array<Record<string, unknown>>) => ({ customer_id: w.a.customer, items, invoice_date: '2026-11-10' });
const line = async (table: string, fk: string, id: string) => (await pool.query(
  `SELECT item_id, gl_account_id FROM ${table} WHERE ${fk} = $1 ORDER BY created_at`, [id])).rows;
const count = async (table: string, company: string) => Number((await pool.query(`SELECT COUNT(*)::int AS n FROM ${table} WHERE company_id = $1`, [company])).rows[0].n);

describe('bill lines (create_supplier_invoice, bulk_create_supplier_invoices)', () => {
  it('a line with an item and no account takes the item\'s purchases account; its own account wins', async () => {
    const ok = await A.ok('create_supplier_invoice', bill([
      { description: 'by item', quantity: 2, unit_price: 10, item_id: item },
      { description: 'own account', quantity: 1, unit_price: 5, item_id: item, gl_account_id: otherExpense },
      { description: 'plain', quantity: 1, unit_price: 5 },
    ], '2'));
    expect(await line('supplier_invoice_items', 'supplier_invoice_id', String(ok.id))).toEqual([
      { item_id: item, gl_account_id: w.a.expense }, { item_id: item, gl_account_id: otherExpense }, { item_id: null, gl_account_id: null },
    ]);
  });

  it('refuses an inactive item and another company\'s item, writing no bill', async () => {
    const before = await count('supplier_invoices', w.a.u.homeCompanyId);
    expect(text(await A.run('create_supplier_invoice', bill([{ description: 'x', quantity: 1, unit_price: 1, item_id: inactiveItem }], '3')))).toMatch(/items\[0\]\.item_id is an inactive item/);
    expect(text(await A.run('create_supplier_invoice', bill([{ description: 'x', quantity: 1, unit_price: 1, item_id: foreignItem }], '4')))).toMatch(/item_id is not an item of your company/);
    expect(await count('supplier_invoices', w.a.u.homeCompanyId)).toBe(before);
  });

  it('bulk: one bad item creates none of them', async () => {
    const before = await count('supplier_invoices', w.a.u.homeCompanyId);
    const r = await A.run('bulk_create_supplier_invoices', { invoices: [
      bill([{ description: 'ok', quantity: 1, unit_price: 1, item_id: item }], '5'),
      bill([{ description: 'bad', quantity: 1, unit_price: 1, item_id: foreignItem }], '6'),
    ] });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/invoices\[1\].*item_id is not an item of your company/);
    expect(await count('supplier_invoices', w.a.u.homeCompanyId)).toBe(before);
    const good = await A.ok('bulk_create_supplier_invoices', { invoices: [bill([{ description: 'ok', quantity: 1, unit_price: 1, item_id: item }], '7')] });
    const id = String(((good.created ?? good.invoices) as Array<{ id: string }>)[0]!.id);
    expect(await line('supplier_invoice_items', 'supplier_invoice_id', id)).toEqual([{ item_id: item, gl_account_id: w.a.expense }]);
  });
});

describe('invoice lines (create_draft_invoice, bulk_create_customer_invoices)', () => {
  it('a line with an item and no account credits the item\'s sales account', async () => {
    const made = await A.ok('create_draft_invoice', invoice([
      { description: 'by item', quantity: 3, unit_price: 20, item_id: item },
      { description: 'own account', unit_price: 2, item_id: item, gl_account_id: otherRevenue },
      { description: 'plain', unit_price: 1 },
    ]));
    expect(await line('customer_invoice_items', 'invoice_id', String(made.id))).toEqual([
      { item_id: item, gl_account_id: w.a.revenue }, { item_id: item, gl_account_id: otherRevenue }, { item_id: null, gl_account_id: null },
    ]);
  });

  it('an item with no sales account leaves the line on the default account', async () => {
    const made = await A.ok('create_draft_invoice', invoice([{ description: 'bare', unit_price: 2, item_id: bareItem }]));
    expect(await line('customer_invoice_items', 'invoice_id', String(made.id))).toEqual([{ item_id: bareItem, gl_account_id: null }]);
  });

  it('refuses an inactive or foreign item, and a bulk with one bad element creates none', async () => {
    const before = await count('customer_invoices', w.a.u.homeCompanyId);
    expect(text(await A.run('create_draft_invoice', invoice([{ description: 'x', unit_price: 1, item_id: inactiveItem }])))).toMatch(/inactive item/);
    expect(text(await A.run('create_draft_invoice', invoice([{ description: 'x', unit_price: 1, item_id: foreignItem }])))).toMatch(/not an item of your company/);
    const bulk = await A.run('bulk_create_customer_invoices', { invoices: [invoice([{ description: 'ok', unit_price: 1, item_id: item }]), invoice([{ description: 'bad', unit_price: 1, item_id: foreignItem }])] });
    expect(bulk.isError).toBe(true);
    expect(text(bulk)).toMatch(/invoices\[1\]/);
    expect(await count('customer_invoices', w.a.u.homeCompanyId)).toBe(before);
  });
});

describe('quote lines (create_draft_quote)', () => {
  it('stores item_id and defaults the sales account; refuses a foreign item', async () => {
    const made = await A.ok('create_draft_quote', { customer_name: 'Quote Co', items: [{ description: 'q', unit_price: 9, item_id: item }] });
    const id = String((made as { id?: string }).id);
    expect(await line('customer_quote_lines', 'quote_id', id)).toEqual([{ item_id: item, gl_account_id: w.a.revenue }]);
    expect(text(await A.run('create_draft_quote', { customer_name: 'Q', items: [{ description: 'q', unit_price: 9, item_id: foreignItem }] }))).toMatch(/not an item of your company/);
  });
});

describe('purchase order lines (POST /api/accounting/purchase-orders)', () => {
  const post = (u: typeof w.a.u, body: Record<string, unknown>) => callRoute(purchaseOrders, u, body, '/api/accounting/purchase-orders');

  it('stores item_id and takes the item\'s purchases account as the line\'s account', async () => {
    const r = await post(w.a.u, { supplierId: w.a.supplier, items: [{ description: 'po line', quantity: 2, unitPrice: 10, itemId: item }, { description: 'plain', quantity: 1, unitPrice: 1 }] });
    expect(r.status).toBe(201);
    const id = String((r.body.data as { id: string }).id);
    expect(await line('po_items', 'purchase_order_id', id)).toEqual([{ item_id: item, gl_account_id: w.a.expense }, { item_id: null, gl_account_id: null }]);
  });

  it('answers 400 for an inactive or another company\'s item and creates no PO', async () => {
    const before = await count('purchase_orders', w.a.u.homeCompanyId);
    for (const itemId of [inactiveItem, foreignItem]) {
      const r = await post(w.a.u, { supplierId: w.a.supplier, items: [{ description: 'x', quantity: 1, unitPrice: 1, itemId }] });
      expect(r.status).toBe(400);
    }
    expect(await count('purchase_orders', w.a.u.homeCompanyId)).toBe(before);
  });
});

describe('a refused line leaves the other company untouched', () => {
  it('B\'s own item works for B, and A\'s items are refused for B', async () => {
    const mine = await B.ok('create_draft_invoice', { customer_id: w.b.customer, items: [{ description: 'b line', unit_price: 3, item_id: foreignItem }], invoice_date: '2026-11-10' });
    expect(await line('customer_invoice_items', 'invoice_id', String(mine.id))).toEqual([{ item_id: foreignItem, gl_account_id: w.b.revenue }]);
    expect(text(await B.run('create_draft_invoice', { customer_id: w.b.customer, items: [{ description: 'x', unit_price: 1, item_id: item }] }))).toMatch(/not an item of your company/);
  });
});
