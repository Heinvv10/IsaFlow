/**
 * Supplier merge and a bill's goods received note (gate at c63b1e26, major; issue #1708; docs/design/mcp-goods-received.md
 * "A bill's GRN"), real PostgreSQL, as app_user. A bill whose only tie to a PO is its grn_id (no link row, no header, no line)
 * would move to the target supplier while its note's PO stays on the source. Both merge paths refuse it, as they refuse a source
 * with PO links: the REST route (pages/api/accounting/supplier-merge.ts) with a 400, the duplicates merge (mergeEntities) with a
 * SupplierMergeRefusal; nothing moves. Taking the note off the bill (the named exit) lets the merge through.
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

/** A draft bill of the fixture's supplier carrying a live note on its PO, and no other tie to a PO. */
async function billOnlyTiedByItsNote(): Promise<{ bill: string; number: string }> {
  const po = await seedQtyPo(pool, f, { lines: [{ qty: 4, price: 10 }] });
  const r = await callTool(pool, f, create, grnArgs(po, [[0, 4]]));
  expect(r.isError, r.text).toBe(false);
  const req = await openRequest(pool, f, f.owner);
  try {
    const bill = await req.run(() => createSupplierInvoice(f.co, {
      invoiceNumber: `GRN-MERGE-${crypto.randomUUID().slice(0, 8)}`, supplierId: f.supplier, invoiceDate: '2026-06-15', grnId: String(r.body.grn_id),
      items: [{ description: 'Delivered goods', quantity: 1, unitPrice: 40, taxRate: 15, glAccountId: f.acc.opex }],
    }, f.owner));
    await req.commit();
    expect(Number((await pool.query('SELECT count(*) AS n FROM purchase_order_bill_links WHERE supplier_invoice_id = $1', [bill.id])).rows[0].n)).toBe(0);
    return { bill: bill.id, number: bill.invoiceNumber };
  } catch (err) { await req.rollback(); throw err; }
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
    expect(text).toContain('grn_id null');
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
