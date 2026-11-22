/**
 * Closing, link closing records and bills (review M3, L1, L2; docs/design/mcp-po-maintenance.md), real PostgreSQL, as app_user:
 *   - M3, the 4-step case: a link call closes a PO (record on the link) -> set_purchase_order_status approved (the record is cleared)
 *     -> set status closed (by hand) -> unlink the bill: the PO stays closed, because this close did not come from a link;
 *   - L1: the unlink's reopen clears closed_from_status in the same UPDATE (the CHECK would refuse otherwise); get_purchase_order
 *     shows closed_from_status for a PO closed by hand; a link close does not set it (it is recorded on the link);
 *   - L2: a bill created through the REST service may name a line of a CLOSED PO (short-closed or Sage-Invoiced POs still have bills);
 *     a draft PO's line is still refused.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { dropBillFixture, openRequest, seedBillFixture, setPolicy, type BillFixture } from './helpers/budgetBillFixture';
import { linkRows, seedBill } from './helpers/poBillLinkHarness';
import { callTool, dropMaintExtras, poRow, seedQtyPo } from './helpers/poMaintHarness';
import { setPurchaseOrderStatusTool as setStatus } from '@/lib/mcp/tools/writeSetPurchaseOrderStatus';
import { closePurchaseOrderTool as close } from '@/lib/mcp/tools/writeClosePurchaseOrder';
import { linkBillsToPurchaseOrderTool as link } from '@/lib/mcp/tools/writeLinkBillsToPurchaseOrder';
import { unlinkBillFromPurchaseOrderTool as unlink } from '@/lib/mcp/tools/writeUnlinkBillFromPurchaseOrder';
import { getPurchaseOrderTool as getPo } from '@/lib/mcp/tools/getPurchaseOrder';
import { createSupplierInvoice } from '@/modules/accounting/services/ap/supplierInvoiceService';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
let f: BillFixture;

beforeAll(async () => { f = await seedBillFixture(pool, 'po-maint-links-close'); await setPolicy(pool, f, 'warn'); }, 60_000);
afterAll(async () => { try { await dropMaintExtras(pool, f); await dropBillFixture(pool, f); } finally { await pool.end(); } }, 60_000);

// PR #1703 R4-1: "closed because fully billed" is on the PO (closed_by_billing), never on a link.
const claims = async (po: string) => [(await pool.query('SELECT closed_by_billing FROM purchase_orders WHERE id = $1', [po])).rows[0].closed_by_billing,
  ...(await linkRows(pool, f, `l.purchase_order_id = '${po}'`)).map((l) => l.closed_po_from_status)];

/** A fully billed, imported PO that a link call has closed. */
async function linkClosed() {
  const po = await seedQtyPo(pool, f, { external: true, lines: [{ qty: 1, price: 100 }] });
  const bill = await seedBill(pool, f, { lines: [100] });
  const r = await callTool(pool, f, link, { links: [{ po_id: po.po, bill_id: bill.id }], close_when_fully_billed: true });
  expect(r.isError, r.text).toBe(false);
  expect((await poRow(pool, po.po)).status).toBe('closed');
  return { po, bill };
}

describe('M3: a PO someone reopened and closed again is not reopened by a later unlink', () => {
  it('link close -> set approved -> set closed -> unlink: still closed; the PO\'s record went when it left closed', async () => {
    const { po, bill } = await linkClosed();
    expect(await claims(po.po)).toEqual([true, null]);
    expect((await callTool(pool, f, setStatus, { po_id: po.po, status: 'approved', reason: 'reopened by hand' })).isError).toBe(false);
    expect(await claims(po.po)).toEqual([false, null]);
    expect((await callTool(pool, f, setStatus, { po_id: po.po, status: 'closed', reason: 'closed by hand' })).isError).toBe(false);
    expect(await poRow(pool, po.po)).toMatchObject({ status: 'closed', closed_from_status: 'approved' });
    const u = await callTool(pool, f, unlink, { po_id: po.po, bill_id: bill.id, reason: 'wrong bill' });
    expect(u.isError, u.text).toBe(false);
    expect(u.body).toMatchObject({ reopened_to: null, po_status: 'closed' });
    expect((await poRow(pool, po.po)).status).toBe('closed');
  });

  it('an unlink right after a link close still reopens it (the link\'s own close is unchanged)', async () => {
    const { po, bill } = await linkClosed();
    const u = await callTool(pool, f, unlink, { po_id: po.po, bill_id: bill.id, reason: 'wrong bill' });
    expect(u.body).toMatchObject({ reopened_to: 'approved' });
    expect((await poRow(pool, po.po)).status).toBe('approved');
  });
});

describe('L1: closed_from_status is truthful', () => {
  it('the unlink\'s reopen clears it in the same statement (the CHECK holds a value only while closed)', async () => {
    const { po, bill } = await linkClosed();
    await pool.query("UPDATE purchase_orders SET closed_from_status = 'approved' WHERE id = $1", [po.po]);
    const u = await callTool(pool, f, unlink, { po_id: po.po, bill_id: bill.id, reason: 'wrong bill' });
    expect(u.isError, u.text).toBe(false);
    expect(await poRow(pool, po.po)).toMatchObject({ status: 'approved', closed_from_status: null });
  });

  it('get_purchase_order shows it for a PO closed by hand, and for one a link closed (PR #1703 R4-1: recorded on the PO)', async () => {
    const hand = await seedQtyPo(pool, f, { status: 'partially_received', lines: [{ qty: 10, price: 10, received: 4 }] });
    expect((await callTool(pool, f, close, { po_id: hand.po, reason: 'short' })).isError).toBe(false);
    const shown = await callTool(pool, f, getPo, { po_id: hand.po });
    expect(shown.body.purchase_order).toMatchObject({ status: 'closed', closed_from_status: 'partially_received' });
    const { po } = await linkClosed();
    expect((await callTool(pool, f, getPo, { po_id: po.po })).body.purchase_order).toMatchObject({ status: 'closed', closed_from_status: 'approved' });
  });
});

describe('L2: a bill line may name a line of a closed PO', () => {
  const billFor = (poItem: string, n: number) => ({
    invoiceNumber: `CLOSED-${n}-${Date.now()}`, supplierId: f.supplier, invoiceDate: '2026-06-15',
    items: [{ description: 'Billed', quantity: 1, unitPrice: 100, taxRate: 0, glAccountId: f.acc.opex, poItemId: poItem }],
  });
  const create = async (poItem: string, n: number) => {
    const req = await openRequest(pool, f, f.owner);
    try { const b = await req.run(() => createSupplierInvoice(f.co, billFor(poItem, n), f.owner)); await req.commit(); return b; } catch (e) { await req.rollback(); throw e; }
  };

  it('a short-closed PO\'s line is accepted (and gets its app link); a draft or cancelled PO\'s line is still refused', async () => {
    const po = await seedQtyPo(pool, f, { status: 'partially_received', lines: [{ qty: 10, price: 10, received: 4 }] });
    expect((await callTool(pool, f, close, { po_id: po.po, reason: 'short' })).isError).toBe(false);
    const bill = await create(po.items[0]!, 1);
    expect(bill.id).toBeTruthy();
    expect((await pool.query('SELECT po_item_id FROM supplier_invoice_items WHERE supplier_invoice_id = $1', [bill.id])).rows[0].po_item_id).toBe(po.items[0]);
    expect((await linkRows(pool, f, `l.purchase_order_id = '${po.po}'`)).map((l) => l.source)).toEqual(['app']);
    for (const [i, status] of ['draft', 'cancelled'].entries()) {
      const other = await seedQtyPo(pool, f, { status, lines: [{ qty: 1, price: 100 }] });
      await expect(create(other.items[0]!, 10 + i)).rejects.toMatchObject({ code: 'SUPPLIER_INVOICE_PO_LINK_REFUSED' });
    }
  });
});
