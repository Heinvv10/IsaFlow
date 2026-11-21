/**
 * Supplier merge and a bill's goods received note (gate at c63b1e26, major; issue #1708; docs/design/mcp-goods-received.md
 * "A bill's GRN"), real PostgreSQL, as app_user. A bill whose only tie to a PO is its grn_id (no link row, no header, no line)
 * would move to the target supplier while its note's PO stays on the source. Both merge paths refuse it, as they refuse a source
 * with PO links: the REST route (pages/api/accounting/supplier-merge.ts) with a 400, the duplicates merge (mergeEntities) with a
 * SupplierMergeRefusal; nothing moves. Taking the note off the bill (the named exit) lets the merge through. Only live bills block
 * (a cancelled or soft-deleted one moves with the rest). A bill create and a merge of its supplier are serialised on the supplier
 * row: the merge's FOR UPDATE (both suppliers, bounded) against the bill INSERT's FK KEY SHARE (supplier_invoices_supplier_id_fkey),
 * so a noted bill is either seen by the merge's check or written after the merge, never moved unseen.
 * Fixture route: isaflow_schema_fixture (assertDisposable). Never skips.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { callRoute, dropBillFixture, openRequest, seedBillFixture, type BillFixture } from './helpers/budgetBillFixture';
import { seedSupplier } from './helpers/poBillLinkHarness';
import { callTool, dropGrnExtras, dropMaintExtras, grnArgs, seedQtyPo } from './helpers/grnHarness';
import { createGoodsReceivedTool as create } from '@/lib/mcp/tools/writeCreateGoodsReceived';
import { updateSupplierInvoiceTool as update } from '@/lib/mcp/tools/writeUpdateSupplierInvoice';
import { createSupplierInvoice } from '@/modules/accounting/services/ap/supplierInvoiceService';
import { SupplierMergeRefusal, mergeEntities } from '@/modules/accounting/services/core/duplicateMergeService';
import { RowLockTimeoutError } from '@/modules/accounting/services/core/rowLockBudget';
import mergeRoute from '../../pages/api/accounting/supplier-merge';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 6 });
let f: BillFixture;
let target: string;

beforeAll(async () => {
  f = await seedBillFixture(pool, 'grn-supplier-merge');
  target = await seedSupplier(pool, f, 'Merge target');
}, 60_000);
afterAll(async () => {
  try { await dropGrnExtras(pool, f); await dropMaintExtras(pool, f); await dropBillFixture(pool, f); } finally { await pool.end(); }
}, 60_000);

/** A live note on a fresh PO of the fixture's supplier. */
async function noteOfSource(): Promise<string> {
  const po = await seedQtyPo(pool, f, { lines: [{ qty: 4, price: 10 }] });
  const r = await callTool(pool, f, create, grnArgs(po, [[0, 4]]));
  expect(r.isError, r.text).toBe(false);
  return String(r.body.grn_id);
}
const billInput = (grnId: string, fx: BillFixture = f) => ({
  invoiceNumber: `GRN-MERGE-${crypto.randomUUID().slice(0, 8)}`, supplierId: fx.supplier, invoiceDate: '2026-06-15', grnId,
  items: [{ description: 'Delivered goods', quantity: 1, unitPrice: 40, taxRate: 15, glAccountId: fx.acc.opex }],
});

/** A draft bill of the fixture's supplier carrying a live note on its PO, and no other tie to a PO. */
async function billOnlyTiedByItsNote(): Promise<{ bill: string; number: string }> {
  const grn = await noteOfSource();
  const req = await openRequest(pool, f, f.owner);
  try {
    const bill = await req.run(() => createSupplierInvoice(f.co, billInput(grn), f.owner));
    await req.commit();
    expect(Number((await pool.query('SELECT count(*) AS n FROM purchase_order_bill_links WHERE supplier_invoice_id = $1', [bill.id])).rows[0].n)).toBe(0);
    return { bill: bill.id, number: bill.invoiceNumber };
  } catch (err) { await req.rollback(); throw err; }
}
async function inReq<T>(fx: BillFixture, fn: () => Promise<T>): Promise<T> {
  const r = await openRequest(pool, fx, fx.owner);
  try { const v = await r.run(fn); await r.commit(); return v; } catch (e) { await r.rollback(); throw e; }
}
const supplierOf = async (bill: string) => String((await pool.query('SELECT supplier_id FROM supplier_invoices WHERE id = $1', [bill])).rows[0].supplier_id);
const sourceLive = async () => (await pool.query('SELECT deleted_at IS NULL AS live FROM suppliers WHERE id = $1', [f.supplier])).rows[0].live as boolean;

describe('supplier merge refuses a source whose live bills carry a goods received note', () => {
  it('the REST merge answers 400 naming the bill and the exit; nothing moves', async () => {
    const { bill, number } = await billOnlyTiedByItsNote();
    const out = await callRoute(mergeRoute as never, f, f.owner, '/api/accounting/supplier-merge', { source_id: f.supplier, target_id: target });
    expect(out.statusCode, JSON.stringify(out.body)).toBe(400);
    const text = JSON.stringify(out.body);
    expect(text).toContain('goods received note');
    expect(text).toContain(number);
    expect(text).toContain('delete it and enter it again without the note');
    expect(await supplierOf(bill)).toBe(f.supplier);
    expect(await sourceLive()).toBe(true);
  });

  it('the duplicates merge throws a SupplierMergeRefusal; nothing moves; with the note taken off, the merge goes through', async () => {
    const { bill } = await billOnlyTiedByItsNote();
    const merge = async () => {
      const req = await openRequest(pool, f, f.owner);
      try { const r = await req.run(() => mergeEntities(f.co, 'supplier', target, f.supplier, f.owner)); await req.commit(); return r; } catch (err) { await req.rollback(); return err; }
    };
    const refused = await merge();
    expect(refused).toBeInstanceOf(SupplierMergeRefusal);
    expect((refused as Error).message).toContain('goods received note');
    expect(await supplierOf(bill)).toBe(f.supplier);
    // The exit: take the note off every such bill (drafts: grn_id null), then merge.
    const carrying = (await pool.query(
      "SELECT id FROM supplier_invoices WHERE company_id = $1 AND supplier_id = $2 AND grn_id IS NOT NULL AND deleted_at IS NULL AND status IS DISTINCT FROM 'cancelled'",
      [f.co, f.supplier])).rows.map((r) => String(r.id));
    for (const id of carrying) expect((await callTool(pool, f, update, { invoice_id: id, grn_id: null })).isError).toBe(false);
    const done = await merge();
    expect(done).not.toBeInstanceOf(Error);
    expect(await supplierOf(bill)).toBe(target);
    expect(await sourceLive()).toBe(false);
  });
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
/** Until a statement containing `fragment` waits on a lock (or `ms` passed; false then). */
async function waitsOnLock(fragment: string, ms = 3000): Promise<boolean> {
  for (let t = 0; t < ms; t += 25) {
    const rows = (await pool.query(
      "SELECT 1 FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND datname = current_database() AND query LIKE '%' || $1 || '%'", [fragment])).rows;
    if (rows.length > 0) return true;
    await sleep(25);
  }
  return false;
}
describe('a bill create and a merge of its supplier are serialised on the supplier row (follow-up to the merge major)', () => {
  it('a create in flight holds the supplier (FK KEY SHARE): the merge waits for it, then sees its bill and refuses', async () => {
    const own = await seedBillFixture(pool, 'grn-merge-race-a');
    const fresh = await seedSupplier(pool, own, 'Race target A');
    try {
      const po = await seedQtyPo(pool, own, { lines: [{ qty: 4, price: 10 }] });
      const note = await callTool(pool, own, create, grnArgs(po, [[0, 4]]));
      const creating = await openRequest(pool, own, own.owner);
      let merging: Promise<unknown> | undefined;
      try {
        await creating.run(() => createSupplierInvoice(own.co, billInput(String(note.body.grn_id), own), own.owner));
        const m = await openRequest(pool, own, own.owner);
        merging = m.run(() => mergeEntities(own.co, 'supplier', fresh, own.supplier, own.owner))
          .then(async (r) => { await m.commit(); return r; }, async (e) => { await m.rollback(); return e; });
        expect(await waitsOnLock('FROM suppliers')).toBe(true);
        await creating.commit();
      } catch (err) { await creating.rollback(); throw err; }
      const outcome = await merging!;
      expect(outcome).toBeInstanceOf(SupplierMergeRefusal);
      expect((outcome as Error).message).toContain('goods received note');
      expect((await pool.query('SELECT deleted_at IS NULL AS live FROM suppliers WHERE id = $1', [own.supplier])).rows[0].live).toBe(true);
    } finally { await dropGrnExtras(pool, own); await dropMaintExtras(pool, own); await dropBillFixture(pool, own); }
  });

  it('the REAL merge, paused after its supplier lock, makes a bill create of that supplier wait; no merged bill on the old supplier\'s noted PO', async () => {
    const own = await seedBillFixture(pool, 'grn-merge-race-b');
    const fresh = await seedSupplier(pool, own, 'Race target B');
    try {
      const po = await seedQtyPo(pool, own, { lines: [{ qty: 4, price: 10 }] });
      const note = String((await callTool(pool, own, create, grnArgs(po, [[0, 4]]))).body.grn_id);
      // A plain bill of the source, its row held by the test: the merge takes the suppliers FOR UPDATE, runs its checks, then stops at
      // its bill UPDATE on this row. That is where it is paused, holding the supplier lock (review of 3010bf7e, L2).
      const plain = await inReq(own, () => createSupplierInvoice(own.co, billInput('', own), own.owner));
      const hold = await pool.connect();
      await hold.query('BEGIN');
      await hold.query('SELECT id FROM supplier_invoices WHERE id = $1 FOR UPDATE', [plain.id]);
      const m = await openRequest(pool, own, own.owner);
      const merging = m.run(() => mergeEntities(own.co, 'supplier', fresh, own.supplier, own.owner))
        .then(async (r) => { await m.commit(); return r; }, async (e) => { await m.rollback(); return e; });
      let creating: Promise<unknown> | undefined;
      try {
        expect(await waitsOnLock('UPDATE supplier_invoices SET supplier_id')).toBe(true);
        const c = await openRequest(pool, own, own.owner);
        creating = c.run(() => createSupplierInvoice(own.co, billInput(note, own), own.owner))
          .then(async (r) => { await c.commit(); return r; }, async (e) => { await c.rollback(); return e; });
        expect(await waitsOnLock('INSERT INTO supplier_invoices')).toBe(true);
      } finally { await hold.query('ROLLBACK'); hold.release(); }
      expect(await merging).toMatchObject({ reassignedTransactions: expect.any(Number) });
      await creating;
      const stranded = Number((await pool.query(
        `SELECT count(*) AS n FROM supplier_invoices si JOIN goods_received_notes g ON g.id = si.grn_id JOIN purchase_orders po ON po.id = g.purchase_order_id
          WHERE si.company_id = $1 AND si.supplier_id = $2 AND po.supplier_id = $3`, [own.co, fresh, own.supplier])).rows[0].n);
      expect(stranded).toBe(0);
    } finally { await dropGrnExtras(pool, own); await dropMaintExtras(pool, own); await dropBillFixture(pool, own); }
  });
});

describe('the merge\'s supplier lock is bounded', () => {
  it('a supplier row held past the 5 s budget is a typed, retryable RowLockTimeoutError; nothing moves', async () => {
    const own = await seedBillFixture(pool, 'grn-merge-bound');
    const fresh = await seedSupplier(pool, own, 'Bound target');
    const holder = await pool.connect();
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT id FROM suppliers WHERE id = $1 FOR UPDATE', [own.supplier]);
      const req = await openRequest(pool, own, own.owner);
      let out: unknown;
      try { out = await req.run(() => mergeEntities(own.co, 'supplier', fresh, own.supplier, own.owner)); await req.commit(); }
      catch (err) { await req.rollback(); out = err; }
      expect(out).toBeInstanceOf(RowLockTimeoutError);
      expect((out as RowLockTimeoutError).code).toBe('ROW_LOCK_TIMEOUT');
      await holder.query('ROLLBACK');
      expect((await pool.query('SELECT deleted_at IS NULL AS live FROM suppliers WHERE id = $1', [own.supplier])).rows).toEqual([{ live: true }]);
    } finally {
      await holder.query('ROLLBACK'); holder.release();
      await dropGrnExtras(pool, own); await dropMaintExtras(pool, own); await dropBillFixture(pool, own);
    }
  }, 30_000);
});

describe('only live bills block the merge (follow-up: the live-only filter)', () => {
  it('a cancelled bill and a soft-deleted bill carrying a grn_id do not block it; both move with the rest', async () => {
    const own = await seedBillFixture(pool, 'grn-merge-live-only');
    const fresh = await seedSupplier(pool, own, 'Live-only target');
    try {
      const po = await seedQtyPo(pool, own, { lines: [{ qty: 4, price: 10 }] });
      const note = String((await callTool(pool, own, create, grnArgs(po, [[0, 4]]))).body.grn_id);
      const bills: string[] = [];
      for (let i = 0; i < 2; i++) {
        const req = await openRequest(pool, own, own.owner);
        try { bills.push((await req.run(() => createSupplierInvoice(own.co, billInput(note, own), own.owner))).id); await req.commit(); }
        catch (err) { await req.rollback(); throw err; }
      }
      // Set as the cancel / delete paths leave them (the bill guards are not what this test is about).
      const c = await pool.connect();
      try {
        await c.query('BEGIN');
        await c.query('SET LOCAL session_replication_role = replica');
        await c.query("UPDATE supplier_invoices SET status = 'cancelled' WHERE id = $1", [bills[0]]);
        await c.query('UPDATE supplier_invoices SET deleted_at = now() WHERE id = $1', [bills[1]]);
        await c.query('COMMIT');
      } catch (err) { await c.query('ROLLBACK'); throw err; } finally { c.release(); }
      const req = await openRequest(pool, own, own.owner);
      let out: unknown;
      try { out = await req.run(() => mergeEntities(own.co, 'supplier', fresh, own.supplier, own.owner)); await req.commit(); }
      catch (err) { await req.rollback(); out = err; }
      expect(out).not.toBeInstanceOf(Error);
      const moved = (await pool.query('SELECT supplier_id::text AS s FROM supplier_invoices WHERE id = ANY($1::uuid[])', [bills])).rows.map((r) => r.s);
      expect(moved).toEqual([fresh, fresh]);
    } finally { await dropGrnExtras(pool, own); await dropMaintExtras(pool, own); await dropBillFixture(pool, own); }
  });
});
