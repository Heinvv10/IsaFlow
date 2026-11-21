/**
 * update_purchase_order (docs/design/mcp-po-maintenance.md, decision 1), real PostgreSQL, every call as app_user (poImportHarness):
 *   - a draft and a submitted PO are edited: header fields, lines REPLACED, totals recomputed from the lines, expected_totals to
 *     the cent, audit row, nothing in the ledger; omitted header fields stay, null clears;
 *   - item_code / item_id lines take the item's purchases account and VAT type; an unknown code is refused;
 *   - refused: a PO with a goods receipt, with a bill link, with a bill line naming one of its lines, with a bill naming it by header;
 *     partially_received / closed / cancelled by status; a foreign supplier is "Not found".
 * The approved-PO budget behaviour and the dry run are in mcp-po-maintenance-update-approved.int.test.ts.
 * Fixture route: isaflow_schema_fixture (assertDisposable). Never skips.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { dropBillFixture, seedBillFixture, setPolicy, type BillFixture } from './helpers/budgetBillFixture';
import { linkRows, seedBill, seedPo, seedSupplier } from './helpers/poBillLinkHarness';
import { auditOf, callTool, dropMaintExtras, glCount, poLines, poRow, seedGrn, seedItem, seedQtyPo } from './helpers/poMaintHarness';
import { updatePurchaseOrderTool as update } from '@/lib/mcp/tools/writeUpdatePurchaseOrder';
import { linkBillsToPurchaseOrderTool as link } from '@/lib/mcp/tools/writeLinkBillsToPurchaseOrder';
import { unlinkBillFromPurchaseOrderTool as unlink } from '@/lib/mcp/tools/writeUnlinkBillFromPurchaseOrder';
import { cancelPurchaseOrderTool as cancel } from '@/lib/mcp/tools/writeCancelPurchaseOrder';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
let f: BillFixture;
let other: BillFixture;

beforeAll(async () => {
  f = await seedBillFixture(pool, 'po-maint-update');
  other = await seedBillFixture(pool, 'po-maint-update-other');
  await setPolicy(pool, f, 'warn');
}, 60_000);
afterAll(async () => {
  try {
    for (const x of [f, other]) { await dropMaintExtras(pool, x); await dropBillFixture(pool, x); }
  } finally {
    await pool.end();
  }
}, 60_000);

const line = (o: Record<string, unknown> = {}) => ({ description: 'Cable', quantity: 2, unit_price: 50.5, tax_rate: 15, gl_account_id: f.acc.opex, ...o });

describe('a draft or submitted PO', () => {
  it.each(['draft', 'submitted'])('a %s PO: header and lines replaced, totals from the lines, audited, no ledger row', async (status) => {
    const po = await seedPo(pool, f, { status, lines: [100, 200] });
    const before = await glCount(pool, f);
    const r = await callTool(pool, f, update, {
      po_id: po.po, reference: 'REF-9', notes: 'rush', delivery_date: '2026-07-01', order_date: '2026-06-20',
      lines: [line(), line({ description: 'Pole', quantity: 1, unit_price: 10, tax_rate: 0 })],
      expected_totals: { subtotal: 111, tax_amount: 15.15, total: 126.15 },
    });
    expect(r.isError, r.text).toBe(false);
    expect(r.body).toMatchObject({ updated: true, status, lines_replaced: 2, subtotal: 111, tax_amount: 15.15, total: 126.15, budget_checked: false });
    expect(await poRow(pool, po.po)).toMatchObject({ status, reference: 'REF-9', notes: 'rush', delivery: '2026-07-01', order_date: '2026-06-20', subtotal: '111.00', total: '126.15' });
    const lines = await poLines(pool, po.po);
    expect(lines.map((l) => [l.description, l.line_total, l.tax_amount])).toEqual([['Cable', '101.00', '15.15'], ['Pole', '10.00', '0.00']]);
    expect(await glCount(pool, f)).toEqual(before);
    const audit = (await auditOf(pool, f, po.po)).at(-1)!;
    expect(audit).toMatchObject({ action: 'update', user_id: f.owner });
    expect(audit.changes.fields.map((x) => x.field)).toEqual(expect.arrayContaining(['reference', 'order_date', 'total']));
    expect(audit.changes.metadata).toMatchObject({ source: 'mcp:update_purchase_order', lines: '2' });
  });

  it('a header-only edit keeps the lines and totals; an omitted field stays and null clears', async () => {
    const po = await seedPo(pool, f, { status: 'draft', lines: [100] });
    await pool.query("UPDATE purchase_orders SET reference = 'keep', notes = 'drop' WHERE id = $1", [po.po]);
    const r = await callTool(pool, f, update, { po_number: po.number, notes: null });
    expect(r.isError, r.text).toBe(false);
    expect(r.body).toMatchObject({ changed_fields: ['notes'], lines_replaced: null });
    expect(await poRow(pool, po.po)).toMatchObject({ reference: 'keep', notes: null, subtotal: '100.00' });
    expect((await poLines(pool, po.po)).map((l) => l.line_total)).toEqual(['100.00']);
  });

  it('expected_totals that differ by a cent refuse the call and nothing is written', async () => {
    const po = await seedPo(pool, f, { status: 'draft', lines: [100] });
    const r = await callTool(pool, f, update, { po_id: po.po, lines: [line()], expected_totals: { total: 116.14 } });
    expect(r.isError).toBe(true);
    expect(r.text).toContain('expected_totals.total is 116.14 but the lines add up to 116.15');
    expect((await poLines(pool, po.po)).map((l) => l.line_total)).toEqual(['100.00']);
    expect(await auditOf(pool, f, po.po)).toHaveLength(0);
  });

  it('the source line_total / tax_amount are stored as sent; an unknown field is refused', async () => {
    const po = await seedPo(pool, f, { status: 'draft', lines: [100] });
    const r = await callTool(pool, f, update, { po_id: po.po, lines: [line({ quantity: 3, unit_price: 100, line_total: 290, tax_amount: 43.5 })] });
    expect(r.isError, r.text).toBe(false);
    expect((await poLines(pool, po.po))[0]).toMatchObject({ line_total: '290.00', tax_amount: '43.50' });
    const bad = await callTool(pool, f, update, { po_id: po.po, lines: [line({ colour: 'red' })] });
    expect(bad.text).toContain('lines[0].colour is not a field of this tool');
  });

  it('a manager may edit (any writer)', async () => {
    const po = await seedPo(pool, f, { status: 'draft', lines: [100] });
    const r = await callTool(pool, f, update, { po_id: po.po, notes: 'by manager' }, { user: f.manager, companyRole: 'manager' });
    expect(r.isError, r.text).toBe(false);
  });

  it('another supplier of the company is accepted; another company\'s supplier is "Not found"', async () => {
    const po = await seedPo(pool, f, { status: 'draft', lines: [100] });
    const second = await seedSupplier(pool, f);
    expect((await callTool(pool, f, update, { po_id: po.po, supplier_id: second })).isError).toBe(false);
    expect((await poRow(pool, po.po)).supplier_id).toBe(second);
    const foreign = await callTool(pool, f, update, { po_id: po.po, supplier_id: other.supplier });
    expect(foreign).toMatchObject({ isError: true, text: 'Not found' });
    expect((await poRow(pool, po.po)).supplier_id).toBe(second);
  });
});

describe('item lines', () => {
  it('item_code takes the item\'s purchases account and VAT type; item_id the same; an explicit account wins', async () => {
    const po = await seedPo(pool, f, { status: 'draft', lines: [100] });
    const std = await seedItem(pool, f, { code: 'CAB-1', acct: f.acc.travel });
    await seedItem(pool, f, { code: 'EXE-1', acct: f.acc.travel, vat: 'exempt' });
    const r = await callTool(pool, f, update, {
      po_id: po.po,
      lines: [
        { description: 'By code', quantity: 1, unit_price: 100, item_code: 'CAB-1' },
        { description: 'By id', quantity: 1, unit_price: 100, item_id: std },
        { description: 'Exempt', quantity: 1, unit_price: 100, item_code: 'EXE-1' },
        { description: 'Own account', quantity: 1, unit_price: 100, item_code: 'CAB-1', gl_account_id: f.acc.nob },
      ],
    });
    expect(r.isError, r.text).toBe(false);
    const lines = await poLines(pool, po.po);
    expect(lines.map((l) => l.gl_account_id)).toEqual([f.acc.travel, f.acc.travel, f.acc.travel, f.acc.nob]);
    expect(lines.map((l) => l.tax_rate)).toEqual(['15.00', '15.00', '0.00', '15.00']);
    expect(lines.map((l) => l.tax_amount)).toEqual(['15.00', '15.00', '0.00', '15.00']);
    expect(lines.map((l) => l.item_id).slice(0, 2)).toEqual([std, std]);
  });

  it('an unknown code, another company\'s item, a deactivated item and giving both are refused', async () => {
    const po = await seedPo(pool, f, { status: 'draft', lines: [100] });
    const theirs = await seedItem(pool, other, { code: 'THEIRS', acct: other.acc.travel });
    await seedItem(pool, f, { code: 'OFF-1', acct: f.acc.travel, active: false });
    const one = (extra: Record<string, unknown>) => callTool(pool, f, update, { po_id: po.po, lines: [{ description: 'x', quantity: 1, unit_price: 1, ...extra }] });
    expect((await one({ item_code: 'NOPE' })).text).toContain('lines[0].item_code: no item with the code "NOPE"');
    expect((await one({ item_code: 'THEIRS' })).text).toContain('no item with the code');
    expect((await one({ item_id: theirs })).isError).toBe(true);
    expect((await one({ item_code: 'OFF-1' })).isError).toBe(true);
    expect((await one({ item_code: 'CAB-1', item_id: theirs })).text).toContain('give item_id or item_code, not both');
    expect((await poLines(pool, po.po)).map((l) => l.line_total)).toEqual(['100.00']);
  });
});

describe('what refuses an update', () => {
  it('a goods receipt: refused, "cancel its goods received notes first", nothing changed', async () => {
    const po = await seedQtyPo(pool, f, { lines: [{ qty: 10, price: 10, received: 4 }] });
    await seedGrn(pool, f, po);
    const r = await callTool(pool, f, update, { po_id: po.po, notes: 'x', lines: [line()] });
    expect(r.isError).toBe(true);
    expect(r.text).toContain('a receipt is on record');
    expect(r.text).toContain('cancel its goods received notes first (cancel_goods_received)');
    expect((await poLines(pool, po.po))[0]).toMatchObject({ quantity: '10.00', line_total: '100.00' });
    expect((await poRow(pool, po.po)).notes).toBeNull();
  });

  it('a bill link (made by link_bills_to_purchase_order) and a bill line naming a PO line tie the PO; a bill naming it ONLY in its header ties it when the link tool could link the pair (unlink it first), and not otherwise', async () => {
    const a = await seedPo(pool, f, { lines: [100] });
    const billA = await seedBill(pool, f, { lines: [100] });
    expect((await callTool(pool, f, link, { links: [{ po_id: a.po, bill_id: billA.id }] })).isError).toBe(false);
    expect(await linkRows(pool, f, `l.purchase_order_id = '${a.po}'`)).toHaveLength(1);
    // The link made the bill's header name the PO too: clear it, so the link row alone is what refuses.
    await pool.query('UPDATE supplier_invoices SET purchase_order_id = NULL WHERE id = $1', [billA.id]);
    const viaLink = await callTool(pool, f, update, { po_id: a.po, notes: 'x' });
    expect(viaLink.text).toContain('A bill is linked to or names this purchase order');
    expect(viaLink.text).toContain('unlink_bill_from_purchase_order');

    const b = await seedPo(pool, f, { lines: [100] });
    const billB = await seedBill(pool, f, { lines: [100] });
    await pool.query('UPDATE supplier_invoice_items SET po_item_id = $1 WHERE id = $2', [b.items[0], billB.lines[0]]);
    expect(await linkRows(pool, f, `l.purchase_order_id = '${b.po}'`)).toHaveLength(0);
    expect((await callTool(pool, f, update, { po_id: b.po, lines: [line()] })).text).toContain('A bill is linked');

    for (const p of [a, b]) expect((await poLines(pool, p.po)).map((l) => l.line_total)).toEqual(['100.00']);

    // Header only on an APPROVED PO by an APPROVED same-supplier bill (the app approved the PO after a bill named it while it was only
    // submitted: no link row was ever made). The link tool could link it, so it is billing the PO: update / cancel are refused.
    const c = await seedPo(pool, f, { lines: [100] });
    const billC = await seedBill(pool, f, { lines: [100] });
    await pool.query('UPDATE supplier_invoices SET purchase_order_id = $1 WHERE id = $2', [c.po, billC.id]);
    expect(await linkRows(pool, f, `l.purchase_order_id = '${c.po}'`)).toHaveLength(0);
    for (const args of [{ notes: 'x' }, { notes: 'x', lines: [line()] }]) {
      const r = await callTool(pool, f, update, { po_id: c.po, ...args });
      expect(r.isError).toBe(true);
      expect(r.text).toContain('A bill is linked to or names this purchase order');
      expect(r.text).toContain('unlink it first (unlink_bill_from_purchase_order)');
    }
    expect((await callTool(pool, f, cancel, { po_id: c.po, reason: 'x' })).text).toContain('unlink it first');
    expect((await poLines(pool, c.po)).map((l) => l.line_total)).toEqual(['100.00']);
    // The way out is unlink itself (it clears a header reference with no link row), and the PO is free.
    expect((await callTool(pool, f, unlink, { po_id: c.po, bill_id: billC.id, reason: 'not billing this order' })).isError).toBe(false);
    expect((await callTool(pool, f, update, { po_id: c.po, notes: 'free again', lines: [line()] })).isError).toBe(false);

    // A header reference the link tool could NOT link is no tie, so no dead end: a draft / submitted / cancelled PO, a draft bill,
    // another supplier's bill.
    const free = async (label: string, po: { po: string }) => {
      const r = await callTool(pool, f, update, { po_id: po.po, notes: label });
      return r;
    };
    const draftPo = await seedPo(pool, f, { status: 'draft', lines: [100] });
    const billD = await seedBill(pool, f, { lines: [100] });
    await pool.query('UPDATE supplier_invoices SET purchase_order_id = $1 WHERE id = $2', [draftPo.po, billD.id]);
    expect((await free('draft PO', draftPo)).isError).toBe(false);
    expect((await callTool(pool, f, cancel, { po_id: draftPo.po, reason: 'free' })).isError).toBe(false);
    const draftBillPo = await seedPo(pool, f, { lines: [100] });
    const draftBill = await seedBill(pool, f, { lines: [100], status: 'draft' });
    await pool.query('UPDATE supplier_invoices SET purchase_order_id = $1 WHERE id = $2', [draftBillPo.po, draftBill.id]);
    expect((await free('draft bill', draftBillPo)).isError).toBe(false);
    const otherSupplierPo = await seedPo(pool, f, { lines: [100] });
    const otherBill = await seedBill(pool, f, { lines: [100], supplier: await seedSupplier(pool, f, 'Header supplier') });
    await pool.query('UPDATE supplier_invoices SET purchase_order_id = $1 WHERE id = $2', [otherSupplierPo.po, otherBill.id]);
    expect((await free('other supplier', otherSupplierPo)).isError).toBe(false);
    const deletedBillPo = await seedPo(pool, f, { lines: [100] });
    const deletedBill = await seedBill(pool, f, { lines: [100] });
    await pool.query('UPDATE supplier_invoices SET purchase_order_id = $1, deleted_at = NOW() WHERE id = $2', [deletedBillPo.po, deletedBill.id]);
    expect((await free('deleted bill', deletedBillPo)).isError).toBe(false);
  });

  it('a header-only supplier change on a linked PO is refused with the supplier-specific wording (the PUT\'s check runs with no lines too)', async () => {
    const po = await seedPo(pool, f, { lines: [100] });
    const bill = await seedBill(pool, f, { lines: [100] });
    expect((await callTool(pool, f, link, { links: [{ po_id: po.po, bill_id: bill.id }] })).isError).toBe(false);
    const second = await seedSupplier(pool, f, 'Another supplier');
    const r = await callTool(pool, f, update, { po_id: po.po, supplier_id: second });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/^A bill is linked to or names this purchase order \[.+\(id [0-9a-f-]{36}, link\)\], so its supplier cannot change; unlink it first \(unlink_bill_from_purchase_order\)$/);
    expect((await poRow(pool, po.po)).supplier_id).toBe(f.supplier);
    expect((await callTool(pool, f, update, { po_id: po.po, supplier_id: other.supplier })).text).toBe('Not found');
  });

  it.each(['partially_received', 'received', 'closed', 'cancelled'])('a %s PO is refused with its status', async (status) => {
    const po = await seedPo(pool, f, { status, lines: [100] });
    const r = await callTool(pool, f, update, { po_id: po.po, notes: 'x' });
    expect(r.isError).toBe(true);
    expect(r.text).toContain(`this one is ${status.replace('_', ' ')}`);
    expect((await poRow(pool, po.po)).notes).toBeNull();
  });
});
