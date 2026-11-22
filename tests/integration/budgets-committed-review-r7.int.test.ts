/**
 * PR #1703, round-7 blind review, real PostgreSQL 16:
 *   H1  a budget read that fails with a real SQL error after a reopen runs in its own savepoint: the cancel commits, the reopen
 *       persists, and the warning says the budget could not be checked (a caught error that aborted the request transaction would
 *       turn its COMMIT into a ROLLBACK under a 200);
 *   M1  the per-(bill, PO) floor is decided over every line of the bill naming the PO, whatever accounts are read;
 *   M2  fully billed is against max(header subtotal, lines' total), as 1022 closes on;
 *   L1  readCommitments' "fully billed, commits 0" verdict counts the same own bills it nets;
 *   L5  the cancel dry run's would_reopen_purchase_orders is the real cancel's reopened_purchase_orders, empty included.
 * Fixture route: isaflow_schema_fixture (assertDisposable). Never skips.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { dropBillFixture, seedBillFixture, setPolicy, type BillFixture } from './helpers/budgetBillFixture';
import { callTool } from './helpers/poImportHarness';
import { approveBill, seedBill, seedPo, seedRawBill, type SeededPo } from './helpers/poBillLinkHarness';
import { linkBillsToPurchaseOrderTool as link } from '@/lib/mcp/tools/writeLinkBillsToPurchaseOrder';
import { cancelSupplierInvoiceTool as cancelBill } from '@/lib/mcp/tools/writeCancelSupplierInvoice';
import { readCommitments } from '@/modules/accounting/services/budgets/remainingCommitted';
import { openPoLineCents } from '@/modules/accounting/services/budgets/remainingBudgetCore';
import { billedCentsByPo } from '@/modules/accounting/services/ap/purchaseOrderBilled';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
let f: BillFixture;

beforeAll(async () => {
  f = await seedBillFixture(pool, 'rev-r7');
  await setPolicy(pool, f, 'warn');
}, 60_000);
afterAll(async () => {
  try { await dropBillFixture(pool, f); } finally { await pool.end(); }
}, 60_000);

const committed = async (po: SeededPo, accounts = [f.acc.opex], opts = {}) => {
  const rows = await readCommitments(f.co, accounts, '2026-06-01', '2026-06-30', opts);
  return po.items.map((id) => { const r = rows.find((x) => x.poItemId === id); return r ? openPoLineCents(r.lineTotal, r.billed) : 0; });
};
const status = async (po: SeededPo) => (await pool.query('SELECT status, closed_by_billing FROM purchase_orders WHERE id = $1', [po.po])).rows[0];
const approvedBill = async (amount: number) => { const b = await seedBill(pool, f, { status: 'draft', lines: [amount] }); await approveBill(pool, f, b.id); return b; };
const closedBy = async (po: SeededPo, bills: Array<{ id: string }>) =>
  expect((await callTool(pool, f, link, { links: bills.map((b) => ({ po_id: po.po, bill_id: b.id })), close_when_fully_billed: true })).isError).toBe(false);

describe('H1: a failed budget read after a reopen cannot roll the cancel back', () => {
  it('the budget settings table is unreadable during the cancel: it commits, the PO reopens, the warning says so', async () => {
    const po = await seedPo(pool, f, { lines: [1000] });
    const h = await approvedBill(1000);
    await closedBy(po, [h]);
    // A real SQL error inside the read (42P01): the preview's first query is the policy read.
    await pool.query('ALTER TABLE budget_control_settings RENAME TO budget_control_settings_r7_hidden');
    let r: Awaited<ReturnType<typeof callTool>>;
    try {
      r = await callTool(pool, f, cancelBill, { invoice_id: h.id });
    } finally {
      await pool.query('ALTER TABLE budget_control_settings_r7_hidden RENAME TO budget_control_settings');
    }
    expect(r.isError, r.text).toBe(false);
    expect((r.body.budget_warnings as string[]).join(' ')).toContain('The budget could not be checked just now');
    expect(await status(po)).toEqual({ status: 'approved', closed_by_billing: false });
    expect((await pool.query('SELECT status FROM supplier_invoices WHERE id = $1', [h.id])).rows[0].status).toBe('cancelled');
  });
});

describe('M1: the floor does not depend on which accounts are read', () => {
  it('A +300 (opex) and B -400 (travel) of one bill on one PO net -100: neither line is netted, whatever is read', async () => {
    const po = await seedPo(pool, f, { lines: [500, 500] });
    await pool.query('UPDATE po_items SET gl_account_id = $2 WHERE id = $1', [po.items[1], f.acc.travel]);
    // An unnamed R200 line keeps the bill's own total positive (a document may not carry a negative total).
    await seedRawBill(pool, f, { items: [{ total: 300, poItem: po.items[0] }, { total: -400, poItem: po.items[1] }, { total: 200 }], subtotal: 100, total: 115 });
    expect((await billedCentsByPo(f.co, [po.po])).get(po.po) ?? 0).toBe(0);
    expect(await committed(po, [f.acc.opex])).toEqual([50000, 0]);
    expect(await committed(po, [f.acc.travel])).toEqual([0, 50000]);
    expect(await committed(po, [f.acc.opex, f.acc.travel])).toEqual([50000, 50000]);
  });
});

describe('M2: fully billed against max(header subtotal, lines\' total)', () => {
  it('a PO of header subtotal 0 and a R100 line, closed by its R100 bill: cancelling the bill reopens it and it commits R100', async () => {
    const po = await seedPo(pool, f, { lines: [100] });
    await pool.query('UPDATE purchase_orders SET subtotal = 0, total = 0 WHERE id = $1', [po.po]);
    const h = await approvedBill(100);
    await closedBy(po, [h]);
    expect([await status(po), await committed(po)]).toEqual([{ status: 'closed', closed_by_billing: true }, [0]]);
    const r = await callTool(pool, f, cancelBill, { invoice_id: h.id });
    expect(r.isError, r.text).toBe(false);
    expect([await status(po), await committed(po)]).toEqual([{ status: 'approved', closed_by_billing: false }, [10000]]);
  });
});

describe('L1: the settled verdict counts the bills readCommitments nets as own', () => {
  it('A billed R800 by lines and a DRAFT R200 header bill passed as already billed: fully billed, so 0', async () => {
    const po = await seedPo(pool, f, { lines: [500, 500] });
    await seedRawBill(pool, f, { items: [{ total: 800, poItem: po.items[0] }], subtotal: 800, total: 920 });
    const c = await seedRawBill(pool, f, { items: [{ total: 200 }], subtotal: 200, total: 230 });
    await closedBy(po, [c]);
    await pool.query(`UPDATE supplier_invoices SET status = 'draft' WHERE id = $1`, [c.id]); // under-billed now: 800 of 1000
    const d = await seedRawBill(pool, f, { items: [{ total: 200 }], subtotal: 200, total: 230, header: po.po, status: 'draft' });
    expect(await committed(po)).toEqual([0, 50000]);
    expect(await committed(po, [f.acc.opex], { alsoBilledInvoiceIds: [d.id] })).toEqual([0, 0]);
    expect(await committed(po, [f.acc.opex], { excludeInvoiceId: d.id })).toEqual([0, 0]);
  });
});

describe('L5: the dry run says what the cancel does', () => {
  it.each([
    ['the bill alone keeps the PO closed', 1],
    ['another bill keeps it fully billed', 2],
  ] as const)('%s: would_reopen_purchase_orders equals reopened_purchase_orders', async (_label, n) => {
    const po = await seedPo(pool, f, { lines: [1000] });
    const bills = [];
    for (let i = 0; i < n; i++) bills.push(await approvedBill(1000));
    await closedBy(po, bills);
    const dry = await callTool(pool, f, cancelBill, { invoice_id: bills[0]!.id, dry_run: true });
    const real = await callTool(pool, f, cancelBill, { invoice_id: bills[0]!.id });
    expect([dry.isError, real.isError], `${dry.text} ${real.text}`).toEqual([false, false]);
    expect(dry.body.would_reopen_purchase_orders).toEqual(real.body.reopened_purchase_orders);
    expect((real.body.reopened_purchase_orders as unknown[]).length).toBe(n === 1 ? 1 : 0);
  });
});
