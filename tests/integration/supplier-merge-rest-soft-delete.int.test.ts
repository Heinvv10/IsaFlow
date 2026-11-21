/**
 * The REST supplier merge (pages/api/accounting/supplier-merge.ts) soft-deletes its source, as the duplicates merge does
 * (review of b4741393, M1; orchestrator ruling, fail-closed), real PostgreSQL, as app_user through the real route:
 *   - after the merge the source carries deleted_at (and stays inactive, "[MERGED]"); list_suppliers no longer offers it;
 *   - history still resolves it: a purchase order the merge does not move still names its supplier (get_purchase_order);
 *   - a bill create racing the REAL route (paused at its bill UPDATE, holding both suppliers FOR UPDATE) waits at its FK
 *     check and is then refused, typed (1021's supplier-live trigger): no bill on the merged-away supplier.
 * Fixture route: isaflow_schema_fixture (assertDisposable). Never skips.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { callRoute, dropBillFixture, openRequest, seedBillFixture, type BillFixture } from './helpers/budgetBillFixture';
import { seedSupplier } from './helpers/poBillLinkHarness';
import { callTool, dropGrnExtras, dropMaintExtras, seedQtyPo } from './helpers/grnHarness';
import { listSuppliersTool } from '@/lib/mcp/tools/contacts';
import { getPurchaseOrderTool } from '@/lib/mcp/tools/getPurchaseOrder';
import { createSupplierInvoice } from '@/modules/accounting/services/ap/supplierInvoiceService';
import { BillSupplierDeletedError } from '@/modules/accounting/services/ap/billSupplierLive';
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
const billInput = (fx: BillFixture) => ({
  invoiceNumber: `REST-${crypto.randomUUID().slice(0, 8)}`, supplierId: fx.supplier, invoiceDate: '2026-06-15',
  items: [{ description: 'Goods', quantity: 1, unitPrice: 40, taxRate: 15, glAccountId: fx.acc.opex }],
});
async function withFixture(tag: string, fn: (fx: BillFixture, target: string) => Promise<void>) {
  const fx = await seedBillFixture(pool, tag);
  const target = await seedSupplier(pool, fx, `${tag} target`);
  try { await fn(fx, target); } finally { await dropGrnExtras(pool, fx); await dropMaintExtras(pool, fx); await dropBillFixture(pool, fx); }
}

describe('the REST merge soft-deletes its source', () => {
  it('deleted_at is set (inactive, [MERGED]); list_suppliers drops it; a PO the merge leaves still names it', async () => {
    await withFixture('rest-merge-soft', async (fx, target) => {
      const po = await seedQtyPo(pool, fx, { lines: [{ qty: 1, price: 10 }] });
      const before = String((await pool.query('SELECT name FROM suppliers WHERE id = $1', [fx.supplier])).rows[0].name);
      const out = await callRoute(mergeRoute as never, fx, fx.owner, '/api/accounting/supplier-merge', { source_id: fx.supplier, target_id: target });
      expect(out.statusCode, JSON.stringify(out.body)).toBe(200);
      expect((await pool.query('SELECT deleted_at IS NOT NULL AS deleted, is_active, name FROM suppliers WHERE id = $1', [fx.supplier])).rows[0])
        .toEqual({ deleted: true, is_active: false, name: `${before} [MERGED]` });
      const list = await callTool(pool, fx, listSuppliersTool, { limit: 200 });
      expect(list.text).not.toContain(fx.supplier);
      expect(list.text).toContain(target);
      const got = await callTool(pool, fx, getPurchaseOrderTool, { po_id: po.po });
      expect(got.isError, got.text).toBe(false);
      expect((got.body.purchase_order as { supplier_name?: string }).supplier_name).toBe(`${before} [MERGED]`);
    });
  }, 30_000);
});

describe('a bill create racing the REAL REST merge', () => {
  it('waits at its FK check while the paused route holds the suppliers, then is refused typed; no bill on the merged-away supplier', async () => {
    await withFixture('rest-merge-race', async (fx, target) => {
      const plain = await (async () => {
        const r = await openRequest(pool, fx, fx.owner);
        try { const v = await r.run(() => createSupplierInvoice(fx.co, billInput(fx), fx.owner)); await r.commit(); return v; } catch (e) { await r.rollback(); throw e; }
      })();
      // Held by the test: the route takes both suppliers FOR UPDATE, runs its checks, then stops at its bill UPDATE on this row.
      const hold = await pool.connect();
      await hold.query('BEGIN');
      await hold.query('SELECT id FROM supplier_invoices WHERE id = $1 FOR UPDATE', [plain.id]);
      const merging = callRoute(mergeRoute as never, fx, fx.owner, '/api/accounting/supplier-merge', { source_id: fx.supplier, target_id: target });
      const c = await openRequest(pool, fx, fx.owner);
      let creating: Promise<unknown> | undefined;
      try {
        expect(await waitsOnLock('UPDATE supplier_invoices')).toBe(true);
        creating = c.run(() => createSupplierInvoice(fx.co, billInput(fx), fx.owner))
          .then(async (v) => { await c.commit(); return v; }, async (e) => { await c.rollback(); return e; });
        expect(await waitsOnLock('INSERT INTO supplier_invoices')).toBe(true);
      } finally { await hold.query('ROLLBACK'); hold.release(); }
      expect((await merging).statusCode).toBe(200);
      const created = await creating;
      expect(created).toBeInstanceOf(BillSupplierDeletedError);
      const onSource = Number((await pool.query(
        'SELECT count(*) AS n FROM supplier_invoices WHERE supplier_id = $1 AND deleted_at IS NULL', [fx.supplier])).rows[0].n);
      expect(onSource).toBe(0);
    });
  }, 30_000);
});
