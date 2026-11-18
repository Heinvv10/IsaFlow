/**
 * bulk_create_purchase_orders edges (review round 1 of PR #1591), real PostgreSQL, as app_user (poImportHarness):
 *   - fences: another company's / an inactive line account refuses the batch with nothing written; CC1 is stored;
 *   - the counter is never lowered, ignores numbers of another form, and is not raised by a replay; a mixed batch
 *     creates the new and reports the old; a replay whose number or status differs says so and changes nothing;
 *   - only an approved import is budget-checked (a billed PO far over budget is created under block); budget warnings
 *     name no figures to a token without read:reports;
 *   - two concurrent imports of one Sage id make one PO;
 *   - list_purchase_orders filters, pages and totals;
 *   - a discounted or 4-decimal line keeps its amount through the app's own edit (the stored effective unit price).
 * Fixture route: isaflow_schema_fixture (assertDisposable). Never skips.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { dropBillFixture, openRequest, seedBillFixture, setPolicy, type BillFixture } from './helpers/budgetBillFixture';
import type { McpToolContext } from '@/lib/mcp/types';
import { putPo } from './helpers/budgetPoFixture';
import { callTool, counterNext, dropPoDocuments, poCount, sagePo, type Json } from './helpers/poImportHarness';
import { bulkCreatePurchaseOrdersTool as create } from '@/lib/mcp/tools/writeBulkPurchaseOrders';
import { listPurchaseOrdersTool as list } from '@/lib/mcp/tools/listPurchaseOrders';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 6 });
let f: BillFixture;
let other: BillFixture;
let inactive: string;

beforeAll(async () => {
  f = await seedBillFixture(pool, 'po-edges');
  other = await seedBillFixture(pool, 'po-edges-other');
  inactive = String((await pool.query(`INSERT INTO gl_accounts (company_id, account_code, account_name, account_type, normal_balance, level, is_active)
    VALUES ($1, 'BB-6900', 'Retired', 'expense', 'debit', 3, false) RETURNING id`, [f.co])).rows[0].id);
  await setPolicy(pool, f, 'block');
}, 60_000);
afterAll(async () => {
  try {
    for (const x of [f, other]) { await dropPoDocuments(pool, x); await dropBillFixture(pool, x); }
  } finally {
    await pool.end();
  }
}, 60_000);

const row = async (n: string) => (await pool.query(
  `SELECT po.id, po.status, po.order_date::TEXT AS order_date, po.total::TEXT AS total, po.approved_by, po.approved_at,
          pi.cc1_id, pi.unit_price::TEXT AS unit_price, pi.line_total::TEXT AS line_total
     FROM purchase_orders po JOIN po_items pi ON pi.purchase_order_id = po.id
    WHERE po.company_id = $1 AND po.po_number = $2`, [f.co, n])).rows[0];

describe('fences', () => {
  it('another company\'s account, or an inactive one, refuses the batch naming the element; nothing is written', async () => {
    const foreign = await callTool(pool, f, create, { purchase_orders: [sagePo(1, f), sagePo(2, f, { acct: other.acc.opex })] });
    expect(foreign.text).toBe('purchase_orders[1]: One or more lines name GL accounts that are not in your company.');
    const retired = await callTool(pool, f, create, { purchase_orders: [sagePo(3, f, { acct: inactive })] });
    expect(retired.text).toMatch(/^purchase_orders\[0\]: A line cannot be coded to BB-6900 Retired: it is inactive\.$/);
    expect(await poCount(pool, f)).toBe(0);
  });

  it('stores the line\'s CC1 and leaves draft / closed / cancelled POs unapproved', async () => {
    const r = await callTool(pool, f, create, { purchase_orders: [
      sagePo(10, f, { status: 'draft', acct: f.acc.opex, cc1: 'FT' }), sagePo(11, f, { status: 'billed' }), sagePo(12, f, { status: 'cancelled' }),
    ] });
    expect(r.isError, r.text).toBe(false);
    expect(await row('PO0000010')).toMatchObject({ status: 'draft', cc1_id: f.cc.FT, approved_by: null, approved_at: null });
    expect(await row('PO0000011')).toMatchObject({ status: 'closed', approved_by: null, approved_at: null });
    expect(await row('PO0000012')).toMatchObject({ status: 'cancelled', approved_by: null, approved_at: null });
  });
});

describe('the counter and replays', () => {
  it('is never lowered, ignores numbers of another form, and a mixed batch creates only the new', async () => {
    expect(await counterNext(pool, f)).toBe(13);
    const r = await callTool(pool, f, create, { purchase_orders: [sagePo(10, f, { status: 'draft', acct: f.acc.opex, cc1: 'FT' }), sagePo(5, f, { status: 'billed' }),
      { ...sagePo(6, f, { status: 'billed' }), po_number: 'SAGE-999999' }] });
    expect(r.body).toMatchObject({ created: 2, already_existed: 1, counter: { next_number: 13, raised: false } });
  });

  it('a replay whose number or status differs reports both, changes nothing and does not move the counter', async () => {
    const before = await row('PO0000010');
    const r = await callTool(pool, f, create, { purchase_orders: [{ ...sagePo(10, f, { status: 'open', acct: f.acc.opex, cc1: 'FT' }), po_number: 'PO0999999' }] });
    const p = (r.body.purchase_orders as Json[])[0]!;
    expect(p).toMatchObject({ already_existed: true, payload_differs: true, po_number: 'PO0000010', status: 'draft' });
    expect(p.differences).toEqual([
      { field: 'po_number', existing: 'PO0000010', requested: 'PO0999999' },
      { field: 'status', existing: 'draft', requested: 'approved' },
    ]);
    expect(r.wroteNothing).toBe(true);
    expect(await row('PO0000010')).toEqual(before);
    expect(await counterNext(pool, f)).toBe(13);
  });
});

describe('the budget', () => {
  it('only an approved import is checked: a billed PO far over budget is created under block', async () => {
    const r = await callTool(pool, f, create, { purchase_orders: [sagePo(20, f, { status: 'billed', acct: f.acc.opex, cc1: 'FT', price: 50_000 })] });
    expect(r.body).toMatchObject({ created: 1 });
  });

  it('budget warnings name no figures to a token without read:reports', async () => {
    await setPolicy(pool, f, 'warn');
    const withFigures = await callTool(pool, f, create, { purchase_orders: [sagePo(21, f, { acct: f.acc.opex, cc1: 'FT', price: 700 })] });
    const without = await callTool(pool, f, create, { purchase_orders: [sagePo(22, f, { acct: f.acc.opex, cc1: 'FT', price: 700 })] },
      { scopes: ['write:invoices', 'read:invoices'] });
    const warn = (r: typeof without) => ((r.body.purchase_orders as Json[])[0]!.budget_warnings as string[]).join(' ');
    expect(warn(withFigures)).toMatch(/^Over budget: BB-6100 Opex · FT Fibertime · 2026-06: remaining R.1.000\.00, this order R.1.400\.00$/);
    expect(warn(without)).toBe('Over budget: BB-6100 Opex · FT Fibertime · 2026-06: over budget');
    await setPolicy(pool, f, 'block');
  });
});

describe('concurrency', () => {
  it('a second import of one Sage id waits for the first and then reports it already there; one PO', async () => {
    const po = sagePo(30, f, { status: 'billed', ref: 'race-1' });
    const ctx = { userId: f.owner, companyId: f.co, scopes: ['write:invoices', 'read:invoices'], tokenJti: 'j', oauthAppId: null } as McpToolContext;
    // The first import's transaction stays open (its PO inserted, uncommitted) while the second runs.
    const first = await openRequest(pool, f, f.owner);
    const one = await first.run(() => create.handler({ idempotency_key: 'race-a', purchase_orders: [po] }, ctx));
    expect(JSON.parse(one.content[0]!.text)).toMatchObject({ created: 1 });
    let settled = false;
    const second = callTool(pool, f, create, { purchase_orders: [po] }).finally(() => { settled = true; });
    await new Promise((r) => setTimeout(r, 500));
    expect(settled).toBe(false); // it is waiting on the first import's locks
    await first.commit();
    const two = await second;
    expect(two.isError, two.text).toBe(false);
    expect(two.body).toMatchObject({ created: 0, already_existed: 1 });
    expect(Number((await pool.query("SELECT count(*) AS n FROM purchase_orders WHERE company_id = $1 AND external_ref = 'race-1'", [f.co])).rows[0].n)).toBe(1);
  });
});

describe('list_purchase_orders', () => {
  it('filters by status list, supplier, dates and external ref; pages with next_offset; totals over the filter', async () => {
    const all = await callTool(pool, f, list, {});
    const closed = await callTool(pool, f, list, { status: ['closed', 'cancelled'] });
    expect((closed.body.purchase_orders as Json[]).map((p) => p.po_number)).toEqual(['PO0000005', 'PO0000011', 'PO0000012', 'PO0000020', 'PO0000030', 'SAGE-999999']);
    expect((await callTool(pool, f, list, { supplier_id: other.supplier })).body.total).toBe(0);
    expect((await callTool(pool, f, list, { from_date: '2026-06-11' })).body.total).toBe(0);
    expect((await callTool(pool, f, list, { external_system: 'SAGE', external_ref: 900010 })).body.purchase_orders).toMatchObject([{ po_number: 'PO0000010' }]);
    const page1 = await callTool(pool, f, list, { limit: 4 });
    const page2 = await callTool(pool, f, list, { limit: 4, offset: Number(page1.body.next_offset) });
    expect(page1.body.next_offset).toBe(4);
    expect([...(page1.body.purchase_orders as Json[]), ...(page2.body.purchase_orders as Json[])].map((p) => p.id))
      .toEqual((all.body.purchase_orders as Json[]).slice(0, 8).map((p) => p.id));
    const past = await callTool(pool, f, list, { offset: 500 });
    expect(past.body).toMatchObject({ purchase_orders: [], total: all.body.total, totals: all.body.totals, next_offset: null });
    expect((await callTool(pool, f, list, { from_date: '2026-07-01', to_date: '2026-06-01' })).text).toBe('from_date must not be after to_date');
    expect((await callTool(pool, f, list, { status: 'sent' })).isError).toBe(true);
  });
});

describe('the stored unit price', () => {
  it('a discounted and a 4-decimal line keep their amounts through the app\'s own edit of the draft', async () => {
    const po = { ...sagePo(40, f, { status: 'draft' }), expected_totals: undefined, lines: [
      { description: 'discounted', quantity: 10, unit_price: 100, line_total: 900, tax_rate: 0 },
      { description: '4 decimals', quantity: 1000, unit_price: 1.2345, tax_rate: 0 },
    ] };
    expect((await callTool(pool, f, create, { purchase_orders: [po] })).body).toMatchObject({ created: 1, purchase_orders: [{ total: 2134.5 }] });
    const id = String((await row('PO0000040')).id);
    const lines = (await pool.query('SELECT description, quantity::TEXT AS q, unit_price::TEXT AS u, line_total::TEXT AS t FROM po_items WHERE purchase_order_id = $1 ORDER BY sort_order', [id])).rows;
    expect(lines).toEqual([
      { description: 'discounted', q: '10.00', u: '90.000000', t: '900.00' },
      { description: '4 decimals', q: '1000.00', u: '1.234500', t: '1234.50' },
    ]);
    // The app's edit sends the lines back as it shows them and recomputes line_total = qty x unit price.
    const put = await putPo(f, f.owner, id, { items: lines.map((l) => ({ description: l.description, quantity: Number(l.q), unit_price: Number(l.u), tax_rate: 0 })) });
    expect(put.statusCode, JSON.stringify(put.body)).toBe(200);
    const after = (await pool.query('SELECT line_total::TEXT AS t FROM po_items WHERE purchase_order_id = $1 ORDER BY sort_order', [id])).rows;
    expect(after).toEqual([{ t: '900.00' }, { t: '1234.50' }]);
  });
});
