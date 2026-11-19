/**
 * link_bills_to_purchase_order / unlink_bill_from_purchase_order / get_purchase_order (design docs/design/mcp-po-bill-links.md,
 * migration 1006), real PostgreSQL, every call as app_user (poImportHarness):
 *   - 100 links on APPROVED bills (five of them really approved, so they carry journals) write no journal row and leave
 *     every bill's status, totals and amount_paid alone;
 *   - close_when_fully_billed closes the PO that the call leaves fully billed, and nothing closes it without the flag;
 *   - cross-supplier, cross-company, already-linked, cancelled-bill and draft-PO rows are refused, each listed, nothing written;
 *   - the same external_ref again is already_existed; a reference on another pair is refused;
 *   - unlink restores: link gone, line links cleared, header reset, PO reopened to the status it came from;
 *   - a bill split across POs keeps its amounts, the header goes NULL, the three-way read still matches its lines;
 *   - line links reduce budget committed, header-only links do not (the documented limit);
 *   - dry_run writes nothing and leaves the idempotency key free, and refuses what the live call refuses.
 * Fixture route: isaflow_schema_fixture (assertDisposable). Never skips.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { dropBillFixture, openRequest, seedBillFixture, setPolicy, type BillFixture } from './helpers/budgetBillFixture';
import { asOwner, callTool, type Json } from './helpers/poImportHarness';
import {
  billHeader, ledgerSnapshot, lineLinks, linkRows, poStatus, seedBill, seedPo,
} from './helpers/poBillLinkHarness';
import { linkBillsToPurchaseOrderTool as link } from '@/lib/mcp/tools/writeLinkBillsToPurchaseOrder';
import { unlinkBillFromPurchaseOrderTool as unlink } from '@/lib/mcp/tools/writeUnlinkBillFromPurchaseOrder';
import { getPurchaseOrderTool as getPo } from '@/lib/mcp/tools/getPurchaseOrder';
import { getSupplierInvoiceTool as getBill, listSupplierInvoicesTool as listBills } from '@/lib/mcp/tools/supplierInvoices';
import { findByExternalRefTool as find } from '@/lib/mcp/tools/externalRef';
import { approveSupplierInvoice } from '@/modules/accounting/services/ap/supplierInvoiceService';
import { readCommitments } from '@/modules/accounting/services/budgets/remainingCommitted';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
let f: BillFixture;
let other: BillFixture;

beforeAll(async () => {
  f = await seedBillFixture(pool, 'po-links');
  other = await seedBillFixture(pool, 'po-links-other');
  await setPolicy(pool, f, 'warn');
}, 60_000);
afterAll(async () => {
  try {
    for (const x of [f, other]) await dropBillFixture(pool, x);
  } finally {
    await pool.end();
  }
}, 60_000);

const ids = (rows: Json[] | unknown) => (rows as Json[]).map((r) => r.index);

describe('100 links on approved bills', () => {
  it('write no journal and leave every bill as it was', async () => {
    const pos = [];
    for (let i = 0; i < 100; i++) pos.push(await seedPo(pool, f, { lines: [100 + i], status: i % 4 === 0 ? 'received' : 'approved' }));
    const bills = [];
    for (let i = 0; i < 100; i++) bills.push(await seedBill(pool, f, { lines: [100 + i], status: i < 5 ? 'draft' : 'approved' }));
    // Five bills are APPROVED through the real service: they carry journals.
    for (const b of bills.slice(0, 5)) {
      const req = await openRequest(pool, f, f.owner);
      try { await req.run(() => approveSupplierInvoice(f.co, b.id, f.owner)); await req.commit(); } catch (e) { await req.rollback(); throw e; }
    }
    const journalled = await pool.query('SELECT count(*)::INT AS n FROM supplier_invoices WHERE company_id = $1 AND gl_journal_entry_id IS NOT NULL', [f.co]);
    expect(journalled.rows[0].n).toBe(5);

    const before = await ledgerSnapshot(pool, f, bills.map((b) => b.id));
    expect(before.entries).toBeGreaterThanOrEqual(5);
    const r = await callTool(pool, f, link, {
      links: pos.map((p, i) => ({ po_number: p.number, bill_id: bills[i]!.id, external_system: 'sage', external_ref: `FD-${i}` })),
    });
    expect(r.isError, r.text).toBe(false);
    expect(r.body).toMatchObject({ linked: 100, already_existed: 0 });
    expect((r.body.links as Json[])[7]).toMatchObject({ amount: 107, already_existed: false, lines_linked: 0 });

    const after = await ledgerSnapshot(pool, f, bills.map((b) => b.id));
    expect(after).toEqual(before);
    const rows = await linkRows(pool, f);
    expect(rows).toHaveLength(100);
    expect(rows.every((l) => l.source === 'mcp' && l.created_by === f.owner)).toBe(true);
    expect(await billHeader(pool, bills[3]!.id)).toBe(pos[3]!.po);
    const audits = await pool.query("SELECT count(*)::INT AS n FROM audit_log WHERE company_id = $1 AND entity_type = 'purchase_order'", [f.co]);
    expect(audits.rows[0].n).toBe(100);
  }, 180_000);
});

describe('close_when_fully_billed', () => {
  it('leaves a fully billed PO alone without the flag, and closes it with it', async () => {
    const p1 = await seedPo(pool, f, { lines: [100, 200], status: 'partially_received' });
    const b1 = await seedBill(pool, f, { lines: [300] });
    const noFlag = await callTool(pool, f, link, { links: [{ po_id: p1.po, bill_id: b1.id }] });
    expect(noFlag.body.purchase_orders).toEqual([expect.objectContaining({ status: 'partially_received', billed: 300, fully_billed: true, closed_by_this_call: false })]);
    expect(await poStatus(pool, p1.po)).toBe('partially_received');

    const p2 = await seedPo(pool, f, { lines: [100, 200], status: 'partially_received' });
    const half = await seedBill(pool, f, { lines: [100] });
    const rest = await seedBill(pool, f, { lines: [200] });
    const first = await callTool(pool, f, link, { links: [{ po_id: p2.po, bill_id: half.id }], close_when_fully_billed: true });
    expect(first.body.purchase_orders).toEqual([expect.objectContaining({ status: 'partially_received', billed: 100, fully_billed: false })]);
    const second = await callTool(pool, f, link, { links: [{ po_id: p2.po, bill_id: rest.id }], close_when_fully_billed: true });
    expect(second.body.purchase_orders).toEqual([expect.objectContaining({ status_before: 'partially_received', status: 'closed', closed_by_this_call: true, fully_billed: true })]);
    expect(await poStatus(pool, p2.po)).toBe('closed');
    const rows = await linkRows(pool, f, `l.purchase_order_id = '${p2.po}'`);
    expect(rows.map((l) => l.closed_po_from_status)).toEqual([null, 'partially_received']);
    const audit = await pool.query(
      `SELECT changes FROM audit_log WHERE entity_id = $1 AND entity_type = 'purchase_order' ORDER BY created_at DESC, id LIMIT 1`, [p2.po]);
    expect(audit.rows[0].changes.fields).toEqual([{ field: 'status', old: 'partially_received', new: 'closed', label: 'Status' }]);
  });

  it('a draft bill does not count as billed; a closed PO still takes a link and stays closed', async () => {
    const po = await seedPo(pool, f, { lines: [50], status: 'approved' });
    const draft = await seedBill(pool, f, { lines: [50], status: 'draft' });
    const r = await callTool(pool, f, link, { links: [{ po_id: po.po, bill_id: draft.id }], close_when_fully_billed: true });
    expect(r.body.purchase_orders).toEqual([expect.objectContaining({ status: 'approved', billed: 0, fully_billed: false })]);
    const closed = await seedPo(pool, f, { lines: [80], status: 'closed' });
    const b = await seedBill(pool, f, { lines: [80] });
    const c = await callTool(pool, f, link, { links: [{ po_id: closed.po, bill_id: b.id }], close_when_fully_billed: true });
    expect(c.isError, c.text).toBe(false);
    expect(c.body.purchase_orders).toEqual([expect.objectContaining({ status: 'closed', closed_by_this_call: false, fully_billed: true })]);
  });
});

describe('refusals: every bad row listed, nothing written', () => {
  it('cross-supplier, cross-company, cancelled bill, draft PO, bad line, already linked', async () => {
    const otherSupplier = crypto.randomUUID();
    await pool.query("INSERT INTO suppliers (id, company_id, name, is_active) VALUES ($1, $2, 'Other supplier', true)", [otherSupplier, f.co]);
    const po = await seedPo(pool, f, { lines: [100] });
    const strangers = await seedPo(pool, f, { lines: [100], supplier: otherSupplier });
    const draftPo = await seedPo(pool, f, { lines: [100], status: 'draft' });
    const theirPo = await seedPo(pool, other, { lines: [100] });
    const theirBill = await seedBill(pool, other, { lines: [100] });
    const ok = await seedBill(pool, f, { lines: [100] });
    const cancelled = await seedBill(pool, f, { lines: [100], status: 'cancelled' });
    const taken = await seedBill(pool, f, { lines: [100] });
    const bill2 = await seedBill(pool, f, { lines: [100] });
    expect((await callTool(pool, f, link, { links: [{ po_id: po.po, bill_id: taken.id }] })).isError).toBe(false);
    const rowsBefore = await linkRows(pool, f);

    const r = await callTool(pool, f, link, {
      links: [
        { po_id: po.po, bill_id: ok.id },                                            // 0 fine
        { po_id: strangers.po, bill_id: ok.id },                                     // 1 cross-supplier
        { po_id: theirPo.po, bill_id: ok.id },                                       // 2 another company's PO
        { po_id: po.po, bill_id: theirBill.id },                                     // 3 another company's bill
        { po_id: po.po, bill_id: cancelled.id },                                     // 4 cancelled bill
        { po_id: draftPo.po, bill_id: bill2.id },                                    // 5 draft PO
        { po_id: po.po, bill_id: taken.id },                                         // 6 already linked
        { po_id: po.po, bill_id: bill2.id, lines: [{ po_item_id: strangers.items[0], bill_line_id: bill2.lines[0] }] }, // 7 PO line of another PO
        { po_id: po.po, bill_id: ok.id },                                            // 8 same pair as 0
      ],
    });
    expect(r.isError).toBe(true);
    expect(r.text).toContain('8 of 9 links cannot be made; nothing was linked.');
    for (const reason of [
      'links[1]: bill', 'are of different suppliers', 'links[2]: purchase order not found', 'links[3]: bill not found', 'is cancelled',
      'links[5]: purchase order', 'is draft', 'links[6]: bill', 'is already linked to purchase order', `links[7]: purchase order line ${strangers.items[0]} is not a line of purchase order`,
      'links[8]: the same purchase order and bill as links[0]',
    ]) expect(r.text).toContain(reason);
    expect(r.text).not.toContain('links[0]:');
    expect(await linkRows(pool, f)).toEqual(rowsBefore);
    expect(await billHeader(pool, ok.id)).toBeNull();
  });

  it('a bill line already naming another PO line, a line named twice, and an amount past the subtotal are refused', async () => {
    const a = await seedPo(pool, f, { lines: [100] });
    const b = await seedPo(pool, f, { lines: [100] });
    const bill = await seedBill(pool, f, { lines: [100] });
    expect((await callTool(pool, f, link, { links: [{ po_id: a.po, bill_id: bill.id, amount: 40, lines: [{ po_item_id: a.items[0], bill_line_id: bill.lines[0] }] }] })).isError).toBe(false);
    const again = await callTool(pool, f, link, { links: [{ po_id: b.po, bill_id: bill.id, lines: [{ po_item_id: b.items[0], bill_line_id: bill.lines[0] }] }] });
    expect(again.text).toContain('already names another purchase order line');
    const past = await callTool(pool, f, link, { links: [{ po_id: b.po, bill_id: bill.id, amount: 60.02 }] });
    expect(past.text).toContain('would pass it');
    const rest = await callTool(pool, f, link, { links: [{ po_id: b.po, bill_id: bill.id }] });
    expect(rest.isError, rest.text).toBe(false);
    expect(rest.body.links).toEqual([expect.objectContaining({ amount: 60 })]);
  });
});

describe('idempotency on external_ref', () => {
  it('the same pair under the same reference is already_existed and leaves the key free; a reference on another pair is refused', async () => {
    const po = await seedPo(pool, f, { lines: [100, 100] });
    const b1 = await seedBill(pool, f, { lines: [100] });
    const b2 = await seedBill(pool, f, { lines: [100] });
    const first = await callTool(pool, f, link, { links: [{ po_id: po.po, bill_id: b1.id, external_system: 'Sage', external_ref: 4711 }] });
    expect(first.body).toMatchObject({ linked: 1 });
    expect(first.wroteNothing).toBe(false);
    const rerun = await callTool(pool, f, link, { links: [{ po_number: po.number, bill_id: b1.id, external_system: 'sage', external_ref: '4711' }] });
    expect(rerun.body).toMatchObject({ linked: 0, already_existed: 1 });
    expect((rerun.body.links as Json[])[0]).toMatchObject({ already_existed: true, external_system: 'sage', external_ref: '4711' });
    expect(rerun.wroteNothing).toBe(true);
    expect(await linkRows(pool, f, `l.purchase_order_id = '${po.po}'`)).toHaveLength(1);

    const noRef = await callTool(pool, f, link, { links: [{ po_id: po.po, bill_id: b1.id }] });
    expect(noRef.text).toContain('is already linked to purchase order');
    const stolen = await callTool(pool, f, link, { links: [{ po_id: po.po, bill_id: b2.id, external_system: 'sage', external_ref: '4711' }] });
    expect(stolen.text).toContain('external_ref 4711 (sage) is already used by another purchase order link');

    const found = await callTool(pool, f, find, { source: 'sage', kind: 'po_bill_link', id: 4711 });
    expect(found.body).toMatchObject({ found: true, kind: 'po_bill_link', record: { purchase_order_id: po.po, supplier_invoice_id: b1.id, total_amount: 100 } });
    expect(String((found.body.record as Json).number)).toBe(`${po.number} <- ${String((await pool.query('SELECT invoice_number FROM supplier_invoices WHERE id = $1', [b1.id])).rows[0].invoice_number)}`);
    const none = await callTool(pool, other, find, { source: 'sage', kind: 'po_bill_link', id: 4711 });
    expect(none.body).toMatchObject({ found: false });
  });
});

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
    expect(dry.body).toMatchObject({ dry_run: true, would_unlink: true, lines_cleared: 2, reopened_to: 'received' });
    expect(dry.wroteNothing).toBe(true);
    expect(await linkRows(pool, f, `l.purchase_order_id = '${po.po}'`)).toHaveLength(1);

    const r = await callTool(pool, f, unlink, { po_number: po.number, bill_id: bill.id, reason: 'wrong PO' });
    expect(r.isError, r.text).toBe(false);
    expect(r.body).toMatchObject({ unlinked: true, lines_cleared: 2, po_status_before: 'closed', po_status: 'received', reopened_to: 'received' });
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

  it('a PO closed by another link, or by hand, is not reopened', async () => {
    const po = await seedPo(pool, f, { lines: [100], status: 'approved' });
    const b1 = await seedBill(pool, f, { lines: [30] });
    const b2 = await seedBill(pool, f, { lines: [70] });
    await callTool(pool, f, link, { links: [{ po_id: po.po, bill_id: b1.id }] });
    await callTool(pool, f, link, { links: [{ po_id: po.po, bill_id: b2.id }], close_when_fully_billed: true });
    expect(await poStatus(pool, po.po)).toBe('closed');
    await callTool(pool, f, unlink, { po_id: po.po, bill_id: b1.id, reason: 'not this one' });
    expect(await poStatus(pool, po.po)).toBe('closed');
    await pool.query("UPDATE purchase_orders SET status = 'cancelled' WHERE id = $1", [po.po]);
    await callTool(pool, f, unlink, { po_id: po.po, bill_id: b2.id, reason: 'cancelled meanwhile' });
    expect(await poStatus(pool, po.po)).toBe('cancelled');
  });
});

describe('a bill split across purchase orders', () => {
  it('keeps each amount, leaves the header NULL, and the three-way read matches its lines', async () => {
    const a = await seedPo(pool, f, { lines: [100] });
    const b = await seedPo(pool, f, { lines: [200] });
    const bill = await seedBill(pool, f, { lines: [100, 200] });
    const r = await callTool(pool, f, link, {
      links: [
        { po_id: a.po, bill_id: bill.id, lines: [{ po_item_id: a.items[0], bill_line_id: bill.lines[0] }] },
        { po_id: b.po, bill_id: bill.id, lines: [{ po_item_id: b.items[0], bill_line_id: bill.lines[1] }] },
      ],
    });
    expect(r.isError, r.text).toBe(false);
    expect((r.body.links as Json[]).map((l) => l.amount)).toEqual([100, 200]);
    expect(await billHeader(pool, bill.id)).toBeNull();
    expect((await linkRows(pool, f, `l.supplier_invoice_id = '${bill.id}'`)).map((l) => l.amount)).toEqual(['100.00', '200.00']);

    const got = await callTool(pool, f, getBill, { invoice_id: bill.id });
    expect(got.body.purchase_order_ids).toEqual([a.po, b.po]);
    const three = got.body.three_way as Json;
    expect(three).toMatchObject({ has_purchase_order: true, lines_total: 2, lines_without_po_line: 0 });
    for (const l of three.lines as Json[]) expect(l).toMatchObject({ quantity: { po: 1, invoice: 1 }, unit_price: { variance_percent: 0 } });
    expect((three.lines as Json[]).map((l) => (l.unit_price as Json).po).sort()).toEqual([100, 200]);

    const listed = await callTool(pool, f, listBills, { search: bill.id.slice(0, 8) });
    expect((listed.body.invoices as Json[])[0]).toMatchObject({ id: bill.id, purchase_order_ids: [a.po, b.po] });
    const second = await callTool(pool, f, getPo, { po_id: b.po });
    expect(second.body).toMatchObject({ billed_total: 200, fully_billed: true });
    expect((second.body.bills as Json[])).toEqual([expect.objectContaining({ bill_id: bill.id, linked_amount: 200, counts_as_billed: true })]);

    await callTool(pool, f, unlink, { po_id: a.po, bill_id: bill.id, reason: 'split changed' });
    expect(await billHeader(pool, bill.id)).toBe(b.po);
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

describe('dry_run', () => {
  it('writes nothing, leaves the key free, and refuses what the live call refuses', async () => {
    const po = await seedPo(pool, f, { lines: [100], status: 'approved' });
    const bill = await seedBill(pool, f, { lines: [100] });
    const before = await ledgerSnapshot(pool, f, [bill.id]);
    const args = { links: [{ po_id: po.po, bill_id: bill.id, lines: [{ po_item_id: po.items[0], bill_line_id: bill.lines[0] }] }], close_when_fully_billed: true, idempotency_key: 'dry-then-live' };
    const dry = await callTool(pool, f, link, { ...args, dry_run: true });
    expect(dry.isError, dry.text).toBe(false);
    expect(dry.body).toMatchObject({ dry_run: true, would_link: 1 });
    expect((dry.body.links as Json[])[0]).toMatchObject({ link_id: null, amount: 100 });
    expect((dry.body.purchase_orders as Json[])[0]).toMatchObject({ status: 'closed', closed_by_this_call: true });
    expect(dry.wroteNothing).toBe(true);
    expect(await linkRows(pool, f, `l.purchase_order_id = '${po.po}'`)).toEqual([]);
    expect(await poStatus(pool, po.po)).toBe('approved');
    expect(await lineLinks(pool, bill.id)).toEqual([null]);
    expect(await billHeader(pool, bill.id)).toBeNull();
    expect(await ledgerSnapshot(pool, f, [bill.id])).toEqual(before);

    const live = await callTool(pool, f, link, args);
    expect(live.isError, live.text).toBe(false);
    expect(live.body).toMatchObject({ linked: 1 });
    expect(await poStatus(pool, po.po)).toBe('closed');

    const refusedDry = await callTool(pool, f, link, { links: [{ po_id: po.po, bill_id: bill.id }], dry_run: true });
    const refusedLive = await callTool(pool, f, link, { links: [{ po_id: po.po, bill_id: bill.id }] });
    expect(refusedDry.isError).toBe(true);
    expect(refusedDry.text).toBe(refusedLive.text);
  });
});

describe('get_purchase_order', () => {
  it('reads lines with received / billed / outstanding, bills, GRNs and documents; another company\'s PO is Not found', async () => {
    const po = await seedPo(pool, f, { lines: [100, 300], status: 'partially_received' });
    const bill = await seedBill(pool, f, { lines: [100] });
    await callTool(pool, f, link, { links: [{ po_id: po.po, bill_id: bill.id, lines: [{ po_item_id: po.items[0], bill_line_id: bill.lines[0] }] }] });
    const grn = crypto.randomUUID();
    await pool.query("INSERT INTO goods_received_notes (id, company_id, grn_number, purchase_order_id, received_by) VALUES ($1, $2, 'GRN-1', $3, 'x')", [grn, f.co, po.po]);
    await pool.query('INSERT INTO grn_items (grn_id, po_item_id, quantity_received) VALUES ($1, $2, 1)', [grn, po.items[0]]);
    await pool.query('UPDATE po_items SET quantity_received = 1 WHERE id = $1', [po.items[0]]);
    await pool.query(`INSERT INTO procurement_documents (entity_type, entity_id, document_type, document_name, is_active) VALUES ('purchase_order', $1, 'purchase_order', 'po.pdf', true)`, [po.po]);

    const r = await callTool(pool, f, getPo, { po_number: po.number });
    expect(r.isError, r.text).toBe(false);
    expect(r.body).toMatchObject({ billed_total: 100, outstanding_to_bill: 300, fully_billed: false, lines_total: 2, bills_total: 1, goods_received_notes_total: 1, documents_total: 1 });
    const lines = r.body.lines as Json[];
    expect(lines[0]).toMatchObject({ quantity_ordered: 1, quantity_received: 1, quantity_billed: 1, amount_billed: 100, outstanding_quantity_to_bill: 0, outstanding_amount_to_bill: 0, outstanding_quantity_to_receive: 0 });
    expect(lines[1]).toMatchObject({ quantity_billed: 0, outstanding_amount_to_bill: 300, outstanding_quantity_to_receive: 1 });
    expect((r.body.goods_received_notes as Json[])[0]).toMatchObject({ grn_number: 'GRN-1', items: [{ po_item_id: po.items[0], quantity_received: 1 }] });
    expect((r.body.documents as Json[])[0]).toMatchObject({ name: 'po.pdf' });

    const theirs = await callTool(pool, other, getPo, { po_id: po.po });
    expect(theirs).toMatchObject({ isError: true, text: 'Not found' });
    await pool.query("DELETE FROM procurement_documents WHERE entity_id = $1", [po.po]);
  });
});
