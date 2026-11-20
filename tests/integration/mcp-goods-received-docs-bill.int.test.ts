/**
 * A bill's documents include its goods received note's and its POs' documents, whatever the order they arrived in, and the legacy
 * `goods_receipt_note` document type is readable (merge-gate findings 2 and 4 on #1697; docs/design/mcp-goods-received.md
 * "Attachments"), real PostgreSQL, as app_user:
 *   - document first, then the bill: a delivery note on the note and a document on the PO, filed before the bill exists, are listed
 *     on the bill (no bill attachment needed);
 *   - bill first, then the documents: filed on the note and the PO after the bill, they are listed on it too;
 *   - a document already cross-linked to the bill (an older link row) is listed once;
 *   - another company's PO or note named by a bill (the ids carry no foreign key) lends it nothing, and neither does an older
 *     document_links row from the bill to another company's documents (gate finding 2 on #1697, a user of both companies);
 *   - procurement_documents' policy admits a legacy goods_receipt_note document of this company's note, and only that.
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
import { seedBill } from './helpers/poBillLinkHarness';
import { PDF } from './helpers/mcpUploadHarness';
import { callTool, dropGrnExtras, dropMaintExtras, grnArgs, seedQtyPo, type QtyPo } from './helpers/grnHarness';
import { createGoodsReceivedTool as create } from '@/lib/mcp/tools/writeCreateGoodsReceived';
import { attachEntityDocumentTool as attach } from '@/lib/mcp/tools/writeAttachEntityDocument';
import { createSupplierInvoice } from '@/modules/accounting/services/ap/supplierInvoiceService';
import { listEntityDocuments } from '@/modules/accounting/services/core/documentQueryService';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 6 });
let f: BillFixture;
let other: BillFixture;
let n = 0;

beforeAll(async () => {
  f = await seedBillFixture(pool, 'grn-docs-bill');
  other = await seedBillFixture(pool, 'grn-docs-bill-other');
}, 60_000);
afterAll(async () => {
  try {
    for (const x of [f, other]) {
      await pool.query(`DELETE FROM document_links WHERE linked_entity_id IN (SELECT id FROM supplier_invoices WHERE company_id = $1
                         UNION ALL SELECT id FROM goods_received_notes WHERE company_id = $1 UNION ALL SELECT id FROM purchase_orders WHERE company_id = $1)`, [x.co]);
      await pool.query(`DELETE FROM procurement_documents WHERE entity_type IN ('purchase_order', 'goods_receipt_note', 'supplier_invoice')
                         AND entity_id IN (SELECT id FROM purchase_orders WHERE company_id = $1 UNION ALL SELECT id FROM goods_received_notes WHERE company_id = $1
                                           UNION ALL SELECT id FROM supplier_invoices WHERE company_id = $1)`, [x.co]);
      await dropGrnExtras(pool, x); await dropMaintExtras(pool, x); await dropBillFixture(pool, x);
    }
  } finally { await pool.end(); }
}, 60_000);

const noteOnPo = async (fx: BillFixture): Promise<{ po: QtyPo; grn: string }> => {
  const po = await seedQtyPo(pool, fx, { lines: [{ qty: 4, price: 10 }] });
  const r = await callTool(pool, fx, create, grnArgs(po, [[0, 4]]));
  expect(r.isError, r.text).toBe(false);
  return { po, grn: String(r.body.grn_id) };
};
const fileOn = async (fx: BillFixture, entityType: 'goods_received' | 'purchase_order', entityId: string, name: string) => {
  const a = await callTool(pool, fx, attach, {
    entity_type: entityType, entity_id: entityId, file_name: name, mime_type: 'application/pdf', content: PDF(`${name} ${entityId}`).toString('base64'),
  });
  expect(a.isError, a.text).toBe(false);
};
const legacyDoc = async (grn: string, name: string) => String((await pool.query(
  `INSERT INTO procurement_documents (entity_type, entity_id, document_type, document_name, file_url, uploaded_by, is_active)
   VALUES ('goods_receipt_note', $1, 'delivery_note', $2, 'https://files.test/legacy', 'legacy', true) RETURNING id`, [grn, name])).rows[0].id);
const createBill = async (grnId: string, over: { purchaseOrderId?: string; poItemId?: string } = {}): Promise<string> => {
  const req = await openRequest(pool, f, f.owner);
  try {
    const bill = await req.run(() => createSupplierInvoice(f.co, {
      invoiceNumber: `GRN-DOC-${n++}-${Date.now()}`, supplierId: f.supplier, invoiceDate: '2026-06-15', grnId,
      ...(over.purchaseOrderId ? { purchaseOrderId: over.purchaseOrderId } : {}),
      items: [{ description: 'Delivered goods', quantity: 1, unitPrice: 40, taxRate: 15, glAccountId: f.acc.opex, ...(over.poItemId ? { poItemId: over.poItemId } : {}) }],
    }, f.owner));
    await req.commit();
    return bill.id;
  } catch (err) { await req.rollback(); throw err; }
};
/** The bill's listing as the app and list_documents read it: `source:name:linkReason`, as app_user of `fx`. */
const onBill = async (fx: BillFixture, bill: string): Promise<string[]> => {
  const req = await openRequest(pool, fx, fx.owner);
  try {
    const r = await req.run(() => listEntityDocuments(fx.co, 'supplier_invoice', bill, 50, 0));
    return r.ok ? r.documents.map((d) => `${d.source}:${d.documentName}:${d.linkReason ?? ''}`).sort() : [`refused:${r.reason}`];
  } finally { await req.rollback(); }
};

describe('a bill lists its note\'s and its POs\' documents (finding 4)', () => {
  it('document first, then the bill: filed before the bill exists, they are listed on it', async () => {
    const { po, grn } = await noteOnPo(f);
    await fileOn(f, 'goods_received', grn, 'DN-first.pdf');
    await fileOn(f, 'purchase_order', po.po, 'PO-first.pdf');
    await legacyDoc(grn, 'LEGACY-first.pdf');
    const bill = await createBill(grn, { purchaseOrderId: po.po });
    expect(await onBill(f, bill)).toEqual(['linked:DN-first.pdf:grn_invoice_link', 'linked:LEGACY-first.pdf:grn_invoice_link', 'linked:PO-first.pdf:po_invoice_link']);
  });

  it('bill first, then the documents: filed after the bill, they are listed on it; a PO its lines name counts too', async () => {
    const { po, grn } = await noteOnPo(f);
    const bill = await createBill(grn, { poItemId: po.items[0] });
    expect(await onBill(f, bill)).toEqual([]);
    await fileOn(f, 'goods_received', grn, 'DN-later.pdf');
    await fileOn(f, 'purchase_order', po.po, 'PO-later.pdf');
    expect(await onBill(f, bill)).toEqual(['linked:DN-later.pdf:grn_invoice_link', 'linked:PO-later.pdf:po_invoice_link']);
  });

  it('a document already cross-linked to the bill by an older link row is listed once', async () => {
    const { grn } = await noteOnPo(f);
    const bill = await createBill(grn);
    await fileOn(f, 'goods_received', grn, 'DN-once.pdf');
    const doc = String((await pool.query("SELECT id FROM procurement_documents WHERE entity_type = 'goods_received' AND entity_id = $1", [grn])).rows[0].id);
    await pool.query("INSERT INTO document_links (document_id, linked_entity_type, linked_entity_id, link_reason) VALUES ($1, 'supplier_invoice', $2, 'grn_invoice_link')", [doc, bill]);
    expect(await onBill(f, bill)).toEqual(['linked:DN-once.pdf:grn_invoice_link']);
  });

  it('another company\'s PO or note named by a bill lends it nothing, even to a user of both companies', async () => {
    const theirs = await noteOnPo(other);
    await fileOn(other, 'goods_received', theirs.grn, 'THEIRS-dn.pdf');
    await fileOn(other, 'purchase_order', theirs.po.po, 'THEIRS-po.pdf');
    const bill = await seedBill(pool, f, { status: 'draft', lines: [40] });
    await pool.query('UPDATE supplier_invoices SET grn_id = $2, purchase_order_id = $3 WHERE id = $1', [bill.id, theirs.grn, theirs.po.po]);
    await pool.query("INSERT INTO company_users (company_id, user_id, role) VALUES ($1, $2, 'owner') ON CONFLICT DO NOTHING", [other.co, f.owner]);
    try {
      expect(await onBill(f, bill.id)).toEqual([]);
    } finally {
      await pool.query('DELETE FROM company_users WHERE company_id = $1 AND user_id = $2', [other.co, f.owner]);
    }
  });
});

describe('an older document_links row lends a bill only its own company\'s documents (gate finding 2)', () => {
  it('a link row from this bill to another company\'s note, PO or bill documents (any type) lists none of them, even to a user of both', async () => {
    const theirs = await noteOnPo(other);
    await fileOn(other, 'goods_received', theirs.grn, 'XLINK-dn.pdf');
    await fileOn(other, 'purchase_order', theirs.po.po, 'XLINK-po.pdf');
    await legacyDoc(theirs.grn, 'XLINK-legacy.pdf');
    const theirBill = await seedBill(pool, other, { status: 'draft', lines: [40] });
    await pool.query(`INSERT INTO procurement_documents (entity_type, entity_id, document_type, document_name, file_url, uploaded_by, is_active)
                      VALUES ('supplier_invoice', $1, 'invoice', 'XLINK-bill.pdf', 'https://files.test/x', 'x', true)`, [theirBill.id]);
    const ours = await noteOnPo(f);
    await fileOn(f, 'goods_received', ours.grn, 'XLINK-ours.pdf');
    const bill = await seedBill(pool, f, { status: 'draft', lines: [40] });
    await pool.query(`INSERT INTO document_links (document_id, linked_entity_type, linked_entity_id, link_reason)
                      SELECT d.id, 'supplier_invoice', $1, 'grn_invoice_link' FROM procurement_documents d WHERE d.document_name LIKE 'XLINK-%'`, [bill.id]);
    await pool.query("INSERT INTO company_users (company_id, user_id, role) VALUES ($1, $2, 'owner') ON CONFLICT DO NOTHING", [other.co, f.owner]);
    try {
      expect(await onBill(f, bill.id)).toEqual(['linked:XLINK-ours.pdf:grn_invoice_link']);
    } finally {
      await pool.query('DELETE FROM company_users WHERE company_id = $1 AND user_id = $2', [other.co, f.owner]);
    }
  });
});

describe('the legacy goods_receipt_note document type (finding 2)', () => {
  it('app_user sees (and may deactivate) a legacy document of this company\'s note, never one of another company\'s note', async () => {
    const ours = await noteOnPo(f);
    const theirs = await noteOnPo(other);
    const mine = await legacyDoc(ours.grn, 'LEGACY-ours.pdf');
    const foreign = await legacyDoc(theirs.grn, 'LEGACY-theirs.pdf');
    const req = await openRequest(pool, f, f.owner);
    try {
      const seen = (await req.client.query('SELECT id FROM procurement_documents WHERE id = ANY($1::UUID[])', [[mine, foreign]])).rows.map((r) => String(r.id));
      expect(seen).toEqual([mine]);
      expect((await req.client.query('UPDATE procurement_documents SET is_active = false WHERE id = ANY($1::UUID[]) RETURNING id', [[mine, foreign]])).rows)
        .toEqual([{ id: mine }]);
    } finally { await req.rollback(); }
  });
});
