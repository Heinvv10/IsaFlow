/**
 * A goods received note on a closed or cancelled PO (docs/design/mcp-goods-received.md, breaker round 2 M1), real PostgreSQL, as
 * app_user (grnHarness):
 *   - a note on a CLOSED PO cancels: the PO stays closed, the quantities come back, and its closing records (closed_from_status, and a
 *     link close's closed_po_from_status) become the status the receipts now give, so a later reopen lands there;
 *   - a cancelled PO carries only cancelled notes: every way to cancel a PO refuses one with a live note; a note on a cancelled PO (only
 *     by hand) is refused, offering no exit that does not exist.
 * Fixture route: isaflow_schema_fixture (assertDisposable). Never skips.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { dropBillFixture, seedBillFixture, setPolicy, type BillFixture } from './helpers/budgetBillFixture';
import { callTool, dropGrnExtras, dropMaintExtras, grnArgs, poState, refusal, seedQtyPo, type QtyPo } from './helpers/grnHarness';
import { linkRows, seedBill } from './helpers/poBillLinkHarness';
import { poRow } from './helpers/poMaintHarness';
import { createGoodsReceivedTool as create } from '@/lib/mcp/tools/writeCreateGoodsReceived';
import { cancelGoodsReceivedTool as cancelGrn } from '@/lib/mcp/tools/writeCancelGoodsReceived';
import { closePurchaseOrderTool as closePo } from '@/lib/mcp/tools/writeClosePurchaseOrder';
import { cancelPurchaseOrderTool as cancelPo } from '@/lib/mcp/tools/writeCancelPurchaseOrder';
import { setPurchaseOrderStatusTool as setStatus } from '@/lib/mcp/tools/writeSetPurchaseOrderStatus';
import { linkBillsToPurchaseOrderTool as link } from '@/lib/mcp/tools/writeLinkBillsToPurchaseOrder';
import { unlinkBillFromPurchaseOrderTool as unlink } from '@/lib/mcp/tools/writeUnlinkBillFromPurchaseOrder';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
let f: BillFixture;

beforeAll(async () => {
  f = await seedBillFixture(pool, 'grn-closed');
  await setPolicy(pool, f, 'warn');
}, 60_000);
afterAll(async () => {
  try { await dropGrnExtras(pool, f); await dropMaintExtras(pool, f); await dropBillFixture(pool, f); } finally { await pool.end(); }
}, 60_000);

const receive = async (po: QtyPo, qty: number) => {
  const r = await callTool(pool, f, create, grnArgs(po, [[0, qty]]));
  expect(r.isError, r.text).toBe(false);
  return String(r.body.grn_id);
};
const cancelNote = (grn: string) => callTool(pool, f, cancelGrn, { grn_id: grn, reason: 'returned to the supplier' });
const claims = async (po: string) => (await linkRows(pool, f, `l.purchase_order_id = '${po}'`)).map((l) => l.closed_po_from_status);

describe('a note on a closed PO cancels (breaker M1)', () => {
  it('short-closed: the PO stays closed, the quantities come back, closed_from_status follows the receipts', async () => {
    const po = await seedQtyPo(pool, f, { lines: [{ qty: 10, price: 5 }] });
    const first = await receive(po, 6);
    expect((await callTool(pool, f, closePo, { po_id: po.po, reason: 'short delivery accepted' })).isError).toBe(false);
    expect(await poRow(pool, po.po)).toMatchObject({ status: 'closed', closed_from_status: 'partially_received' });
    const dry = await callTool(pool, f, cancelGrn, { grn_id: first, reason: 'x', dry_run: true });
    expect(dry.isError, dry.text).toBe(false);
    expect(dry.body).toMatchObject({ dry_run: true, would_cancel: true, po_status: 'closed', receipt_status: 'approved' });
    expect(await poState(pool, po)).toEqual({ status: 'closed', received: [6] });
    expect((await poRow(pool, po.po)).closed_from_status).toBe('partially_received');
    const r = await cancelNote(first);
    expect(r.isError, r.text).toBe(false);
    expect(r.body).toMatchObject({ cancelled: true, po_status_before: 'closed', po_status: 'closed', receipt_status: 'approved' });
    expect(await poState(pool, po)).toEqual({ status: 'closed', received: [0] });
    expect((await poRow(pool, po.po)).closed_from_status).toBe('approved');
  });

  it('closed from received: cancelling one of two notes records partially_received', async () => {
    const po = await seedQtyPo(pool, f, { lines: [{ qty: 10, price: 5 }] });
    await receive(po, 6);
    const second = await receive(po, 4);
    expect((await callTool(pool, f, closePo, { po_id: po.po, reason: 'done' })).isError).toBe(false);
    expect((await poRow(pool, po.po)).closed_from_status).toBe('received');
    expect((await cancelNote(second)).isError).toBe(false);
    expect(await poRow(pool, po.po)).toMatchObject({ status: 'closed', closed_from_status: 'partially_received' });
    expect(await poState(pool, po)).toEqual({ status: 'closed', received: [6] });
  });

  it('closed by a link: the link\'s closing record follows the receipts, so the unlink reopens to what the receipts say', async () => {
    const po = await seedQtyPo(pool, f, { lines: [{ qty: 1, price: 100 }] });
    const grn = await receive(po, 1);
    const bill = await seedBill(pool, f, { lines: [100] });
    const linked = await callTool(pool, f, link, { links: [{ po_id: po.po, bill_id: bill.id }], close_when_fully_billed: true });
    expect(linked.isError, linked.text).toBe(false);
    expect(await poRow(pool, po.po)).toMatchObject({ status: 'closed', closed_from_status: null });
    expect(await claims(po.po)).toEqual(['received']);
    expect((await cancelNote(grn)).isError).toBe(false);
    expect(await claims(po.po)).toEqual(['approved']);
    expect((await poRow(pool, po.po)).closed_from_status).toBeNull();
    const u = await callTool(pool, f, unlink, { po_id: po.po, bill_id: bill.id, reason: 'wrong bill' });
    expect(u.isError, u.text).toBe(false);
    expect(u.body).toMatchObject({ reopened_to: 'approved' });
    // Reopened right: the goods can be received again.
    expect((await callTool(pool, f, create, grnArgs(po, [[0, 1]]))).isError).toBe(false);
  });
});

describe('a cancelled PO carries only cancelled notes', () => {
  it('every way to cancel a PO refuses one with a live note; a note on a cancelled PO (by hand) is refused with no exit offered', async () => {
    const po = await seedQtyPo(pool, f, { external: true, lines: [{ qty: 5, price: 10 }] });
    // Rejected goods only: the PO stays approved, the one status a PO cancel starts from, and the note is live.
    const made = await callTool(pool, f, create, grnArgs(po, [[0, 0, 1]]));
    expect(made.isError, made.text).toBe(false);
    const grn = String(made.body.grn_id);
    expect((await callTool(pool, f, cancelPo, { po_id: po.po, reason: 'x' })).text).toContain('a receipt is on record');
    expect((await callTool(pool, f, setStatus, { po_id: po.po, status: 'cancelled', reason: 'x' })).text).toContain('a receipt is on record');
    expect((await poRow(pool, po.po)).status).toBe('approved');
    await pool.query("UPDATE purchase_orders SET status = 'cancelled' WHERE id = $1", [po.po]);
    const r = refusal((await cancelNote(grn)).text);
    expect(r).toMatchObject({ code: 'po_not_receivable', po_status: 'cancelled' });
    expect(r.message).not.toMatch(/first|back|reopen/i);
  });
});
