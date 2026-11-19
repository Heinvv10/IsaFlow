/**
 * The bill and PO reads over links (design docs/design/mcp-po-bill-links.md, migration 1006), real PostgreSQL, as app_user:
 *   - a bill split across POs keeps its amounts, its header goes NULL, `purchase_order_ids` lists both and the three-way read
 *     (get_supplier_invoice and the stored performThreeWayMatch) matches it line by line against both POs;
 *   - get_purchase_order: lines (received / billed / outstanding), bills, goods received notes (truncation per note),
 *     documents, billed_total ignoring cancelled and deleted bills; another company's PO is "Not found".
 *   - the readers that used to key on the header PO see a multi-PO bill: the bill list's has_po flag, the PO documents auto-linked
 *     to a bill's document, and the bill PDF's "PO #".
 * Fixture route: isaflow_schema_fixture (assertDisposable). Never skips.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { dropBillFixture, openRequest, seedBillFixture, setPolicy, type BillFixture } from './helpers/budgetBillFixture';
import { callTool, type Json } from './helpers/poImportHarness';
import { billHeader, linkRows, seedBill, seedPo } from './helpers/poBillLinkHarness';
import { linkBillsToPurchaseOrderTool as link } from '@/lib/mcp/tools/writeLinkBillsToPurchaseOrder';
import { unlinkBillFromPurchaseOrderTool as unlink } from '@/lib/mcp/tools/writeUnlinkBillFromPurchaseOrder';
import { getPurchaseOrderTool as getPo } from '@/lib/mcp/tools/getPurchaseOrder';
import { getSupplierInvoiceTool as getBill, listSupplierInvoicesTool as listBills } from '@/lib/mcp/tools/supplierInvoices';
import { getSupplierInvoices, performThreeWayMatch } from '@/modules/accounting/services/ap/supplierInvoiceService';
import { generateSupplierInvoicePdf } from '@/modules/accounting/services/ap/supplierInvoicePdfBuilder';
import { autoLinkSupplierInvoice } from '@/modules/accounting/services/core/documentStorageService';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
let f: BillFixture;
let other: BillFixture;

beforeAll(async () => {
  f = await seedBillFixture(pool, 'po-links-reads');
  other = await seedBillFixture(pool, 'po-links-reads-other');
  await setPolicy(pool, f, 'warn');
}, 60_000);
afterAll(async () => {
  try {
    for (const x of [f, other]) await dropBillFixture(pool, x);
  } finally {
    await pool.end();
  }
}, 60_000);

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

  it('the stored three-way match (performThreeWayMatch) of a no-header multi-PO bill reads both POs against the real tables', async () => {
    const a = await seedPo(pool, f, { lines: [100] });
    const b = await seedPo(pool, f, { lines: [200] });
    const bill = await seedBill(pool, f, { lines: [100, 200] });
    await callTool(pool, f, link, { links: [
      { po_id: a.po, bill_id: bill.id, lines: [{ po_item_id: a.items[0], bill_line_id: bill.lines[0] }] },
      { po_id: b.po, bill_id: bill.id, lines: [{ po_item_id: b.items[0], bill_line_id: bill.lines[1] }] },
    ] });
    expect(await billHeader(pool, bill.id)).toBeNull();
    const req = await openRequest(pool, f, f.owner);
    let result;
    try { result = await req.run(() => performThreeWayMatch(f.co, bill.id)); await req.commit(); } catch (e) { await req.rollback(); throw e; }
    expect(result.matchStatus).toBe('po_matched');
    expect(result.itemResults.map((r) => r.lineMatchStatus)).toEqual(['po_matched', 'po_matched']);
    const stored = await pool.query('SELECT match_status FROM supplier_invoices WHERE id = $1', [bill.id]);
    expect(stored.rows[0].match_status).toBe('po_matched');
    const lines = await pool.query('SELECT line_match_status FROM supplier_invoice_items WHERE supplier_invoice_id = $1', [bill.id]);
    expect(lines.rows.map((r) => r.line_match_status)).toEqual(['po_matched', 'po_matched']);
  });
});

describe('get_purchase_order', () => {
  it('reads lines with received / billed / outstanding, bills, GRNs and documents; another company\'s PO is Not found', async () => {
    const po = await seedPo(pool, f, { lines: [100, 300], status: 'partially_received' });
    const bill = await seedBill(pool, f, { lines: [100] });
    await callTool(pool, f, link, { links: [{ po_id: po.po, bill_id: bill.id, lines: [{ po_item_id: po.items[0], bill_line_id: bill.lines[0] }] }] });
    // A link to a bill that was later cancelled is listed but does not count as billed; a deleted bill's link is listed too, flagged deleted
    // (round 6: every tie is listed, because unlink can clear it and the refusals name it).
    const cancelled = await seedBill(pool, f, { lines: [50] });
    const gone = await seedBill(pool, f, { lines: [40] });
    await callTool(pool, f, link, { links: [{ po_id: po.po, bill_id: cancelled.id }, { po_id: po.po, bill_id: gone.id }] });
    await pool.query("UPDATE supplier_invoices SET status = 'cancelled' WHERE id = $1", [cancelled.id]);
    await pool.query('UPDATE supplier_invoices SET deleted_at = now() WHERE id = $1', [gone.id]);
    const grn = crypto.randomUUID();
    await pool.query("INSERT INTO goods_received_notes (id, company_id, grn_number, purchase_order_id, received_by) VALUES ($1, $2, 'GRN-1', $3, 'x')", [grn, f.co, po.po]);
    await pool.query('INSERT INTO grn_items (grn_id, po_item_id, quantity_received) VALUES ($1, $2, 1)', [grn, po.items[0]]);
    await pool.query('UPDATE po_items SET quantity_received = 1 WHERE id = $1', [po.items[0]]);
    await pool.query(`INSERT INTO procurement_documents (entity_type, entity_id, document_type, document_name, is_active) VALUES ('purchase_order', $1, 'purchase_order', 'po.pdf', true)`, [po.po]);

    const r = await callTool(pool, f, getPo, { po_number: po.number });
    expect(r.isError, r.text).toBe(false);
    expect(r.body).toMatchObject({ billed_total: 100, outstanding_to_bill: 300, fully_billed: false, lines_total: 2, bills_total: 3, goods_received_notes_total: 1, documents_total: 1 });
    expect((r.body.bills as Json[]).map((x) => [x.bill_id, x.tie, x.deleted, x.counts_as_billed]).sort()).toEqual([
      [bill.id, 'link', false, true], [cancelled.id, 'link', false, false], [gone.id, 'link', true, false],
    ].sort());
    const lines = r.body.lines as Json[];
    expect(lines[0]).toMatchObject({ quantity_ordered: 1, quantity_received: 1, quantity_billed: 1, amount_billed: 100, outstanding_quantity_to_bill: 0, outstanding_amount_to_bill: 0, outstanding_quantity_to_receive: 0 });
    expect(lines[1]).toMatchObject({ quantity_billed: 0, outstanding_amount_to_bill: 300, outstanding_quantity_to_receive: 1 });
    expect((r.body.goods_received_notes as Json[])[0]).toMatchObject({ grn_number: 'GRN-1', items: [{ po_item_id: po.items[0], quantity_received: 1 }], items_total: 1, items_truncated: false });
    expect((r.body.documents as Json[])[0]).toMatchObject({ name: 'po.pdf' });

    // Per-note truncation: a receipt of more lines than the cap says so for that note.
    const big = crypto.randomUUID();
    await pool.query("INSERT INTO goods_received_notes (id, company_id, grn_number, purchase_order_id, received_by) VALUES ($1, $2, 'GRN-2', $3, 'x')", [big, f.co, po.po]);
    const more = await seedPo(pool, f, { lines: [1, 2, 3, 4, 5, 6, 7], status: 'approved' });
    await pool.query('UPDATE goods_received_notes SET purchase_order_id = $2 WHERE id = $1', [big, more.po]);
    for (const item of more.items) await pool.query('INSERT INTO grn_items (grn_id, po_item_id, quantity_received) VALUES ($1, $2, 1)', [big, item]);
    const wide = await callTool(pool, f, getPo, { po_id: more.po });
    expect((wide.body.goods_received_notes as Json[])[0]).toMatchObject({ items_total: 7, items_truncated: true });
    expect(((wide.body.goods_received_notes as Json[])[0]!.items as Json[])).toHaveLength(5);
    const theirs = await callTool(pool, other, getPo, { po_id: po.po });
    expect(theirs).toMatchObject({ isError: true, text: 'Not found' });
    await pool.query("DELETE FROM procurement_documents WHERE entity_id = $1", [po.po]);
  });
});

describe('readers that keyed on the header PO', () => {
  it('has_po, the PO documents linked to a bill\'s document, and the PDF\'s PO # all see a bill linked to two POs', async () => {
    const a = await seedPo(pool, f, { lines: [100] });
    const b = await seedPo(pool, f, { lines: [200] });
    const bill = await seedBill(pool, f, { lines: [100, 200] });
    const plain = await seedBill(pool, f, { lines: [10] });
    await callTool(pool, f, link, { links: [{ po_id: a.po, bill_id: bill.id, amount: 100 }, { po_id: b.po, bill_id: bill.id, amount: 200 }] });
    expect(await billHeader(pool, bill.id)).toBeNull();

    const req = await openRequest(pool, f, f.owner);
    try {
      const list = await req.run(() => getSupplierInvoices(f.co, { limit: 200 }));
      expect(list.invoices.find((i) => i.id === bill.id)!.hasPo).toBe(true);
      expect(list.invoices.find((i) => i.id === plain.id)!.hasPo).toBe(false);
      const pdf = await req.run(() => generateSupplierInvoicePdf(f.co, bill.id));
      expect(Buffer.isBuffer(pdf) && pdf.length > 1000).toBe(true);
    } finally { await req.rollback(); }

    // Each PO's filed documents are cross-linked to the bill, and the bill's document to each PO.
    for (const [po, name] of [[a.po, 'a.pdf'], [b.po, 'b.pdf']] as const) {
      await pool.query(`INSERT INTO procurement_documents (entity_type, entity_id, document_type, document_name, is_active) VALUES ('purchase_order', $1, 'purchase_order', $2, true)`, [po, name]);
    }
    const doc = (await pool.query(`INSERT INTO procurement_documents (entity_type, entity_id, document_type, document_name, is_active) VALUES ('supplier_invoice', $1, 'supplier_invoice', 'bill.pdf', true) RETURNING id`, [bill.id])).rows[0].id;
    await autoLinkSupplierInvoice(doc, bill.id, f.co);
    const toPos = await pool.query(`SELECT linked_entity_id FROM document_links WHERE document_id = $1 AND linked_entity_type = 'purchase_order' ORDER BY 1`, [doc]);
    expect(toPos.rows.map((r) => String(r.linked_entity_id)).sort()).toEqual([a.po, b.po].sort());
    const toBill = await pool.query(`SELECT count(*)::INT AS n FROM document_links WHERE linked_entity_type = 'supplier_invoice' AND linked_entity_id = $1 AND link_reason = 'po_invoice_link'`, [bill.id]);
    expect(toBill.rows[0].n).toBe(2);
    await pool.query(`DELETE FROM document_links WHERE document_id = $1 OR linked_entity_id = $2`, [doc, bill.id]);
    await pool.query(`DELETE FROM procurement_documents WHERE entity_id = ANY($1::UUID[])`, [[a.po, b.po, bill.id]]);
  });
});
