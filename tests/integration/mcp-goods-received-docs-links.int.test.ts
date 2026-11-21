/**
 * Document listings and older link rows (Codex gate round 3 on #1697, findings 2, 4 and 6; docs/design/mcp-goods-received.md
 * "Attachments"), real PostgreSQL, as app_user:
 *   - a goods_received listing checks that the id is a note OF THIS COMPANY, not merely some row of it: a note of another company the
 *     user also belongs to, sharing its id with one of this company's bills, lends nothing (finding 2);
 *   - an older automatic link row (po_invoice_link / grn_invoice_link) onto a bill is shown only while the document's parent is the
 *     bill's current note or one of the POs it names now: after the draft switches notes, or the PO is unlinked, the former paperwork is
 *     gone; a manual link row stays (finding 4);
 *   - a note's listing includes bill scans linked to it under the legacy alias goods_receipt_note (finding 6).
 * Object storage is not run here: vfStorage.uploadFile is stubbed, every database write is real.
 * Fixture route: isaflow_schema_fixture (assertDisposable). Never skips.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';

vi.mock('@/services/vfStorageAdapter', () => ({
  vfStorage: { uploadFile: vi.fn(async (_b: Buffer, _a: string, t: string, name: string) => ({ url: `https://files.test/${t}/${name}`, path: `${t}/${name}` })) },
  normalizeStorageUrl: (u: string | null | undefined) => u ?? undefined,
}));

import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { dropBillFixture, openRequest, seedBillFixture, type BillFixture } from './helpers/budgetBillFixture';
import { callTool, dropGrnExtras, dropMaintExtras, grnArgs, seedQtyPo, type QtyPo } from './helpers/grnHarness';
import { createGoodsReceivedTool as create } from '@/lib/mcp/tools/writeCreateGoodsReceived';
import { updateSupplierInvoiceTool as update } from '@/lib/mcp/tools/writeUpdateSupplierInvoice';
import { unlinkBillFromPurchaseOrderTool as unlink } from '@/lib/mcp/tools/writeUnlinkBillFromPurchaseOrder';
import { createSupplierInvoice } from '@/modules/accounting/services/ap/supplierInvoiceService';
import { listEntityDocuments } from '@/modules/accounting/services/core/documentQueryService';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 6 });
let f: BillFixture;
let other: BillFixture;
let n = 0;

beforeAll(async () => {
  f = await seedBillFixture(pool, 'grn-docs-links');
  other = await seedBillFixture(pool, 'grn-docs-links-other');
}, 60_000);
afterAll(async () => {
  try {
    for (const x of [f, other]) {
      await pool.query(`DELETE FROM document_links WHERE linked_entity_id IN (SELECT id FROM supplier_invoices WHERE company_id = $1
                         UNION ALL SELECT id FROM goods_received_notes WHERE company_id = $1 UNION ALL SELECT id FROM purchase_orders WHERE company_id = $1)`, [x.co]);
      await pool.query(`DELETE FROM procurement_documents WHERE entity_id IN (SELECT id FROM purchase_orders WHERE company_id = $1
                         UNION ALL SELECT id FROM goods_received_notes WHERE company_id = $1 UNION ALL SELECT id FROM supplier_invoices WHERE company_id = $1)`, [x.co]);
      await dropGrnExtras(pool, x); await dropMaintExtras(pool, x); await dropBillFixture(pool, x);
    }
  } finally { await pool.end(); }
}, 60_000);

const noteOnPo = async (fx: BillFixture, po?: QtyPo): Promise<{ po: QtyPo; grn: string }> => {
  const p = po ?? await seedQtyPo(pool, fx, { lines: [{ qty: 4, price: 10 }] });
  const r = await callTool(pool, fx, create, grnArgs(p, [[0, 1]]));
  expect(r.isError, r.text).toBe(false);
  return { po: p, grn: String(r.body.grn_id) };
};
/** A document row on `entityType` / `entityId` (as the upload would store it), its id. */
const doc = async (entityType: string, entityId: string, name: string) => String((await pool.query(
  `INSERT INTO procurement_documents (entity_type, entity_id, document_type, document_name, file_url, uploaded_by, is_active)
   VALUES ($1, $2, 'other', $3, 'https://files.test/d', 'test', true) RETURNING id`, [entityType, entityId, name])).rows[0].id);
const linkRow = (document: string, linkedType: string, linkedId: string, reason: string | null) => pool.query(
  'INSERT INTO document_links (document_id, linked_entity_type, linked_entity_id, link_reason) VALUES ($1, $2, $3, $4)', [document, linkedType, linkedId, reason]);
const draftBill = async (grnId: string, purchaseOrderId?: string): Promise<string> => {
  const req = await openRequest(pool, f, f.owner);
  try {
    const bill = await req.run(() => createSupplierInvoice(f.co, {
      invoiceNumber: `GRN-DL-${n++}-${Date.now()}`, supplierId: f.supplier, invoiceDate: '2026-06-15', grnId,
      ...(purchaseOrderId ? { purchaseOrderId } : {}),
      items: [{ description: 'Delivered goods', quantity: 1, unitPrice: 40, taxRate: 15, glAccountId: f.acc.opex }],
    }, f.owner));
    await req.commit();
    return bill.id;
  } catch (err) { await req.rollback(); throw err; }
};
/** `source:name:linkReason` of the entity's listing, as app_user of `fx`. */
const listed = async (fx: BillFixture, entityType: string, id: string): Promise<string[]> => {
  const req = await openRequest(pool, fx, fx.owner);
  try {
    const r = await req.run(() => listEntityDocuments(fx.co, entityType, id, 50, 0));
    return r.ok ? r.documents.map((d) => `${d.source}:${d.documentName}:${d.linkReason ?? ''}`).sort() : [`refused:${r.reason}`];
  } finally { await req.rollback(); }
};

describe('a goods_received listing is fenced to a note of the selected company (finding 2)', () => {
  it('another company\'s note sharing its id with this company\'s bill lists nothing, even to a user of both companies', async () => {
    const bill = await draftBill('');
    const theirs = await seedQtyPo(pool, other, { lines: [{ qty: 1, price: 1 }] });
    await pool.query(`INSERT INTO goods_received_notes (id, company_id, grn_number, purchase_order_id, received_by) VALUES ($1, $2, 'GRN-90001', $3, 'x')`,
      [bill, other.co, theirs.po]);
    await doc('goods_received', bill, 'THEIRS-shared.pdf');
    await pool.query("INSERT INTO company_users (company_id, user_id, role) VALUES ($1, $2, 'owner') ON CONFLICT DO NOTHING", [other.co, f.owner]);
    try {
      expect(await listed(f, 'goods_received', bill)).toEqual(['refused:entity_not_found']);
    } finally {
      await pool.query('DELETE FROM company_users WHERE company_id = $1 AND user_id = $2', [other.co, f.owner]);
    }
  });
});

describe('an older automatic link row follows the bill\'s current note and POs (finding 4)', () => {
  it('after the draft switches notes, the former note\'s auto-linked paperwork is gone; a manual link stays', async () => {
    const first = await noteOnPo(f);
    const second = await noteOnPo(f);
    const bill = await draftBill(first.grn);
    const auto = await doc('goods_received', first.grn, 'AUTO-first-note.pdf');
    const manual = await doc('goods_received', first.grn, 'MANUAL-first-note.pdf');
    await linkRow(auto, 'supplier_invoice', bill, 'grn_invoice_link');
    await linkRow(manual, 'supplier_invoice', bill, null);
    expect(await listed(f, 'supplier_invoice', bill)).toEqual(['linked:AUTO-first-note.pdf:grn_invoice_link', 'linked:MANUAL-first-note.pdf:']);
    const r = await callTool(pool, f, update, { invoice_id: bill, grn_id: second.grn });
    expect(r.isError, r.text).toBe(false);
    expect(await listed(f, 'supplier_invoice', bill)).toEqual(['linked:MANUAL-first-note.pdf:']);
  });

  it('after the PO is unlinked, its auto-linked paperwork is gone from the bill', async () => {
    const po = await seedQtyPo(pool, f, { lines: [{ qty: 4, price: 10 }] });
    const bill = await draftBill('', po.po);
    const auto = await doc('purchase_order', po.po, 'AUTO-po.pdf');
    await linkRow(auto, 'supplier_invoice', bill, 'po_invoice_link');
    expect(await listed(f, 'supplier_invoice', bill)).toEqual(['linked:AUTO-po.pdf:po_invoice_link']);
    const r = await callTool(pool, f, unlink, { po_id: po.po, bill_id: bill, reason: 'wrong PO' });
    expect(r.isError, r.text).toBe(false);
    expect(await listed(f, 'supplier_invoice', bill)).toEqual([]);
  });
});

describe('a note\'s listing includes scans linked under the legacy alias (finding 6)', () => {
  it('a bill scan linked to the note as goods_receipt_note is listed on the note', async () => {
    const { grn } = await noteOnPo(f);
    const bill = await draftBill(grn);
    const scan = await doc('supplier_invoice', bill, 'SCAN-legacy-alias.pdf');
    await linkRow(scan, 'goods_receipt_note', grn, 'grn_invoice_link');
    expect(await listed(f, 'goods_received', grn)).toEqual(['linked:SCAN-legacy-alias.pdf:grn_invoice_link']);
  });
});
