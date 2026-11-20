/**
 * create_goods_received / cancel_goods_received refusals and fences, list_goods_received / get_goods_received, find_by_external_ref
 * (docs/design/mcp-goods-received.md), real PostgreSQL, as app_user (grnHarness). Acceptance items:
 *   4. cancel is refused for a note on a bill (naming it), for a note already cancelled, and for a note on a closed PO;
 *   6. another company's PO or note is not_found; lists never show another company's notes.
 * Plus: per-line refusals (line_not_on_po, duplicate_line, a PO that is not receivable),
 * cancelled notes kept out of the three-way match, find_by_external_ref kind goods_received.
 * Fixture route: isaflow_schema_fixture (assertDisposable). Never skips.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { dropBillFixture, seedBillFixture, type BillFixture } from './helpers/budgetBillFixture';
import { asOwner } from './helpers/poImportHarness';
import { seedBill } from './helpers/poBillLinkHarness';
import {
  callTool, dropGrnExtras, dropMaintExtras, grnArgs, grnRows, poState, refusal, seedQtyPo, type Json,
} from './helpers/grnHarness';
import { createGoodsReceivedTool as create } from '@/lib/mcp/tools/writeCreateGoodsReceived';
import { cancelGoodsReceivedTool as cancel } from '@/lib/mcp/tools/writeCancelGoodsReceived';
import { getGoodsReceivedTool as getGrn, listGoodsReceivedTool as listGrn } from '@/lib/mcp/tools/goodsReceivedReadTools';
import { findByExternalRefTool as findRef } from '@/lib/mcp/tools/externalRef';
import { readMatchInputs } from '@/modules/accounting/services/ap/threeWayMatchState';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
let f: BillFixture;
let other: BillFixture;

beforeAll(async () => {
  f = await seedBillFixture(pool, 'grn-refusals');
  other = await seedBillFixture(pool, 'grn-refusals-other');
}, 60_000);
afterAll(async () => {
  try {
    for (const x of [f, other]) { await dropGrnExtras(pool, x); await dropMaintExtras(pool, x); await dropBillFixture(pool, x); }
  } finally { await pool.end(); }
}, 60_000);

const received = async (fx: BillFixture, lines: number[], take: number[]) => {
  const po = await seedQtyPo(pool, fx, { lines: lines.map((qty) => ({ qty, price: 10 })) });
  const r = await callTool(pool, fx, create, grnArgs(po, take.map((q, i) => [i, q] as [number, number])));
  expect(r.isError, r.text).toBe(false);
  return { po, grn: String(r.body.grn_id), number: String(r.body.grn_number) };
};

describe('create refusals', () => {
  it('a line not on the PO and a PO line twice are refused per line; a draft / closed / cancelled PO is po_not_receivable', async () => {
    const po = await seedQtyPo(pool, f, { lines: [{ qty: 5, price: 1 }, { qty: 5, price: 1 }] });
    const foreignLine = (await seedQtyPo(pool, f, { lines: [{ qty: 1, price: 1 }] })).items[0]!;
    const notes = await grnRows(pool, f);
    const notOnPo = await callTool(pool, f, create, { ...grnArgs(po, [[0, 1]]), lines: [{ po_item_id: po.items[0], quantity_received: 1 }, { po_item_id: foreignLine, quantity_received: 1 }] });
    expect(refusal(notOnPo.text)).toMatchObject({ code: 'line_not_on_po', lines: [{ index: 1, po_item_id: foreignLine, code: 'line_not_on_po' }] });
    const twice = await callTool(pool, f, create, grnArgs(po, [[0, 1], [1, 1], [0, 2]]));
    expect(refusal(twice.text)).toMatchObject({ code: 'duplicate_line', lines: [{ index: 2, po_item_id: po.items[0], code: 'duplicate_line' }] });
    for (const status of ['draft', 'closed', 'cancelled']) {
      const p = await seedQtyPo(pool, f, { status, lines: [{ qty: 5, price: 1 }] });
      expect(refusal((await callTool(pool, f, create, grnArgs(p, [[0, 1]]))).text), status).toMatchObject({ code: 'po_not_receivable', po_status: status });
    }
    expect(await grnRows(pool, f)).toEqual(notes);
    expect(await poState(pool, po)).toEqual({ status: 'approved', received: [0, 0] });
  });
});

describe('cancel refusals (4)', () => {
  it('a note on a bill is refused naming the bill; deleting the bill frees it', async () => {
    const { po, grn, number } = await received(f, [4], [4]);
    const bill = await seedBill(pool, f, { status: 'draft', lines: [40] });
    await pool.query('UPDATE supplier_invoices SET grn_id = $2 WHERE id = $1', [bill.id, grn]);
    const invoiceNumber = String((await pool.query('SELECT invoice_number FROM supplier_invoices WHERE id = $1', [bill.id])).rows[0].invoice_number);
    const r = await callTool(pool, f, cancel, { grn_id: grn, reason: 'x' });
    expect(refusal(r.text)).toMatchObject({ code: 'grn_on_bill', bills: [{ id: bill.id, invoice_number: invoiceNumber }], bills_total: 1, written: false });
    expect(refusal(r.text).message).toContain(number);
    expect(await poState(pool, po)).toEqual({ status: 'received', received: [4] });
    await pool.query('UPDATE supplier_invoices SET deleted_at = now() WHERE id = $1', [bill.id]);
    expect((await callTool(pool, f, cancel, { grn_id: grn, reason: 'x' })).isError).toBe(false);
  });

  it('a note already cancelled, and a note on a closed or cancelled PO, are refused with nothing written', async () => {
    const { po, grn } = await received(f, [4], [2]);
    expect((await callTool(pool, f, cancel, { grn_id: grn, reason: 'first' })).isError).toBe(false);
    const again = await callTool(pool, f, cancel, { grn_id: grn, reason: 'second' });
    expect(refusal(again.text)).toMatchObject({ code: 'already_cancelled' });
    expect((await grnRows(pool, f)).find((r) => r.id === grn)).toMatchObject({ cancel_reason: 'first' });

    for (const status of ['closed', 'cancelled']) {
      const x = await received(f, [4], [3]);
      await pool.query('UPDATE purchase_orders SET status = $2 WHERE id = $1', [x.po.po, status]);
      const r = await callTool(pool, f, cancel, { grn_id: x.grn, reason: 'x' });
      expect(refusal(r.text), status).toMatchObject({ code: 'po_not_receivable', po_status: status });
      expect(await poState(pool, x.po)).toEqual({ status, received: [3] });
      expect((await grnRows(pool, f)).find((r) => r.id === x.grn)).toMatchObject({ status: 'received' });
    }
    expect(await poState(pool, po)).toEqual({ status: 'approved', received: [0] });
  });

  it('a reason is required, and a dry run of a refused cancel answers the same refusal', async () => {
    const { grn } = await received(f, [2], [1]);
    expect((await callTool(pool, f, cancel, { grn_id: grn, reason: ' ' })).text).toContain('reason is required');
    await pool.query("UPDATE purchase_orders SET status = 'closed' WHERE id = (SELECT purchase_order_id FROM goods_received_notes WHERE id = $1)", [grn]);
    expect(refusal((await callTool(pool, f, cancel, { grn_id: grn, reason: 'x', dry_run: true })).text)).toMatchObject({ code: 'po_not_receivable', dry_run: true });
  });
});

describe('tenancy (6)', () => {
  it('another company\'s PO, PO line and note are not_found; its notes never list', async () => {
    const theirs = await received(other, [5], [1]);
    const ours = await seedQtyPo(pool, f, { lines: [{ qty: 5, price: 1 }] });
    expect(refusal((await callTool(pool, f, create, grnArgs(theirs.po, [[0, 1]]))).text)).toMatchObject({ code: 'not_found', message: 'Not found' });
    const crossLine = await callTool(pool, f, create, { ...grnArgs(ours, [[0, 1]]), lines: [{ po_item_id: theirs.po.items[0], quantity_received: 1 }] });
    expect(refusal(crossLine.text)).toMatchObject({ code: 'line_not_on_po' });
    expect(refusal((await callTool(pool, f, cancel, { grn_id: theirs.grn, reason: 'x' })).text)).toMatchObject({ code: 'not_found', message: 'Not found' });
    expect((await callTool(pool, f, getGrn, { grn_id: theirs.grn })).text).toBe('Not found');
    const listed = await callTool(pool, f, listGrn, {});
    expect((listed.body.goods_received_notes as Json[]).map((n) => n.id)).not.toContain(theirs.grn);
    expect((await callTool(pool, f, listGrn, { po_id: theirs.po.po })).body).toMatchObject({ total: 0 });
    expect(await poState(pool, theirs.po)).toEqual({ status: 'partially_received', received: [1] });
  });

  it('a user of both companies, working in one, never sees or touches the other\'s notes (row security alone admits both)', async () => {
    const theirs = await received(other, [5], [1]);
    await pool.query("INSERT INTO company_users (company_id, user_id, role) VALUES ($1, $2, 'owner') ON CONFLICT DO NOTHING", [other.co, f.owner]);
    try {
      const listed = await callTool(pool, f, listGrn, {});
      expect((listed.body.goods_received_notes as Json[]).map((n) => n.id)).not.toContain(theirs.grn);
      expect((await callTool(pool, f, listGrn, { po_id: theirs.po.po })).body).toMatchObject({ total: 0 });
      expect((await callTool(pool, f, getGrn, { grn_id: theirs.grn })).text).toBe('Not found');
      expect(refusal((await callTool(pool, f, cancel, { grn_id: theirs.grn, reason: 'x' })).text)).toMatchObject({ code: 'not_found' });
      expect(refusal((await callTool(pool, f, create, grnArgs(theirs.po, [[0, 1]]))).text)).toMatchObject({ code: 'not_found' });
      expect(await poState(pool, theirs.po)).toEqual({ status: 'partially_received', received: [1] });
    } finally {
      await pool.query('DELETE FROM company_users WHERE company_id = $1 AND user_id = $2', [other.co, f.owner]);
    }
  });
});

describe('reads', () => {
  it('list and get show the note, its items with the PO line, its bills and its cancel details', async () => {
    const { po, grn, number } = await received(f, [8, 2], [3, 2]);
    const bill = await seedBill(pool, f, { status: 'draft', lines: [30] });
    await pool.query('UPDATE supplier_invoices SET grn_id = $2 WHERE id = $1', [bill.id, grn]);
    const got = await callTool(pool, f, getGrn, { grn_id: grn });
    expect(got.body.goods_received_note).toMatchObject({ id: grn, grn_number: number, status: 'received', purchase_order_id: po.po, supplier_id: f.supplier });
    expect(got.body.items).toEqual([
      expect.objectContaining({ po_item_id: po.items[0], description: 'Qty line 0', quantity_ordered: 8, quantity_received: 3, po_line_quantity_received: 3 }),
      expect.objectContaining({ po_item_id: po.items[1], quantity_ordered: 2, quantity_received: 2 }),
    ]);
    expect(got.body).toMatchObject({ items_total: 2, bills_total: 1, bills: [expect.objectContaining({ id: bill.id, deleted: false })] });
    const listed = await callTool(pool, f, listGrn, { po_id: po.po });
    expect(listed.body).toMatchObject({ total: 1, next_offset: null, goods_received_notes: [expect.objectContaining({ id: grn, line_count: 2, document_count: 0, po_status: 'partially_received' })] });

    await pool.query('UPDATE supplier_invoices SET grn_id = NULL WHERE id = $1', [bill.id]);
    expect((await callTool(pool, f, cancel, { grn_id: grn, reason: 'returned' })).isError).toBe(false);
    const cancelled = await callTool(pool, f, listGrn, { po_id: po.po, status: 'cancelled' });
    expect((cancelled.body.goods_received_notes as Json[])[0]).toMatchObject({ status: 'cancelled', cancel_reason: 'returned', cancelled_by: f.owner });
    expect((await callTool(pool, f, listGrn, { po_id: po.po, status: 'received' })).body).toMatchObject({ total: 0 });
  });

  it('find_by_external_ref kind goods_received: the live note, a cancelled one as superseded', async () => {
    const po = await seedQtyPo(pool, f, { lines: [{ qty: 5, price: 1 }] });
    const ref = `ff-${po.po.slice(0, 8)}`;
    const a = await callTool(pool, f, create, grnArgs(po, [[0, 1]], { external_system: 'fibreflow', external_ref: ref }));
    await callTool(pool, f, cancel, { grn_id: a.body.grn_id, reason: 'x' });
    const b = await callTool(pool, f, create, grnArgs(po, [[0, 2]], { external_system: 'fibreflow', external_ref: ref }));
    const found = await callTool(pool, f, findRef, { source: 'FibreFlow', kind: 'goods_received', id: ref });
    expect(found.body).toMatchObject({ found: true, record: { id: b.body.grn_id, number: b.body.grn_number, status: 'received' } });
    expect((found.body.superseded as Json[]).map((s) => s.id)).toEqual([a.body.grn_id]);
    expect((await callTool(pool, other, findRef, { source: 'fibreflow', kind: 'goods_received', id: ref })).body).toMatchObject({ found: false, superseded: [] });
    expect((await callTool(pool, f, listGrn, { external_ref: ref })).body).toMatchObject({ total: 2 });
  });

  it('a cancelled note is not matched: the three-way match reads no goods received from it', async () => {
    const { po, grn } = await received(f, [5], [5]);
    const inputs = () => asOwner(pool, f, () => readMatchInputs(f.co, { supplierId: f.supplier, purchaseOrderId: po.po, grnId: grn }));
    expect((await inputs()).grnItems).toHaveLength(1);
    expect((await callTool(pool, f, cancel, { grn_id: grn, reason: 'x' })).isError).toBe(false);
    expect((await inputs()).grnItems).toHaveLength(0);
  });
});
