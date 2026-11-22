/**
 * PR #1703 x the supplier merge as master has it since #1655 / #1699 (core/supplierMergePurchaseOrders.ts): a merge moves the
 * canonical purchase orders WITH the bills (the retired supplier_purchase_orders is no longer touched, migration 1022), after both
 * supplier rows FOR UPDATE and the source's PO rows FOR UPDATE, refusing a source whose PO has a link row (migration 1006):
 *   - a bill create in flight naming a PO of the source holds the supplier (FK KEY SHARE): both merge paths wait for it, then see
 *     its app link and refuse (a 400 class); nothing moves;
 *   - a bill tied to a source PO by its HEADER or a LINE only (no link row), set before the merge or by an edit racing it, ends on
 *     the survivor together with that PO: no bill names another supplier's PO.
 * Fixture route: isaflow_schema_fixture (assertDisposable). Never skips.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { callRoute, dropBillFixture, openRequest, seedBillFixture, setPolicy, type BillFixture } from './helpers/budgetBillFixture';
import { seedBill, seedPo, seedSupplier } from './helpers/poBillLinkHarness';
import mergeRoute from '../../pages/api/accounting/supplier-merge';
import { createSupplierInvoice } from '@/modules/accounting/services/ap/supplierInvoiceService';
import { SupplierMergeRefusal, mergeEntities } from '@/modules/accounting/services/core/duplicateMergeService';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 8 });
let f: BillFixture;
beforeAll(async () => { f = await seedBillFixture(pool, 'spo-merge-lock'); await setPolicy(pool, f, 'warn'); }, 60_000);
afterAll(async () => { try { await dropBillFixture(pool, f); } finally { await pool.end(); } }, 60_000);

const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));
async function waitsOnLock(fragment: string): Promise<boolean> {
  for (let i = 0; i < 200; i++) {
    const rows = (await pool.query(
      "SELECT 1 FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND datname = current_database() AND query LIKE '%' || $1 || '%'", [fragment])).rows;
    if (rows.length > 0) return true;
    await sleep(25);
  }
  return false;
}
const dupMerge = async (own: BillFixture, target: string) => {
  const req = await openRequest(pool, own, own.owner);
  try { const r = await req.run(() => mergeEntities(own.co, 'supplier', target, own.supplier, own.owner, 'owner')); await req.commit(); return r; }
  catch (e) { await req.rollback(); return e; }
};
const restMerge = (own: BillFixture, target: string) =>
  callRoute(mergeRoute as never, own, own.owner, '/api/accounting/supplier-merge', { source_id: own.supplier, target_id: target });
const suppliersOf = async (bill: string, po: string) => (await pool.query(
  'SELECT si.supplier_id::TEXT AS bill, po.supplier_id::TEXT AS po FROM supplier_invoices si, purchase_orders po WHERE si.id = $1 AND po.id = $2',
  [bill, po])).rows[0] as { bill: string; po: string };

describe('a create in flight naming a PO of the source', () => {
  for (const path of ['duplicates', 'rest'] as const) {
    it(`${path}: the merge waits on the supplier, then sees the create's link and refuses; nothing moves`, async () => {
      const own = await seedBillFixture(pool, `spo-merge-inflight-${path}`);
      try {
        const target = await seedSupplier(pool, own, `Merge target (${path})`);
        const po = await seedPo(pool, own, { lines: [100] });
        const creating = await openRequest(pool, own, own.owner);
        let merging: Promise<unknown> | undefined;
        let billId = '';
        try {
          billId = (await creating.run(() => createSupplierInvoice(own.co, {
            invoiceNumber: `MERGE-LOCK-${crypto.randomUUID().slice(0, 8)}`, supplierId: own.supplier, invoiceDate: '2026-06-15', purchaseOrderId: po.po,
            items: [{ description: 'Billed on the PO', quantity: 1, unitPrice: 100, taxRate: 15, glAccountId: own.acc.opex }],
          }, own.owner))).id;
          expect((await creating.client.query('SELECT count(*)::INT AS n FROM purchase_order_bill_links WHERE supplier_invoice_id = $1', [billId])).rows[0].n).toBe(1);
          merging = path === 'duplicates' ? dupMerge(own, target) : restMerge(own, target);
          void merging.catch(() => undefined);
          expect(await waitsOnLock('FROM suppliers')).toBe(true);
          await creating.commit();
        } catch (err) { await creating.rollback(); throw err; }
        const out = await merging!;
        if (path === 'duplicates') {
          expect(out).toBeInstanceOf(SupplierMergeRefusal);
          expect((out as Error).message).toContain('bills linked to purchase orders');
        } else {
          expect((out as { statusCode: number }).statusCode).toBe(400);
          expect(JSON.stringify((out as { body: unknown }).body)).toContain('bills linked to purchase orders');
        }
        expect(await suppliersOf(billId, po.po)).toEqual({ bill: own.supplier, po: own.supplier });
      } finally { await dropBillFixture(pool, own); }
    }, 60_000);
  }
});

describe('a bill tied to a source PO only by its header or a line (no link row)', () => {
  for (const tie of ['header', 'line'] as const) {
    for (const path of ['duplicates', 'rest'] as const) {
      it(`${tie}, ${path}: the bill and its PO move together; no cross-supplier tie`, async () => {
        const own = await seedBillFixture(pool, `spo-merge-${tie}-${path}`);
        try {
          const target = await seedSupplier(pool, own, `Merge target (${tie}, ${path})`);
          const po = await seedPo(pool, own, { lines: [100] });
          const bill = await seedBill(pool, own, { lines: [100] });
          await pool.query('DELETE FROM purchase_order_bill_links WHERE supplier_invoice_id = $1', [bill.id]);
          if (tie === 'header') await pool.query('UPDATE supplier_invoices SET purchase_order_id = $2 WHERE id = $1', [bill.id, po.po]);
          else await pool.query('UPDATE supplier_invoice_items SET po_item_id = $2 WHERE supplier_invoice_id = $1', [bill.id, po.items[0]]);
          const out = path === 'duplicates' ? await dupMerge(own, target) : await restMerge(own, target);
          if (path === 'duplicates') expect(out).not.toBeInstanceOf(Error);
          else expect((out as { statusCode: number }).statusCode).toBe(200);
          expect(await suppliersOf(bill.id, po.po)).toEqual({ bill: target, po: target });
        } finally { await dropBillFixture(pool, own); }
      }, 60_000);
    }
  }
});

describe('a header tie set while the merge runs', () => {
  for (const path of ['duplicates', 'rest'] as const) {
    it(`${path}: an edit setting the header to a source PO, committed while the merge's bill UPDATE waits on it: both end on the survivor`, async () => {
      const own = await seedBillFixture(pool, `spo-merge-late-${path}`);
      const holder = await pool.connect();
      try {
        const target = await seedSupplier(pool, own, `Late tie target (${path})`);
        const po = await seedPo(pool, own, { lines: [100] });
        const bill = await seedBill(pool, own, { status: 'draft', lines: [100] });
        await pool.query('DELETE FROM purchase_order_bill_links WHERE supplier_invoice_id = $1', [bill.id]);
        await holder.query('BEGIN');
        await holder.query('UPDATE supplier_invoices SET purchase_order_id = $2 WHERE id = $1', [bill.id, po.po]);
        const merging: Promise<unknown> = path === 'duplicates' ? dupMerge(own, target) : restMerge(own, target);
        void merging.catch(() => undefined);
        expect(await waitsOnLock('UPDATE supplier_invoices')).toBe(true);
        await holder.query('COMMIT');
        const out = await merging;
        if (path === 'duplicates') expect(out).not.toBeInstanceOf(Error);
        else expect((out as { statusCode: number }).statusCode).toBe(200);
        expect(await suppliersOf(bill.id, po.po)).toEqual({ bill: target, po: target });
      } finally {
        await holder.query('ROLLBACK').catch(() => undefined); holder.release();
        await dropBillFixture(pool, own);
      }
    }, 60_000);
  }
});
