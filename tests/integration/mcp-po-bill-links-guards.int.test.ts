/**
 * Purchase order <-> bill links, the layers under the tools (migration 1006), real PostgreSQL:
 *   - the table refuses what the code never writes, as app_user: another company's rows, a PO and a bill of two suppliers,
 *     an UPDATE, a zero amount; another company reads none;
 *   - the migration's backfill: one `backfill` link per live bill naming a same-company, same-supplier purchase_orders row,
 *     with the amount the design gives, none for the rest, and a re-run adds nothing;
 *   - the REST bill create writes the `app` link (a legacy or foreign PO id gets none);
 *   - races: the same pair or the same reference from two calls at once ends with one link and one clean refusal; a held
 *     row ends in the typed, retryable timeout with nothing written; link x PO cancel x bill approve / cancel never deadlock.
 * Fixture route: isaflow_schema_fixture (assertDisposable). Never skips.
 */
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import billsRoute from '../../pages/api/accounting/supplier-invoices';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { callRoute, dropBillFixture, openRequest, seedBillFixture, setPolicy, type BillFixture } from './helpers/budgetBillFixture';
import { callTool, type Json } from './helpers/poImportHarness';
import { linkRows, seedBill, seedPo } from './helpers/poBillLinkHarness';
import { linkBillsToPurchaseOrderTool as link } from '@/lib/mcp/tools/writeLinkBillsToPurchaseOrder';
import { approveSupplierInvoice, cancelSupplierInvoice } from '@/modules/accounting/services/ap/supplierInvoiceService';
import { cancelApprovedPurchaseOrder } from '@/modules/accounting/services/ap/purchaseOrderCancel';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 8 });
let f: BillFixture;
let other: BillFixture;

beforeAll(async () => {
  f = await seedBillFixture(pool, 'po-links-guards');
  other = await seedBillFixture(pool, 'po-links-guards-other');
  await setPolicy(pool, f, 'warn');
}, 60_000);
afterAll(async () => {
  try {
    for (const x of [f, other]) await dropBillFixture(pool, x);
  } finally {
    await pool.end();
  }
}, 60_000);

/** Runs `text` as `fixture`'s owner in an app_user transaction that is rolled back; resolves to the error's SQLSTATE or null. */
async function asAppUser(fixture: BillFixture, text: string, params: unknown[] = []): Promise<{ code: string | null; rows: unknown[] }> {
  const req = await openRequest(pool, fixture, fixture.owner);
  try {
    const r = await req.client.query(text, params);
    return { code: null, rows: r.rows };
  } catch (e) {
    return { code: (e as { code?: string }).code ?? 'unknown', rows: [] };
  } finally {
    await req.rollback();
  }
}

const INSERT = `INSERT INTO purchase_order_bill_links (company_id, purchase_order_id, supplier_invoice_id, amount, source) VALUES ($1, $2, $3, $4, 'mcp')`;

describe('the table refuses what the code never writes (app_user)', () => {
  it('a link of one company, one supplier is accepted; foreign rows, mixed suppliers, updates and zero amounts are not', async () => {
    const po = await seedPo(pool, f, { lines: [100] });
    const bill = await seedBill(pool, f, { lines: [100] });
    expect((await asAppUser(f, INSERT, [f.co, po.po, bill.id, 100])).code).toBeNull();

    const theirPo = await seedPo(pool, other, { lines: [100] });
    const theirBill = await seedBill(pool, other, { lines: [100] });
    expect((await asAppUser(f, INSERT, [f.co, theirPo.po, bill.id, 100])).code).toBe('23514');   // PO of another company
    expect((await asAppUser(f, INSERT, [f.co, po.po, theirBill.id, 100])).code).toBe('23514');   // bill of another company
    // Not the session company: the guard (BEFORE INSERT) sees neither document under row security and refuses before the policy's check does.
    expect((await asAppUser(f, INSERT, [other.co, theirPo.po, theirBill.id, 100])).code).toBe('23514');

    const sup = crypto.randomUUID();
    await pool.query("INSERT INTO suppliers (id, company_id, name, is_active) VALUES ($1, $2, 'S2', true)", [sup, f.co]);
    const mixed = await seedBill(pool, f, { lines: [100], supplier: sup });
    expect((await asAppUser(f, INSERT, [f.co, po.po, mixed.id, 100])).code).toBe('23514');
    expect((await asAppUser(f, INSERT, [f.co, po.po, bill.id, 0])).code).toBe('23514');

    await pool.query(INSERT, [f.co, po.po, bill.id, 100]);
    expect((await asAppUser(f, 'UPDATE purchase_order_bill_links SET amount = 1 WHERE company_id = $1', [f.co])).code).toBe('42501');
    expect((await asAppUser(f, 'DELETE FROM purchase_order_bill_links WHERE company_id = $1', [f.co])).code).toBeNull();
    expect((await asAppUser(other, 'SELECT id FROM purchase_order_bill_links')).rows).toEqual([]);
    expect((await asAppUser(f, 'SELECT id FROM purchase_order_bill_links')).rows).toHaveLength(1);
    await pool.query('DELETE FROM purchase_order_bill_links WHERE company_id = $1', [f.co]);
  });
});

describe('the migration backfill', () => {
  it('links live bills of a same-company, same-supplier PO with the design amount, and a re-run adds nothing', async () => {
    const po = await seedPo(pool, f, { lines: [100, 300], status: 'closed' });
    const header = async (bill: string, poId: string | null) => pool.query('UPDATE supplier_invoices SET purchase_order_id = $2 WHERE id = $1', [bill, poId]);
    const plain = await seedBill(pool, f, { lines: [250] });                       // header only: subtotal
    const withLines = await seedBill(pool, f, { lines: [100, 150] });               // one line names a PO line: that line's amount
    const wayOver = await seedBill(pool, f, { lines: [50] });                       // its named lines exceed nothing: capped by subtotal
    const cancelled = await seedBill(pool, f, { lines: [10], status: 'cancelled' });
    const deleted = await seedBill(pool, f, { lines: [10] });
    const legacy = await seedBill(pool, f, { lines: [10] });
    const zero = await seedBill(pool, f, { lines: [] });
    const sup = crypto.randomUUID();
    await pool.query("INSERT INTO suppliers (id, company_id, name, is_active) VALUES ($1, $2, 'S3', true)", [sup, f.co]);
    const mixed = await seedBill(pool, f, { lines: [10], supplier: sup });
    const foreignPo = await seedPo(pool, other, { lines: [10] });
    const foreign = await seedBill(pool, f, { lines: [10] });
    for (const b of [plain, withLines, wayOver, cancelled, deleted, zero, mixed]) await header(b.id, po.po);
    await header(legacy.id, crypto.randomUUID());
    await header(foreign.id, foreignPo.po);
    await pool.query('UPDATE supplier_invoice_items SET po_item_id = $2 WHERE id = $1', [withLines.lines[0], po.items[0]]);
    await pool.query('UPDATE supplier_invoice_items SET po_item_id = $2, line_total = 500 WHERE id = $1', [wayOver.lines[0], po.items[1]]);
    await pool.query('UPDATE supplier_invoices SET deleted_at = now() WHERE id = $1', [deleted.id]);

    const sqlText = readFileSync('scripts/migrations/sql/1006_purchase_order_bill_links.sql', 'utf8');
    const run = async () => { const c = await pool.connect(); try { await c.query('BEGIN'); await c.query(sqlText); await c.query('COMMIT'); } catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); } };
    await run();
    const rows = await linkRows(pool, f);
    const byBill = new Map(rows.map((r) => [r.bill, r]));
    expect([...byBill.keys()].sort()).toEqual([plain.id, withLines.id, wayOver.id].sort());
    expect(rows.every((r) => r.source === 'backfill' && r.po === po.po && r.external_ref === null)).toBe(true);
    expect(byBill.get(plain.id)!.amount).toBe('250.00');
    expect(byBill.get(withLines.id)!.amount).toBe('100.00');
    expect(byBill.get(wayOver.id)!.amount).toBe('50.00');
    await run();
    expect(await linkRows(pool, f)).toHaveLength(3);
    await pool.query('DELETE FROM purchase_order_bill_links WHERE company_id = $1', [f.co]);
  });
});

describe('the bill create writes the app link', () => {
  const create = (body: Record<string, unknown>) => callRoute(billsRoute as never, f, f.owner, '/api/accounting/supplier-invoices', {
    useSequence: true, supplierId: f.supplier, invoiceDate: '2026-06-15', taxRate: 0, ...body });
  const line = (poItemId?: string) => ({ ...(poItemId ? { poItemId } : {}), description: 'x', quantity: 1, unitPrice: 80, taxRate: 0, glAccountId: f.acc.opex, cc1Id: f.cc.FT });

  it('a bill naming a PO of its supplier gets one; a legacy, foreign or other-supplier id gets none', async () => {
    const po = await seedPo(pool, f, { lines: [80, 20] });
    const ok = await create({ purchaseOrderId: po.po, items: [line(po.items[0])] });
    expect(ok.statusCode, JSON.stringify(ok.body)).toBe(201);
    const bill = (ok.body as { data: { id: string } }).data.id;
    expect(await linkRows(pool, f, `l.supplier_invoice_id = '${bill}'`)).toEqual([expect.objectContaining({ po: po.po, amount: '80.00', source: 'app', created_by: f.owner })]);

    const headerOnly = await create({ purchaseOrderId: po.po, items: [line()] });
    const bill2 = (headerOnly.body as { data: { id: string } }).data.id;
    expect((await linkRows(pool, f, `l.supplier_invoice_id = '${bill2}'`))[0]).toMatchObject({ amount: '80.00', source: 'app' });

    const legacy = await create({ purchaseOrderId: crypto.randomUUID(), items: [line()] });
    expect(legacy.statusCode).toBe(201);
    expect(await linkRows(pool, f, `l.supplier_invoice_id = '${(legacy.body as { data: { id: string } }).data.id}'`)).toEqual([]);
    const foreignPo = await seedPo(pool, other, { lines: [10] });
    const foreign = await create({ purchaseOrderId: foreignPo.po, items: [line()] });
    expect(foreign.statusCode).toBe(201);
    expect(await linkRows(pool, f, `l.supplier_invoice_id = '${(foreign.body as { data: { id: string } }).data.id}'`)).toEqual([]);
    const none = await create({ items: [line()] });
    expect(await linkRows(pool, f, `l.supplier_invoice_id = '${(none.body as { data: { id: string } }).data.id}'`)).toEqual([]);
  });
});

describe('races', () => {
  it('the same pair from two calls at once: one link, one clean "already linked"', async () => {
    const po = await seedPo(pool, f, { lines: [100] });
    const bill = await seedBill(pool, f, { lines: [100] });
    const results = await Promise.all([1, 2, 3].map(() => callTool(pool, f, link, { links: [{ po_id: po.po, bill_id: bill.id }] })));
    expect(results.filter((r) => !r.isError)).toHaveLength(1);
    for (const r of results.filter((x) => x.isError)) expect(r.text).toContain('is already linked to purchase order');
    expect(await linkRows(pool, f, `l.purchase_order_id = '${po.po}'`)).toHaveLength(1);
  });

  it('one external_ref on two different pairs at once: one link, one clean refusal (never a unique violation)', async () => {
    const po = await seedPo(pool, f, { lines: [100, 100] });
    const [b1, b2] = [await seedBill(pool, f, { lines: [100] }), await seedBill(pool, f, { lines: [100] })];
    const ref = { external_system: 'sage', external_ref: 'RACE-1' };
    const results = await Promise.all([b1, b2].map((b) => callTool(pool, f, link, { links: [{ po_id: po.po, bill_id: b.id, ...ref }] })));
    expect(results.filter((r) => !r.isError)).toHaveLength(1);
    expect(results.find((r) => r.isError)!.text).toContain('is already used by another purchase order link');
  });

  async function held(sqlText: string, params: unknown[], during: () => Promise<unknown>) {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await c.query(sqlText, params);
      return await during().then((v) => ({ v }), (e: unknown) => ({ e }));
    } finally { await c.query('ROLLBACK'); c.release(); }
  }

  it('a PO or a bill held by another request ends in a typed retryable timeout and nothing is written', async () => {
    const po = await seedPo(pool, f, { lines: [100] });
    const bill = await seedBill(pool, f, { lines: [100] });
    const call = () => callTool(pool, f, link, { links: [{ po_id: po.po, bill_id: bill.id, lines: [{ po_item_id: po.items[0], bill_line_id: bill.lines[0] }] }] });
    const poHeld = await held('SELECT 1 FROM purchase_orders WHERE id = $1 FOR UPDATE', [po.po], call);
    expect((poHeld as { e: { code: string } }).e).toMatchObject({ code: 'PURCHASE_ORDER_LOCK_TIMEOUT' });
    const billHeld = await held('SELECT 1 FROM supplier_invoices WHERE id = $1 FOR UPDATE', [bill.id], call);
    expect((billHeld as { e: { code: string } }).e).toMatchObject({ code: 'ROW_LOCK_TIMEOUT' });
    expect(await linkRows(pool, f, `l.purchase_order_id = '${po.po}'`)).toEqual([]);
    const ok = await call();
    expect(ok.isError, ok.text).toBe(false);
  }, 60_000);

  it('lock-order census in motion: link x PO cancel x bill approve / cancel (same rows, concurrently) never deadlock', async () => {
    const outcomes: unknown[] = [];
    const inRequest = async (fn: () => Promise<unknown>) => {
      const req = await openRequest(pool, f, f.owner);
      try { const v = await req.run(fn); await req.commit(); return v; } catch (e) { await req.rollback(); throw e; }
    };
    for (let i = 0; i < 10; i++) {
      const po = await seedPo(pool, f, { lines: [100] });
      const bill = await seedBill(pool, f, { lines: [100], status: 'draft' });
      const ops: Array<Promise<unknown>> = [
        callTool(pool, f, link, { links: [{ po_id: po.po, bill_id: bill.id }], close_when_fully_billed: true }),
        inRequest(() => cancelApprovedPurchaseOrder(f.co, po.po, f.owner, 'race')),
        inRequest(() => (i % 2 === 0 ? approveSupplierInvoice(f.co, bill.id, f.owner) : cancelSupplierInvoice(f.co, bill.id, f.owner))),
      ];
      outcomes.push(...(await Promise.allSettled(ops)));
    }
    const rejected = outcomes.filter((o) => (o as PromiseSettledResult<unknown>).status === 'rejected') as PromiseRejectedResult[];
    expect(rejected.map((r) => (r.reason as { code?: string }).code).filter((c) => c === '40P01' || c === '55P03')).toEqual([]);
    expect(outcomes).toHaveLength(30);
    const settled = outcomes.filter((o) => (o as PromiseSettledResult<{ body?: Json }>).status === 'fulfilled');
    expect(settled.length).toBeGreaterThan(10);
  }, 120_000);
});
