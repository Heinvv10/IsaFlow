/**
 * A cancelled goods received note on the PO's other paths (docs/design/mcp-goods-received.md, review M2 / L4), real PostgreSQL, as
 * app_user (grnHarness):
 *   - once every note on a PO is cancelled, cancel_purchase_order cancels it and update_purchase_order edits its header; replacing its
 *     lines, or setting an imported PO back to draft (where the PUT replaces lines and the DELETE removes the PO), stays refused,
 *     because the cancelled notes keep their items, which name those lines (kept as the record, never deleted);
 *   - the bill's GRN picker (GET purchase-orders/unmatched, by PO and by supplier) and the item-movement report leave a cancelled
 *     note out.
 * Fixture route: isaflow_schema_fixture (assertDisposable). Never skips.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { callRoute, dropBillFixture, seedBillFixture, setPolicy, type BillFixture } from './helpers/budgetBillFixture';
import { callTool, dropGrnExtras, dropMaintExtras, grnArgs, poState, seedQtyPo, type QtyPo } from './helpers/grnHarness';
import { poLines, poRow } from './helpers/poMaintHarness';
import { createGoodsReceivedTool as create } from '@/lib/mcp/tools/writeCreateGoodsReceived';
import { cancelGoodsReceivedTool as cancelGrn } from '@/lib/mcp/tools/writeCancelGoodsReceived';
import { updatePurchaseOrderTool as updatePo } from '@/lib/mcp/tools/writeUpdatePurchaseOrder';
import { cancelPurchaseOrderTool as cancelPo } from '@/lib/mcp/tools/writeCancelPurchaseOrder';
import { setPurchaseOrderStatusTool as setStatus } from '@/lib/mcp/tools/writeSetPurchaseOrderStatus';
import unmatchedRoute from '../../pages/api/accounting/purchase-orders/unmatched';
import itemMovementRoute from '../../pages/api/accounting/reports/item-movement';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
let f: BillFixture;
const stock: string[] = [];

beforeAll(async () => {
  f = await seedBillFixture(pool, 'grn-po-loop');
  await setPolicy(pool, f, 'warn');
}, 60_000);
afterAll(async () => {
  try {
    await dropGrnExtras(pool, f);
    await dropMaintExtras(pool, f);
    await pool.query('UPDATE po_items SET product_id = NULL WHERE product_id = ANY($1::UUID[])', [stock]);
    await pool.query('DELETE FROM products WHERE id = ANY($1::UUID[])', [stock]);
    await dropBillFixture(pool, f);
  } finally { await pool.end(); }
}, 60_000);

const receive = async (po: QtyPo, qty: number) => {
  const r = await callTool(pool, f, create, grnArgs(po, [[0, qty]]));
  expect(r.isError, r.text).toBe(false);
  return { id: String(r.body.grn_id), number: String(r.body.grn_number) };
};
const cancelNote = async (grn: string) => {
  const r = await callTool(pool, f, cancelGrn, { grn_id: grn, reason: 'delivered to the wrong site' });
  expect(r.isError, r.text).toBe(false);
};
const line = { description: 'Replacement', quantity: 1, unit_price: 5, tax_rate: 0, gl_account_id: '' };

describe('a PO whose every note is cancelled (M2)', () => {
  it('cancel_purchase_order cancels it; update_purchase_order edits its header but cannot replace the lines the cancelled notes name', async () => {
    const po = await seedQtyPo(pool, f, { lines: [{ qty: 5, price: 10 }] });
    await cancelNote((await receive(po, 2)).id);
    await cancelNote((await receive(po, 3)).id);
    expect(await poState(pool, po)).toEqual({ status: 'approved', received: [0] });

    const header = await callTool(pool, f, updatePo, { po_id: po.po, notes: 'after the receipts were cancelled' });
    expect(header.isError, header.text).toBe(false);
    expect((await poRow(pool, po.po)).notes).toBe('after the receipts were cancelled');

    const lines = await callTool(pool, f, updatePo, { po_id: po.po, lines: [{ ...line, gl_account_id: f.acc.opex }] });
    expect(lines.isError).toBe(true);
    expect(lines.text).toContain('cancelled goods received note');
    expect((await poLines(pool, po.po)).map((l) => l.line_total)).toEqual(['50.00']);

    const cancelled = await callTool(pool, f, cancelPo, { po_id: po.po, reason: 'no longer needed' });
    expect(cancelled.isError, cancelled.text).toBe(false);
    expect((await poRow(pool, po.po)).status).toBe('cancelled');
  });

  it('a live note still refuses both; an imported PO is closed by set_purchase_order_status but not set back to draft', async () => {
    const po = await seedQtyPo(pool, f, { lines: [{ qty: 5, price: 10 }] });
    // Rejected goods only: the PO stays approved, and the note is still a receipt on record.
    const rejected = await callTool(pool, f, create, grnArgs(po, [[0, 0, 1]]));
    expect(rejected.isError, rejected.text).toBe(false);
    const live = { id: String(rejected.body.grn_id) };
    expect(await poState(pool, po)).toEqual({ status: 'approved', received: [0] });
    const cancelled = await callTool(pool, f, cancelPo, { po_id: po.po, reason: 'x' });
    expect(cancelled.text).toContain('a receipt is on record');
    expect((await callTool(pool, f, updatePo, { po_id: po.po, notes: 'x' })).text).toContain('a receipt is on record');
    await cancelNote(live.id);
    expect((await callTool(pool, f, updatePo, { po_id: po.po, notes: 'free again' })).isError).toBe(false);

    const imported = await seedQtyPo(pool, f, { external: true, lines: [{ qty: 4, price: 10 }] });
    await cancelNote((await receive(imported, 4)).id);
    const draft = await callTool(pool, f, setStatus, { po_id: imported.po, status: 'draft', reason: 'x' });
    expect(draft.isError).toBe(true);
    expect(draft.text).toContain('cancelled goods received note');
    expect((await poRow(pool, imported.po)).status).toBe('approved');
    const closed = await callTool(pool, f, setStatus, { po_id: imported.po, status: 'closed', reason: 'billed in Sage' });
    expect(closed.isError, closed.text).toBe(false);
    expect((await poRow(pool, imported.po)).status).toBe('closed');
  });
});

describe('the reads that leave a cancelled note out (L4)', () => {
  it('GET purchase-orders/unmatched lists the live note only, by PO and by supplier', async () => {
    const po = await seedQtyPo(pool, f, { lines: [{ qty: 10, price: 1 }] });
    const live = await receive(po, 2);
    const gone = await receive(po, 3);
    await cancelNote(gone.id);
    for (const query of [{ supplierId: f.supplier, purchaseOrderId: po.po, include: 'grns' }, { supplierId: f.supplier, include: 'grns' }]) {
      const r = await callRoute(unmatchedRoute as never, f, f.owner, '/api/accounting/purchase-orders/unmatched', undefined, { method: 'GET', query });
      expect(r.statusCode, JSON.stringify(r.body)).toBe(200);
      const ids = ((r.body.data as { grns: Array<{ id: string }> }).grns).map((g) => g.id);
      expect(ids, JSON.stringify(query)).toContain(live.id);
      expect(ids, JSON.stringify(query)).not.toContain(gone.id);
    }
  });

  it('the item-movement report counts the live note only, for one item and for all', async () => {
    const product = crypto.randomUUID();
    stock.push(product);
    await pool.query("INSERT INTO products (id, company_id, code, name) VALUES ($1, $2, 'GRN-MOVE', 'Moved item')", [product, f.co]);
    // A product-backed PO line: the receipt itself copies the line's product onto its items (Codex gate at 1cf5bdc1, 1); the test no
    // longer sets grn_items.product_id by hand, and no stock_items row shares the product's id (the report reads products).
    const po = await seedQtyPo(pool, f, { lines: [{ qty: 10, price: 1 }] });
    await pool.query('UPDATE po_items SET product_id = $2 WHERE id = $1', [po.items[0], product]);
    const live = await receive(po, 2);
    const gone = await receive(po, 5);
    expect((await pool.query('SELECT DISTINCT product_id::text AS p FROM grn_items WHERE grn_id = ANY($1::UUID[])', [[live.id, gone.id]])).rows)
      .toEqual([{ p: product }]);
    await cancelNote(gone.id);
    for (const query of [{ item_id: product }, {}]) {
      const r = await callRoute(itemMovementRoute as never, f, f.owner, '/api/accounting/reports/item-movement', undefined,
        { method: 'GET', query: { from: '2026-06-01', to: '2026-06-30', ...query } });
      expect(r.statusCode, JSON.stringify(r.body)).toBe(200);
      const rows = (r.body.data as Array<{ reference: string; qtyIn: number }>).filter((m) => [live.number, gone.number].includes(m.reference));
      expect(rows, JSON.stringify(query)).toEqual([expect.objectContaining({ reference: live.number, qtyIn: 2, itemName: 'Moved item', itemCode: 'GRN-MOVE' })]);
    }
  });
});
