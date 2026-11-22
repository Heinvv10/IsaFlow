/**
 * PR #1703, round-8 blind review (test gaps), real PostgreSQL 16:
 *   M1  the unlink's budget read that fails with a real SQL error runs in its own savepoint: the unlink commits, its audit row is
 *       written, the warning says the budget could not be checked;
 *   M2  the billing basis, max(header subtotal, lines' total): the cancel dry run agrees with the cancel on it; billed between the
 *       header subtotal and the lines' total is not fully billed for get_purchase_order, closed_under_billed or the link's close;
 *   L3  the link reply carries the header's subtotal and the billing_basis;
 *   L5  a basis of 0 is never fully billed: a link call does not close such a PO.
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
import { getPurchaseOrderTool as getPo } from '@/lib/mcp/tools/getPurchaseOrder';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
let f: BillFixture;

beforeAll(async () => {
  f = await seedBillFixture(pool, 'rev-r8');
  await setPolicy(pool, f, 'warn');
}, 60_000);
afterAll(async () => {
  try { await dropBillFixture(pool, f); } finally { await pool.end(); }
}, 60_000);

const status = async (po: SeededPo) => (await pool.query('SELECT status, closed_by_billing FROM purchase_orders WHERE id = $1', [po.po])).rows[0];
const approvedBill = async (amount: number) => { const b = await seedBill(pool, f, { status: 'draft', lines: [amount] }); await approveBill(pool, f, b.id); return b; };
type PoReply = { id: string; status: string; billed: number; subtotal: number; billing_basis: number; fully_billed: boolean };
const poReply = (r: Awaited<ReturnType<typeof callTool>>, po: SeededPo) => (r.body.purchase_orders as PoReply[]).find((x) => x.id === po.po)!;

describe('M1: a failed budget read cannot roll the unlink back', () => {
  it('the budget amounts table is unreadable during the unlink: it commits, audits, and says the budget could not be checked', async () => {
    const po = await seedPo(pool, f, { lines: [1000] });
    const b = await seedBill(pool, f, { lines: [1000] });
    expect((await callTool(pool, f, link, { links: [{ po_id: po.po, bill_id: b.id }], close_when_fully_billed: true })).isError).toBe(false);
    // A real SQL error (42P01) inside the budget preview, after the gate (which reads only the policy).
    await pool.query('ALTER TABLE budget_month_amounts RENAME TO budget_month_amounts_r8_hidden');
    let u: Awaited<ReturnType<typeof callTool>>;
    try {
      u = await callTool(pool, f, unlink, { po_id: po.po, bill_id: b.id, reason: 'wrong PO' });
    } finally {
      await pool.query('ALTER TABLE budget_month_amounts_r8_hidden RENAME TO budget_month_amounts');
    }
    expect([u.isError, u.body.reopened_to], u.text).toEqual([false, 'approved']);
    expect((u.body.budget_warnings as string[]).join(' ')).toContain('The budget could not be checked just now');
    expect(await status(po)).toEqual({ status: 'approved', closed_by_billing: false });
    const audit = (await pool.query(`SELECT changes->'metadata'->>'unlinked_bill' AS bill FROM audit_log
      WHERE company_id = $1 AND entity_id = $2::UUID AND changes->'metadata' ? 'unlinked_bill'`, [f.co, po.po])).rows;
    expect(audit).toHaveLength(1);
  });
});

describe('M2: the billing basis is max(header subtotal, lines\' total)', () => {
  it('header 0 and a R100 line: the cancel dry run lists what the cancel reopens', async () => {
    const po = await seedPo(pool, f, { lines: [100] });
    await pool.query('UPDATE purchase_orders SET subtotal = 0, total = 0 WHERE id = $1', [po.po]);
    const h = await approvedBill(100);
    expect((await callTool(pool, f, link, { links: [{ po_id: po.po, bill_id: h.id }], close_when_fully_billed: true })).isError).toBe(false);
    const dry = await callTool(pool, f, cancelBill, { invoice_id: h.id, dry_run: true });
    const real = await callTool(pool, f, cancelBill, { invoice_id: h.id });
    expect(dry.body.would_reopen_purchase_orders).toEqual(real.body.reopened_purchase_orders);
    expect((real.body.reopened_purchase_orders as unknown[]).length).toBe(1);
  });
  it('header R50, a R100 line, billed R60: not fully billed for the close, the reply, get_purchase_order and closed_under_billed', async () => {
    const po = await seedPo(pool, f, { lines: [100] });
    await pool.query('UPDATE purchase_orders SET subtotal = 50, total = 50 WHERE id = $1', [po.po]);
    const b = await seedRawBill(pool, f, { items: [{ total: 60 }], subtotal: 60, total: 69 });
    const r = await callTool(pool, f, link, { links: [{ po_id: po.po, bill_id: b.id }], close_when_fully_billed: true });
    expect(r.isError, r.text).toBe(false);
    expect(poReply(r, po)).toMatchObject({ status: 'approved', billed: 60, subtotal: 50, billing_basis: 100, fully_billed: false });
    expect((await callTool(pool, f, getPo, { po_id: po.po })).body).toMatchObject({ fully_billed: false, closed_under_billed: false });
    await pool.query(`UPDATE purchase_orders SET status = 'closed', closed_from_status = 'approved', closed_by_billing = true WHERE id = $1`, [po.po]);
    expect((await callTool(pool, f, getPo, { po_id: po.po })).body).toMatchObject({ fully_billed: false, closed_under_billed: true });
  });
});

describe('L5: a basis of 0 is never fully billed', () => {
  it('a PO of no line and subtotal 0: a billed link with close_when_fully_billed leaves it open', async () => {
    const po = await seedPo(pool, f, { lines: [] });
    const b = await seedRawBill(pool, f, { items: [{ total: 10 }], subtotal: 10, total: 11.5 });
    const r = await callTool(pool, f, link, { links: [{ po_id: po.po, bill_id: b.id }], close_when_fully_billed: true });
    expect(r.isError, r.text).toBe(false);
    expect(poReply(r, po)).toMatchObject({ status: 'approved', billing_basis: 0, fully_billed: false });
    expect(await status(po)).toEqual({ status: 'approved', closed_by_billing: false });
    // Review r9 MEDIUM-1: get_purchase_order and the unlink reply (and its audit) say the same.
    expect((await callTool(pool, f, getPo, { po_id: po.po })).body).toMatchObject({ fully_billed: false });
    const u = await callTool(pool, f, unlink, { po_id: po.po, bill_id: b.id, reason: 'x' });
    expect([u.isError, u.body.fully_billed]).toEqual([false, false]);
  });
});
