/**
 * get_goods_received / list_goods_received reads (merge-gate findings 4, 5 and 6 on #1697; docs/design/mcp-goods-received.md),
 * real PostgreSQL, as app_user:
 *   - a note's documents filed under the legacy entity type goods_receipt_note are listed and counted beside goods_received ones;
 *   - the widest valid note (100 items, every text field at its limit in three-byte characters, documents and bills at their caps)
 *     answers every items page under MAX_READ_RESULT_BYTES through a real McpRegistry, and the pages walk every item once;
 *   - an item whose legacy PO line belongs to another PO is kept (with its quantities, the line's metadata null), so items_total
 *     counts it, as the cancel's items_not_on_po refusal does.
 * Fixture route: isaflow_schema_fixture (assertDisposable). Never skips.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { dropBillFixture, seedBillFixture, type BillFixture } from './helpers/budgetBillFixture';
import { seedBill } from './helpers/poBillLinkHarness';
import { callRegistry, callTool, dropGrnExtras, dropMaintExtras, grnArgs, seedQtyPo, type QtyPo } from './helpers/grnHarness';
import { createGoodsReceivedTool as create } from '@/lib/mcp/tools/writeCreateGoodsReceived';
import { cancelGoodsReceivedTool as cancel } from '@/lib/mcp/tools/writeCancelGoodsReceived';
import { getGoodsReceivedTool as getGrn, listGoodsReceivedTool as listGrn } from '@/lib/mcp/tools/goodsReceivedReadTools';
import { MAX_READ_RESULT_BYTES } from '@/lib/mcp/resultSize';
import { GRN_DETAIL_CAPS } from '@/modules/accounting/services/ap/goodsReceivedReadService';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
let f: BillFixture;
/** Three bytes in UTF-8, and JSON.stringify writes it as it is. */
const wide = (chars: number) => '€'.repeat(chars);

beforeAll(async () => { f = await seedBillFixture(pool, 'grn-read'); }, 60_000);
afterAll(async () => {
  try {
    await pool.query(`DELETE FROM procurement_documents WHERE entity_type = 'goods_receipt_note'
                       AND entity_id IN (SELECT id FROM goods_received_notes WHERE company_id = $1)`, [f.co]);
    await dropGrnExtras(pool, f); await dropMaintExtras(pool, f); await dropBillFixture(pool, f);
  } finally { await pool.end(); }
}, 120_000);

const received = async (lines = 1): Promise<{ po: QtyPo; grn: string }> => {
  const po = await seedQtyPo(pool, f, { lines: Array.from({ length: lines }, () => ({ qty: 4, price: 10 })) });
  const r = await callTool(pool, f, create, grnArgs(po, po.items.map((_, i) => [i, 3] as [number, number])));
  expect(r.isError, r.text).toBe(false);
  return { po, grn: String(r.body.grn_id) };
};
const fileDoc = async (grn: string, entityType: 'goods_received' | 'goods_receipt_note', name: string) => pool.query(
  `INSERT INTO procurement_documents (entity_type, entity_id, document_type, document_name, file_url, uploaded_by, mime_type, file_size, is_active)
   VALUES ($1, $2, 'delivery_note', $3, 'https://files.test/d', 'test', 'application/pdf', 123456, true)`, [entityType, grn, name]);
const get = async (args: Record<string, unknown>) => {
  const r = await callRegistry(pool, f, getGrn, args);
  return { ...r, bytes: Buffer.byteLength(r.text, 'utf8'), body: r.isError ? {} : JSON.parse(r.text) as Record<string, unknown> };
};

describe('a note\'s legacy goods_receipt_note documents (gate finding 4)', () => {
  it('get_goods_received lists them and list_goods_received counts them, beside goods_received ones', async () => {
    const { grn } = await received();
    await fileDoc(grn, 'goods_received', 'DN-new.pdf');
    await fileDoc(grn, 'goods_receipt_note', 'DN-legacy.pdf');
    const detail = await get({ grn_id: grn });
    expect(detail.isError, detail.text).toBe(false);
    expect((detail.body.documents as Array<{ name: string }>).map((d) => d.name).sort()).toEqual(['DN-legacy.pdf', 'DN-new.pdf']);
    expect(detail.body.documents_total).toBe(2);
    const list = await callRegistry(pool, f, listGrn, {});
    const row = (JSON.parse(list.text).goods_received_notes as Array<{ id: string; document_count: number }>).find((n) => n.id === grn);
    expect(row?.document_count).toBe(2);
  });
});

describe('the widest valid note fits a client\'s result limit (gate finding 5)', () => {
  it('100 items with 150 three-byte characters in description and notes: every page is under MAX_READ_RESULT_BYTES and the pages walk every item', async () => {
    const po = await seedQtyPo(pool, f, { lines: Array.from({ length: 100 }, () => ({ qty: 4, price: 10 })) });
    await pool.query('UPDATE po_items SET description = $2 WHERE purchase_order_id = $1', [po.po, wide(150)]);
    await pool.query('UPDATE suppliers SET name = $2 WHERE id = $1', [f.supplier, wide(255)]);
    const r = await callTool(pool, f, create, {
      ...grnArgs(po, po.items.map((_, i) => [i, 3] as [number, number])),
      received_by: wide(200), notes: wide(500), external_system: wide(32), external_ref: wide(128),
      lines: po.items.map((id) => ({ po_item_id: id, quantity_received: 3, quantity_rejected: 1, notes: wide(150) })),
    });
    expect(r.isError, r.text).toBe(false);
    const grn = String(r.body.grn_id);
    expect((await callTool(pool, f, cancel, { grn_id: grn, reason: wide(500) })).isError).toBe(false);
    for (let i = 0; i < GRN_DETAIL_CAPS.documents + 1; i++) await fileDoc(grn, 'goods_received', `${wide(150)}${i}`);
    for (let i = 0; i < GRN_DETAIL_CAPS.bills + 1; i++) {
      const bill = await seedBill(pool, f, { status: 'draft', lines: [10] });
      await pool.query('UPDATE supplier_invoices SET grn_id = $2, invoice_number = $3 WHERE id = $1', [bill.id, grn, `${wide(46)}${String(i).padStart(4, '0')}`]);
    }

    const seen: string[] = [];
    let offset: number | null = 0;
    let pages = 0;
    while (offset !== null) {
      const page = await get({ grn_id: grn, items_offset: offset });
      expect(page.isError, page.text.slice(0, 300)).toBe(false);
      expect(page.bytes).toBeLessThan(MAX_READ_RESULT_BYTES);
      expect(page.body).toMatchObject({ items_total: 100, items_truncated: true, items_offset: offset, documents_total: 26, bills_total: 26 });
      seen.push(...(page.body.items as Array<{ id: string }>).map((i) => i.id));
      offset = page.body.items_next_offset as number | null;
      pages += 1;
    }
    expect(pages).toBe(Math.ceil(100 / GRN_DETAIL_CAPS.items));
    expect(new Set(seen).size).toBe(100);
    expect(await get({ grn_id: grn, items_limit: GRN_DETAIL_CAPS.items + 1 })).toMatchObject({ isError: true });
    expect((await get({ grn_id: grn, items_offset: 200 })).body).toMatchObject({ items: [], items_total: 100, items_next_offset: null });
  }, 120_000);
});

describe('an item whose legacy PO line is on another PO (gate finding 6)', () => {
  it('is kept with its quantities and the line\'s metadata null; items_total counts it', async () => {
    const { grn } = await received();
    const b = await seedQtyPo(pool, f, { lines: [{ qty: 5, price: 10, received: 2 }], status: 'partially_received' });
    const c = await pool.connect();
    try {
      // As mcp-goods-received-cancel-locks' legacyOffPoNote: 1021's item guards off for the one insert, a legacy row.
      await c.query('BEGIN');
      await c.query('ALTER TABLE grn_items DISABLE TRIGGER trg_grn_items_po_line_guard');
      await c.query('ALTER TABLE grn_items DISABLE TRIGGER trg_grn_items_same_transaction_guard');
      await c.query('INSERT INTO grn_items (grn_id, po_item_id, quantity_received, quantity_rejected) VALUES ($1, $2, 2, 1)', [grn, b.items[0]]);
      await c.query('ALTER TABLE grn_items ENABLE ALWAYS TRIGGER trg_grn_items_po_line_guard');
      await c.query('ALTER TABLE grn_items ENABLE ALWAYS TRIGGER trg_grn_items_same_transaction_guard');
      await c.query('COMMIT');
    } catch (err) { await c.query('ROLLBACK'); throw err; } finally { c.release(); }
    const detail = await get({ grn_id: grn });
    expect(detail.isError, detail.text).toBe(false);
    expect(detail.body.items_total).toBe(2);
    const items = detail.body.items as Array<Record<string, unknown>>;
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({ on_purchase_order: true, quantity_ordered: 4, quantity_received: 3, po_line_quantity_received: 3 });
    expect(items[1]).toMatchObject({
      po_item_id: b.items[0], on_purchase_order: false, description: null, quantity_ordered: null, po_line_quantity_received: null,
      quantity_received: 2, quantity_rejected: 1,
    });
    const list = await callRegistry(pool, f, listGrn, {});
    expect((JSON.parse(list.text).goods_received_notes as Array<{ id: string; line_count: number }>).find((n) => n.id === grn)?.line_count).toBe(2);
  });
});
