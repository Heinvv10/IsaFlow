/**
 * Goods received notes in the database (migration 1021; docs/design/mcp-goods-received.md, review M3 / L1 / L5), real PostgreSQL:
 *   - as app_user only the cancel function changes a note: a forged cancel UPDATE, an edit of an item, a DELETE of a note or of its
 *     items are refused by privilege (42501), and the note, its items and the PO are left as they were;
 *   - goods_received_note_cancel answers not_found to a caller outside the session company and for another company's note, re-decides
 *     every refusal itself (a direct call cannot cancel a note on a live bill), and a direct call keeps the quantities whole;
 *   - the 1021 triggers still hold for a role that may UPDATE (migration_admin): a cancelled note and its items never change;
 *   - grn_items row security: no item onto another company's note, none of its items read; the cancel's lookup never resolves another
 *     company's note, even for a user of both companies.
 * Fixture route: isaflow_schema_fixture (assertDisposable). Never skips.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { dropBillFixture, openRequest, seedBillFixture, type BillFixture } from './helpers/budgetBillFixture';
import { seedBill } from './helpers/poBillLinkHarness';
import { callTool, dropGrnExtras, dropMaintExtras, grnArgs, grnItemCount, grnRows, poState, seedQtyPo } from './helpers/grnHarness';
import { createGoodsReceivedTool as create } from '@/lib/mcp/tools/writeCreateGoodsReceived';
import { cancelGoodsReceivedTool as cancel } from '@/lib/mcp/tools/writeCancelGoodsReceived';
import { lockNoteForCancel } from '@/modules/accounting/services/ap/goodsReceivedCancel';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
let f: BillFixture;
let other: BillFixture;

beforeAll(async () => {
  f = await seedBillFixture(pool, 'grn-db');
  other = await seedBillFixture(pool, 'grn-db-other');
}, 60_000);
afterAll(async () => {
  try {
    for (const x of [f, other]) { await dropGrnExtras(pool, x); await dropMaintExtras(pool, x); await dropBillFixture(pool, x); }
  } finally { await pool.end(); }
}, 60_000);

const received = async (fx: BillFixture, qty = 4, take = 3) => {
  const po = await seedQtyPo(pool, fx, { lines: [{ qty, price: 10 }] });
  const r = await callTool(pool, fx, create, grnArgs(po, [[0, take]]));
  expect(r.isError, r.text).toBe(false);
  return { po, grn: String(r.body.grn_id) };
};
/** One committed statement as app_user of `fx` (as `user`): 'ok' and its rows, or the SQLSTATE and message. */
const asApp = async (fx: BillFixture, q: string, params: unknown[], user = fx.owner) => {
  const req = await openRequest(pool, fx, user);
  try {
    const rows = (await req.client.query(q, params)).rows as Array<Record<string, unknown>>;
    await req.commit();
    return { code: 'ok', rows, message: '' };
  } catch (e) {
    await req.rollback();
    return { code: String((e as { code?: string }).code), rows: [], message: (e as Error).message };
  }
};
/** One statement as migration_admin (BYPASSRLS, may UPDATE): the triggers, not a privilege, must refuse. */
const asAdmin = async (q: string, params: unknown[]) => {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query('SET LOCAL ROLE migration_admin');
    await c.query(q, params);
    await c.query('COMMIT');
    return 'ok';
  } catch (e) {
    await c.query('ROLLBACK');
    return String((e as { code?: string }).code);
  } finally { c.release(); }
};

describe('as app_user, only the cancel changes a note (M3)', () => {
  it('a forged cancel, an item edit and the DELETEs are refused by privilege; nothing changed', async () => {
    const { po, grn } = await received(f);
    const before = { notes: await grnRows(pool, f), items: await grnItemCount(pool, f), po: await poState(pool, po) };
    const forged = [
      ["UPDATE goods_received_notes SET status = 'cancelled', cancelled_at = now(), cancelled_by = $2, cancel_reason = 'forged' WHERE id = $1", [grn, f.owner]],
      ['UPDATE grn_items SET quantity_received = 0 WHERE grn_id = $1', [grn]],
      ['DELETE FROM grn_items WHERE grn_id = $1', [grn]],
      ['DELETE FROM goods_received_notes WHERE id = $1', [grn]],
    ] as const;
    for (const [q, params] of forged) expect((await asApp(f, q, [...params])).code, q).toBe('42501');
    expect({ notes: await grnRows(pool, f), items: await grnItemCount(pool, f), po: await poState(pool, po) }).toEqual(before);
  });

  it('the function: not_found outside the session company and for another company\'s note; a live bill refuses it; a direct call keeps the quantities whole', async () => {
    const theirs = await received(other);
    const call = 'SELECT outcome, po_status FROM public.goods_received_note_cancel($1, $2)';
    expect((await asApp(f, call, [theirs.grn, 'x'])).rows).toEqual([{ outcome: 'not_found', po_status: null }]);
    const ours = await received(f);
    // A user who is not a member of the session company (row security's pair: the claims' user and the company GUC).
    expect((await asApp(f, call, [ours.grn, 'x'], other.owner)).rows).toEqual([{ outcome: 'not_found', po_status: null }]);
    const bill = await seedBill(pool, f, { status: 'draft', lines: [30] });
    await pool.query('UPDATE supplier_invoices SET grn_id = $2 WHERE id = $1', [bill.id, ours.grn]);
    expect((await asApp(f, call, [ours.grn, 'x'])).rows).toEqual([{ outcome: 'grn_on_bill', po_status: 'partially_received' }]);
    expect(await poState(pool, ours.po)).toEqual({ status: 'partially_received', received: [3] });
    await pool.query('UPDATE supplier_invoices SET grn_id = NULL WHERE id = $1', [bill.id]);
    expect((await asApp(f, call, [ours.grn, ' direct '])).rows).toEqual([{ outcome: 'cancelled', po_status: 'approved' }]);
    expect(await poState(pool, ours.po)).toEqual({ status: 'approved', received: [0] });
    expect((await grnRows(pool, f)).find((r) => r.id === ours.grn)).toMatchObject({ status: 'cancelled', cancelled_by: f.owner, cancel_reason: 'direct' });
    expect((await asApp(f, call, [ours.grn, 'again'])).rows).toEqual([{ outcome: 'already_cancelled', po_status: 'approved' }]);
    expect(await poState(pool, theirs.po)).toEqual({ status: 'partially_received', received: [3] });
  });

  it('the function itself, called directly, refuses a note on a cancelled PO and writes nothing; a closed PO stays closed', async () => {
    const call = 'SELECT outcome, po_status, receipt_status FROM public.goods_received_note_cancel($1, $2)';
    const dead = await received(f, 4, 3);
    await pool.query("UPDATE purchase_orders SET status = 'cancelled' WHERE id = $1", [dead.po.po]);
    expect((await asApp(f, call, [dead.grn, 'x'])).rows).toEqual([{ outcome: 'po_not_receivable', po_status: 'cancelled', receipt_status: null }]);
    expect(await poState(pool, dead.po)).toEqual({ status: 'cancelled', received: [3] });
    expect((await grnRows(pool, f)).find((n) => n.id === dead.grn)).toMatchObject({ status: 'received' });
    const shut = await received(f, 4, 3);
    await pool.query("UPDATE purchase_orders SET status = 'closed' WHERE id = $1", [shut.po.po]);
    expect((await asApp(f, call, [shut.grn, 'x'])).rows).toEqual([{ outcome: 'cancelled', po_status: 'closed', receipt_status: 'approved' }]);
    expect(await poState(pool, shut.po)).toEqual({ status: 'closed', received: [0] });
  });

  it('the triggers hold for migration_admin: a cancelled note and its items never change; app_user adds no item to it', async () => {
    const { po, grn } = await received(f, 5, 1);
    expect(await asAdmin("UPDATE goods_received_notes SET cancel_reason = 'x' WHERE id = $1", [grn])).toBe('23514');
    expect((await callTool(pool, f, cancel, { grn_id: grn, reason: 'x' })).isError).toBe(false);
    expect(await asAdmin("UPDATE goods_received_notes SET status = 'received', cancelled_at = NULL, cancelled_by = NULL, cancel_reason = NULL WHERE id = $1", [grn])).toBe('23514');
    expect(await asAdmin("UPDATE goods_received_notes SET notes = 'edited' WHERE id = $1", [grn])).toBe('23514');
    expect(await asAdmin('UPDATE grn_items SET quantity_received = 2 WHERE grn_id = $1', [grn])).toBe('23514');
    expect((await asApp(f, 'INSERT INTO grn_items (grn_id, po_item_id, quantity_received) VALUES ($1, $2, 1)', [grn, po.items[0]])).code).toBe('23514');
  });
});

describe('items only with their note (breaker round 2 L1, L3)', () => {
  it('an item added to an existing note is refused, even by a superuser; the note still cancels normally', async () => {
    const { po, grn } = await received(f, 5, 2);
    const add = 'INSERT INTO grn_items (grn_id, po_item_id, quantity_received) VALUES ($1, $2, 3)';
    const late = await asApp(f, add, [grn, po.items[0]]);
    expect(late.code).toBe('23514');
    expect(late.message).toContain('in the transaction that created its note');
    await expect(pool.query(add, [grn, po.items[0]])).rejects.toMatchObject({ code: '23514' });
    expect(await grnItemCount(pool, f)).toBeGreaterThan(0);
    expect((await callTool(pool, f, cancel, { grn_id: grn, reason: 'x' })).isError).toBe(false);
    expect(await poState(pool, po)).toEqual({ status: 'approved', received: [0] });
  });

  it('receipts that disagree with their PO line are a typed refusal with nothing written, not a 500', async () => {
    const { po, grn } = await received(f, 5, 4);
    await pool.query('UPDATE po_items SET quantity_received = 1 WHERE id = $1', [po.items[0]]);
    const r = await callTool(pool, f, cancel, { grn_id: grn, reason: 'x' });
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.text)).toMatchObject({ code: 'receipts_disagree', written: false, lines: [{ po_item_id: po.items[0], line_received: 1, note_received: 4 }] });
    expect((await grnRows(pool, f)).find((n) => n.id === grn)).toMatchObject({ status: 'received' });
    expect(await poState(pool, po)).toEqual({ status: 'partially_received', received: [1] });
    expect((await asApp(f, 'SELECT outcome FROM public.goods_received_note_cancel($1, $2)', [grn, 'x'])).rows).toEqual([{ outcome: 'receipts_disagree' }]);
  });

  it('the cancel\'s bill check has its (company_id, grn_id) partial index', async () => {
    // Asserts the index, not a plan: on CI's shared fixture the planner may prefer another supplier_invoices index once other
    // suites' rows and stats are in, so a plan-shape check here was order-dependent.
    const { rows } = await pool.query(`SELECT pg_get_indexdef(i.indexrelid) AS def FROM pg_index i
      JOIN pg_class c ON c.oid = i.indexrelid WHERE c.relname = 'idx_supplier_invoices_grn'`);
    expect(rows).toHaveLength(1);
    expect(String(rows[0].def)).toMatch(/ON public\.supplier_invoices USING btree \(company_id, grn_id\) WHERE \(grn_id IS NOT NULL\)/);
  });
});

describe('grn_items row security (L1) and the cancel lookup (L5)', () => {
  it('no item onto another company\'s note, none of its items read, even for a user of both companies', async () => {
    const theirs = await received(other);
    const insert = 'INSERT INTO grn_items (grn_id, po_item_id, quantity_received) VALUES ($1, $2, 1)';
    const foreign = await asApp(f, insert, [theirs.grn, theirs.po.items[0]]);
    expect(foreign.code).toBe('42501');
    expect(foreign.message).toContain('row-level security');
    expect((await asApp(f, 'SELECT count(*)::int AS n FROM grn_items WHERE grn_id = $1', [theirs.grn])).rows).toEqual([{ n: 0 }]);
    await pool.query("INSERT INTO company_users (company_id, user_id, role) VALUES ($1, $2, 'owner') ON CONFLICT DO NOTHING", [other.co, f.owner]);
    try {
      // The note's policy admits both companies to this user, so the note is visible; an old note is refused by the same-transaction
      // guard (23514), and a note created in this very transaction (so the guard passes) by the policy's WITH CHECK: the session
      // company is f, so the item is still refused.
      expect((await asApp(f, insert, [theirs.grn, theirs.po.items[0]])).code).toBe('23514');
      const req = await openRequest(pool, f, f.owner);
      try {
        await req.client.query('RESET ROLE');
        const fresh = crypto.randomUUID();
        await req.client.query(`INSERT INTO goods_received_notes (id, company_id, grn_number, purchase_order_id, received_by) VALUES ($1, $2, 'GRN-X', $3, 'x')`,
          [fresh, other.co, theirs.po.po]);
        await req.client.query('SET LOCAL ROLE app_user');
        await expect(req.client.query(insert, [fresh, theirs.po.items[0]])).rejects.toMatchObject({ code: '42501' });
      } finally { await req.rollback(); }
      const lookup = await openRequest(pool, f, f.owner);
      try {
        expect(await lookup.run(() => lockNoteForCancel(f.co, theirs.grn))).toBeNull();
      } finally { await lookup.rollback(); }
    } finally {
      await pool.query('DELETE FROM company_users WHERE company_id = $1 AND user_id = $2', [other.co, f.owner]);
    }
    const ours = await received(f);
    const req = await openRequest(pool, f, f.owner);
    try {
      expect(await req.run(() => lockNoteForCancel(f.co, ours.grn))).toMatchObject({ poId: ours.po.po, status: 'received', poStatus: 'partially_received' });
    } finally { await req.rollback(); }
    expect(Number((await pool.query('SELECT count(*) AS n FROM grn_items WHERE grn_id = $1', [theirs.grn])).rows[0].n)).toBe(1);
  });
});
