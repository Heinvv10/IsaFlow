/**
 * A live bill never carries a cancelled (or foreign, or missing) goods received note, in the DATABASE (Codex gate at 42de08b3, 4;
 * migration 1021's trg_supplier_invoices_grn_live), so a writer that skips the app's checks (the old code after a rollback, a direct
 * statement) is refused too. Real PostgreSQL, as app_user:
 *   - a direct INSERT of a live bill naming a cancelled note is refused (SQLSTATE 23503, constraint supplier_invoices_grn_live);
 *   - relinking a live bill to a cancelled note (UPDATE OF grn_id) is refused; so is restoring a deleted bill whose note was cancelled
 *     (UPDATE deleted_at = NULL); a deleted or cancelled bill may still name it;
 *   - a bill INSERT racing goods_received_note_cancel ends consistently in both orders: cancel first, the insert waits on the note and
 *     is refused; insert first, the cancel waits on the note and answers grn_on_bill;
 *   - a legacy live bill on a missing note (written before the trigger) is untouched by an edit that keeps its grn_id;
 *   - createSupplierInvoice waiting at the trigger on a running cancel answers the typed SupplierInvoiceGrnRefusal;
 *   - a draft edit that puts a note on a bill, and a create naming the note's PO as its header, take the note's PO FOR KEY SHARE before
 *     the statement whose trigger takes the note, so a PO held FOR UPDATE, the cancel's first lock, leaves the note free for the cancel's
 *     second: no cycle.
 * Fixture route: isaflow_schema_fixture (assertDisposable). Never skips.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { dropBillFixture, openRequest, seedBillFixture, type BillFixture } from './helpers/budgetBillFixture';
import { seedBill } from './helpers/poBillLinkHarness';
import { callTool, dropGrnExtras, dropMaintExtras, grnArgs, seedQtyPo } from './helpers/grnHarness';
import { createGoodsReceivedTool as create } from '@/lib/mcp/tools/writeCreateGoodsReceived';
import { cancelGoodsReceivedTool as cancel } from '@/lib/mcp/tools/writeCancelGoodsReceived';
import { updateSupplierInvoiceTool as update } from '@/lib/mcp/tools/writeUpdateSupplierInvoice';
import { createSupplierInvoice } from '@/modules/accounting/services/ap/supplierInvoiceService';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 6 });
let f: BillFixture;
let other: BillFixture;

beforeAll(async () => { f = await seedBillFixture(pool, 'grn-db-guard'); other = await seedBillFixture(pool, 'grn-db-guard-other'); }, 60_000);
afterAll(async () => {
  try {
    for (const x of [f, other]) { await dropGrnExtras(pool, x); await dropMaintExtras(pool, x); await dropBillFixture(pool, x); }
  } finally { await pool.end(); }
}, 60_000);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitsOnLock(fragment: string, ms = 4000): Promise<boolean> {
  for (let t = 0; t < ms; t += 25) {
    const rows = (await pool.query(
      "SELECT 1 FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND datname = current_database() AND query LIKE '%' || $1 || '%'", [fragment])).rows;
    if (rows.length > 0) return true;
    await sleep(25);
  }
  return false;
}
const note = async () => {
  const po = await seedQtyPo(pool, f, { lines: [{ qty: 4, price: 10 }] });
  const r = await callTool(pool, f, create, grnArgs(po, [[0, 4]]));
  expect(r.isError, r.text).toBe(false);
  return String(r.body.grn_id);
};
const cancelled = async () => {
  const id = await note();
  expect((await callTool(pool, f, cancel, { grn_id: id, reason: 'wrong delivery' })).isError).toBe(false);
  return id;
};
const INSERT = `INSERT INTO supplier_invoices (company_id, invoice_number, supplier_id, invoice_date, subtotal, total_amount, status, created_by, grn_id)
                VALUES ($1, $2, $3, '2026-06-15', 40, 46, 'draft', $4, $5) RETURNING id`;
const number = () => `GDB-${crypto.randomUUID().slice(0, 8)}`;
/** One committed statement as app_user: 'ok' or the SQLSTATE and constraint. */
const asApp = async (q: string, params: unknown[]) => {
  const req = await openRequest(pool, f, f.owner);
  try { await req.client.query(q, params); await req.commit(); return 'ok'; } catch (e) {
    await req.rollback();
    const err = e as { code?: string; constraint?: string };
    return `${err.code}:${err.constraint ?? ''}`;
  }
};

describe('the database refuses a live bill on a cancelled note', () => {
  it('a direct INSERT naming a cancelled note is refused; a live note is accepted', async () => {
    const dead = await cancelled();
    expect(await asApp(INSERT, [f.co, number(), f.supplier, f.owner, dead])).toBe('23503:supplier_invoices_grn_live');
    expect(Number((await pool.query('SELECT count(*) AS n FROM supplier_invoices WHERE grn_id = $1', [dead])).rows[0].n)).toBe(0);
    expect(await asApp(INSERT, [f.co, number(), f.supplier, f.owner, await note()])).toBe('ok');
    // A note that is not this company's (another company's live note, or none at all) is refused as well.
    const po = await seedQtyPo(pool, other, { lines: [{ qty: 4, price: 10 }] });
    const theirs = await callTool(pool, other, create, grnArgs(po, [[0, 4]]));
    expect(theirs.isError, theirs.text).toBe(false);
    expect(await asApp(INSERT, [f.co, number(), f.supplier, f.owner, String(theirs.body.grn_id)])).toBe('23503:supplier_invoices_grn_live');
    expect(await asApp(INSERT, [f.co, number(), f.supplier, f.owner, crypto.randomUUID()])).toBe('23503:supplier_invoices_grn_live');
  });

  it('relinking a live bill to a cancelled note, and restoring a deleted bill whose note was cancelled, are refused', async () => {
    const dead = await cancelled();
    const bill = await seedBill(pool, f, { status: 'draft', lines: [40] });
    expect(await asApp('UPDATE supplier_invoices SET grn_id = $2 WHERE id = $1', [bill.id, dead])).toBe('23503:supplier_invoices_grn_live');
    // A deleted bill may carry it (the cancel freed it); bringing that bill back live may not.
    const live = await note();
    const deleted = await seedBill(pool, f, { status: 'draft', lines: [40] });
    await pool.query('UPDATE supplier_invoices SET grn_id = $2, deleted_at = now() WHERE id = $1', [deleted.id, live]);
    expect((await callTool(pool, f, cancel, { grn_id: live, reason: 'after the bill was deleted' })).isError).toBe(false);
    expect(await asApp('UPDATE supplier_invoices SET deleted_at = NULL WHERE id = $1', [deleted.id])).toBe('23503:supplier_invoices_grn_live');
    expect(await asApp("UPDATE supplier_invoices SET notes = 'still deleted' WHERE id = $1", [deleted.id])).toBe('ok');
  });
});

describe('a stored grn_id the trigger has not judged (a legacy live bill on a missing note)', () => {
  it('is untouched by an edit that keeps it: the draft edit (which writes grn_id back unchanged) still saves', async () => {
    const bill = await seedBill(pool, f, { status: 'draft', lines: [40] });
    const dangling = crypto.randomUUID();
    // As production may hold it from before 1021 (201's column has no FK): written with the trigger off, in one transaction.
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await c.query('ALTER TABLE supplier_invoices DISABLE TRIGGER trg_supplier_invoices_grn_live');
      await c.query('UPDATE supplier_invoices SET grn_id = $2 WHERE id = $1', [bill.id, dangling]);
      await c.query('ALTER TABLE supplier_invoices ENABLE ALWAYS TRIGGER trg_supplier_invoices_grn_live');
      await c.query('COMMIT');
    } catch (err) { await c.query('ROLLBACK'); throw err; } finally { c.release(); }
    const r = await callTool(pool, f, update, { invoice_id: bill.id, notes: 'kept its old note id' });
    expect(r.isError, r.text).toBe(false);
    expect((await pool.query('SELECT grn_id::text AS g, notes FROM supplier_invoices WHERE id = $1', [bill.id])).rows[0]).toEqual({ g: dangling, notes: 'kept its old note id' });
  });
});

describe('a bill INSERT racing the note\'s cancel (both orders)', () => {
  it('cancel first: the insert waits on the note, then is refused; no live bill on the cancelled note', async () => {
    const id = await note();
    const c = await openRequest(pool, f, f.owner);
    expect((await c.client.query('SELECT outcome FROM public.goods_received_note_cancel($1, $2)', [id, 'race'])).rows[0]).toEqual({ outcome: 'cancelled' });
    const inserting = asApp(INSERT, [f.co, number(), f.supplier, f.owner, id]);
    try {
      expect(await waitsOnLock('INSERT INTO supplier_invoices')).toBe(true);
    } finally { await c.commit(); }
    expect(await inserting).toBe('23503:supplier_invoices_grn_live');
    expect(Number((await pool.query("SELECT count(*) AS n FROM supplier_invoices WHERE grn_id = $1 AND deleted_at IS NULL AND status IS DISTINCT FROM 'cancelled'", [id])).rows[0].n)).toBe(0);
  });

  it('insert first: the cancel waits on the note, then finds the bill and answers grn_on_bill', async () => {
    const id = await note();
    const b = await openRequest(pool, f, f.owner);
    await b.client.query(INSERT, [f.co, number(), f.supplier, f.owner, id]);
    const c = await openRequest(pool, f, f.owner);
    const cancelling = c.client.query('SELECT outcome FROM public.goods_received_note_cancel($1, $2)', [id, 'race'])
      .then(async (r) => { await c.commit(); return r.rows[0]; }, async (e) => { await c.rollback(); return e; });
    try {
      expect(await waitsOnLock('goods_received_note_cancel')).toBe(true);
    } finally { await b.commit(); }
    expect(await cancelling).toEqual({ outcome: 'grn_on_bill' });
    expect(String((await pool.query('SELECT status FROM goods_received_notes WHERE id = $1', [id])).rows[0].status)).toBe('received');
  });
});

describe('the app writers under the trigger (typed refusal, no cycle with the cancel)', () => {
  it('createSupplierInvoice waiting on a running cancel answers SUPPLIER_INVOICE_GRN_REFUSED', async () => {
    const id = await note();
    const c = await openRequest(pool, f, f.owner);
    expect((await c.client.query('SELECT outcome FROM public.goods_received_note_cancel($1, $2)', [id, 'race'])).rows[0]).toEqual({ outcome: 'cancelled' });
    const req = await openRequest(pool, f, f.owner);
    const input = { invoiceNumber: number(), supplierId: f.supplier, invoiceDate: '2026-06-15', grnId: id,
      items: [{ description: 'Delivered goods', quantity: 1, unitPrice: 40, taxRate: 15, glAccountId: f.acc.opex }] };
    const creating = req.run(() => createSupplierInvoice(f.co, input, f.owner)).then(
      async () => { await req.commit(); return 'created'; },
      async (e: unknown) => { await req.rollback(); return String((e as { code?: string }).code); });
    try {
      // At the note's PO (lockNotePo), which the cancel holds; its INSERT's trigger then reads the committed cancel.
      expect(await waitsOnLock('FOR KEY SHARE OF po')).toBe(true);
    } finally { await c.commit(); }
    expect(await creating).toBe('SUPPLIER_INVOICE_GRN_REFUSED');
  });

  it('a create naming the note\'s PO as header holds that PO before the INSERT: the PO held FOR UPDATE leaves the note free', async () => {
    const po = await seedQtyPo(pool, f, { lines: [{ qty: 4, price: 10 }] });
    const r = await callTool(pool, f, create, grnArgs(po, [[0, 4]]));
    expect(r.isError, r.text).toBe(false);
    const id = String(r.body.grn_id);
    const input = { invoiceNumber: number(), supplierId: f.supplier, invoiceDate: '2026-06-15', grnId: id, purchaseOrderId: po.po,
      items: [{ description: 'Delivered goods', quantity: 1, unitPrice: 40, taxRate: 15, glAccountId: f.acc.opex }] };
    const holder = await pool.connect();
    const req = await openRequest(pool, f, f.owner);
    let creating: Promise<string> | undefined;
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT 1 FROM purchase_orders WHERE id = $1 FOR UPDATE', [po.po]);
      creating = req.run(() => createSupplierInvoice(f.co, input, f.owner)).then(
        async () => { await req.commit(); return 'created'; },
        async (e: unknown) => { await req.rollback(); return String((e as { code?: string }).code ?? e); });
      expect(await waitsOnLock('purchase_orders')).toBe(true);
      await holder.query('SELECT 1 FROM goods_received_notes WHERE id = $1 FOR UPDATE NOWAIT', [id]);
    } finally { await holder.query('ROLLBACK'); holder.release(); }
    expect(await creating!).toBe('created');
  });

  it('a draft edit putting a note on the bill holds the note\'s PO first: the PO held FOR UPDATE leaves the note free', async () => {
    const po = await seedQtyPo(pool, f, { lines: [{ qty: 4, price: 10 }] });
    const r = await callTool(pool, f, create, grnArgs(po, [[0, 4]]));
    expect(r.isError, r.text).toBe(false);
    const id = String(r.body.grn_id);
    const bill = await seedBill(pool, f, { status: 'draft', lines: [40] });
    await pool.query('UPDATE supplier_invoices SET purchase_order_id = $2 WHERE id = $1', [bill.id, po.po]);
    const holder = await pool.connect();
    let editing: ReturnType<typeof callTool> | undefined;
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT 1 FROM purchase_orders WHERE id = $1 FOR UPDATE', [po.po]);
      editing = callTool(pool, f, update, { invoice_id: bill.id, grn_id: id });
      expect(await waitsOnLock('purchase_orders')).toBe(true);
      // goods_received_note_cancel's next lock after the PO: free, since the edit holds nothing on the note yet (else a cycle).
      await holder.query('SELECT 1 FROM goods_received_notes WHERE id = $1 FOR UPDATE NOWAIT', [id]);
    } finally { await holder.query('ROLLBACK'); holder.release(); }
    const done = await editing!;
    expect(done.isError, done.text).toBe(false);
    expect(String((await pool.query('SELECT grn_id::text AS g FROM supplier_invoices WHERE id = $1', [bill.id])).rows[0].g)).toBe(id);
  });
});
