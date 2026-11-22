/**
 * PR #1703 x #1697 (the master merge, isaflow-c8's binding check): the duplicates supplier merge (mergeEntities) runs BOTH of its
 * refusals, the PO-link one (migration 1006) and assertSupplierMergeMovesNoNotedBill, AFTER its suppliers FOR UPDATE lock
 * (assertSupplierMergeKeepsDrcFlag), so neither can race a bill create: a create in flight holds the supplier through the bill INSERT's
 * FK KEY SHARE, the merge waits for it, and then sees the create's app link and refuses (a 400 class); nothing moves.
 * Fixture route: isaflow_schema_fixture (assertDisposable). Never skips.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { dropBillFixture, openRequest, seedBillFixture, setPolicy, type BillFixture } from './helpers/budgetBillFixture';
import { seedPo, seedSupplier } from './helpers/poBillLinkHarness';
import { createSupplierInvoice } from '@/modules/accounting/services/ap/supplierInvoiceService';
import { SupplierMergeRefusal, mergeEntities } from '@/modules/accounting/services/core/duplicateMergeService';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 6 });
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

describe('the duplicates merge refuses a PO-linked source only after its supplier lock', () => {
  it('a create in flight naming a PO of the source: the merge waits on the supplier, then sees its link and refuses; nothing moves', async () => {
    const target = await seedSupplier(pool, f, 'Merge target (lock order)');
    const po = await seedPo(pool, f, { lines: [100] });
    const creating = await openRequest(pool, f, f.owner);
    let merging: Promise<unknown> | undefined;
    let billId = '';
    try {
      const bill = await creating.run(() => createSupplierInvoice(f.co, {
        invoiceNumber: `MERGE-LOCK-${crypto.randomUUID().slice(0, 8)}`, supplierId: f.supplier, invoiceDate: '2026-06-15', purchaseOrderId: po.po,
        items: [{ description: 'Billed on the PO', quantity: 1, unitPrice: 100, taxRate: 15, glAccountId: f.acc.opex }],
      }, f.owner));
      billId = bill.id;
      expect((await creating.client.query('SELECT count(*)::INT AS n FROM purchase_order_bill_links WHERE supplier_invoice_id = $1', [bill.id])).rows[0].n).toBe(1);
      const m = await openRequest(pool, f, f.owner);
      merging = m.run(() => mergeEntities(f.co, 'supplier', target, f.supplier, f.owner))
        .then(async (r) => { await m.commit(); return r; }, async (e) => { await m.rollback(); return e; });
      // The merge is at its suppliers FOR UPDATE, behind the create's FK KEY SHARE: no refusal has read anything yet.
      expect(await waitsOnLock('FROM suppliers')).toBe(true);
      await creating.commit();
    } catch (err) { await creating.rollback(); throw err; }
    const outcome = await merging!;
    expect(outcome).toBeInstanceOf(SupplierMergeRefusal);
    expect((outcome as Error).message).toContain('bills linked to purchase orders');
    const moved = (await pool.query('SELECT supplier_id::TEXT AS s FROM supplier_invoices WHERE id = $1', [billId])).rows[0].s;
    expect(moved).toBe(f.supplier);
    expect((await pool.query('SELECT supplier_id::TEXT AS s FROM purchase_orders WHERE id = $1', [po.po])).rows[0].s).toBe(f.supplier);
    expect((await pool.query('SELECT deleted_at IS NULL AS live FROM suppliers WHERE id = $1', [f.supplier])).rows[0].live).toBe(true);
  }, 60_000);
});
