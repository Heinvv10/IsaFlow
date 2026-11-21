/**
 * Supplier merge against the writes that make a bill live and noted WITHOUT taking the supplier's FK KEY SHARE (blind review of
 * 3010bf7e, M1 and L1; the reviewer's repros R1 / R2 brought in), real PostgreSQL, as app_user:
 *   - R1: a write ADDING grn_id that takes no supplier lock (supplier unchanged) is uncommitted while the merge runs. The merge's
 *     noted-bill check cannot see it; its bill UPDATE waits on the row and, after the write commits, EvalPlanQual moves the now-noted
 *     bill. The UPDATE's RETURNING catches that: the merge is refused and rolls back, also when the caller commits a 4xx (as withAuth
 *     does), in both paths;
 *   - R2: the undo of a deleted noted bill is uncommitted while the merge runs. The restore takes the supplier row FOR KEY SHARE first,
 *     so the merge waits on the supplier, then sees the live noted bill and refuses;
 *   - L1: the refusal names the exit for the bill's state (a paid bill: reverse its payments, then cancel it), in UI terms.
 * Fixture route: isaflow_schema_fixture (assertDisposable). Never skips.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { callRoute, dropBillFixture, openRequest, seedBillFixture, type BillFixture } from './helpers/budgetBillFixture';
import { seedSupplier } from './helpers/poBillLinkHarness';
import { callTool, dropGrnExtras, dropMaintExtras, grnArgs, seedQtyPo } from './helpers/grnHarness';
import { createGoodsReceivedTool as create } from '@/lib/mcp/tools/writeCreateGoodsReceived';
import { createSupplierInvoice } from '@/modules/accounting/services/ap/supplierInvoiceService';
import { SupplierMergeRefusal, mergeEntities } from '@/modules/accounting/services/core/duplicateMergeService';
import { softDelete, undoDelete } from '@/modules/accounting/services/core/softDeleteService';
import mergeRoute from '../../pages/api/accounting/supplier-merge';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 8 });
afterAll(async () => { await pool.end(); });

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
const billInput = (fx: BillFixture, grnId?: string) => ({
  invoiceNumber: `RACE-${crypto.randomUUID().slice(0, 8)}`, supplierId: fx.supplier, invoiceDate: '2026-06-15', ...(grnId ? { grnId } : {}),
  items: [{ description: 'Goods', quantity: 1, unitPrice: 40, taxRate: 15, glAccountId: fx.acc.opex }],
});
async function inReq<T>(fx: BillFixture, fn: () => Promise<T>): Promise<T> {
  const r = await openRequest(pool, fx, fx.owner);
  try { const v = await r.run(fn); await r.commit(); return v; } catch (e) { await r.rollback(); throw e; }
}
/** Bills on the target whose note's PO is still the source supplier's: what a merge must never leave. */
const stranded = async (fx: BillFixture, target: string) => (await pool.query(
  `SELECT si.id::text FROM supplier_invoices si JOIN goods_received_notes g ON g.id = si.grn_id JOIN purchase_orders po ON po.id = g.purchase_order_id
    WHERE si.company_id = $1 AND si.supplier_id = $2 AND po.supplier_id = $3`, [fx.co, target, fx.supplier])).rows;
const noteOf = async (fx: BillFixture) => {
  const po = await seedQtyPo(pool, fx, { lines: [{ qty: 4, price: 10 }] });
  return String((await callTool(pool, fx, create, grnArgs(po, [[0, 4]]))).body.grn_id);
};
async function withFixture(tag: string, fn: (fx: BillFixture, target: string) => Promise<void>) {
  const fx = await seedBillFixture(pool, tag);
  const target = await seedSupplier(pool, fx, `${tag} target`);
  try { await fn(fx, target); } finally { await dropGrnExtras(pool, fx); await dropMaintExtras(pool, fx); await dropBillFixture(pool, fx); }
}
/**
 * An open transaction that makes `bill` noted with a bare UPDATE of grn_id, as app_user: its supplier is unchanged and the row was not
 * written earlier in the transaction, so the FK takes no KEY SHARE on the supplier. It stands for any writer that does this without
 * the supplier lock (the MCP draft edit happens to take it: its earlier UPDATE of the same row makes the FK check run).
 */
async function openNoting(fx: BillFixture, bill: string, note: string) {
  const e = await openRequest(pool, fx, fx.owner);
  await e.client.query('UPDATE supplier_invoices SET grn_id = $2 WHERE id = $1 AND company_id = $3', [bill, note, fx.co]);
  return e;
}

describe('R1: a writer adding grn_id without the supplier lock races a merge (the bill UPDATE\'s RETURNING)', () => {
  it('the duplicates merge is refused after its bill UPDATE, and nothing it wrote stays, even when the caller commits the 4xx', async () => {
    await withFixture('race-r1-dup', async (fx, target) => {
      const note = await noteOf(fx);
      const bill = await inReq(fx, () => createSupplierInvoice(fx.co, billInput(fx), fx.owner));
      const e = await openNoting(fx, bill.id, note);
      // As withAuth does below 500: the merge's request commits whatever it answered.
      const m = await openRequest(pool, fx, fx.owner);
      const merging = m.run(() => mergeEntities(fx.co, 'supplier', target, fx.supplier, fx.owner))
        .then(async (r) => { await m.commit(); return r; }, async (err) => { await m.commit(); return err; });
      try {
        expect(await waitsOnLock('UPDATE supplier_invoices SET supplier_id')).toBe(true);
      } finally { await e.commit(); }
      const out = await merging;
      expect(out).toBeInstanceOf(SupplierMergeRefusal);
      expect((out as Error).message).toContain('goods received note');
      expect(await stranded(fx, target)).toEqual([]);
      expect((await pool.query('SELECT supplier_id::text AS s FROM supplier_invoices WHERE id = $1', [bill.id])).rows[0].s).toBe(fx.supplier);
      expect((await pool.query('SELECT deleted_at IS NULL AS live FROM suppliers WHERE id = $1', [fx.supplier])).rows[0].live).toBe(true);
    });
  }, 30_000);

  it('the REST merge answers 400 and moves nothing', async () => {
    await withFixture('race-r1-rest', async (fx, target) => {
      const note = await noteOf(fx);
      const bill = await inReq(fx, () => createSupplierInvoice(fx.co, billInput(fx), fx.owner));
      const e = await openNoting(fx, bill.id, note);
      const merging = callRoute(mergeRoute as never, fx, fx.owner, '/api/accounting/supplier-merge', { source_id: fx.supplier, target_id: target });
      try {
        expect(await waitsOnLock('UPDATE supplier_invoices')).toBe(true);
      } finally { await e.commit(); }
      const out = await merging;
      expect(out.statusCode, JSON.stringify(out.body)).toBe(400);
      expect(JSON.stringify(out.body)).toContain('goods received note');
      expect(await stranded(fx, target)).toEqual([]);
      expect((await pool.query('SELECT deleted_at IS NULL AS live FROM suppliers WHERE id = $1', [fx.supplier])).rows[0].live).toBe(true);
    });
  }, 30_000);
});

describe('R2: the undo of a deleted noted bill races a merge (the restore\'s supplier KEY SHARE)', () => {
  it('the merge waits on the supplier row while the restore is open, then sees the live noted bill and refuses', async () => {
    await withFixture('race-r2', async (fx, target) => {
      const note = await noteOf(fx);
      const bill = await inReq(fx, () => createSupplierInvoice(fx.co, billInput(fx, note), fx.owner));
      await inReq(fx, () => softDelete(fx.co, 'supplier_invoice', bill.id, fx.owner));
      const r = await openRequest(pool, fx, fx.owner);
      expect(await r.run(() => undoDelete(fx.co, 'supplier_invoice', bill.id, fx.owner))).toBe(true);
      const m = await openRequest(pool, fx, fx.owner);
      const merging = m.run(() => mergeEntities(fx.co, 'supplier', target, fx.supplier, fx.owner))
        .then(async (x) => { await m.commit(); return x; }, async (err) => { await m.commit(); return err; });
      try {
        expect(await waitsOnLock('FROM suppliers')).toBe(true);
      } finally { await r.commit(); }
      const out = await merging;
      expect(out).toBeInstanceOf(SupplierMergeRefusal);
      expect(await stranded(fx, target)).toEqual([]);
    });
  }, 30_000);
});

describe('the refusal names the exit for each bill state, in UI terms (review of 3010bf7e, L1)', () => {
  it('a paid bill carrying a note: reverse its payments, then cancel it; both paths say so', async () => {
    await withFixture('merge-exit-paid', async (fx, target) => {
      const note = await noteOf(fx);
      const bill = await inReq(fx, () => createSupplierInvoice(fx.co, billInput(fx, note), fx.owner));
      const c = await pool.connect();
      try {
        await c.query('BEGIN');
        await c.query('SET LOCAL session_replication_role = replica');
        await c.query("UPDATE supplier_invoices SET status = 'paid' WHERE id = $1", [bill.id]);
        await c.query('COMMIT');
      } catch (err) { await c.query('ROLLBACK'); throw err; } finally { c.release(); }
      const rest = await callRoute(mergeRoute as never, fx, fx.owner, '/api/accounting/supplier-merge', { source_id: fx.supplier, target_id: target });
      expect(rest.statusCode).toBe(400);
      const text = JSON.stringify(rest.body);
      expect(text).toContain('a paid or partially paid bill: reverse its payments, then cancel it');
      expect(text).not.toContain('update_supplier_invoice');
      expect(text).not.toContain('a draft bill');
      const req = await openRequest(pool, fx, fx.owner);
      let dup: unknown;
      try { dup = await req.run(() => mergeEntities(fx.co, 'supplier', target, fx.supplier, fx.owner)); } catch (err) { dup = err; } finally { await req.rollback(); }
      expect((dup as Error).message).toContain('a paid or partially paid bill: reverse its payments, then cancel it');
    });
  }, 30_000);
});
