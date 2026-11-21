/**
 * PR #1703, the merge-queue Codex gate at 70c74adf42, real PostgreSQL 16:
 *   1  a link written for lines that already name its PO takes nothing more from the bill's header PO (the transfer is the change
 *      in the header residual), so a batch that completes the header PO closes it;
 *   2  a cancel (2b: a soft delete) waiting on its bill while a link call closes the bill's PO by billing re-reads the POs once it
 *      holds the bill (the shared lockPosClosedByBilling), and reopens that one;
 *   4  the 1 c tolerance needs billing above 0: a R0.01 order with nothing billed is not fully billed.
 * Fixture route: isaflow_schema_fixture (assertDisposable). Never skips.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { dropBillFixture, openRequest, seedBillFixture, setPolicy, type BillFixture } from './helpers/budgetBillFixture';
import { callTool } from './helpers/poImportHarness';
import { approveBill, seedBill, seedPo, seedRawBill, type SeededPo } from './helpers/poBillLinkHarness';
import { linkBillsToPurchaseOrderTool as link } from '@/lib/mcp/tools/writeLinkBillsToPurchaseOrder';
import { cancelSupplierInvoiceTool as cancelBill } from '@/lib/mcp/tools/writeCancelSupplierInvoice';
import { getPurchaseOrderTool as getPo } from '@/lib/mcp/tools/getPurchaseOrder';
import { linkBillsToPurchaseOrders } from '@/modules/accounting/services/ap/purchaseOrderBillLink';
import { softDelete } from '@/modules/accounting/services/core/softDeleteService';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 8 });
let f: BillFixture;
beforeAll(async () => { f = await seedBillFixture(pool, 'codex-gate'); await setPolicy(pool, f, 'warn'); }, 60_000);
afterAll(async () => { try { await dropBillFixture(pool, f); } finally { await pool.end(); } }, 60_000);

const flag = async (po: SeededPo) => (await pool.query('SELECT status, closed_by_billing FROM purchase_orders WHERE id = $1', [po.po])).rows[0];
async function waitForLockWait(): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if ((await pool.query("SELECT 1 FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND datname = current_database()")).rows.length > 0) return;
    await new Promise((res) => setTimeout(res, 25));
  }
  throw new Error('no session waited on a lock');
}

describe('1: no double deduction from the header residual', () => {
  it('X (R100) names A by a R30 line and B in its header (B holds R70); one call links X to A by lines and a R30 bill to B: B closes', async () => {
    const a = await seedPo(pool, f, { lines: [30] });
    const b = await seedPo(pool, f, { lines: [100] });
    const x = await seedRawBill(pool, f, { items: [{ total: 30, poItem: a.items[0] }, { total: 70 }], subtotal: 100, total: 115, header: b.po });
    const y = await seedRawBill(pool, f, { items: [{ total: 30 }], subtotal: 30, total: 34.5 });
    const r = await callTool(pool, f, link, { links: [
      { po_id: a.po, bill_id: x.id, lines: [{ po_item_id: a.items[0], bill_line_id: x.lines[0] }] },
      { po_id: b.po, bill_id: y.id, amount: 30 },
    ], close_when_fully_billed: true });
    expect(r.isError, r.text).toBe(false);
    const bReply = (r.body.purchase_orders as Array<{ id: string; billed: number; status: string }>).find((p) => p.id === b.po)!;
    expect([bReply.billed, bReply.status, r.body.budget_warnings]).toEqual([100, 'closed', []]);
    expect(await flag(b)).toEqual({ status: 'closed', closed_by_billing: true });
  });
});

describe('2: a cancel racing a billing close', () => {
  it('a link call closes P on bill H while the cancel of H waits on H: once it holds H, the cancel reopens P', async () => {
    const p = await seedPo(pool, f, { lines: [1000] });
    const h = await seedBill(pool, f, { status: 'draft', lines: [1000] });
    await approveBill(pool, f, h.id);
    const l = await openRequest(pool, f, f.owner);
    await l.run(() => linkBillsToPurchaseOrders(f.co, [{ index: 0, poId: p.po, poNumber: null, billId: h.id, amountCents: null, lines: [], ref: null }],
      { userId: f.owner, source: 'mcp', via: 'link_bills_to_purchase_order', closeWhenFullyBilled: true }));
    const c = callTool(pool, f, cancelBill, { invoice_id: h.id });
    try { await waitForLockWait(); } finally { await l.commit(); }
    const r = await c;
    expect(r.isError, r.text).toBe(false);
    expect(await flag(p)).toEqual({ status: 'approved', closed_by_billing: false });
    expect(r.body.reopened_purchase_orders).toEqual([{ purchase_order_id: p.po, po_number: p.number, reopened_to: 'approved' }]);
  });
});

describe('2b: a soft delete racing a billing close (the shared re-read, lockPosClosedByBilling)', () => {
  it('a link call closes P on bill H while the delete of H waits on H: once it holds H, the delete reopens P', async () => {
    const p = await seedPo(pool, f, { lines: [1000] });
    const h = await seedBill(pool, f, { status: 'draft', lines: [1000] });
    await approveBill(pool, f, h.id);
    const l = await openRequest(pool, f, f.owner);
    await l.run(() => linkBillsToPurchaseOrders(f.co, [{ index: 0, poId: p.po, poNumber: null, billId: h.id, amountCents: null, lines: [], ref: null }],
      { userId: f.owner, source: 'mcp', via: 'link_bills_to_purchase_order', closeWhenFullyBilled: true }));
    const d = await openRequest(pool, f, f.owner);
    const del = d.run(() => softDelete(f.co, 'supplier_invoice', h.id, f.owner));
    let res: Awaited<ReturnType<typeof softDelete>>;
    try {
      try { await waitForLockWait(); } finally { await l.commit(); }
      res = await del;
      await d.commit();
    } catch (e) { await d.rollback(); throw e; }
    expect(await flag(p)).toEqual({ status: 'approved', closed_by_billing: false });
    expect(res.reopenedPurchaseOrders.map((r) => r.poNumber)).toEqual([p.number]);
  });
});

describe('4: the tolerance needs billing', () => {
  it('a R0.01 order with nothing billed is not fully billed', async () => {
    const po = await seedPo(pool, f, { lines: [0.01] });
    expect((await callTool(pool, f, getPo, { po_id: po.po })).body).toMatchObject({ billed_total: 0, fully_billed: false });
  });
});
