/**
 * PR #1703, ledger breaker round 2 (ported from its zz-breaker-committed repros) and isaflow-c8's follow-ups, real PostgreSQL 16:
 * one rand of a bill is attributed to at most one PO, and every reader agrees on how much (`budgets/billAttribution`):
 *   BRK-A  an explicit amount beside lines is refused unless it is the lines' posted amount: one R1000 bill never releases more;
 *   BRK-B  a header fallback does not subtract a line-linked PO twice (its lines AND its link);
 *   BRK-C  lines that post R0 are refused (the link would say R500 billed while committed nets 0);
 *   BRK-E  a negative bill line naming a PO line never lifts it above its total, nor the header fallback past the subtotal;
 *   c8-1   billed (fully_billed, the close rule) and committed netting agree when a fallback is shared between two POs;
 *   c8-2   a stored link amount that disagrees with the lines naming its PO (written before BRK-A) is ignored by every reader;
 *   held   the app writer and the 1006 backfill do not subtract a line-named PO's link as well as its lines.
 * Fixture route: isaflow_schema_fixture (assertDisposable). Never skips.
 */
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { dropBillFixture, openRequest, seedBillFixture, setPolicy, type BillFixture } from './helpers/budgetBillFixture';
import { callTool } from './helpers/poImportHarness';
import { linkRows, seedPo, seedRawBill, type SeededPo } from './helpers/poBillLinkHarness';
import { linkBillsToPurchaseOrderTool as link } from '@/lib/mcp/tools/writeLinkBillsToPurchaseOrder';
import { unlinkBillFromPurchaseOrderTool as unlink } from '@/lib/mcp/tools/writeUnlinkBillFromPurchaseOrder';
import { getPurchaseOrderTool as getPo } from '@/lib/mcp/tools/getPurchaseOrder';
import { readCommitments } from '@/modules/accounting/services/budgets/remainingCommitted';
import { openPoLineCents } from '@/modules/accounting/services/budgets/remainingBudgetCore';
import { billedCentsByPo } from '@/modules/accounting/services/ap/purchaseOrderBilled';
import { recordBillLinks } from '@/modules/accounting/services/ap/billPurchaseOrderLinks';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
let f: BillFixture;

beforeAll(async () => {
  f = await seedBillFixture(pool, 'breaker-r2');
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
const mcpLink = (po: string, bill: string, amount: number) => pool.query(
  `INSERT INTO purchase_order_bill_links (company_id, purchase_order_id, supplier_invoice_id, amount, source) VALUES ($1, $2, $3, $4, 'mcp')`,
  [f.co, po, bill, amount]);

describe('BRK-A: one R1000 bill releases at most R1000', () => {
  it('refuses an explicit amount that is not the named lines\' posted amount, then nets X and Y once between them', async () => {
    const x = await seedPo(pool, f, { lines: [900] });
    const y = await seedPo(pool, f, { lines: [1000] });
    const bill = await seedRawBill(pool, f, { items: [{ total: 900 }, { total: 100 }], subtotal: 1000, total: 1150 });
    const lines = [{ po_item_id: x.items[0], bill_line_id: bill.lines[0] }];
    const bad = await callTool(pool, f, link, { links: [{ po_id: x.po, bill_id: bill.id, amount: 100, lines }] });
    expect(bad.isError).toBe(true);
    expect(bad.text).toContain('is not what the bill lines named for purchase order');
    const dry = await callTool(pool, f, link, { links: [{ po_id: x.po, bill_id: bill.id, amount: 100, lines }], dry_run: true });
    expect(dry.isError).toBe(true);
    expect(await linkRows(pool, f, `l.supplier_invoice_id = '${bill.id}'`)).toEqual([]);
    expect((await callTool(pool, f, link, { links: [{ po_id: x.po, bill_id: bill.id, lines }] })).isError).toBe(false);
    expect((await callTool(pool, f, link, { links: [{ po_id: y.po, bill_id: bill.id }] })).isError).toBe(false);
    expect((await linkRows(pool, f, `l.supplier_invoice_id = '${bill.id}'`)).map((l) => [l.po === x.po ? 'X' : 'Y', l.amount]).sort())
      .toEqual([['X', '900.00'], ['Y', '100.00']]);
    expect((90000 - sum(await openOf(x))) + (100000 - sum(await openOf(y)))).toBe(100000);
  });
});

describe('BRK-B: a header fallback subtracts a line-linked PO once', () => {
  it('the header names Z (no link row), its R600 line is linked to X: Z nets the other R400', async () => {
    const z = await seedPo(pool, f, { lines: [1000], status: 'draft' });
    const x = await seedPo(pool, f, { lines: [600] });
    const bill = await seedRawBill(pool, f, { items: [{ total: 600 }, { total: 400 }], subtotal: 1000, total: 1150, header: z.po });
    const r = await callTool(pool, f, link, { links: [{ po_id: x.po, bill_id: bill.id, lines: [{ po_item_id: x.items[0], bill_line_id: bill.lines[0] }] }] });
    expect(r.isError, r.text).toBe(false);
    await pool.query(`UPDATE purchase_orders SET status = 'approved' WHERE id = $1`, [z.po]);
    expect(await openOf(x)).toEqual([0]);
    expect(await openOf(z)).toEqual([60000]);
    expect([await billed(x), await billed(z)]).toEqual([60000, 40000]);
  });
});

describe('BRK-C: lines that post R0', () => {
  it('are refused, so the billing record and committed agree (nothing billed, all committed)', async () => {
    const x = await seedPo(pool, f, { lines: [500] });
    const bill = await seedRawBill(pool, f, { items: [{ total: 0 }, { total: 500 }], subtotal: 500, total: 575 });
    const r = await callTool(pool, f, link, { links: [{ po_id: x.po, bill_id: bill.id, lines: [{ po_item_id: x.items[0], bill_line_id: bill.lines[0] }] }] });
    expect(r.isError).toBe(true);
    expect(r.text).toContain('post 0.00');
    expect([await billed(x), await openOf(x)]).toEqual([0, [50000]]);
  });
});

describe('BRK-D: unlinking the line-linked PO of a bill whose header names another', () => {
  it('succeeds; X commits again and Z nets the whole bill', async () => {
    const z = await seedPo(pool, f, { lines: [1000], status: 'draft' });
    const x = await seedPo(pool, f, { lines: [600] });
    const bill = await seedRawBill(pool, f, { items: [{ total: 600 }, { total: 400 }], subtotal: 1000, total: 1150, header: z.po });
    await callTool(pool, f, link, { links: [{ po_id: x.po, bill_id: bill.id, lines: [{ po_item_id: x.items[0], bill_line_id: bill.lines[0] }] }] });
    await pool.query(`UPDATE purchase_orders SET status = 'approved' WHERE id = $1`, [z.po]);
    const u = await callTool(pool, f, unlink, { po_id: x.po, bill_id: bill.id, reason: 'wrong PO' });
    expect(u.isError, u.text).toBe(false);
    expect([await openOf(x), await openOf(z)]).toEqual([[60000], [0]]);
  });
});

describe('BRK-E: a negative bill line naming a PO line', () => {
  it('never lifts that line above its total, and the header fallback never passes the subtotal', async () => {
    const y = await seedPo(pool, f, { lines: [500] });
    const z = await seedPo(pool, f, { lines: [2000] });
    await seedRawBill(pool, f, { items: [{ total: 1200 }, { total: -200, poItem: y.items[0] }], subtotal: 1000, total: 1150, header: z.po });
    expect(await openOf(y)).toEqual([50000]);
    expect(await openOf(z)).toEqual([100000]);
  });

  it('a negative line does not shrink what the bill attributes to its other POs (positive lines only)', async () => {
    const a = await seedPo(pool, f, { lines: [300] });
    const b = await seedPo(pool, f, { lines: [500] });
    const z = await seedPo(pool, f, { lines: [2000] });
    // R1000 bill: R300 on A, a R-200 line naming B, R900 unnamed, header Z: Z nets 1000 - 300 = 700 (not 1000 - 300 + 200).
    await seedRawBill(pool, f, { items: [{ total: 300, poItem: a.items[0] }, { total: -200, poItem: b.items[0] }, { total: 900 }],
      subtotal: 1000, total: 1150, header: z.po });
    expect(await openOf(z)).toEqual([130000]);
  });
});

describe('c8: one attribution for billed and committed', () => {
  it('a fallback shared between two POs: fully_billed on each agrees with what committed nets', async () => {
    const a = await seedPo(pool, f, { lines: [400] });
    const b = await seedPo(pool, f, { lines: [600] });
    await seedRawBill(pool, f, { items: [{ total: 400, poItem: a.items[0] }, { total: 600 }], subtotal: 1000, total: 1150, header: b.po });
    expect([await openOf(a), await openOf(b)]).toEqual([[0], [0]]);
    expect([await billed(a), await billed(b)]).toEqual([40000, 60000]);
    for (const po of [a, b]) expect((await callTool(pool, f, getPo, { po_id: po.po })).body).toMatchObject({ fully_billed: true });
  });

  it('a stored link amount the lines naming its PO disagree with is ignored by every reader (no data fix needed)', async () => {
    const x = await seedPo(pool, f, { lines: [900] });
    const y = await seedPo(pool, f, { lines: [1000] });
    const bill = await seedRawBill(pool, f, { items: [{ total: 900, poItem: x.items[0] }, { total: 100 }], subtotal: 1000, total: 1150 });
    await mcpLink(x.po, bill.id, 100); // the BRK-A shape, written before the refusal existed
    expect(await billed(x)).toBe(90000);
    expect(await openOf(x)).toEqual([0]);
    const r = await callTool(pool, f, link, { links: [{ po_id: y.po, bill_id: bill.id }] });
    expect(r.isError, r.text).toBe(false);
    expect((await linkRows(pool, f, `l.supplier_invoice_id = '${bill.id}' AND l.purchase_order_id = '${y.po}'`)).map((l) => l.amount)).toEqual(['100.00']);
    expect(await openOf(y)).toEqual([90000]);
  });
});

describe('c8: the link tool\'s close decision reads a stale link as its lines', () => {
  it('a PO fully billed by lines (its stored link says less) closes when the last bill is linked with close_when_fully_billed', async () => {
    const x = await seedPo(pool, f, { lines: [900, 100] });
    const first = await seedRawBill(pool, f, { items: [{ total: 900, poItem: x.items[0] }], subtotal: 900, total: 1035 });
    await mcpLink(x.po, first.id, 100); // stored R100, its lines R900
    const last = await seedRawBill(pool, f, { items: [{ total: 100 }], subtotal: 100, total: 115 });
    const r = await callTool(pool, f, link, { links: [{ po_id: x.po, bill_id: last.id }], close_when_fully_billed: true });
    expect(r.isError, r.text).toBe(false);
    expect((await pool.query('SELECT status FROM purchase_orders WHERE id = $1', [x.po])).rows[0].status).toBe('closed');
  });
});

describe('the writers of ref-less links subtract a line-named PO once', () => {
  const shape = async () => {
    const x = await seedPo(pool, f, { lines: [300] });
    const z = await seedPo(pool, f, { lines: [1000] });
    const bill = await seedRawBill(pool, f, { items: [{ total: 300, poItem: x.items[0] }, { total: 700 }], subtotal: 1000, total: 1150, header: z.po, status: 'draft' });
    await mcpLink(x.po, bill.id, 300);
    return { x, z, bill };
  };
  const zLink = async (bill: string, z: string) =>
    (await linkRows(pool, f, `l.supplier_invoice_id = '${bill}' AND l.purchase_order_id = '${z}'`)).map((l) => l.amount);

  it('the app writer (recordBillLinks) links Z at 700, not 400', async () => {
    const { z, bill } = await shape();
    const req = await openRequest(pool, f, f.owner);
    try { await req.run(() => recordBillLinks(f.co, bill.id, f.owner)); await req.commit(); } catch (e) { await req.rollback(); throw e; }
    expect(await zLink(bill.id, z.po)).toEqual(['700.00']);
  });

  it('the 1006 backfill (as 1022 redefines it) links Z at 700, not 400', async () => {
    const { z, bill } = await shape();
    // The definition in the 1022 file, not whatever an earlier suite left in this database.
    const file = readFileSync('scripts/migrations/sql/1022_retire_supplier_purchase_orders.sql', 'utf8');
    await pool.query(file.slice(file.indexOf('CREATE OR REPLACE FUNCTION public.purchase_order_bill_links_backfill'), file.indexOf('-- ── 1c.')));
    await pool.query('SELECT purchase_order_bill_links_backfill($1)', [f.co]);
    expect(await zLink(bill.id, z.po)).toEqual(['700.00']);
  });
});
