/**
 * unlink_bill_from_purchase_order and the budget (design docs/design/mcp-po-bill-links.md,
 * migration 1006), real PostgreSQL, every call as app_user (poImportHarness):
 *   - unlink restores: link gone, line links cleared, header reset, PO reopened to the status a link closed it from (R1: only
 *     while it is no longer fully billed; the closing record moves to another link while it still is; a PO closed by hand stays);
 *   - a bill cancelled after the close does NOT reopen the PO; get_purchase_order says closed_under_billed;
 *   - R2: an unlink that makes the PO commit again never blocks, even under the block policy, and returns budget_warning;
 *   - unlink across companies (by po_id and by po_number) and of an unknown PO changes nothing;
 *   - line links on bills that really carry journals write no journal; line links reduce committed, header-only ones do not.
 * Fixture route: isaflow_schema_fixture (assertDisposable). Never skips.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { dropBillFixture, seedBillFixture, setPolicy, type BillFixture } from './helpers/budgetBillFixture';
import { asOwner, callTool } from './helpers/poImportHarness';
import { approveBill, billHeader, ledgerSnapshot, lineLinks, linkRows, poStatus, seedBill, seedPo } from './helpers/poBillLinkHarness';
import { linkBillsToPurchaseOrderTool as link } from '@/lib/mcp/tools/writeLinkBillsToPurchaseOrder';
import { unlinkBillFromPurchaseOrderTool as unlink } from '@/lib/mcp/tools/writeUnlinkBillFromPurchaseOrder';
import { getPurchaseOrderTool as getPo } from '@/lib/mcp/tools/getPurchaseOrder';
import { readCommitments } from '@/modules/accounting/services/budgets/remainingCommitted';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
let f: BillFixture;
let other: BillFixture;

beforeAll(async () => {
  f = await seedBillFixture(pool, 'po-links-flows');
  other = await seedBillFixture(pool, 'po-links-flows-other');
  await setPolicy(pool, f, 'warn');
}, 60_000);
afterAll(async () => {
  try {
    for (const x of [f, other]) await dropBillFixture(pool, x);
  } finally {
    await pool.end();
  }
}, 60_000);

describe('unlink', () => {
  it('restores the link, the lines, the header and the PO status', async () => {
    const po = await seedPo(pool, f, { lines: [100, 200], status: 'received' });
    const bill = await seedBill(pool, f, { lines: [100, 200] });
    const done = await callTool(pool, f, link, {
      links: [{ po_id: po.po, bill_id: bill.id, lines: [{ po_item_id: po.items[0], bill_line_id: bill.lines[0] }, { po_item_id: po.items[1], bill_line_id: bill.lines[1] }] }],
      close_when_fully_billed: true,
    });
    expect(done.isError, done.text).toBe(false);
    expect(await poStatus(pool, po.po)).toBe('closed');
    expect(await lineLinks(pool, bill.id)).toEqual(po.items);
    expect(await billHeader(pool, bill.id)).toBe(po.po);

    const noReason = await callTool(pool, f, unlink, { po_id: po.po, bill_id: bill.id, reason: '  ' });
    expect(noReason.text).toContain('reason is required');
    const dry = await callTool(pool, f, unlink, { po_id: po.po, bill_id: bill.id, reason: 'wrong PO', dry_run: true });
    expect(dry.body).toMatchObject({ dry_run: true, would_unlink: true, lines_cleared: 2, reopened_to: 'received', fully_billed: false });
    expect(dry.wroteNothing).toBe(true);
    expect(await linkRows(pool, f, `l.purchase_order_id = '${po.po}'`)).toHaveLength(1);

    const r = await callTool(pool, f, unlink, { po_number: po.number, bill_id: bill.id, reason: 'wrong PO' });
    expect(r.isError, r.text).toBe(false);
    expect(r.body).toMatchObject({ unlinked: true, lines_cleared: 2, po_status_before: 'closed', po_status: 'received', reopened_to: 'received', billed: 0 });
    expect(await linkRows(pool, f, `l.purchase_order_id = '${po.po}'`)).toEqual([]);
    expect(await lineLinks(pool, bill.id)).toEqual([null, null]);
    expect(await billHeader(pool, bill.id)).toBeNull();
    expect(await poStatus(pool, po.po)).toBe('received');
    const audit = await pool.query(
      `SELECT changes FROM audit_log WHERE entity_id = $1 AND entity_type = 'purchase_order' ORDER BY created_at DESC, id LIMIT 1`, [po.po]);
    expect(audit.rows[0].changes).toMatchObject({ metadata: { reason: 'wrong PO', lines_cleared: '2' }, fields: [{ field: 'status', old: 'closed', new: 'received' }] });

    const again = await callTool(pool, f, unlink, { po_id: po.po, bill_id: bill.id, reason: 'again' });
    expect(again.text).toContain('is not linked to purchase order');
  });

  it('R1: reopens whichever link is removed once the PO is no longer fully billed, and clears the closing record', async () => {
    const po = await seedPo(pool, f, { lines: [100], status: 'approved' });
    const b1 = await seedBill(pool, f, { lines: [30] });
    const b2 = await seedBill(pool, f, { lines: [70] });
    await callTool(pool, f, link, { links: [{ po_id: po.po, bill_id: b1.id }] });
    await callTool(pool, f, link, { links: [{ po_id: po.po, bill_id: b2.id }], close_when_fully_billed: true });
    expect(await poStatus(pool, po.po)).toBe('closed');
    // b1's link did not hold the record (b2's did), yet removing it leaves 70 of 100 billed: the PO reopens.
    const r = await callTool(pool, f, unlink, { po_id: po.po, bill_id: b1.id, reason: 'not this one' });
    expect(r.body).toMatchObject({ po_status: 'approved', reopened_to: 'approved', billed: 70, fully_billed: false });
    expect(await poStatus(pool, po.po)).toBe('approved');
    expect((await linkRows(pool, f, `l.purchase_order_id = '${po.po}'`)).map((l) => l.closed_po_from_status)).toEqual([null]);
  });

  it('the closing record moves to another link while the PO stays fully billed, so a later unlink still reopens it', async () => {
    const po = await seedPo(pool, f, { lines: [100], status: 'received' });
    const b1 = await seedBill(pool, f, { lines: [100] });
    const b2 = await seedBill(pool, f, { lines: [100] });
    await callTool(pool, f, link, { links: [{ po_id: po.po, bill_id: b1.id }] });
    await callTool(pool, f, link, { links: [{ po_id: po.po, bill_id: b2.id }], close_when_fully_billed: true });
    expect((await linkRows(pool, f, `l.purchase_order_id = '${po.po}'`)).map((l) => l.closed_po_from_status)).toEqual([null, 'received']);
    const first = await callTool(pool, f, unlink, { po_id: po.po, bill_id: b2.id, reason: 'dup' });
    expect(first.body).toMatchObject({ po_status: 'closed', reopened_to: null, fully_billed: true });
    expect((await linkRows(pool, f, `l.purchase_order_id = '${po.po}'`)).map((l) => [l.bill, l.closed_po_from_status])).toEqual([[b1.id, 'received']]);
    const second = await callTool(pool, f, unlink, { po_id: po.po, bill_id: b1.id, reason: 'gone' });
    expect(second.body).toMatchObject({ po_status: 'received', reopened_to: 'received' });
  });

  it('a PO closed by hand, or cancelled meanwhile, is not touched', async () => {
    const po = await seedPo(pool, f, { lines: [100], status: 'approved' });
    const b1 = await seedBill(pool, f, { lines: [100] });
    await callTool(pool, f, link, { links: [{ po_id: po.po, bill_id: b1.id }] });
    await pool.query("UPDATE purchase_orders SET status = 'closed' WHERE id = $1", [po.po]);
    const r = await callTool(pool, f, unlink, { po_id: po.po, bill_id: b1.id, reason: 'hand-closed' });
    expect(r.body).toMatchObject({ po_status: 'closed', reopened_to: null });
    const p2 = await seedPo(pool, f, { lines: [100], status: 'approved' });
    const b2 = await seedBill(pool, f, { lines: [100] });
    await callTool(pool, f, link, { links: [{ po_id: p2.po, bill_id: b2.id }], close_when_fully_billed: true });
    await pool.query("UPDATE purchase_orders SET status = 'cancelled' WHERE id = $1", [p2.po]);
    await callTool(pool, f, unlink, { po_id: p2.po, bill_id: b2.id, reason: 'cancelled meanwhile' });
    expect(await poStatus(pool, p2.po)).toBe('cancelled');
  });

  it('a bill cancelled after the close does not reopen the PO; get_purchase_order says closed_under_billed', async () => {
    const po = await seedPo(pool, f, { lines: [100], status: 'approved' });
    const bill = await seedBill(pool, f, { lines: [100] });
    await callTool(pool, f, link, { links: [{ po_id: po.po, bill_id: bill.id }], close_when_fully_billed: true });
    expect((await callTool(pool, f, getPo, { po_id: po.po })).body).toMatchObject({ fully_billed: true, closed_under_billed: false });
    await pool.query("UPDATE supplier_invoices SET status = 'cancelled' WHERE id = $1", [bill.id]);
    expect(await poStatus(pool, po.po)).toBe('closed');
    const r = await callTool(pool, f, getPo, { po_id: po.po });
    expect(r.body).toMatchObject({ billed_total: 0, fully_billed: false, closed_under_billed: true });
    expect((r.body.purchase_order as Json).status).toBe('closed');
    const byHand = await seedPo(pool, f, { lines: [100], status: 'closed' });
    expect((await callTool(pool, f, getPo, { po_id: byHand.po })).body).toMatchObject({ closed_under_billed: false });
  });

  it('R2: an unlink that makes the PO commit over budget never blocks, under block too; it returns budget_warning (none when the policy is off)', async () => {
    const mk = async (amount: number) => ({
      po: await seedPo(pool, f, { lines: [amount], date: '2026-06', cc1: f.cc.FT }),
      bill: await seedBill(pool, f, { lines: [amount] }),
    });
    const { po, bill } = await mk(900);
    const rival = await seedPo(pool, f, { lines: [900], date: '2026-06', cc1: f.cc.FT });
    expect(rival.po).toBeTruthy();
    const linked = await callTool(pool, f, link, { links: [{ po_id: po.po, bill_id: bill.id, lines: [{ po_item_id: po.items[0], bill_line_id: bill.lines[0] }] }] });
    expect(linked.isError, linked.text).toBe(false);
    await setPolicy(pool, f, 'block');
    try {
      const dry = await callTool(pool, f, unlink, { po_id: po.po, bill_id: bill.id, reason: 'redo', dry_run: true });
      expect(dry.isError, dry.text).toBe(false);
      expect(String(dry.body.budget_warning)).toMatch(/over budget/i);
      expect(await linkRows(pool, f, `l.purchase_order_id = '${po.po}'`)).toHaveLength(1);
      const r = await callTool(pool, f, unlink, { po_id: po.po, bill_id: bill.id, reason: 'redo' });
      expect(r.isError, r.text).toBe(false);
      expect(r.body).toMatchObject({ unlinked: true, lines_cleared: 1 });
      expect(String(r.body.budget_warning)).toMatch(/over budget/i);
      expect((r.body.budget_warnings as string[]).length).toBe(1);
      expect(await linkRows(pool, f, `l.purchase_order_id = '${po.po}'`)).toEqual([]);
      expect(await lineLinks(pool, bill.id)).toEqual([null]);
      await setPolicy(pool, f, 'off');
      const again = await seedBill(pool, f, { lines: [900] });
      await callTool(pool, f, link, { links: [{ po_id: po.po, bill_id: again.id, lines: [{ po_item_id: po.items[0], bill_line_id: again.lines[0] }] }] });
      const off = await callTool(pool, f, unlink, { po_id: po.po, bill_id: again.id, reason: 'policy off' });
      expect(off.body).toMatchObject({ unlinked: true, budget_warning: null, budget_warnings: [] });
    } finally {
      await setPolicy(pool, f, 'warn');
    }
  });

  it('unlink across companies (po_id and po_number) and of an unknown PO changes nothing', async () => {
    const po = await seedPo(pool, f, { lines: [100] });
    const bill = await seedBill(pool, f, { lines: [100] });
    await callTool(pool, f, link, { links: [{ po_id: po.po, bill_id: bill.id, lines: [{ po_item_id: po.items[0], bill_line_id: bill.lines[0] }] }], close_when_fully_billed: true });
    const before = { links: await linkRows(pool, f), status: await poStatus(pool, po.po), lines: await lineLinks(pool, bill.id), header: await billHeader(pool, bill.id) };
    for (const args of [{ po_id: po.po }, { po_number: po.number }]) {
      const r = await callTool(pool, other, unlink, { ...args, bill_id: bill.id, reason: 'not mine' });
      expect(r.isError).toBe(true);
      expect(r.text).toMatch(/not found$/);
    }
    const unknown = await callTool(pool, f, unlink, { po_id: crypto.randomUUID(), bill_id: bill.id, reason: 'nothing' });
    expect(unknown).toMatchObject({ isError: true, text: 'Purchase order not found' });
    const unknownNumber = await callTool(pool, f, unlink, { po_number: 'NOPE', bill_id: bill.id, reason: 'nothing' });
    expect(unknownNumber.text).toBe('Purchase order not found');
    expect({ links: await linkRows(pool, f), status: await poStatus(pool, po.po), lines: await lineLinks(pool, bill.id), header: await billHeader(pool, bill.id) }).toEqual(before);
  });
});

describe('budget committed', () => {
  it('line links reduce a PO line\'s committed amount; a header-only link does not', async () => {
    const po = await seedPo(pool, f, { lines: [400, 600], status: 'approved' });
    const bill = await seedBill(pool, f, { lines: [400] });
    const committed = async () => (await asOwner(pool, f, () => readCommitments(f.co, [f.acc.opex], '2026-06-01', '2026-06-30', { excludePoItemIds: [] })))
      .filter((c) => po.items.includes(c.poItemId))
      .reduce((s, c) => s + c.lineTotal - c.billed.reduce((x, p) => x + p.amount, 0), 0);
    expect(await committed()).toBe(1000);
    const headerOnly = await callTool(pool, f, link, { links: [{ po_id: po.po, bill_id: bill.id }] });
    expect(headerOnly.isError, headerOnly.text).toBe(false);
    expect(await committed()).toBe(1000);
    await callTool(pool, f, unlink, { po_id: po.po, bill_id: bill.id, reason: 'redo with lines' });
    const withLines = await callTool(pool, f, link, { links: [{ po_id: po.po, bill_id: bill.id, lines: [{ po_item_id: po.items[0], bill_line_id: bill.lines[0] }] }] });
    expect(withLines.isError, withLines.text).toBe(false);
    expect(await committed()).toBe(600);
    await callTool(pool, f, unlink, { po_id: po.po, bill_id: bill.id, reason: 'undo' });
    expect(await committed()).toBe(1000);
  });
});

describe('line links on bills that really have journals', () => {
  it('write no journal row and leave the bills\' figures alone', async () => {
    const po = await seedPo(pool, f, { lines: [100, 300] });
    const bills = [await seedBill(pool, f, { lines: [100], status: 'draft' }), await seedBill(pool, f, { lines: [300], status: 'draft' })];
    for (const b of bills) await approveBill(pool, f, b.id);
    const journalled = await pool.query('SELECT count(*)::INT AS n FROM supplier_invoices WHERE id = ANY($1::UUID[]) AND gl_journal_entry_id IS NOT NULL', [bills.map((b) => b.id)]);
    expect(journalled.rows[0].n).toBe(2);
    const before = await ledgerSnapshot(pool, f, bills.map((b) => b.id));
    const r = await callTool(pool, f, link, { links: bills.map((b, i) => ({ po_id: po.po, bill_id: b.id, lines: [{ po_item_id: po.items[i], bill_line_id: b.lines[0] }] })) });
    expect(r.isError, r.text).toBe(false);
    expect(await ledgerSnapshot(pool, f, bills.map((b) => b.id))).toEqual(before);
    expect(await lineLinks(pool, bills[1]!.id)).toEqual([po.items[1]]);
    await callTool(pool, f, unlink, { po_id: po.po, bill_id: bills[1]!.id, reason: 'undo' });
    expect(await ledgerSnapshot(pool, f, bills.map((b) => b.id))).toEqual(before);
  });
});

