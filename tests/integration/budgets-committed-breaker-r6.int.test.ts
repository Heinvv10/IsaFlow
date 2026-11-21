/**
 * PR #1703, ledger breaker round 6 (ported from its zz-b6-attack repros at 266e1fe48b) and the round-6 blind review, PostgreSQL 16:
 *   M5 / A1 / A4  a PO closed by billing commits 0 while it is fully billed at PO level (billedCentsByPo), even with a line
 *                 over-billed by its lines (R4-5); only once it is not does it commit its per-line open remainder;
 *   A2            a bill's postings to a PO are dropped only when they sum below 0 across that PO (the billAttribution floor):
 *                 +500 / -500 on two lines of one PO stay, so a header bill still nets exactly;
 *   A3            the unlink warns only when the PO's committed really rose (before / after under the lock);
 *   M4            the cancel dry run names the POs the cancel would reopen.
 * Fixture route: isaflow_schema_fixture (assertDisposable). Never skips.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { dropBillFixture, seedBillFixture, setPolicy, type BillFixture } from './helpers/budgetBillFixture';
import { callTool } from './helpers/poImportHarness';
import { approveBill, seedBill, seedPo, seedRawBill, type SeededPo } from './helpers/poBillLinkHarness';
import { linkBillsToPurchaseOrderTool as link } from '@/lib/mcp/tools/writeLinkBillsToPurchaseOrder';
import { unlinkBillFromPurchaseOrderTool as unlink } from '@/lib/mcp/tools/writeUnlinkBillFromPurchaseOrder';
import { cancelSupplierInvoiceTool as cancelBill } from '@/lib/mcp/tools/writeCancelSupplierInvoice';
import { readCommitments } from '@/modules/accounting/services/budgets/remainingCommitted';
import { openPoLineCents } from '@/modules/accounting/services/budgets/remainingBudgetCore';
import { billedCentsByPo } from '@/modules/accounting/services/ap/purchaseOrderBilled';
import { poCommittedCents } from '@/modules/accounting/services/ap/purchaseOrderBillingClose';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
let f: BillFixture;

beforeAll(async () => {
  f = await seedBillFixture(pool, 'brk-r6');
  await setPolicy(pool, f, 'warn');
}, 60_000);
afterAll(async () => {
  try { await dropBillFixture(pool, f); } finally { await pool.end(); }
}, 60_000);

const committed = async (po: SeededPo) => {
  const rows = await readCommitments(f.co, [f.acc.opex], '2026-06-01', '2026-06-30', {});
  return po.items.map((id) => { const r = rows.find((x) => x.poItemId === id); return r ? openPoLineCents(r.lineTotal, r.billed) : 0; });
};
const billed = async (po: SeededPo) => (await billedCentsByPo(f.co, [po.po])).get(po.po.toLowerCase()) ?? 0;
const status = async (po: SeededPo) => (await pool.query('SELECT status, closed_by_billing FROM purchase_orders WHERE id = $1', [po.po])).rows[0];
/** Both readers agree: the committed engine and the per-PO helper the link / unlink compare. */
const both = async (po: SeededPo) => {
  const lines = await committed(po);
  return { lines, po: (await poCommittedCents(f.co, [po.po])).get(po.po.toLowerCase()) };
};

describe('M5: a PO closed by billing commits 0 while it is fully billed', () => {
  it('A1: A 500 billed R800 by lines, a R200 link closes it: fully billed, committed [0, 0]', async () => {
    const po = await seedPo(pool, f, { lines: [500, 500] });
    const b1 = await seedRawBill(pool, f, { items: [{ total: 800 }], subtotal: 800, total: 920 });
    const b2 = await seedRawBill(pool, f, { items: [{ total: 200 }], subtotal: 200, total: 230 });
    const r = await callTool(pool, f, link, {
      links: [{ po_id: po.po, bill_id: b1.id, lines: [{ po_item_id: po.items[0], bill_line_id: b1.lines[0] }] }, { po_id: po.po, bill_id: b2.id, amount: 200 }],
      close_when_fully_billed: true,
    });
    expect(r.isError, r.text).toBe(false);
    expect([await status(po), await billed(po), await both(po)]).toEqual([{ status: 'closed', closed_by_billing: true }, 100000, { lines: [0, 0], po: 0 }]);
    // Under-billed (the R200 bill gone outside the app): its per-line open remainder commits, closed or not.
    await pool.query(`UPDATE supplier_invoices SET status = 'cancelled' WHERE id = $1`, [b2.id]);
    expect([await billed(po), await both(po)]).toEqual([80000, { lines: [0, 50000], po: 50000 }]);
  });
  it('A4: cancelling a R300 lines bill on B while billed stays R1000 leaves committed 0', async () => {
    const po = await seedPo(pool, f, { lines: [500, 500] });
    await seedRawBill(pool, f, { items: [{ total: 800, poItem: po.items[0] }], subtotal: 800, total: 920 });
    const b2 = await seedRawBill(pool, f, { items: [{ total: 300, poItem: po.items[1] }], subtotal: 300, total: 345 });
    const b3 = await seedRawBill(pool, f, { items: [{ total: 200 }], subtotal: 200, total: 230 });
    expect((await callTool(pool, f, link, { links: [{ po_id: po.po, bill_id: b3.id, amount: 200 }], close_when_fully_billed: true })).isError).toBe(false);
    await pool.query(`UPDATE supplier_invoices SET status = 'cancelled' WHERE id = $1`, [b2.id]);
    expect([await billed(po), await both(po)]).toEqual([100000, { lines: [0, 0], po: 0 }]);
  });
});

describe('A2: the floor is per bill and PO', () => {
  it('bill X: A +500 and B -500 (nets 0 on the PO, kept); a R500 header link: committed [0, 50000] = subtotal less billed', async () => {
    const po = await seedPo(pool, f, { lines: [500, 500] });
    await seedRawBill(pool, f, { items: [{ total: 500, poItem: po.items[0] }, { total: -500, poItem: po.items[1] }], subtotal: 0, total: 0 });
    const h = await seedRawBill(pool, f, { items: [{ total: 500 }], subtotal: 500, total: 575 });
    expect((await callTool(pool, f, link, { links: [{ po_id: po.po, bill_id: h.id, amount: 500 }] })).isError).toBe(false);
    expect([await billed(po), await both(po)]).toEqual([50000, { lines: [0, 50000], po: 50000 }]);
  });
});

describe('A3: an unlink warns only when committed really rose', () => {
  it('a: a bill whose lines on the PO net below 0 (dropped, nets nothing): unlinking it warns nothing', async () => {
    const po = await seedPo(pool, f, { lines: [1000] });
    const x = await seedRawBill(pool, f, { items: [{ total: 200, poItem: po.items[0] }, { total: -300, poItem: po.items[0] }, { total: 200 }], subtotal: 100, total: 115 });
    const u = await callTool(pool, f, unlink, { po_id: po.po, bill_id: x.id, reason: 'x' });
    expect([u.isError, u.body.budget_warnings, u.body.budget_warning ?? null, await committed(po)]).toEqual([false, [], null, [100000]]);
  });
  it('b: a second lines bill on an already over-billed line: unlinking it moves nothing and warns nothing', async () => {
    const po = await seedPo(pool, f, { lines: [500, 500] });
    await seedRawBill(pool, f, { items: [{ total: 500, poItem: po.items[0] }], subtotal: 500, total: 575 });
    const b2 = await seedRawBill(pool, f, { items: [{ total: 300, poItem: po.items[0] }], subtotal: 300, total: 345 });
    const u = await callTool(pool, f, unlink, { po_id: po.po, bill_id: b2.id, reason: 'x' });
    expect([u.isError, u.body.budget_warnings, u.body.budget_warning ?? null, await committed(po)]).toEqual([false, [], null, [0, 50000]]);
  });
});

describe('M4: the cancel dry run names what the cancel would reopen', () => {
  it('a bill that alone keeps its PO closed by billing: would_reopen_purchase_orders names it, nothing is written', async () => {
    const po = await seedPo(pool, f, { lines: [1000] });
    const h = await seedBill(pool, f, { status: 'draft', lines: [1000] });
    await approveBill(pool, f, h.id);
    expect((await callTool(pool, f, link, { links: [{ po_id: po.po, bill_id: h.id }], close_when_fully_billed: true })).isError).toBe(false);
    const dry = await callTool(pool, f, cancelBill, { invoice_id: h.id, dry_run: true });
    expect(dry.isError, dry.text).toBe(false);
    expect(dry.body.would_reopen_purchase_orders).toEqual([{ purchase_order_id: po.po, po_number: po.number, reopened_to: 'approved' }]);
    expect(await status(po)).toEqual({ status: 'closed', closed_by_billing: true });
  });
});
