/**
 * A draft edit keeps the bill's goods received note agreeing with the bill (merge-gate finding 3 on #1697; docs/design/mcp-goods-received.md
 * "A bill's GRN"), real PostgreSQL, as app_user through update_supplier_invoice:
 *   - changing the supplier of a draft that carries a note on the old supplier's PO is refused, naming the exit (grn_id), and nothing
 *     is written;
 *   - the same supplier change with grn_id null (the note comes off), or with a live note on a PO of the new supplier, goes through;
 *   - grn_id naming a cancelled note, or a note on another supplier's PO, is refused.
 * Fixture route: isaflow_schema_fixture (assertDisposable). Never skips.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { dropBillFixture, openRequest, seedBillFixture, type BillFixture } from './helpers/budgetBillFixture';
import { seedSupplier } from './helpers/poBillLinkHarness';
import { callTool, dropGrnExtras, dropMaintExtras, grnArgs, seedQtyPo } from './helpers/grnHarness';
import { createGoodsReceivedTool as create } from '@/lib/mcp/tools/writeCreateGoodsReceived';
import { cancelGoodsReceivedTool as cancel } from '@/lib/mcp/tools/writeCancelGoodsReceived';
import { updateSupplierInvoiceTool as update } from '@/lib/mcp/tools/writeUpdateSupplierInvoice';
import { createSupplierInvoice } from '@/modules/accounting/services/ap/supplierInvoiceService';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 6 });
let f: BillFixture;
let supplierB: string;
let n = 0;

beforeAll(async () => {
  f = await seedBillFixture(pool, 'grn-bill-edit');
  supplierB = await seedSupplier(pool, f, 'Supplier B (edit)');
}, 60_000);
afterAll(async () => {
  try { await dropGrnExtras(pool, f); await dropMaintExtras(pool, f); await dropBillFixture(pool, f); } finally { await pool.end(); }
}, 60_000);

/** A live note receiving a one-line PO of `supplier` (default: the fixture's supplier A). */
const noteOf = async (supplier?: string): Promise<string> => {
  const po = await seedQtyPo(pool, f, { lines: [{ qty: 4, price: 10 }] });
  if (supplier) await pool.query('UPDATE purchase_orders SET supplier_id = $2 WHERE id = $1', [po.po, supplier]);
  const r = await callTool(pool, f, create, grnArgs(po, [[0, 4]]));
  expect(r.isError, r.text).toBe(false);
  return String(r.body.grn_id);
};
/** A draft bill of supplier A carrying `grn` (it names no PO, so only the supplier ties the note). */
const draftWith = async (grn: string): Promise<string> => {
  const req = await openRequest(pool, f, f.owner);
  try {
    const bill = await req.run(() => createSupplierInvoice(f.co, {
      invoiceNumber: `GRN-EDIT-${n++}-${Date.now()}`, supplierId: f.supplier, invoiceDate: '2026-06-15', grnId: grn,
      items: [{ description: 'Delivered goods', quantity: 1, unitPrice: 40, taxRate: 15, glAccountId: f.acc.opex }],
    }, f.owner));
    await req.commit();
    return bill.id;
  } catch (err) { await req.rollback(); throw err; }
};
const billRow = async (id: string) => (await pool.query(
  'SELECT supplier_id::text AS supplier_id, grn_id::text AS grn_id FROM supplier_invoices WHERE id = $1', [id])).rows[0] as { supplier_id: string; grn_id: string | null };

describe('a draft edit re-judges the bill\'s goods received note (gate finding 3)', () => {
  it('a supplier change is refused while the note is on the old supplier\'s PO, naming grn_id; nothing is written', async () => {
    const grn = await noteOf();
    const bill = await draftWith(grn);
    const r = await callTool(pool, f, update, { invoice_id: bill, supplier_id: supplierB });
    expect(r.isError).toBe(true);
    expect(r.text).toContain('another supplier\'s purchase order');
    expect(r.text).toContain('grn_id: null');
    expect(await billRow(bill)).toEqual({ supplier_id: f.supplier, grn_id: grn });
  });

  it('the supplier change with grn_id null takes the note off and goes through', async () => {
    const grn = await noteOf();
    const bill = await draftWith(grn);
    const r = await callTool(pool, f, update, { invoice_id: bill, supplier_id: supplierB, grn_id: null });
    expect(r.isError, r.text).toBe(false);
    expect(r.body).toMatchObject({ supplier_id: supplierB, grn_id: null });
    expect(r.body.changed).toEqual(expect.arrayContaining(['supplierId', 'grnId']));
    expect(await billRow(bill)).toEqual({ supplier_id: supplierB, grn_id: null });
  });

  it('the supplier change with a live note on the new supplier\'s PO goes through and carries that note', async () => {
    const bill = await draftWith(await noteOf());
    const theirs = await noteOf(supplierB);
    const r = await callTool(pool, f, update, { invoice_id: bill, supplier_id: supplierB, grn_id: theirs });
    expect(r.isError, r.text).toBe(false);
    expect(await billRow(bill)).toEqual({ supplier_id: supplierB, grn_id: theirs });
  });

  it('grn_id naming a cancelled note or a note on another supplier\'s PO is refused; nothing is written', async () => {
    const grn = await noteOf();
    const bill = await draftWith(grn);
    const dead = await noteOf();
    expect((await callTool(pool, f, cancel, { grn_id: dead, reason: 'wrong delivery' })).isError).toBe(false);
    const cancelled = await callTool(pool, f, update, { invoice_id: bill, grn_id: dead });
    expect(cancelled.isError).toBe(true);
    expect(cancelled.text).toContain('cancelled');
    const foreign = await callTool(pool, f, update, { invoice_id: bill, grn_id: await noteOf(supplierB) });
    expect(foreign.isError).toBe(true);
    expect(foreign.text).toContain('another supplier\'s purchase order');
    expect(await billRow(bill)).toEqual({ supplier_id: f.supplier, grn_id: grn });
  });
});
