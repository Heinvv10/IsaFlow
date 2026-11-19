/**
 * Purchase order <-> bill links, the layers under the tools (migration 1006), real PostgreSQL:
 *   - the table refuses what the code never writes, as app_user: another company's rows, a PO and a bill of two suppliers,
 *     a forged source 'backfill' or closing record, a rewritten reference, an UPDATE of the amount, a zero amount; a PO or
 *     bill that has a link cannot change supplier (the database, supplier merge, the PO PUT, the draft edit); another
 *     company reads none;
 *   - the migration's backfill: one `backfill` link per live bill naming a same-company, same-supplier purchase_orders row,
 *     with the amount the design gives, none for the rest, and a re-run adds nothing;
 *   - the bill's header column follows the links only where it is theirs to rewrite (NULL, a linked PO); a legacy id stays.
 * The races are in mcp-po-bill-links-races.int.test.ts.
 * Fixture route: isaflow_schema_fixture (assertDisposable). Never skips.
 */
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { callRoute, dropBillFixture, openRequest, seedBillFixture, setPolicy, type BillFixture } from './helpers/budgetBillFixture';
import mergeRoute from '../../pages/api/accounting/supplier-merge';
import poRoute from '../../pages/api/accounting/purchase-orders/[id]';
import { callTool } from './helpers/poImportHarness';
import { billHeader, linkRows, seedBill, seedPo, seedSupplier } from './helpers/poBillLinkHarness';
import { linkBillsToPurchaseOrderTool as link } from '@/lib/mcp/tools/writeLinkBillsToPurchaseOrder';
import { unlinkBillFromPurchaseOrderTool as unlink } from '@/lib/mcp/tools/writeUnlinkBillFromPurchaseOrder';
import { updateSupplierInvoiceTool as updateBill } from '@/lib/mcp/tools/writeUpdateSupplierInvoice';
import { getSupplierInvoiceTool as getBill } from '@/lib/mcp/tools/supplierInvoices';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
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
    expect((await asAppUser(f, 'UPDATE purchase_order_bill_links SET source = \'app\' WHERE company_id = $1', [f.co])).code).toBe('42501');
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

    // The two functions as the migration file defines them (re-created here, not the whole file: its triggers lock the tables other suites use).
    const file = readFileSync('scripts/migrations/sql/1006_purchase_order_bill_links.sql', 'utf8');
    const functions = file.slice(file.indexOf('CREATE OR REPLACE FUNCTION public.po_bill_posted_cents'), file.indexOf('SELECT public.purchase_order_bill_links_backfill();'));
    await pool.query(functions);
    await pool.query('SELECT purchase_order_bill_links_backfill()');
    const rows = await linkRows(pool, f);
    const byBill = new Map(rows.map((r) => [r.bill, r]));
    expect([...byBill.keys()].sort()).toEqual([plain.id, withLines.id, wayOver.id].sort());
    expect(rows.every((r) => r.source === 'backfill' && r.po === po.po && r.external_ref === null)).toBe(true);
    expect(byBill.get(plain.id)!.amount).toBe('250.00');
    expect(byBill.get(withLines.id)!.amount).toBe('100.00');
    expect(byBill.get(wayOver.id)!.amount).toBe('50.00');
    expect(Number((await pool.query('SELECT purchase_order_bill_links_backfill() AS n')).rows[0].n)).toBe(0);
    expect(await linkRows(pool, f)).toHaveLength(3);
    await pool.query('DELETE FROM purchase_order_bill_links WHERE company_id = $1', [f.co]);
  });
});

describe('what app_user cannot forge, and the supplier guard', () => {
  it('source backfill, a closing record on a PO that is not closed, a rewritten reference: refused; adopting a reference and moving the record: allowed', async () => {
    const po = await seedPo(pool, f, { lines: [100] });
    const bill = await seedBill(pool, f, { lines: [100] });
    const ins = (cols: string, vals: string) => `INSERT INTO purchase_order_bill_links (company_id, purchase_order_id, supplier_invoice_id, amount, ${cols}) VALUES ($1, $2, $3, 100, ${vals})`;
    expect((await asAppUser(f, ins('source', "'backfill'"), [f.co, po.po, bill.id])).code).toBe('42501');
    expect((await asAppUser(f, ins('source, closed_po_from_status', "'mcp', 'approved'"), [f.co, po.po, bill.id])).code).toBe('23514');
    expect((await asAppUser(f, ins('source, closed_po_from_status', "'mcp', 'draft'"), [f.co, po.po, bill.id])).code).toBe('23514');
    await pool.query("INSERT INTO purchase_order_bill_links (company_id, purchase_order_id, supplier_invoice_id, amount, source) VALUES ($1, $2, $3, 100, 'app')", [f.co, po.po, bill.id]);
    const req = async (text: string) => asAppUser(f, text, [f.co, po.po]);
    // The closing record is a claim about a closed PO.
    expect((await req("UPDATE purchase_order_bill_links SET closed_po_from_status = 'approved' WHERE company_id = $1 AND purchase_order_id = $2")).code).toBe('23514');
    await pool.query("UPDATE purchase_orders SET status = 'closed' WHERE id = $1", [po.po]);
    expect((await req("UPDATE purchase_order_bill_links SET closed_po_from_status = 'approved' WHERE company_id = $1 AND purchase_order_id = $2")).code).toBeNull();
    expect((await req("UPDATE purchase_order_bill_links SET external_system = 'sage', external_ref = 'A' WHERE company_id = $1 AND purchase_order_id = $2")).code).toBeNull();
    // A reference, once set, never changes.
    await pool.query("UPDATE purchase_order_bill_links SET external_system = 'sage', external_ref = 'A' WHERE purchase_order_id = $1", [po.po]);
    expect((await req("UPDATE purchase_order_bill_links SET external_ref = 'B' WHERE company_id = $1 AND purchase_order_id = $2")).code).toBe('23514');
    // A closing record is moved or cleared, not rewritten.
    await pool.query("UPDATE purchase_order_bill_links SET closed_po_from_status = 'received' WHERE purchase_order_id = $1", [po.po]);
    expect((await req("UPDATE purchase_order_bill_links SET closed_po_from_status = 'approved' WHERE company_id = $1 AND purchase_order_id = $2")).code).toBe('23514');
    expect((await req("UPDATE purchase_order_bill_links SET closed_po_from_status = NULL WHERE company_id = $1 AND purchase_order_id = $2")).code).toBeNull();
    await pool.query('DELETE FROM purchase_order_bill_links WHERE company_id = $1', [f.co]);
  });

  it('a linked PO or bill cannot change supplier, at the database (any role); an unlinked one can', async () => {
    const sup = await seedSupplier(pool, f);
    const po = await seedPo(pool, f, { lines: [100] });
    const bill = await seedBill(pool, f, { lines: [100] });
    const free = await seedBill(pool, f, { lines: [100] });
    await pool.query("INSERT INTO purchase_order_bill_links (company_id, purchase_order_id, supplier_invoice_id, amount, source) VALUES ($1, $2, $3, 100, 'app')", [f.co, po.po, bill.id]);
    const code = async (text: string, params: unknown[]) => pool.query(text, params).then(() => null, (e: { code?: string }) => e.code ?? 'unknown');
    expect(await code('UPDATE supplier_invoices SET supplier_id = $2 WHERE id = $1', [bill.id, sup])).toBe('23514');
    expect(await code('UPDATE purchase_orders SET supplier_id = $2 WHERE id = $1', [po.po, sup])).toBe('23514');
    expect((await asAppUser(f, 'UPDATE supplier_invoices SET supplier_id = $2 WHERE id = $1', [bill.id, sup])).code).toBe('23514');
    expect(await code('UPDATE supplier_invoices SET supplier_id = $2 WHERE id = $1', [free.id, sup])).toBeNull();
    expect(await code('UPDATE supplier_invoices SET supplier_id = supplier_id, notes = \'x\' WHERE id = $1', [bill.id])).toBeNull();
    await pool.query('DELETE FROM purchase_order_bill_links WHERE company_id = $1', [f.co]);
  });

  it('the draft edit, the PO PUT and supplier merge refuse a supplier change with a reason before the database has to', async () => {
    const sup = await seedSupplier(pool, f);
    const po = await seedPo(pool, f, { lines: [100] });
    const bill = await seedBill(pool, f, { lines: [100], status: 'draft' });
    await pool.query("INSERT INTO purchase_order_bill_links (company_id, purchase_order_id, supplier_invoice_id, amount, source) VALUES ($1, $2, $3, 100, 'app')", [f.co, po.po, bill.id]);
    // MCP update_supplier_invoice
    const upd = await callTool(pool, f, updateBill, { invoice_id: bill.id, supplier_id: sup });
    expect(upd.isError).toBe(true);
    expect(upd.text).toContain('is linked to a purchase order, so its supplier cannot change');
    // PO PUT (only a draft / submitted PO is editable; a link on one is what the app / backfill could have made before it moved on).
    await pool.query("UPDATE purchase_orders SET status = 'draft' WHERE id = $1", [po.po]);
    const put = await callRoute(poRoute as never, f, f.owner, `/api/accounting/purchase-orders/${po.po}`, { supplier_id: sup }, { method: 'PUT', id: po.po });
    expect(put.statusCode).toBe(400);
    expect(JSON.stringify(put.body)).toContain('Bills are linked to this purchase order, so its supplier cannot change');
    // Supplier merge: the source holds linked documents.
    const merge = await callRoute(mergeRoute as never, f, f.owner, '/api/accounting/supplier-merge', { source_id: f.supplier, target_id: sup });
    expect(merge.statusCode).toBe(400);
    expect(JSON.stringify(merge.body)).toContain('has bills linked to purchase orders');
    expect(String((await pool.query('SELECT supplier_id FROM supplier_invoices WHERE id = $1', [bill.id])).rows[0].supplier_id)).toBe(f.supplier);
    expect((await pool.query('SELECT is_active FROM suppliers WHERE id = $1', [f.supplier])).rows[0].is_active).toBe(true);
    await pool.query('DELETE FROM purchase_order_bill_links WHERE company_id = $1', [f.co]);
  });
});

describe('the bill header follows the links only where it is theirs to rewrite', () => {
  it('a legacy id and an unlinked canonical PO stay; NULL and a linked PO follow the single-link rule', async () => {
    const a = await seedPo(pool, f, { lines: [100] });
    const b = await seedPo(pool, f, { lines: [100] });
    const legacyId = crypto.randomUUID();
    const legacy = await seedBill(pool, f, { lines: [100] });
    await pool.query('UPDATE supplier_invoices SET purchase_order_id = $2 WHERE id = $1', [legacy.id, legacyId]);
    const unlinkedHeader = await seedBill(pool, f, { lines: [100] });
    await pool.query('UPDATE supplier_invoices SET purchase_order_id = $2 WHERE id = $1', [unlinkedHeader.id, b.po]);
    const plain = await seedBill(pool, f, { lines: [100] });
    const r = await callTool(pool, f, link, { links: [
      { po_id: a.po, bill_id: legacy.id }, { po_id: a.po, bill_id: unlinkedHeader.id }, { po_id: a.po, bill_id: plain.id },
    ] });
    expect(r.isError, r.text).toBe(false);
    expect(await billHeader(pool, legacy.id)).toBe(legacyId);
    expect(await billHeader(pool, unlinkedHeader.id)).toBe(b.po);
    expect(await billHeader(pool, plain.id)).toBe(a.po);
    const listed = await callTool(pool, f, getBill, { invoice_id: legacy.id });
    expect(listed.body.purchase_order_ids).toEqual([a.po]);
    // The legacy header survives an unlink of the link made over it; the managed one resets.
    await callTool(pool, f, unlink, { po_id: a.po, bill_id: legacy.id, reason: 'undo' });
    await callTool(pool, f, unlink, { po_id: a.po, bill_id: plain.id, reason: 'undo' });
    expect(await billHeader(pool, legacy.id)).toBe(legacyId);
    expect(await billHeader(pool, plain.id)).toBeNull();
    // Two links: NULL; one removed: the other, and an unlink of the PO the header names (removed) resets it.
    const two = await seedBill(pool, f, { lines: [100, 100] });
    await callTool(pool, f, link, { links: [{ po_id: a.po, bill_id: two.id, amount: 100 }, { po_id: b.po, bill_id: two.id, amount: 100 }] });
    expect(await billHeader(pool, two.id)).toBeNull();
    await callTool(pool, f, unlink, { po_id: a.po, bill_id: two.id, reason: 'one' });
    expect(await billHeader(pool, two.id)).toBe(b.po);
    await callTool(pool, f, unlink, { po_id: b.po, bill_id: two.id, reason: 'two' });
    expect(await billHeader(pool, two.id)).toBeNull();
  });
});
