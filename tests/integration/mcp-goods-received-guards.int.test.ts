/**
 * Goods received notes: what the database refuses and what the cancel refuses when the receipts were not written the way
 * createGoodsReceived writes them (migration 1021; docs/design/mcp-goods-received.md, review round 3), real PostgreSQL, as app_user:
 *   M1  a cancel never takes quantities off a PO line that other live notes still account for (`receipts_disagree`, nothing written);
 *   L1  a bill whose status is NULL still holds its note (grn_on_bill);
 *   L2  a note names a PO of its own company, and an item a line of its note's PO;
 *   L4  autoLinkSupplierInvoice links only this company's PO and note documents, for a user of two companies.
 * Fixture route: isaflow_schema_fixture (assertDisposable). Never skips.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { dropBillFixture, openRequest, seedBillFixture, type BillFixture } from './helpers/budgetBillFixture';
import { seedBill } from './helpers/poBillLinkHarness';
import { callTool, dropGrnExtras, dropMaintExtras, grnArgs, poState, refusal, seedQtyPo, type QtyPo } from './helpers/grnHarness';
import { inOneTransaction } from './helpers/poMaintHarness';
import { createGoodsReceivedTool as create } from '@/lib/mcp/tools/writeCreateGoodsReceived';
import { cancelGoodsReceivedTool as cancel } from '@/lib/mcp/tools/writeCancelGoodsReceived';
import { autoLinkSupplierInvoice } from '@/modules/accounting/services/core/documentStorageService';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
let f: BillFixture;
let other: BillFixture;

beforeAll(async () => {
  f = await seedBillFixture(pool, 'grn-guards');
  other = await seedBillFixture(pool, 'grn-guards-other');
}, 60_000);
afterAll(async () => {
  try {
    for (const x of [f, other]) { await dropGrnExtras(pool, x); await dropMaintExtras(pool, x); await dropBillFixture(pool, x); }
  } finally { await pool.end(); }
}, 60_000);

const received = async (fx: BillFixture, qty = 4, take = 4) => {
  const po = await seedQtyPo(pool, fx, { lines: [{ qty, price: 10 }] });
  const r = await callTool(pool, fx, create, grnArgs(po, [[0, take]]));
  expect(r.isError, r.text).toBe(false);
  return { po, grn: String(r.body.grn_id) };
};
/** One committed transaction as app_user: the statements run in order; 'ok' or the SQLSTATE and message of the one that failed. */
const asApp = async (fx: BillFixture, statements: Array<[string, unknown[]]>) => {
  const req = await openRequest(pool, fx, fx.owner);
  try {
    for (const [q, params] of statements) await req.client.query(q, params);
    await req.commit();
    return { code: 'ok', message: '' };
  } catch (e) {
    await req.rollback();
    return { code: String((e as { code?: string }).code), message: (e as Error).message };
  }
};
const newNote = (id: string, fx: BillFixture, po: string): [string, unknown[]] => [
  "INSERT INTO goods_received_notes (id, company_id, grn_number, purchase_order_id, received_by) VALUES ($1, $2, $3, $4, 'tester')",
  [id, fx.co, `GRN-${id.slice(0, 8)}`, po]];
const newItem = (grn: string, item: string, qty = 4): [string, unknown[]] => [
  'INSERT INTO grn_items (grn_id, po_item_id, quantity_received) VALUES ($1, $2, $3)', [grn, item, qty]];

describe('a cancel keeps what other live notes still account for (M1)', () => {
  it('a second note written without touching po_items cannot be cancelled, nor can the first: nothing is taken off the line', async () => {
    const { po, grn } = await received(f);
    const forged = crypto.randomUUID();
    expect(await asApp(f, [newNote(forged, f, po.po), newItem(forged, po.items[0]!)])).toMatchObject({ code: 'ok' });
    for (const target of [forged, grn]) {
      const r = await callTool(pool, f, cancel, { grn_id: target, reason: 'x' });
      expect(r.isError).toBe(true);
      expect(refusal(r.text)).toMatchObject({
        code: 'receipts_disagree', written: false,
        lines: [{ po_item_id: po.items[0], line_received: 4, note_received: 4, other_notes_received: 4 }],
      });
    }
    expect(await poState(pool, po)).toEqual({ status: 'received', received: [4] });
    const status = (await pool.query('SELECT status FROM goods_received_notes WHERE id = ANY($1::uuid[])', [[forged, grn]])).rows;
    expect(status).toEqual([{ status: 'received' }, { status: 'received' }]);
    // A further receipt is still refused: the line is full.
    expect(refusal((await callTool(pool, f, create, grnArgs(po, [[0, 4]]))).text)).toMatchObject({ code: 'over_receipt' });
  });

  it('the notes of an ordinary partial receipt still cancel one by one', async () => {
    const po = await seedQtyPo(pool, f, { lines: [{ qty: 10, price: 10 }] });
    const first = String((await callTool(pool, f, create, grnArgs(po, [[0, 6]]))).body.grn_id);
    const second = String((await callTool(pool, f, create, grnArgs(po, [[0, 4]]))).body.grn_id);
    expect((await callTool(pool, f, cancel, { grn_id: first, reason: 'x' })).isError).toBe(false);
    expect(await poState(pool, po)).toEqual({ status: 'partially_received', received: [4] });
    expect((await callTool(pool, f, cancel, { grn_id: second, reason: 'x' })).isError).toBe(false);
    expect(await poState(pool, po)).toEqual({ status: 'approved', received: [0] });
  });
});

describe('a bill with no status still holds its note (L1)', () => {
  it('grn_on_bill, from the tool and from the function', async () => {
    const { po, grn } = await received(f, 4, 2);
    const bill = await seedBill(pool, f, { status: 'draft', lines: [20] });
    await pool.query('UPDATE supplier_invoices SET grn_id = $2, status = NULL WHERE id = $1', [bill.id, grn]);
    expect((await pool.query('SELECT status FROM supplier_invoices WHERE id = $1', [bill.id])).rows).toEqual([{ status: null }]);
    expect(refusal((await callTool(pool, f, cancel, { grn_id: grn, reason: 'x' })).text)).toMatchObject({ code: 'grn_on_bill', bills_total: 1 });
    expect(await poState(pool, po)).toEqual({ status: 'partially_received', received: [2] });
    await pool.query("UPDATE supplier_invoices SET status = 'cancelled' WHERE id = $1", [bill.id]);
    expect((await callTool(pool, f, cancel, { grn_id: grn, reason: 'x' })).isError).toBe(false);
  });
});

describe('a note and its items stay on one company and one PO (L2)', () => {
  it('a note naming another company\'s PO is refused, as app_user and as the superuser', async () => {
    const theirs = await seedQtyPo(pool, other, { lines: [{ qty: 4, price: 10 }] });
    const ours = await seedQtyPo(pool, f, { lines: [{ qty: 4, price: 10 }] });
    const id = crypto.randomUUID();
    const asUser = await asApp(f, [newNote(id, f, theirs.po)]);
    expect(asUser.code).toBe('23514');
    expect(asUser.message).toContain('purchase order of its own company');
    const [q, params] = newNote(id, f, theirs.po);
    await expect(pool.query(q, params)).rejects.toMatchObject({ code: '23514' });
    expect(await asApp(f, [newNote(id, f, ours.po)])).toMatchObject({ code: 'ok' });
    expect(Number((await pool.query('SELECT count(*) AS n FROM goods_received_notes WHERE id = $1', [id])).rows[0].n)).toBe(1);
  });

  it('an item naming a line of another PO (its own company\'s or another\'s) is refused; a line of the note\'s own PO is not', async () => {
    const mine = await seedQtyPo(pool, f, { lines: [{ qty: 4, price: 10 }] });
    const sibling = await seedQtyPo(pool, f, { lines: [{ qty: 4, price: 10 }] });
    const theirs = await seedQtyPo(pool, other, { lines: [{ qty: 4, price: 10 }] });
    for (const line of [sibling.items[0]!, theirs.items[0]!]) {
      const id = crypto.randomUUID();
      const r = await asApp(f, [newNote(id, f, mine.po), newItem(id, line)]);
      expect(r.code, line).toBe('23514');
      expect(r.message).toContain('line of its purchase order');
      await expect(inOneTransaction(pool, async (c) => {
        await c.query(...newNote(id, f, mine.po));
        await c.query(...newItem(id, line));
      })).rejects.toMatchObject({ code: '23514' });
    }
    const id = crypto.randomUUID();
    expect(await asApp(f, [newNote(id, f, mine.po), newItem(id, mine.items[0]!, 1)])).toMatchObject({ code: 'ok' });
  });
});

describe('autoLinkSupplierInvoice stays inside the bill\'s company (L4)', () => {
  it('a bill naming another company\'s note and PO is not linked to their documents, for a user of both companies', async () => {
    const theirs = await received(other);
    const doc = async (type: string, id: string, name: string) => String((await pool.query(
      `INSERT INTO procurement_documents (entity_type, entity_id, document_type, document_name, is_active) VALUES ($1, $2, $1, $3, true) RETURNING id`,
      [type, id, name])).rows[0].id);
    const theirNote = await doc('goods_received', theirs.grn, 'their-delivery.pdf');
    const theirPo = await doc('purchase_order', theirs.po.po, 'their-po.pdf');
    const bill = await seedBill(pool, f, { status: 'draft', lines: [20] });
    await pool.query('UPDATE supplier_invoices SET grn_id = $2, purchase_order_id = $3 WHERE id = $1', [bill.id, theirs.grn, theirs.po.po]);
    const mine = await doc('supplier_invoice', bill.id, 'bill.pdf');
    await pool.query("INSERT INTO company_users (company_id, user_id, role) VALUES ($1, $2, 'owner') ON CONFLICT DO NOTHING", [other.co, f.owner]);
    try {
      const req = await openRequest(pool, f, f.owner);
      try { await req.run(() => autoLinkSupplierInvoice(mine, bill.id, f.co)); await req.commit(); } catch (err) { await req.rollback(); throw err; }
      const links = (await pool.query(
        `SELECT document_id, linked_entity_type, linked_entity_id FROM document_links WHERE document_id = ANY($1::uuid[]) OR linked_entity_id = $2`,
        [[mine, theirNote, theirPo], bill.id])).rows;
      expect(links).toEqual([]);
    } finally {
      await pool.query('DELETE FROM company_users WHERE company_id = $1 AND user_id = $2', [other.co, f.owner]);
      await pool.query('DELETE FROM document_links WHERE document_id = ANY($1::uuid[]) OR linked_entity_id = $2', [[mine, theirNote, theirPo], bill.id]);
      await pool.query('DELETE FROM procurement_documents WHERE id = ANY($1::uuid[])', [[mine, theirNote, theirPo]]);
    }
  });
});
