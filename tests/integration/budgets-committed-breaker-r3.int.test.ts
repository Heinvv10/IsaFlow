/**
 * PR #1703, ledger breaker round 3 (ported from its zz-breaker3 repros at 1fe0abb779), real PostgreSQL 16:
 *   R3-1  a header tie spreads over each PO line's room left after its line billing (a fully billed PO commits 0);
 *   R3-2  named limit: a lines tie may net more than the bill's subtotal when other lines are negative (line netting "wherever it
 *         posted"); recorded, not asserted against;
 *   R3-3  unlinking ANY tie (link, header, lines) reopens a PO a link call closed once it is no longer fully billed, with a warning;
 *   R3-4  a link never takes a header tie's rands: refused, naming the header's PO, dry run too;
 *   R3-5  a bill's links and lines never net more than its subtotal, across calls and within one;
 *   R3-6  get_purchase_order and the link reply agree.
 * Fixture route: isaflow_schema_fixture (assertDisposable). Never skips.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { dropBillFixture, seedBillFixture, setPolicy, type BillFixture } from './helpers/budgetBillFixture';
import { callTool } from './helpers/poImportHarness';
import { linkRows, poStatus, seedPo, seedRawBill, type SeededPo } from './helpers/poBillLinkHarness';
import { linkBillsToPurchaseOrderTool as link } from '@/lib/mcp/tools/writeLinkBillsToPurchaseOrder';
import { unlinkBillFromPurchaseOrderTool as unlink } from '@/lib/mcp/tools/writeUnlinkBillFromPurchaseOrder';
import { getPurchaseOrderTool as getPo } from '@/lib/mcp/tools/getPurchaseOrder';
import { readCommitments } from '@/modules/accounting/services/budgets/remainingCommitted';
import { openPoLineCents } from '@/modules/accounting/services/budgets/remainingBudgetCore';
import { billedCentsByPo } from '@/modules/accounting/services/ap/purchaseOrderBilled';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
let f: BillFixture;

beforeAll(async () => {
  f = await seedBillFixture(pool, 'zz-breaker3');
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

describe('R3-1 header spread ignores line billing on the same PO', () => {
  it('PO A+B, bill 1 lines-billed A, bill 2 header-billed (link, no lines) the rest: fully billed, but committed still holds R250', async () => {
    const po = await seedPo(pool, f, { lines: [500, 500] });
    const b1 = await seedRawBill(pool, f, { items: [{ total: 500 }], subtotal: 500, total: 575 });
    const r1 = await callTool(pool, f, link, { links: [{ po_id: po.po, bill_id: b1.id, lines: [{ po_item_id: po.items[0], bill_line_id: b1.lines[0] }] }] });
    expect(r1.isError, r1.text).toBe(false);
    const b2 = await seedRawBill(pool, f, { items: [{ total: 500 }], subtotal: 500, total: 575 });
    const r2 = await callTool(pool, f, link, { links: [{ po_id: po.po, bill_id: b2.id }] });
    expect(r2.isError, r2.text).toBe(false);
    const open = await openOf(po);
    expect(await billed(po)).toBe(100000);
    // Invariant: billed reaches the subtotal, so committed must be 0.
    expect(sum(open)).toBe(0);
  });
});

describe('R3-2 lines tie larger than the bill subtotal', () => {
  it('R1200 line naming PO X, a R-400 unnamed line, subtotal R800: the bill nets more than R800 across its POs', async () => {
    const x = await seedPo(pool, f, { lines: [1200] });
    const z = await seedPo(pool, f, { lines: [1000] });
    await seedRawBill(pool, f, { items: [{ total: 1200, poItem: x.items[0] }, { total: -400 }], subtotal: 800, total: 920, header: z.po });
    const openX = await openOf(x); const openZ = await openOf(z);
    const netted = (120000 - sum(openX)) + (100000 - sum(openZ));
    // Named limit R3-2 (billAttribution header): X's line posted R1200 to its account, so X nets R1200; Z nets 0.
    expect([netted, await billed(z)]).toEqual([120000, 0]);
  });
});

describe('R3-3 unlinking a header-only bill from a PO a link call closed', () => {
  it('leaves the PO closed under-billed: it neither reopens nor commits', async () => {
    const po = await seedPo(pool, f, { lines: [1000] });
    // B1 names the PO only in its header (no link row: e.g. written while the PO was a draft, or a legacy bill the backfill skipped).
    const b1 = await seedRawBill(pool, f, { items: [{ total: 600 }], subtotal: 600, total: 690, header: po.po });
    const b2 = await seedRawBill(pool, f, { items: [{ total: 400 }], subtotal: 400, total: 460 });
    const r = await callTool(pool, f, link, { links: [{ po_id: po.po, bill_id: b2.id }], close_when_fully_billed: true });
    expect(r.isError, r.text).toBe(false);
    const statusClosed = await poStatus(pool, po.po);
    const u = await callTool(pool, f, unlink, { po_id: po.po, bill_id: b1.id, reason: 'wrong PO' });
    expect(u.isError, u.text).toBe(false);
    const after = await poStatus(pool, po.po);
    expect(statusClosed).toBe('closed');
    // Invariant: a PO closed as fully billed that is no longer fully billed reopens (as unlinking a LINK does), so the R600 commits again.
    expect([after, u.body.reopened_to, await openOf(po)]).toEqual(['approved', 'approved', [60000]]);
  });
  it('same with a lines-only tie (no link row)', async () => {
    const po = await seedPo(pool, f, { lines: [600, 400] });
    const b1 = await seedRawBill(pool, f, { items: [{ total: 600, poItem: po.items[0] }], subtotal: 600, total: 690 });
    const b2 = await seedRawBill(pool, f, { items: [{ total: 400 }], subtotal: 400, total: 460 });
    const r = await callTool(pool, f, link, { links: [{ po_id: po.po, bill_id: b2.id, lines: [{ po_item_id: po.items[1], bill_line_id: b2.lines[0] }] }], close_when_fully_billed: true });
    expect(r.isError, r.text).toBe(false);
    const statusClosed = await poStatus(pool, po.po);
    const u = await callTool(pool, f, unlink, { po_id: po.po, bill_id: b1.id, reason: 'wrong PO' });
    expect(u.isError, u.text).toBe(false);
    const after = await poStatus(pool, po.po);
    expect(statusClosed).toBe('closed');
    expect([after, u.body.reopened_to]).toEqual(['approved', 'approved']);
  });
});

describe('R3-4 (ruled again in round 4) a link without an amount never silently takes a header tie\'s rands', () => {
  it('bill header-nets P2; linking it to P1 with no amount is refused, dry run too; an explicit amount takes it, warned', async () => {
    const p1 = await seedPo(pool, f, { lines: [1000] });
    const p2 = await seedPo(pool, f, { lines: [1000] });
    const b = await seedRawBill(pool, f, { items: [{ total: 1000 }], subtotal: 1000, total: 1150, header: p2.po });
    const before = { p1: await openOf(p1), p2: await openOf(p2) };
    const want = `the bill's header names purchase order ${p2.number}; give an amount or unlink it first`;
    for (const dry_run of [false, true]) {
      const r = await callTool(pool, f, link, { links: [{ po_id: p1.po, bill_id: b.id }], dry_run });
      expect([r.isError, r.text.includes(want)]).toEqual([true, true]);
    }
    expect({ p1: await openOf(p1), p2: await openOf(p2) }).toEqual(before);
    expect(await linkRows(pool, f, `l.supplier_invoice_id = '${b.id}'`)).toEqual([]);
    const explicit = await callTool(pool, f, link, { links: [{ po_id: p1.po, bill_id: b.id, amount: 100 }] });
    expect(explicit.isError, explicit.text).toBe(false);
    expect((explicit.body.budget_warnings as string[]).join(' ')).toContain(`header names purchase order ${p2.number}`);
    expect({ p1: await openOf(p1), p2: await openOf(p2) }).toEqual({ p1: [90000], p2: [10000] });
  });
});

describe('R3-5 multiple POs, links + lines on the same PO, a PO of another supplier', () => {
  it('a bill with a link to PO Y and lines on PO X plus a link row on X: total netted <= subtotal', async () => {
    const x = await seedPo(pool, f, { lines: [700] });
    const y = await seedPo(pool, f, { lines: [1000] });
    const b = await seedRawBill(pool, f, { items: [{ total: 700 }, { total: 300 }], subtotal: 1000, total: 1150 });
    const r1 = await callTool(pool, f, link, { links: [{ po_id: y.po, bill_id: b.id, amount: 300 }] });
    expect(r1.isError, r1.text).toBe(false);
    const r2 = await callTool(pool, f, link, { links: [{ po_id: x.po, bill_id: b.id, lines: [{ po_item_id: x.items[0], bill_line_id: b.lines[0] }] }] });
    expect(r2.isError, r2.text).toBe(false);
    expect([await openOf(x), await openOf(y)]).toEqual([[0], [70000]]); // R700 + R300 netted: the subtotal, once
  });
  it('the reverse order: lines on X first (R700), then Y with no amount, then repeat X lines with amount equal', async () => {
    const x = await seedPo(pool, f, { lines: [700] });
    const y = await seedPo(pool, f, { lines: [1000] });
    const b = await seedRawBill(pool, f, { items: [{ total: 700 }, { total: 300 }], subtotal: 1000, total: 1150 });
    const r1 = await callTool(pool, f, link, { links: [{ po_id: x.po, bill_id: b.id, lines: [{ po_item_id: x.items[0], bill_line_id: b.lines[0] }] }] });
    expect(r1.isError, r1.text).toBe(false);
    const r2 = await callTool(pool, f, link, { links: [{ po_id: y.po, bill_id: b.id, lines: [{ po_item_id: y.items[0], bill_line_id: b.lines[1] }] }] });
    expect(r2.isError, r2.text).toBe(false);
    expect([await openOf(x), await openOf(y)]).toEqual([[0], [70000]]);
  });
  it('in ONE call: X by lines and Y with no amount, Y planned before X', async () => {
    const x = await seedPo(pool, f, { lines: [700] });
    const y = await seedPo(pool, f, { lines: [1000] });
    const b = await seedRawBill(pool, f, { items: [{ total: 700 }, { total: 300 }], subtotal: 1000, total: 1150 });
    const r = await callTool(pool, f, link, { links: [
      { po_id: y.po, bill_id: b.id },
      { po_id: x.po, bill_id: b.id, lines: [{ po_item_id: x.items[0], bill_line_id: b.lines[0] }] },
    ] });
    // Y's default takes the whole R1000 first, so X's R700 of lines would pass the subtotal: refused, nothing written.
    expect([r.isError, r.text.includes('more would pass it')]).toEqual([true, true]);
    expect([await openOf(x), await openOf(y)]).toEqual([[70000], [100000]]);
  });
});

describe('R3-6 follow-ups', () => {
  it('R3-3 detail: closed_under_billed flags it; committed for the PO after the unlink', async () => {
    const po = await seedPo(pool, f, { lines: [1000] });
    const b1 = await seedRawBill(pool, f, { items: [{ total: 600 }], subtotal: 600, total: 690, header: po.po });
    const b2 = await seedRawBill(pool, f, { items: [{ total: 400 }], subtotal: 400, total: 460 });
    await callTool(pool, f, link, { links: [{ po_id: po.po, bill_id: b2.id }], close_when_fully_billed: true });
    await callTool(pool, f, unlink, { po_id: po.po, bill_id: b1.id, reason: 'wrong PO' });
    const det = await callTool(pool, f, getPo, { po_id: po.po });
    const j = JSON.parse(det.text);
    expect([j.purchase_order.status, j.closed_under_billed, await openOf(po)]).toEqual(['approved', false, [60000]]);
  });
  it('lines-only tie: the link call\'s fully_billed / close decision vs get_purchase_order', async () => {
    const po = await seedPo(pool, f, { lines: [600, 400] });
    await seedRawBill(pool, f, { items: [{ total: 600, poItem: po.items[0] }], subtotal: 600, total: 690 });
    const b2 = await seedRawBill(pool, f, { items: [{ total: 400 }], subtotal: 400, total: 460 });
    const r = await callTool(pool, f, link, { links: [{ po_id: po.po, bill_id: b2.id, lines: [{ po_item_id: po.items[1], bill_line_id: b2.lines[0] }] }], close_when_fully_billed: true });
    const rj = JSON.parse(r.text);
    const det = JSON.parse((await callTool(pool, f, getPo, { po_id: po.po })).text);
    expect(rj.purchase_orders[0].fully_billed).toBe(det.fully_billed);
  });
});
