/**
 * Committed spend nets HEADER billing (Hein's ruling on PR #1703; isaflow-c8's six requirements), real PostgreSQL 16 and the
 * real budgets/remainingCommitted.readCommitments. A bill ties a PO by its lines (po_item_id) or by its header
 * (purchase_order_bill_links row, or supplier_invoices.purchase_order_id). Decided once per bill and PO: a bill with ANY line
 * naming a line of that PO nets it by lines only; otherwise it nets the PO by its link row's amount (its ex-VAT share on that
 * PO), or by its ex-VAT subtotal when only its header names the PO, spread over the PO's lines by line_total share in cents,
 * the residual on the last line. Same bill statuses as line netting (approved / paid / partially_paid), and the bill must be
 * the PO's company AND supplier. Fixture route: isaflow_schema_fixture (assertDisposable). Never skips.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { dropBillFixture, seedBillFixture, setPolicy, type BillFixture } from './helpers/budgetBillFixture';
import { seedPo, seedRawBill, seedSupplier, type SeededPo } from './helpers/poBillLinkHarness';
import { readCommitments } from '@/modules/accounting/services/budgets/remainingCommitted';
import { openPoLineCents } from '@/modules/accounting/services/budgets/remainingBudgetCore';
import { previewPurchaseOrderBudget } from '@/modules/accounting/services/ap/purchaseOrderBudget';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
let f: BillFixture;
let other: BillFixture;

beforeAll(async () => {
  f = await seedBillFixture(pool, 'committed-header');
  other = await seedBillFixture(pool, 'committed-header-other');
}, 60_000);
afterAll(async () => {
  try { for (const x of [f, other]) await dropBillFixture(pool, x); } finally { await pool.end(); }
}, 60_000);

/** Open cents per line of the PO, in its line order (readCommitments over the PO's month). */
const openOf = async (po: SeededPo, opts: { excludeInvoiceId?: string } = {}) => {
  const rows = await readCommitments(f.co, [f.acc.opex], '2026-06-01', '2026-06-30', opts);
  return po.items.map((id) => { const r = rows.find((x) => x.poItemId === id); return r ? openPoLineCents(r.lineTotal, r.billed) : null; });
};
const link = (po: string, bill: string, amount: number, source = 'mcp') => pool.query(
  `INSERT INTO purchase_order_bill_links (company_id, purchase_order_id, supplier_invoice_id, amount, source) VALUES ($1, $2, $3, $4, $5)`,
  [f.co, po, bill, amount, source]);
const headerBill = (po: string | null, total: number, o: { status?: string; supplier?: string; items?: Array<{ total: number; poItem?: string }> } = {}) =>
  seedRawBill(pool, f, { items: o.items ?? [{ total }], subtotal: total, total: Math.round(total * 115) / 100, header: po, status: o.status, supplier: o.supplier });

describe('a header-only bill nets the PO pro rata', () => {
  it('nets its subtotal over the lines by line_total share', async () => {
    const po = await seedPo(pool, f, { lines: [100, 200, 700] });
    await headerBill(po.po, 300);
    expect(await openOf(po)).toEqual([7000, 14000, 49000]);
  });

  it('puts the rounding residual on the last line', async () => {
    const po = await seedPo(pool, f, { lines: [100, 100, 100] });
    await headerBill(po.po, 100);
    expect(await openOf(po)).toEqual([6667, 6667, 6666]);
  });

  it('a fully billed PO commits nothing; an over-billed one floors at 0', async () => {
    const full = await seedPo(pool, f, { lines: [400, 600] });
    await headerBill(full.po, 1000);
    expect(await openOf(full)).toEqual([0, 0]);
    const over = await seedPo(pool, f, { lines: [400, 600] });
    await headerBill(over.po, 1500, { status: 'paid' });
    expect(await openOf(over)).toEqual([0, 0]);
  });

  it('a draft or cancelled header bill nets nothing; the bill being checked (excludeInvoiceId) does', async () => {
    const po = await seedPo(pool, f, { lines: [1000] });
    const draft = await headerBill(po.po, 300, { status: 'draft' });
    await headerBill(po.po, 200, { status: 'cancelled' });
    expect(await openOf(po)).toEqual([100000]);
    expect(await openOf(po, { excludeInvoiceId: draft.id })).toEqual([70000]);
  });

  it('another supplier\'s bill, another company\'s bill and a soft-deleted bill net nothing', async () => {
    const po = await seedPo(pool, f, { lines: [1000] });
    const gone = await headerBill(po.po, 300);
    await pool.query('UPDATE supplier_invoices SET deleted_at = now() WHERE id = $1', [gone.id]);
    await headerBill(po.po, 300, { supplier: await seedSupplier(pool, f, 'Header stranger') });
    await seedRawBill(pool, other, { items: [{ total: 300 }], subtotal: 300, total: 345, header: po.po, supplier: f.supplier });
    expect(await openOf(po)).toEqual([100000]);
  });
});

describe('the link row settles the amount, and each bill nets each PO once', () => {
  it('a bill split across two POs nets each by its own link amount, never by the bill total', async () => {
    const a = await seedPo(pool, f, { lines: [1000] });
    const b = await seedPo(pool, f, { lines: [1000] });
    const bill = await headerBill(a.po, 500);
    await link(a.po, bill.id, 200);
    await link(b.po, bill.id, 300);
    expect(await openOf(a)).toEqual([80000]);
    expect(await openOf(b)).toEqual([70000]);
  });

  it('a bill with a line link AND a header link to the same PO nets once, by its lines', async () => {
    const po = await seedPo(pool, f, { lines: [100, 100] });
    const bill = await headerBill(po.po, 100, { items: [{ total: 100, poItem: po.items[0] }] });
    await link(po.po, bill.id, 100);
    expect(await openOf(po)).toEqual([0, 10000]);
  });

  it('a bill whose lines name PO A while its header names PO B nets A by lines and B by header, never the same rand twice', async () => {
    const a = await seedPo(pool, f, { lines: [500] });
    const b = await seedPo(pool, f, { lines: [500] });
    // R200 bill: its R120 line names A's line, its R80 line names nothing, its header names B. A nets 120; B nets what the
    // lines do not attribute elsewhere, 200 - 120 = 80 (no link row: the header's amount is the subtotal less the rest).
    await headerBill(b.po, 200, { items: [{ total: 120, poItem: a.items[0] }, { total: 80 }] });
    expect(await openOf(a)).toEqual([38000]);
    expect(await openOf(b)).toEqual([42000]);
  });

  it('a header-only PO nets what the bill\'s lines and links have not already attributed elsewhere, each rand once', async () => {
    // Review M2: R1000 bill, R400 of lines on A AND an app link of 400 on A (the same 400), header on B with no link: B nets 600.
    const a = await seedPo(pool, f, { lines: [1000] });
    const b = await seedPo(pool, f, { lines: [1000] });
    const bill = await headerBill(b.po, 1000, { items: [{ total: 400, poItem: a.items[0] }, { total: 600 }] });
    await link(a.po, bill.id, 400, 'app');
    expect(await openOf(a)).toEqual([60000]);
    expect(await openOf(b)).toEqual([40000]);
    // A disagreeing link on A (an mcp link of 700, the pre-BRK-A shape) changes nothing: A's lines name it, so A holds their
    // R400 (one rand to one PO: lines when lines name the PO, else its link); B still nets 600.
    await pool.query('DELETE FROM purchase_order_bill_links WHERE supplier_invoice_id = $1', [bill.id]);
    await link(a.po, bill.id, 700);
    expect(await openOf(a)).toEqual([60000]);
    expect(await openOf(b)).toEqual([40000]);
  });

  it('a new canonical PO with a header-only bill nets too (one rule for every PO)', async () => {
    const po = await seedPo(pool, f, { lines: [250, 250] });
    const bill = await headerBill(po.po, 100);
    expect((await pool.query('SELECT purchase_order_bill_links_backfill($1) AS n', [f.co])).rows[0].n).not.toBeNull();
    // Linked or not, the same R100 nets: the link row (backfilled at the subtotal) replaces the header, it does not add to it.
    expect((await pool.query('SELECT amount::TEXT FROM purchase_order_bill_links WHERE supplier_invoice_id = $1', [bill.id])).rows).toEqual([{ amount: '100.00' }]);
    expect(await openOf(po)).toEqual([20000, 20000]);
  });
});

describe('the PO approval uses the same figure', () => {
  it('checks a PO line at its open amount, its header billing netted', async () => {
    await setPolicy(pool, f, 'warn');
    const po = await seedPo(pool, f, { lines: [1000], status: 'draft', cc1: f.cc.FT });
    await headerBill(po.po, 300);
    expect((await previewPurchaseOrderBudget(f.co, po.po))!.lines.map((l) => l.amount)).toEqual([700]);
  });
});
