/**
 * create_goods_received / cancel_goods_received (docs/design/mcp-goods-received.md), real PostgreSQL, as app_user (grnHarness).
 * Acceptance items:
 *   1. on a PO for 10, receiving 6 makes it partially_received, 4 more makes it received; GRN numbers go up by one;
 *   2. 1 more after that is refused as over_receipt with nothing written;
 *   3. cancelling the second note restores 6 and partially_received, the first 0 and approved;
 *   7. a repeated external_ref is refused naming the first note; once that note is cancelled the reference is free again;
 *   8. a dry run writes nothing and leaves the idempotency key free for the live call (through a real McpRegistry);
 *   9. neither create nor cancel writes a ledger row.
 * Plus: the app's POST /api/accounting/goods-received still receives (same service), and both writes are audited.
 * Fixture route: isaflow_schema_fixture (assertDisposable). Never skips.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { callRoute, dropBillFixture, seedBillFixture, type BillFixture } from './helpers/budgetBillFixture';
import {
  callRegistry, callTool, dropGrnExtras, dropMaintExtras, glCount, grnArgs, grnAudit, grnItemCount, grnRows, poState, refusal, seedQtyPo,
} from './helpers/grnHarness';
import { createGoodsReceivedTool as create } from '@/lib/mcp/tools/writeCreateGoodsReceived';
import { cancelGoodsReceivedTool as cancel } from '@/lib/mcp/tools/writeCancelGoodsReceived';
import grnRoute from '../../pages/api/accounting/goods-received';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
let f: BillFixture;

beforeAll(async () => { f = await seedBillFixture(pool, 'grn-main'); }, 60_000);
afterAll(async () => {
  try { await dropGrnExtras(pool, f); await dropMaintExtras(pool, f); await dropBillFixture(pool, f); } finally { await pool.end(); }
}, 60_000);

const num = (n: string) => Number(n.replace('GRN-', ''));

describe('receive, over-receive, cancel (1, 2, 3, 9)', () => {
  it('6 then 4 receives the PO in full; 1 more is over_receipt; cancelling walks it back; no ledger row', async () => {
    const po = await seedQtyPo(pool, f, { lines: [{ qty: 10, price: 5 }] });
    const gl = await glCount(pool, f);

    const first = await callTool(pool, f, create, grnArgs(po, [[0, 6]]));
    expect(first.isError, first.text).toBe(false);
    expect(first.body).toMatchObject({ created: true, po_status_before: 'approved', po_status: 'partially_received', posted_to_ledger: false });
    expect(await poState(pool, po)).toEqual({ status: 'partially_received', received: [6] });

    const second = await callTool(pool, f, create, grnArgs(po, [[0, 4]]), { user: f.manager, companyRole: 'manager' });
    expect(second.isError, second.text).toBe(false);
    expect(second.body).toMatchObject({ po_status_before: 'partially_received', po_status: 'received' });
    expect(num(String(second.body.grn_number))).toBe(num(String(first.body.grn_number)) + 1);
    expect(await poState(pool, po)).toEqual({ status: 'received', received: [10] });
    expect(await glCount(pool, f)).toEqual(gl);

    const notes = await grnRows(pool, f);
    const items = await grnItemCount(pool, f);
    const over = await callTool(pool, f, create, grnArgs(po, [[0, 1]]));
    expect(over.isError).toBe(true);
    expect(refusal(over.text)).toMatchObject({
      refused: true, code: 'over_receipt', written: false, lines: [{ index: 0, po_item_id: po.items[0], code: 'over_receipt', outstanding: 0, asked: 1 }],
    });
    // Only rejected goods on a received PO: nothing is over-received, the PO takes no receipt.
    expect(refusal((await callTool(pool, f, create, grnArgs(po, [[0, 0, 1]]))).text)).toMatchObject({ code: 'po_not_receivable', po_status: 'received' });
    expect(await grnRows(pool, f)).toEqual(notes);
    expect(await grnItemCount(pool, f)).toBe(items);

    const c2 = await callTool(pool, f, cancel, { grn_id: second.body.grn_id, reason: 'counted twice' });
    expect(c2.isError, c2.text).toBe(false);
    expect(c2.body).toMatchObject({ cancelled: true, po_status_before: 'received', po_status: 'partially_received', posted_to_ledger: false });
    expect(await poState(pool, po)).toEqual({ status: 'partially_received', received: [6] });

    const c1 = await callTool(pool, f, cancel, { grn_id: first.body.grn_id, reason: 'wrong PO' }, { user: f.manager, companyRole: 'manager' });
    expect(c1.isError, c1.text).toBe(false);
    expect(await poState(pool, po)).toEqual({ status: 'approved', received: [0] });
    expect(await glCount(pool, f)).toEqual(gl);

    const row = (await grnRows(pool, f)).find((r) => r.id === first.body.grn_id)!;
    expect(row).toMatchObject({ status: 'cancelled', cancelled_by: f.manager, cancel_reason: 'wrong PO', has_cancelled_at: true });
    const audit = await grnAudit(pool, f, String(first.body.grn_id));
    expect(audit.map((a) => a.action)).toEqual(['create', 'update']);
    expect(audit[0]!.changes.metadata).toMatchObject({ source: 'mcp:create_goods_received', po_status_before: 'approved', po_status_after: 'partially_received' });
    expect(audit[1]).toMatchObject({ user_id: f.manager });
    expect(audit[1]!.changes.metadata).toMatchObject({ cancelled: 'true', reason: 'wrong PO', source: 'mcp:cancel_goods_received', po_status_after: 'approved' });
  });

  it('over_receipt lists every refused line with its outstanding and asked quantities; nothing is written', async () => {
    const po = await seedQtyPo(pool, f, { lines: [{ qty: 10, price: 5, received: 9 }, { qty: 4, price: 1 }, { qty: 2, price: 1, received: 2 }], status: 'partially_received' });
    const notes = await grnRows(pool, f);
    const r = await callTool(pool, f, create, grnArgs(po, [[0, 1.5], [1, 4], [2, 0.01, 1]]));
    expect(r.isError).toBe(true);
    const body = refusal(r.text);
    expect(body).toMatchObject({ code: 'over_receipt', written: false });
    expect(body.lines).toEqual([
      { index: 0, po_item_id: po.items[0], code: 'over_receipt', outstanding: 1, asked: 1.5 },
      { index: 2, po_item_id: po.items[2], code: 'over_receipt', outstanding: 0, asked: 0.01 },
    ]);
    expect(await grnRows(pool, f)).toEqual(notes);
    expect(await poState(pool, po)).toEqual({ status: 'partially_received', received: [9, 0, 2] });
    // Rejected goods do not count against what is outstanding.
    const ok = await callTool(pool, f, create, grnArgs(po, [[0, 1, 5], [2, 0, 3]]));
    expect(ok.isError, ok.text).toBe(false);
    expect(await poState(pool, po)).toEqual({ status: 'partially_received', received: [10, 0, 2] });
  });
});

describe('external reference (7)', () => {
  it('a repeated reference is refused naming the first note; after that note is cancelled the reference is free', async () => {
    const po = await seedQtyPo(pool, f, { lines: [{ qty: 10, price: 5 }] });
    const ref = { external_system: 'FibreFlow', external_ref: `del-${po.po.slice(0, 8)}` };
    const first = await callTool(pool, f, create, grnArgs(po, [[0, 2]], ref));
    expect(first.isError, first.text).toBe(false);
    expect(first.body).toMatchObject({ external_system: 'fibreflow', external_ref: ref.external_ref });

    const again = await callTool(pool, f, create, grnArgs(po, [[0, 1]], { ...ref, external_system: 'fibreflow' }));
    expect(again.isError).toBe(true);
    expect(refusal(again.text)).toMatchObject({
      code: 'duplicate_external_ref', written: false,
      existing_goods_received: { id: first.body.grn_id, grn_number: first.body.grn_number },
    });
    expect(await poState(pool, po)).toEqual({ status: 'partially_received', received: [2] });

    expect((await callTool(pool, f, cancel, { grn_id: first.body.grn_id, reason: 'redo' })).isError).toBe(false);
    const reused = await callTool(pool, f, create, grnArgs(po, [[0, 3]], ref));
    expect(reused.isError, reused.text).toBe(false);
    expect(await poState(pool, po)).toEqual({ status: 'partially_received', received: [3] });
  });
});

describe('dry run (8)', () => {
  it('writes nothing and leaves the key free: the live call with the same key then succeeds', async () => {
    const po = await seedQtyPo(pool, f, { lines: [{ qty: 3, price: 5 }] });
    const key = `grn-dry-${po.po}`;
    const notes = await grnRows(pool, f);
    const dry = await callRegistry(pool, f, create, { ...grnArgs(po, [[0, 3]]), dry_run: true, idempotency_key: key });
    expect(dry.isError, dry.text).toBe(false);
    expect(JSON.parse(dry.text)).toMatchObject({ dry_run: true, would_create: true, grn_id: null, grn_number: 'next', po_status: 'received' });
    expect(await grnRows(pool, f)).toEqual(notes);
    expect(await poState(pool, po)).toEqual({ status: 'approved', received: [0] });
    expect((await pool.query('SELECT 1 FROM mcp_tool_calls WHERE company_id = $1 AND idempotency_key = $2', [f.co, key])).rowCount).toBe(0);

    const live = await callRegistry(pool, f, create, { ...grnArgs(po, [[0, 3]]), idempotency_key: key });
    expect(live.isError, live.text).toBe(false);
    expect(JSON.parse(live.text)).toMatchObject({ created: true, po_status: 'received' });
    expect(await poState(pool, po)).toEqual({ status: 'received', received: [3] });

    const grnId = String(JSON.parse(live.text).grn_id);
    const cancelKey = `grn-cancel-${po.po}`;
    const dryCancel = await callRegistry(pool, f, cancel, { grn_id: grnId, reason: 'x', dry_run: true, idempotency_key: cancelKey }, 'manager');
    expect(JSON.parse(dryCancel.text)).toMatchObject({ dry_run: true, would_cancel: true, po_status: 'approved' });
    expect(await poState(pool, po)).toEqual({ status: 'received', received: [3] });
    const liveCancel = await callRegistry(pool, f, cancel, { grn_id: grnId, reason: 'x', idempotency_key: cancelKey }, 'manager');
    expect(JSON.parse(liveCancel.text)).toMatchObject({ cancelled: true, po_status: 'approved' });
  });
});

describe('the app POST', () => {
  it('still receives through the same service, and refuses an over-receipt with its message', async () => {
    const po = await seedQtyPo(pool, f, { lines: [{ qty: 2, price: 5 }] });
    const body = (q: number) => ({ purchaseOrderId: po.po, receivedDate: '2026-06-21', items: [{ poItemId: po.items[0], quantityReceived: q }] });
    const r = await callRoute(grnRoute as never, f, f.owner, '/api/accounting/goods-received', body(2));
    expect(r.statusCode, JSON.stringify(r.body)).toBe(201);
    expect(await poState(pool, po)).toEqual({ status: 'received', received: [2] });
    const audit = await grnAudit(pool, f, String((r.body.data as { id: string }).id));
    expect(audit[0]!.changes.metadata).toMatchObject({ source: 'app' });
    await pool.query("UPDATE purchase_orders SET status = 'partially_received' WHERE id = $1", [po.po]);
    const over = await callRoute(grnRoute as never, f, f.owner, '/api/accounting/goods-received', body(1));
    expect(over.statusCode).toBe(400);
    expect(JSON.stringify(over.body)).toContain('Received quantity exceeds the outstanding order quantity');
  });
});
