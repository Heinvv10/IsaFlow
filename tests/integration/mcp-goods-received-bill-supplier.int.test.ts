/**
 * A bill carries only a goods received note of its own supplier, and of a PO it names (merge-gate finding 1 on #1697;
 * docs/design/mcp-goods-received.md "A bill's GRN"), real PostgreSQL, as app_user:
 *   - a bill for supplier B naming a live note on supplier A's PO (same company) is refused, by the service and by the REST create
 *     (a 400 before it reserves a number);
 *   - a bill that names a PO (its header, or a PO its lines name) may carry only a note of one of those POs;
 *   - the undo of a soft-deleted bill refuses the same mismatches, and restores a bill whose note agrees.
 * Fixture route: isaflow_schema_fixture (assertDisposable). Never skips.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { callRoute, dropBillFixture, openRequest, seedBillFixture, type BillFixture } from './helpers/budgetBillFixture';
import { seedBill, seedSupplier } from './helpers/poBillLinkHarness';
import { callTool, dropGrnExtras, dropMaintExtras, grnArgs, seedQtyPo, type QtyPo } from './helpers/grnHarness';
import { createGoodsReceivedTool as create } from '@/lib/mcp/tools/writeCreateGoodsReceived';
import { createSupplierInvoice } from '@/modules/accounting/services/ap/supplierInvoiceService';
import { undoDelete } from '@/modules/accounting/services/core/softDeleteService';
import billsRoute from '../../pages/api/accounting/supplier-invoices';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 6 });
let f: BillFixture;
let otherSupplier: string;
let n = 0;

beforeAll(async () => {
  f = await seedBillFixture(pool, 'grn-bill-supplier');
  otherSupplier = await seedSupplier(pool, f, 'Supplier B');
}, 60_000);
afterAll(async () => {
  try { await dropGrnExtras(pool, f); await dropMaintExtras(pool, f); await dropBillFixture(pool, f); } finally { await pool.end(); }
}, 60_000);

/** A PO of supplier A (the fixture's) with one line, and a live note receiving it. */
const noteOnPo = async (): Promise<{ po: QtyPo; grn: string }> => {
  const po = await seedQtyPo(pool, f, { lines: [{ qty: 4, price: 10 }] });
  const r = await callTool(pool, f, create, grnArgs(po, [[0, 4]]));
  expect(r.isError, r.text).toBe(false);
  return { po, grn: String(r.body.grn_id) };
};
const billInput = (grnId: string, over: { supplierId?: string; purchaseOrderId?: string; poItemId?: string } = {}) => ({
  invoiceNumber: `GRN-SUP-${n++}-${Date.now()}`, supplierId: over.supplierId ?? f.supplier, invoiceDate: '2026-06-15', grnId,
  ...(over.purchaseOrderId ? { purchaseOrderId: over.purchaseOrderId } : {}),
  items: [{ description: 'Delivered goods', quantity: 1, unitPrice: 40, taxRate: 15, glAccountId: f.acc.opex, ...(over.poItemId ? { poItemId: over.poItemId } : {}) }],
});
const createBill = async (input: ReturnType<typeof billInput>): Promise<{ id?: string; error?: string; code?: string }> => {
  const req = await openRequest(pool, f, f.owner);
  try {
    const bill = await req.run(() => createSupplierInvoice(f.co, input, f.owner));
    await req.commit();
    return { id: bill.id };
  } catch (err) {
    await req.rollback();
    return { error: (err as Error).message, code: (err as { code?: string }).code };
  }
};
const undo = async (id: string): Promise<string> => {
  const req = await openRequest(pool, f, f.owner);
  try { const r = await req.run(() => undoDelete(f.co, 'supplier_invoice', id, f.owner)); await req.commit(); return String(r); } catch (e) { await req.rollback(); return (e as Error).message; }
};
const deletedBill = async (grn: string, over: { supplier?: string; po?: string } = {}) => {
  const bill = await seedBill(pool, f, { status: 'draft', lines: [40], ...(over.supplier ? { supplier: over.supplier } : {}) });
  await pool.query('UPDATE supplier_invoices SET grn_id = $2, purchase_order_id = $3, deleted_at = now() WHERE id = $1', [bill.id, grn, over.po ?? null]);
  return bill.id;
};

describe('a bill carries a note of its own supplier only', () => {
  it('the service refuses supplier B\'s bill naming a note on supplier A\'s PO; supplier A\'s bill takes it', async () => {
    const { grn } = await noteOnPo();
    const refused = await createBill(billInput(grn, { supplierId: otherSupplier }));
    expect(refused).toMatchObject({ code: 'SUPPLIER_INVOICE_GRN_REFUSED' });
    expect(refused.error).toContain('another supplier');
    expect((await pool.query('SELECT count(*)::INT AS n FROM supplier_invoices WHERE grn_id = $1', [grn])).rows[0].n).toBe(0);
    expect((await createBill(billInput(grn))).error).toBeUndefined();
  });

  it('the REST create refuses it with a 400 before it reserves a number', async () => {
    const { grn } = await noteOnPo();
    const counter = async () => (await pool.query(
      "SELECT next_number FROM company_document_numbers WHERE company_id = $1 AND document_type = 'supplier_invoice'", [f.co])).rows[0]?.next_number ?? null;
    const before = await counter();
    const { invoiceNumber: _n, ...body } = billInput(grn, { supplierId: otherSupplier });
    const r = await callRoute(billsRoute as never, f, f.owner, '/api/accounting/supplier-invoices', { ...body, useSequence: true });
    expect(r.statusCode, JSON.stringify(r.body)).toBe(400);
    expect(JSON.stringify(r.body)).toContain('another supplier');
    expect(await counter()).toBe(before);
  });
});

describe('a bill that names a PO carries only a note of that PO', () => {
  it('a header PO, or a PO its lines name, other than the note\'s is refused; the note\'s own PO is accepted', async () => {
    const { po, grn } = await noteOnPo();
    const elsewhere = await seedQtyPo(pool, f, { lines: [{ qty: 4, price: 10 }] });
    const byHeader = await createBill(billInput(grn, { purchaseOrderId: elsewhere.po }));
    expect(byHeader).toMatchObject({ code: 'SUPPLIER_INVOICE_GRN_REFUSED' });
    expect(byHeader.error).toContain('purchase order the bill does not name');
    const byLine = await createBill(billInput(grn, { poItemId: elsewhere.items[0] }));
    expect(byLine).toMatchObject({ code: 'SUPPLIER_INVOICE_GRN_REFUSED' });
    expect(byLine.error).toContain('purchase order the bill does not name');
    expect((await createBill(billInput(grn, { purchaseOrderId: po.po, poItemId: po.items[0] }))).error).toBeUndefined();
  });
});

describe('the undo of a deleted bill keeps the same rule', () => {
  it('refuses another supplier\'s note and a note of a PO the bill does not name; restores an agreeing one', async () => {
    const { po, grn } = await noteOnPo();
    const elsewhere = await seedQtyPo(pool, f, { lines: [{ qty: 4, price: 10 }] });
    const foreignSupplier = await deletedBill(grn, { supplier: otherSupplier });
    expect(await undo(foreignSupplier)).toContain('another supplier');
    const otherPo = await deletedBill(grn, { po: elsewhere.po });
    expect(await undo(otherPo)).toContain('purchase order the bill does not name');
    const stillDeleted = await pool.query('SELECT count(*)::INT AS n FROM supplier_invoices WHERE id = ANY($1::UUID[]) AND deleted_at IS NOT NULL', [[foreignSupplier, otherPo]]);
    expect(stillDeleted.rows[0].n).toBe(2);
    expect(await undo(await deletedBill(grn, { po: po.po }))).toBe('true');
    expect(await undo(await deletedBill(grn))).toBe('true');
  });
});
