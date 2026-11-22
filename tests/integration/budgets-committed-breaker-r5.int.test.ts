/**
 * PR #1703, ledger breaker round 5 (ported from its zz-breaker5 repros at b3459f2d00) and the round-5 blind review, PostgreSQL 16:
 *   STRUCTURAL  a PO closed BY BILLING still counts in committed at its open remainder (line total less attributed billing), so
 *               whatever path under-bills it (a link taking a header residual, a cancel or delete racing a close, a lines link),
 *               the unbilled rands commit again by themselves; a close by hand and a cancelled PO commit nothing;
 *   H1          an explicit amount never takes a header residual from a PO that is not committing (closed, cancelled): refused,
 *               dry run too; the header POs are locked with the call's POs, before its bills (B5-3d waits instead of racing);
 *   B5-2        the reply's billed / fully_billed net what the same call takes from a header tie, and never close on it;
 *   B5-5c       the "commits it again" warning only when that PO's committed really rose;
 *   M1          cancel and soft delete report the POs they reopened, with a warning each;
 *   B5-6        bulk cancel takes every bill's POs closed by billing first, so it cannot deadlock a link call.
 * Fixture route: isaflow_schema_fixture (assertDisposable). Never skips.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { dropBillFixture, openRequest, seedBillFixture, setPolicy, type BillFixture } from './helpers/budgetBillFixture';
import { callTool } from './helpers/poImportHarness';
import { approveBill, seedBill, seedPo, seedRawBill, type SeededPo } from './helpers/poBillLinkHarness';
import { linkBillsToPurchaseOrderTool as link } from '@/lib/mcp/tools/writeLinkBillsToPurchaseOrder';
import { unlinkBillFromPurchaseOrderTool as unlink } from '@/lib/mcp/tools/writeUnlinkBillFromPurchaseOrder';
import { cancelSupplierInvoiceTool as cancelBill } from '@/lib/mcp/tools/writeCancelSupplierInvoice';
import { closePurchaseOrderTool as closePo } from '@/lib/mcp/tools/writeClosePurchaseOrder';
import { linkBillsToPurchaseOrders } from '@/modules/accounting/services/ap/purchaseOrderBillLink';
import { lockPosClosedByBilling } from '@/modules/accounting/services/ap/purchaseOrderBillingClose';
import { softDelete } from '@/modules/accounting/services/core/softDeleteService';
import { cancelSupplierInvoice } from '@/modules/accounting/services/ap/supplierInvoiceWorkflowService';
import { readCommitments } from '@/modules/accounting/services/budgets/remainingCommitted';
import { openPoLineCents } from '@/modules/accounting/services/budgets/remainingBudgetCore';
import { billedCentsByPo } from '@/modules/accounting/services/ap/purchaseOrderBilled';
import { withSavepoint } from '@/lib/neon';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 8 });
let f: BillFixture;

beforeAll(async () => {
  f = await seedBillFixture(pool, 'brk-r5');
  await setPolicy(pool, f, 'warn');
}, 60_000);
afterAll(async () => {
  try { await dropBillFixture(pool, f); } finally { await pool.end(); }
}, 60_000);

const committed = async (po: SeededPo) => {
  const rows = await readCommitments(f.co, [f.acc.opex], '2026-06-01', '2026-06-30', {});
  return po.items.reduce((s, id) => { const r = rows.find((x) => x.poItemId === id); return s + (r ? openPoLineCents(r.lineTotal, r.billed) : 0); }, 0);
};
const billed = async (po: SeededPo) => (await billedCentsByPo(f.co, [po.po])).get(po.po.toLowerCase()) ?? 0;
const flag = async (po: SeededPo) => (await pool.query('SELECT status, closed_from_status, closed_by_billing FROM purchase_orders WHERE id = $1', [po.po])).rows[0];
const approvedBill = async (amount: number) => { const b = await seedBill(pool, f, { status: 'draft', lines: [amount] }); await approveBill(pool, f, b.id); return b; };
/** po (R1000) billed in full by H's header alone, closed by a link call whose own bill is then unlinked. */
async function closedByHeaderOnly(po: SeededPo) {
  const b = await seedRawBill(pool, f, { items: [{ total: 200 }], subtotal: 200, total: 230 });
  expect((await callTool(pool, f, link, { links: [{ po_id: po.po, bill_id: b.id, amount: 200 }], close_when_fully_billed: true })).isError).toBe(false);
  expect((await callTool(pool, f, unlink, { po_id: po.po, bill_id: b.id, reason: 'wrong PO' })).isError).toBe(false);
  expect(await flag(po)).toEqual({ status: 'closed', closed_from_status: 'approved', closed_by_billing: true });
}
async function waitForLockWait(): Promise<void> {
  for (let i = 0; i < 100; i++) {
    const r = await pool.query("SELECT 1 FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND datname = current_database()");
    if (r.rows.length > 0) return;
    await new Promise((res) => setTimeout(res, 50));
  }
  throw new Error('no session waited on a lock');
}

describe('STRUCTURAL: a PO closed by billing commits whatever becomes unbilled', () => {
  it('B5-1b: a lines link takes a header residual from a PO closed by billing (lines win): it stays closed and commits R1000', async () => {
    const z = await seedPo(pool, f, { lines: [1000], status: 'received' });
    const p = await seedPo(pool, f, { lines: [1000] });
    const h = await approvedBill(1000);
    await pool.query('UPDATE supplier_invoices SET purchase_order_id = $2 WHERE id = $1', [h.id, z.po]);
    await pool.query('DELETE FROM purchase_order_bill_links WHERE supplier_invoice_id = $1', [h.id]);
    await pool.query(`UPDATE purchase_orders SET status = 'closed', closed_from_status = 'received', closed_by_billing = true WHERE id = $1`, [z.po]);
    expect(await committed(z)).toBe(0);
    const r = await callTool(pool, f, link, { links: [{ po_id: p.po, bill_id: h.id, lines: [{ po_item_id: p.items[0], bill_line_id: h.lines[0] }] }] });
    expect(r.isError, r.text).toBe(false);
    expect([(await flag(z)).status, await billed(z), await committed(z)]).toEqual(['closed', 0, 100000]);
  });
  // Breaker r12 F2 / r13: a link no longer reads a bill whose removal is uncommitted as billing; it refuses, retryably, and the retry
  // reads it gone. The structural rule (closed by billing, under-billed: commits subtotal less billed) is pinned after it.
  it.each(['cancel', 'soft delete'] as const)('B5-3 / 3b: a %s racing the close of its PO: the link is refused, then reads it gone; a PO closed under-billed commits subtotal less billed', async (how) => {
    const p = await seedPo(pool, f, { lines: [1000] });
    const h = await approvedBill(1000);
    await pool.query('UPDATE supplier_invoices SET purchase_order_id = $2 WHERE id = $1', [h.id, p.po]);
    await pool.query('DELETE FROM purchase_order_bill_links WHERE supplier_invoice_id = $1', [h.id]);
    const c = await seedRawBill(pool, f, { items: [{ total: 1 }], subtotal: 1, total: 1.15 });
    const req = await openRequest(pool, f, f.owner);
    await req.run(() => (how === 'cancel' ? cancelSupplierInvoice(f.co, h.id, f.owner) : softDelete(f.co, 'supplier_invoice', h.id, f.owner, { allowReversal: true })));
    const args = { links: [{ po_id: p.po, bill_id: c.id, amount: 1 }], close_when_fully_billed: true };
    try {
      await expect(callTool(pool, f, link, args)).rejects.toMatchObject({ code: 'ROW_LOCK_TIMEOUT' });
    } finally { await req.commit(); }
    expect((await callTool(pool, f, link, args)).isError).toBe(false);
    expect([(await flag(p)).status, await billed(p), await committed(p)]).toEqual(['approved', 100, 99900]);
    await pool.query(`UPDATE purchase_orders SET status = 'closed', closed_from_status = 'approved', closed_by_billing = true WHERE id = $1`, [p.po]);
    expect([(await flag(p)).status, await billed(p), await committed(p)]).toEqual(['closed', 100, 99900]);
  });
  it('a close by hand and a cancelled PO commit nothing', async () => {
    const hand = await seedPo(pool, f, { lines: [1000] });
    expect((await callTool(pool, f, closePo, { po_id: hand.po, reason: 'short' })).isError).toBe(false);
    const gone = await seedPo(pool, f, { lines: [1000], status: 'cancelled' });
    expect([await committed(hand), await committed(gone)]).toEqual([0, 0]);
  });
});

describe('H1: an explicit amount never takes a header residual from a PO that is not committing', () => {
  it('B5-1: the header PO is closed by billing: refused, dry run too; it stays fully billed', async () => {
    const z = await seedPo(pool, f, { lines: [1000] });
    const p = await seedPo(pool, f, { lines: [300] });
    const h = await seedRawBill(pool, f, { items: [{ total: 1000 }], subtotal: 1000, total: 1150, header: z.po });
    await closedByHeaderOnly(z);
    const want = `the bill's header names purchase order ${z.number}, which is closed; unlink it from that purchase order first`;
    for (const dry_run of [true, false]) {
      const r = await callTool(pool, f, link, { links: [{ po_id: p.po, bill_id: h.id, amount: 300 }], dry_run });
      expect([r.isError, r.text.includes(want)], r.text).toEqual([true, true]);
    }
    expect([await billed(z), await committed(z), await committed(p)]).toEqual([100000, 0, 30000]);
  });
  it('the header PO is cancelled: refused', async () => {
    const z = await seedPo(pool, f, { lines: [1000], status: 'cancelled' });
    const p = await seedPo(pool, f, { lines: [300] });
    const h = await seedRawBill(pool, f, { items: [{ total: 1000 }], subtotal: 1000, total: 1150, header: z.po });
    const r = await callTool(pool, f, link, { links: [{ po_id: p.po, bill_id: h.id, amount: 300 }] });
    expect([r.isError, r.text.includes(`purchase order ${z.number}, which is cancelled; unlink it from that purchase order first`)]).toEqual([true, true]);
  });
  it('B5-3d: a link taking the header residual holds the header PO, so a racing close waits and sees it', async () => {
    const p = await seedPo(pool, f, { lines: [1000] });
    const q = await seedPo(pool, f, { lines: [1000] });
    const h = await seedRawBill(pool, f, { items: [{ total: 1000 }], subtotal: 1000, total: 1150, header: p.po });
    const c = await seedRawBill(pool, f, { items: [{ total: 1 }], subtotal: 1, total: 1.15 });
    const x = await openRequest(pool, f, f.owner);
    await x.run(() => linkBillsToPurchaseOrders(f.co, [{ index: 0, poId: q.po, poNumber: null, billId: h.id, amountCents: 100000, lines: [], ref: null }],
      { userId: f.owner, source: 'mcp', via: 'link_bills_to_purchase_order', closeWhenFullyBilled: false }));
    const y = callTool(pool, f, link, { links: [{ po_id: p.po, bill_id: c.id, amount: 1 }], close_when_fully_billed: true });
    try { await waitForLockWait(); } finally { await x.commit(); }
    expect((await y).isError).toBe(false);
    expect([(await flag(p)).status, await billed(p), await committed(p)]).toEqual(['approved', 100, 99900]);
  });
});

describe('B5-2 / B5-5c the reply agrees with get_purchase_order and warns only on a real rise', () => {
  it('B5-2: one call [Q takes H\'s R1000 from P\'s header, P gets R0.01] with close: P is billed 0.01 and not closed', async () => {
    const p = await seedPo(pool, f, { lines: [1000] });
    const q = await seedPo(pool, f, { lines: [1000] });
    const h = await seedRawBill(pool, f, { items: [{ total: 1000 }], subtotal: 1000, total: 1150, header: p.po });
    const c = await seedRawBill(pool, f, { items: [{ total: 1 }], subtotal: 1, total: 1.15 });
    const links = [{ po_id: q.po, bill_id: h.id, amount: 1000 }, { po_id: p.po, bill_id: c.id, amount: 1 }];
    for (const dry_run of [true, false]) {
      const r = await callTool(pool, f, link, { links, close_when_fully_billed: true, dry_run });
      expect(r.isError, r.text).toBe(false);
      const pAfter = (r.body.purchase_orders as Array<{ id: string; billed: number; fully_billed: boolean; status: string }>).find((x) => x.id === p.po)!;
      expect([pAfter.billed, pAfter.fully_billed, pAfter.status]).toEqual([1, false, 'approved']);
    }
    expect([(await flag(p)).status, await billed(p)]).toEqual(['approved', 100]);
  });
  it('B5-5c: the header PO is fully billed by lines elsewhere (its header nets 0): taking from the header warns nothing', async () => {
    const z = await seedPo(pool, f, { lines: [1000] });
    const p = await seedPo(pool, f, { lines: [300] });
    await seedRawBill(pool, f, { items: [{ total: 1000, poItem: z.items[0] }], subtotal: 1000, total: 1150 });
    const h = await seedRawBill(pool, f, { items: [{ total: 1000 }], subtotal: 1000, total: 1150, header: z.po });
    const r = await callTool(pool, f, link, { links: [{ po_id: p.po, bill_id: h.id, amount: 300 }] });
    expect([r.isError, r.body.budget_warnings, await committed(z)], r.text).toEqual([false, [], 0]);
  });
});

describe('M1 / B5-6 a cancel and a delete say what they reopened; bulk cancel takes the POs first', () => {
  it('the MCP cancel reports the reopened PO and a warning; a soft delete returns them', async () => {
    for (const how of ['cancel', 'delete'] as const) {
      const po = await seedPo(pool, f, { lines: [1000] });
      const h = await approvedBill(1000);
      expect((await callTool(pool, f, link, { links: [{ po_id: po.po, bill_id: h.id }], close_when_fully_billed: true })).isError).toBe(false);
      let out: { reopened: Array<{ po_number: string; reopened_to: string }>; warnings: string[] };
      if (how === 'cancel') {
        const r = await callTool(pool, f, cancelBill, { invoice_id: h.id });
        expect(r.isError, r.text).toBe(false);
        const rows = r.body.reopened_purchase_orders as Array<{ purchase_order_id: string; po_number: string; reopened_to: string }>;
        expect(rows.map((x) => x.purchase_order_id)).toEqual([po.po]);
        out = { reopened: rows.map((x) => ({ po_number: x.po_number, reopened_to: x.reopened_to })), warnings: r.body.budget_warnings as never };
      } else {
        const req = await openRequest(pool, f, f.owner);
        let res: Awaited<ReturnType<typeof softDelete>>;
        try { res = await req.run(() => softDelete(f.co, 'supplier_invoice', h.id, f.owner, { allowReversal: true })); await req.commit(); } catch (e) { await req.rollback(); throw e; }
        out = { reopened: res.reopenedPurchaseOrders.map((x) => ({ po_number: x.poNumber, reopened_to: x.reopenedTo })), warnings: res.budgetWarnings };
      }
      expect(out.reopened, how).toEqual([{ po_number: po.number, reopened_to: 'approved' }]);
      expect(out.warnings.join(' '), how).toContain(`Purchase order ${po.number} reopened to approved`);
    }
  });
  // This proves the PRIMITIVE (lockPosClosedByBilling over every id first, then the cancels) on real locks; that the bulk route
  // makes that call, sorted, before its loop is pinned by tests/unit/services/supplierInvoicesBulkAction.test.ts (review r6 M1/M2).
  it('B5-6: with every bill\'s POs closed by billing locked first, a bulk cancel [B1, H] and a link of B1 to P queue, never deadlock', async () => {
    const po = await seedPo(pool, f, { lines: [1000] });
    const a = await approvedBill(1000);
    const b = await approvedBill(50);
    // The bulk route walks sorted ids: B1 (first) is cancelled, then H (second), which alone bills P by its header.
    const [first, second] = [a, b].sort((x, y) => (x.id < y.id ? -1 : 1));
    await pool.query('UPDATE supplier_invoices SET purchase_order_id = $2 WHERE id = $1', [second!.id, po.po]);
    const hSub = Number((await pool.query('SELECT subtotal FROM supplier_invoices WHERE id = $1', [second!.id])).rows[0].subtotal);
    await pool.query('UPDATE purchase_orders SET subtotal = $2, total = $2 WHERE id = $1', [po.po, hSub]);
    await pool.query('UPDATE po_items SET line_total = $2, unit_price = $2 WHERE id = $1', [po.items[0], hSub]);
    await pool.query('DELETE FROM purchase_order_bill_links WHERE supplier_invoice_id = ANY($1::UUID[])', [[a.id, b.id]]);
    await closedByHeaderOnlyAt(po);
    const bulk = await openRequest(pool, f, f.owner);
    const out: string[] = [];
    try {
      await bulk.run(() => lockPosClosedByBilling(f.co, [first!.id, second!.id]));
      await bulk.run(() => withSavepoint('bulk_supplier_invoice_item', () => cancelSupplierInvoice(f.co, first!.id, f.owner)));
      const l = callTool(pool, f, link, { links: [{ po_id: po.po, bill_id: first!.id, amount: 1 }] })
        .then((r) => out.push(`link isError=${r.isError}`), (e) => out.push(`link threw ${String(e)}`));
      await waitForLockWait();
      await bulk.run(() => withSavepoint('bulk_supplier_invoice_item', () => cancelSupplierInvoice(f.co, second!.id, f.owner)))
        .then(() => out.push('bulk item 2 ok'), (e) => out.push(`bulk item 2 threw ${String(e)}`));
      await bulk.commit();
      await l;
    } finally { await bulk.rollback().catch(() => undefined); }
    expect(out.join(' ')).not.toMatch(/deadlock|40P01/);
    expect(out).toContain('bulk item 2 ok');
  }, 60_000);
});

/** The PO's own bill closes it at its (rewritten) subtotal by header alone; the closing link's bill is unlinked again. */
async function closedByHeaderOnlyAt(po: SeededPo) {
  const c = await seedRawBill(pool, f, { items: [{ total: 1 }], subtotal: 1, total: 1.15 });
  expect((await callTool(pool, f, link, { links: [{ po_id: po.po, bill_id: c.id, amount: 1 }], close_when_fully_billed: true })).isError).toBe(false);
  expect((await callTool(pool, f, unlink, { po_id: po.po, bill_id: c.id, reason: 'x' })).isError).toBe(false);
  expect((await flag(po)).closed_by_billing).toBe(true);
}
