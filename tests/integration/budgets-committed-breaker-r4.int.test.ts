/**
 * PR #1703, ledger breaker round 4 (ported from its zz-breaker4 repros at 0c54f785e4) and the round-4 blind review, real PostgreSQL 16:
 *   R4-1  "closed because fully billed" lives on the PO (closed_by_billing): removing a counted tie (unlink, a bill cancelled or
 *         soft-deleted) that leaves it under-billed reopens it, whichever tie held the PO closed; a manual short close never reopens;
 *         an uncounted tie (a cancelled bill's) never reopens it (review L2);
 *   R4-2  a soft-deleted bill nets nothing, by lines or as header room (its journal is reversed out of actuals);
 *   R4-3  the spread water-fills: every cent that fits is netted;
 *   R4-4  a header tie is a residual, never a hold: an explicit amount may take from it (warned), no amount is refused (review M1);
 *   R4-5  named limit: a line over-billed by lines leaves committed beside fully_billed true;
 *   R4-6 / R4-7  room follows a line bill's status; an unlink that moves nothing warns nothing.
 * Fixture route: isaflow_schema_fixture (assertDisposable). Never skips.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { dropBillFixture, openRequest, seedBillFixture, setPolicy, type BillFixture } from './helpers/budgetBillFixture';
import { callTool } from './helpers/poImportHarness';
import { approveBill, poStatus, seedBill, seedPo, seedRawBill, type SeededPo } from './helpers/poBillLinkHarness';
import { linkBillsToPurchaseOrderTool as link } from '@/lib/mcp/tools/writeLinkBillsToPurchaseOrder';
import { unlinkBillFromPurchaseOrderTool as unlink } from '@/lib/mcp/tools/writeUnlinkBillFromPurchaseOrder';
import { getPurchaseOrderTool as getPo } from '@/lib/mcp/tools/getPurchaseOrder';
import { cancelSupplierInvoiceTool as cancelBill } from '@/lib/mcp/tools/writeCancelSupplierInvoice';
import { closePurchaseOrderTool as closePo } from '@/lib/mcp/tools/writeClosePurchaseOrder';
import { softDelete } from '@/modules/accounting/services/core/softDeleteService';
import { readCommitments } from '@/modules/accounting/services/budgets/remainingCommitted';
import { openPoLineCents } from '@/modules/accounting/services/budgets/remainingBudgetCore';
import { billedCentsByPo } from '@/modules/accounting/services/ap/purchaseOrderBilled';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
let f: BillFixture;

beforeAll(async () => {
  f = await seedBillFixture(pool, 'brk-r4');
  await setPolicy(pool, f, 'warn');
}, 60_000);
afterAll(async () => {
  try { await dropBillFixture(pool, f); } finally { await pool.end(); }
}, 60_000);

const openOf = async (po: SeededPo) => {
  const rows = await readCommitments(f.co, [f.acc.opex], '2026-06-01', '2026-06-30', {});
  return po.items.map((id) => { const r = rows.find((x) => x.poItemId === id); return r ? openPoLineCents(r.lineTotal, r.billed) : null; });
};
const sum = (a: Array<number | null>) => a.reduce<number>((s, c) => s + (c ?? 0), 0);
const billed = async (po: SeededPo) => (await billedCentsByPo(f.co, [po.po])).get(po.po.toLowerCase()) ?? 0;
const detail = async (po: SeededPo) => JSON.parse((await callTool(pool, f, getPo, { po_id: po.po })).text);
const flag = async (po: SeededPo) => (await pool.query('SELECT status, closed_from_status, closed_by_billing FROM purchase_orders WHERE id = $1', [po.po])).rows[0];
/** A PO billed in full by a header-only bill H; a R200 bill B linked with close_when_fully_billed closes it, then B is unlinked. */
async function closedByHeaderOnly(h: { id: string }, po: SeededPo) {
  const b = await seedRawBill(pool, f, { items: [{ total: 200 }], subtotal: 200, total: 230 });
  const r = await callTool(pool, f, link, { links: [{ po_id: po.po, bill_id: b.id, amount: 200 }], close_when_fully_billed: true });
  expect(r.isError, r.text).toBe(false);
  expect(await flag(po)).toEqual({ status: 'closed', closed_from_status: 'approved', closed_by_billing: true });
  const u = await callTool(pool, f, unlink, { po_id: po.po, bill_id: b.id, reason: 'wrong PO' });
  expect([u.isError, u.body.reopened_to]).toEqual([false, null]); // still fully billed by H's header
  expect(await flag(po)).toEqual({ status: 'closed', closed_from_status: 'approved', closed_by_billing: true });
  void h;
}

describe('R4-1 "closed because fully billed" lives on the purchase order', () => {
  it('unlink the link that closed it (the header still bills it in full), then the header bill: it reopens and commits again', async () => {
    const po = await seedPo(pool, f, { lines: [1000] });
    const h = await seedRawBill(pool, f, { items: [{ total: 1000 }], subtotal: 1000, total: 1150, header: po.po });
    await closedByHeaderOnly(h, po);
    const u = await callTool(pool, f, unlink, { po_id: po.po, bill_id: h.id, reason: 'wrong PO' });
    expect([u.isError, u.body.reopened_to]).toEqual([false, 'approved']);
    expect(await flag(po)).toEqual({ status: 'approved', closed_from_status: null, closed_by_billing: false });
    expect([await openOf(po), (await detail(po)).closed_under_billed]).toEqual([[100000], false]);
  });
  it('the header bill cancelled outside the app: get_purchase_order flags closed_under_billed', async () => {
    const po = await seedPo(pool, f, { lines: [1000] });
    const h = await seedRawBill(pool, f, { items: [{ total: 1000 }], subtotal: 1000, total: 1150, header: po.po });
    await closedByHeaderOnly(h, po);
    await pool.query(`UPDATE supplier_invoices SET status = 'cancelled' WHERE id = $1`, [h.id]);
    const d = await detail(po);
    expect([d.purchase_order.status, d.fully_billed, d.closed_under_billed]).toEqual(['closed', false, true]);
  });
  it.each(['cancel', 'soft-delete'] as const)('the header bill %s through the app: the PO reopens', async (how) => {
    const po = await seedPo(pool, f, { lines: [1000] });
    const h = await seedBill(pool, f, { status: 'draft', lines: [1000] });
    await approveBill(pool, f, h.id);
    await pool.query('UPDATE supplier_invoices SET purchase_order_id = $2 WHERE id = $1', [h.id, po.po]);
    await closedByHeaderOnly(h, po);
    if (how === 'cancel') {
      const r = await callTool(pool, f, cancelBill, { invoice_id: h.id });
      expect(r.isError, r.text).toBe(false);
    } else {
      const req = await openRequest(pool, f, f.owner);
      try { await req.run(() => softDelete(f.co, 'supplier_invoice', h.id, f.owner)); await req.commit(); } catch (e) { await req.rollback(); throw e; }
    }
    expect(await flag(po)).toEqual({ status: 'approved', closed_from_status: null, closed_by_billing: false });
    expect(await openOf(po)).toEqual([100000]);
  });
  it('a manual short close never reopens, whatever is unlinked', async () => {
    const po = await seedPo(pool, f, { lines: [1000] });
    const b = await seedRawBill(pool, f, { items: [{ total: 400 }], subtotal: 400, total: 460 });
    expect((await callTool(pool, f, link, { links: [{ po_id: po.po, bill_id: b.id }] })).isError).toBe(false);
    const c = await callTool(pool, f, closePo, { po_id: po.po, reason: 'short close' });
    expect(c.isError, c.text).toBe(false);
    expect(await flag(po)).toEqual({ status: 'closed', closed_from_status: 'approved', closed_by_billing: false });
    const u = await callTool(pool, f, unlink, { po_id: po.po, bill_id: b.id, reason: 'wrong PO' });
    expect([u.isError, u.body.reopened_to, await poStatus(pool, po.po)]).toEqual([false, null, 'closed']);
  });
  it('L2: unlinking a cancelled bill\'s header from a PO closed under-billed leaves it closed (the tie never counted)', async () => {
    const po = await seedPo(pool, f, { lines: [1000] });
    const b = await seedRawBill(pool, f, { items: [{ total: 1000 }], subtotal: 1000, total: 1150 });
    expect((await callTool(pool, f, link, { links: [{ po_id: po.po, bill_id: b.id }], close_when_fully_billed: true })).isError).toBe(false);
    await pool.query(`UPDATE supplier_invoices SET status = 'cancelled' WHERE id = $1`, [b.id]); // closed_under_billed now
    const stray = await seedRawBill(pool, f, { items: [{ total: 300 }], subtotal: 300, total: 345, status: 'cancelled', header: po.po });
    const u = await callTool(pool, f, unlink, { po_id: po.po, bill_id: stray.id, reason: 'x' });
    expect([u.isError, u.body.reopened_to, await poStatus(pool, po.po)]).toEqual([false, null, 'closed']);
  });
});

describe('R4-2 / R4-3 / R4-5 / R4-6 the header spread', () => {
  it('R4-2: a soft-deleted line bill nets nothing and leaves its room to a live header bill', async () => {
    const po = await seedPo(pool, f, { lines: [500, 500] });
    const l = await seedRawBill(pool, f, { items: [{ total: 500, poItem: po.items[0] }], subtotal: 500, total: 575 });
    await pool.query('UPDATE supplier_invoices SET deleted_at = NOW() WHERE id = $1', [l.id]);
    await seedRawBill(pool, f, { items: [{ total: 500 }], subtotal: 500, total: 575, header: po.po });
    expect(await billed(po)).toBe(50000);
    // The header's R500 spreads over the live room [500, 500]: 250 / 250; the deleted bill nets nothing (ruling): committed 500.
    expect(await openOf(po)).toEqual([25000, 25000]);
  });
  it('R4-3: 40 lines of R100 and a R50 line billed R49.99 by lines; a R4000 header bill: committed is the 1c left', async () => {
    const po = await seedPo(pool, f, { lines: [...Array(40).fill(100), 50] });
    await seedRawBill(pool, f, { items: [{ total: 49.99, poItem: po.items[40] }], subtotal: 49.99, total: 57.49 });
    await seedRawBill(pool, f, { items: [{ total: 4000 }], subtotal: 4000, total: 4600, header: po.po });
    expect([await billed(po), sum(await openOf(po))]).toEqual([404999, 1]);
  });
  it('R4-5 named limit: A 500 billed R800 by lines and a R200 header bill: fully billed, yet B still commits R300', async () => {
    const po = await seedPo(pool, f, { lines: [500, 500] });
    await seedRawBill(pool, f, { items: [{ total: 800, poItem: po.items[0] }], subtotal: 800, total: 920 });
    await seedRawBill(pool, f, { items: [{ total: 200 }], subtotal: 200, total: 230, header: po.po });
    expect([(await detail(po)).fully_billed, await openOf(po)]).toEqual([true, [0, 30000]]);
  });
  it('R4-6: room follows a line bill through draft, approved, cancelled and soft-deleted', async () => {
    const po = await seedPo(pool, f, { lines: [500, 500] });
    await seedRawBill(pool, f, { items: [{ total: 500 }], subtotal: 500, total: 575, header: po.po });
    const l = await seedRawBill(pool, f, { items: [{ total: 300, poItem: po.items[0] }], subtotal: 300, total: 345, status: 'draft' });
    const snap = async () => [await billed(po), await openOf(po)];
    expect(await snap()).toEqual([50000, [25000, 25000]]);
    await pool.query(`UPDATE supplier_invoices SET status = 'approved' WHERE id = $1`, [l.id]);
    expect(await snap()).toEqual([80000, [5715, 14285]]); // room [200, 500]: the header's R500 by room share
    await pool.query(`UPDATE supplier_invoices SET status = 'cancelled' WHERE id = $1`, [l.id]);
    expect(await snap()).toEqual([50000, [25000, 25000]]);
    // Soft-deleted approved: billed, the header room and line netting all ignore it (R4-2 ruling).
    await pool.query(`UPDATE supplier_invoices SET status = 'approved', deleted_at = NOW() WHERE id = $1`, [l.id]);
    expect(await snap()).toEqual([50000, [25000, 25000]]);
  });
  it('R4-6b: two header bills competing for the same room net no more than it', async () => {
    const po = await seedPo(pool, f, { lines: [700, 300] });
    await seedRawBill(pool, f, { items: [{ total: 700, poItem: po.items[0] }], subtotal: 700, total: 805 });
    await seedRawBill(pool, f, { items: [{ total: 200 }], subtotal: 200, total: 230, header: po.po });
    await seedRawBill(pool, f, { items: [{ total: 250 }], subtotal: 250, total: 287.5, header: po.po });
    expect(await openOf(po)).toEqual([0, 0]);
  });
  it('R4-7: unlinking a header bill that nets nothing warns nothing', async () => {
    const po = await seedPo(pool, f, { lines: [1000] });
    await seedRawBill(pool, f, { items: [{ total: 1000, poItem: po.items[0] }], subtotal: 1000, total: 1150 });
    const h = await seedRawBill(pool, f, { items: [{ total: 500 }], subtotal: 500, total: 575, header: po.po });
    const u = await callTool(pool, f, unlink, { po_id: po.po, bill_id: h.id, reason: 'wrong PO' });
    expect([u.isError, await openOf(po), u.body.budget_warnings ?? []]).toEqual([false, [0], []]);
  });
});

describe('R4-4 / review M1 a header tie is a residual, never a hold', () => {
  const headerBill = (z: SeededPo, total = 1000) => seedRawBill(pool, f, { items: [{ total }], subtotal: total, total: total * 1.15, header: z.po });
  it('a: an explicit R300 of a bill whose header names Z goes to P; Z commits that R300 again, and the reply names Z', async () => {
    const z = await seedPo(pool, f, { lines: [1000] });
    const p = await seedPo(pool, f, { lines: [300] });
    const b = await headerBill(z);
    const dry = await callTool(pool, f, link, { links: [{ po_id: p.po, bill_id: b.id, amount: 300 }], dry_run: true });
    const r = await callTool(pool, f, link, { links: [{ po_id: p.po, bill_id: b.id, amount: 300 }] });
    expect([dry.isError, r.isError], r.text).toEqual([false, false]);
    for (const out of [dry, r]) expect((out.body.budget_warnings as string[]).join(' ')).toContain(`header names purchase order ${z.number}`);
    expect([await openOf(p), await openOf(z)]).toEqual([[0], [30000]]);
  });
  it('a: with no amount it is refused, naming Z; dry run the same; nothing is written', async () => {
    const z = await seedPo(pool, f, { lines: [1000] });
    const p = await seedPo(pool, f, { lines: [300] });
    const b = await headerBill(z);
    const want = `the bill's header names purchase order ${z.number}; give an amount or unlink it first`;
    for (const dry_run of [true, false]) {
      const r = await callTool(pool, f, link, { links: [{ po_id: p.po, bill_id: b.id }], dry_run });
      expect([r.isError, r.text.includes(want)]).toEqual([true, true]);
    }
    expect([await openOf(p), await openOf(z)]).toEqual([[30000], [0]]);
  });
  it('b: one call [Z 700, P 300] on a bill whose header names Z', async () => {
    const z = await seedPo(pool, f, { lines: [1000] });
    const p = await seedPo(pool, f, { lines: [300] });
    const b = await headerBill(z);
    const r = await callTool(pool, f, link, { links: [{ po_id: z.po, bill_id: b.id, amount: 700 }, { po_id: p.po, bill_id: b.id, amount: 300 }] });
    expect(r.isError, r.text).toBe(false);
    expect([await openOf(z), await openOf(p)]).toEqual([[30000], [0]]);
  });
  it('M1: subtotal R300, header P2, one call [P2 100, P1 200] and [P1 200, P2 100]: both pass, 300 in all', async () => {
    for (const order of [0, 1]) {
      const p1 = await seedPo(pool, f, { lines: [1000] });
      const p2 = await seedPo(pool, f, { lines: [1000] });
      const b = await headerBill(p2, 300);
      const rows = [{ po_id: p2.po, bill_id: b.id, amount: 100 }, { po_id: p1.po, bill_id: b.id, amount: 200 }];
      const r = await callTool(pool, f, link, { links: order === 0 ? rows : [...rows].reverse() });
      expect(r.isError, r.text).toBe(false);
      expect([await billed(p1), await billed(p2)]).toEqual([20000, 10000]);
    }
  });
  it('c: the header names a cancelled PO: dry run and live agree, and after unlinking it the bill links', async () => {
    const z = await seedPo(pool, f, { lines: [1000], status: 'cancelled' });
    const p = await seedPo(pool, f, { lines: [1000] });
    const b = await headerBill(z);
    const r = await callTool(pool, f, link, { links: [{ po_id: p.po, bill_id: b.id }] });
    const dry = await callTool(pool, f, link, { links: [{ po_id: p.po, bill_id: b.id }], dry_run: true });
    expect([r.isError, dry.isError]).toEqual([true, true]);
    expect((await callTool(pool, f, unlink, { po_id: z.po, bill_id: b.id, reason: 'header named a cancelled PO' })).isError).toBe(false);
    const r2 = await callTool(pool, f, link, { links: [{ po_id: p.po, bill_id: b.id }] });
    expect(r2.isError, r2.text).toBe(false);
  });
});
