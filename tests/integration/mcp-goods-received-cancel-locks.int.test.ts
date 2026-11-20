/**
 * The cancel's guards and locks (merge-gate findings 3 and 5 on #1697; docs/design/mcp-goods-received.md, the census in
 * docs/design/mcp-po-bill-links.md), real PostgreSQL, as app_user:
 *   - a note holding an item of a line that is not on the note's PO (a legacy row, written before 1021's item guard) is refused
 *     (items_not_on_po) before any write, by the service (which reads first and so waits on no note lock) and by the definer itself;
 *   - the cancel takes no number lock 620: a cancel blocked on its PO row does not hold up a create on another PO of the company;
 *   - its row-lock waits are bounded (the PO row, the note a bill holds): a typed retryable refusal, nothing written;
 *   - a create racing a cancel never leaves two live notes with one external reference (the create's check, then the partial
 *     unique index), though the cancel no longer serialises on 620.
 * Fixture route: isaflow_schema_fixture (assertDisposable). Never skips.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { dropBillFixture, openRequest, seedBillFixture, type BillFixture } from './helpers/budgetBillFixture';
import { callTool, dropGrnExtras, dropMaintExtras, grnArgs, poState, refusal, seedQtyPo, type QtyPo } from './helpers/grnHarness';
import { createGoodsReceivedTool as create } from '@/lib/mcp/tools/writeCreateGoodsReceived';
import { cancelGoodsReceivedTool as cancel } from '@/lib/mcp/tools/writeCancelGoodsReceived';
import { cancelGoodsReceived } from '@/modules/accounting/services/ap/goodsReceivedCancel';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 10 });
let f: BillFixture;

beforeAll(async () => { f = await seedBillFixture(pool, 'grn-cancel-locks'); }, 60_000);
afterAll(async () => {
  try { await dropGrnExtras(pool, f); await dropMaintExtras(pool, f); await dropBillFixture(pool, f); } finally { await pool.end(); }
}, 60_000);

const received = async (extra: Record<string, unknown> = {}): Promise<{ po: QtyPo; grn: string }> => {
  const po = await seedQtyPo(pool, f, { lines: [{ qty: 4, price: 10 }] });
  const r = await callTool(pool, f, create, grnArgs(po, [[0, 3]], extra));
  expect(r.isError, r.text).toBe(false);
  return { po, grn: String(r.body.grn_id) };
};
const noteStatus = async (grn: string) => String((await pool.query('SELECT status FROM goods_received_notes WHERE id = $1', [grn])).rows[0].status);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const waitingOn = async (fragment: string) => (await pool.query(
  "SELECT 1 FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND datname = current_database() AND query LIKE '%' || $1 || '%'", [fragment])).rows.length > 0;
async function blockedOn(fragment: string): Promise<void> {
  for (let i = 0; i < 200; i++) { if (await waitingOn(fragment)) return; await sleep(25); }
  throw new Error(`nothing blocked on ${fragment}`);
}
/** A cancel through the tool that never rejects: its answer, or the error it threw (a lock timeout is thrown, not answered). */
const cancelling = (grn: string) => callTool(pool, f, cancel, { grn_id: grn, reason: 'locks' })
  .then((r) => ({ r, e: undefined as undefined | { code?: string; message: string } }), (e: Error & { code?: string }) => ({ r: undefined, e }));
/** Holds the PO row FOR UPDATE in another transaction until `release`. */
async function holdPo(po: string) {
  const c = await pool.connect();
  await c.query('BEGIN');
  await c.query('SELECT id FROM purchase_orders WHERE id = $1 FOR UPDATE', [po]);
  return { release: async () => { try { await c.query('ROLLBACK'); } finally { c.release(); } } };
}

/** A note on PO A whose second item names a line of PO B, written as 1021's item guards would now refuse it (a legacy row). */
async function legacyOffPoNote(): Promise<{ a: QtyPo; b: QtyPo; grn: string }> {
  const { po: a, grn } = await received();
  const b = await seedQtyPo(pool, f, { lines: [{ qty: 5, price: 10, received: 2 }], status: 'partially_received' });
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query('ALTER TABLE grn_items DISABLE TRIGGER trg_grn_items_po_line_guard');
    await c.query('ALTER TABLE grn_items DISABLE TRIGGER trg_grn_items_same_transaction_guard');
    await c.query('INSERT INTO grn_items (grn_id, po_item_id, quantity_received) VALUES ($1, $2, 2)', [grn, b.items[0]]);
    await c.query('ALTER TABLE grn_items ENABLE ALWAYS TRIGGER trg_grn_items_po_line_guard');
    await c.query('ALTER TABLE grn_items ENABLE ALWAYS TRIGGER trg_grn_items_same_transaction_guard');
    await c.query('COMMIT');
  } catch (err) { await c.query('ROLLBACK'); throw err; } finally { c.release(); }
  return { a, b, grn };
}

describe('an item of a line not on the note\'s PO (finding 3)', () => {
  it('the tool refuses items_not_on_po, naming the line, before any write; the PO lines keep their quantities', async () => {
    const { a, b, grn } = await legacyOffPoNote();
    const out = await callTool(pool, f, cancel, { grn_id: grn, reason: 'legacy' });
    expect(out.isError).toBe(true);
    expect(refusal(out.text)).toMatchObject({ code: 'items_not_on_po', written: false, lines: [{ po_item_id: b.items[0] }] });
    expect(await noteStatus(grn)).toBe('received');
    expect(await poState(pool, a)).toEqual({ status: 'partially_received', received: [3] });
    expect(await poState(pool, b)).toEqual({ status: 'partially_received', received: [2] });
  });

  it('the service decides it on its own read, so it waits on no note lock: a bill holding the note does not delay the refusal', async () => {
    const { grn } = await legacyOffPoNote();
    const bill = await openRequest(pool, f, f.owner);
    try {
      await bill.client.query('SELECT public.goods_received_note_hold($1)', [grn]);
      const out = await Promise.race([cancelling(grn), sleep(4000).then(() => 'still waiting' as const)]);
      expect(out === 'still waiting' ? out : out.r ? refusal(out.r.text).code : out.e?.code).toBe('items_not_on_po');
    } finally { await bill.rollback(); }
  });

  it('the definer refuses it too when called directly as app_user', async () => {
    const { a, grn } = await legacyOffPoNote();
    const req = await openRequest(pool, f, f.owner);
    try {
      expect((await req.client.query('SELECT outcome FROM public.goods_received_note_cancel($1, $2)', [grn, 'direct'])).rows[0]).toEqual({ outcome: 'items_not_on_po' });
      await req.commit();
    } catch (err) { await req.rollback(); throw err; }
    expect(await noteStatus(grn)).toBe('received');
    expect(await poState(pool, a)).toEqual({ status: 'partially_received', received: [3] });
  });
});

describe('the cancel\'s locks (finding 5)', () => {
  it('a cancel blocked on its PO row does not hold up a create on another PO of the company (no number lock 620)', async () => {
    const { po, grn } = await received();
    const another = await seedQtyPo(pool, f, { lines: [{ qty: 1, price: 10 }] });
    const held = await holdPo(po.po);
    let pending: ReturnType<typeof cancelling> | undefined;
    try {
      pending = cancelling(grn);
      await blockedOn('FOR UPDATE OF po');
      const made = await callTool(pool, f, create, grnArgs(another, [[0, 1]]));
      expect(made.isError, made.text).toBe(false);
      expect(await waitingOn('FOR UPDATE OF po'), 'the cancel is still waiting: the create did not wait for it').toBe(true);
    } finally { await held.release(); }
    const done = await pending!;
    expect(done.e?.message).toBeUndefined();
    expect(done.r?.isError, done.r?.text).toBe(false);
  });

  it('a cancel waits at most the row-lock budget for its PO, then refuses typed and retryable; nothing written', async () => {
    const { po, grn } = await received();
    const held = await holdPo(po.po);
    try {
      const out = await Promise.race([cancelling(grn), sleep(15_000).then(() => 'still waiting' as const)]);
      expect(out === 'still waiting' ? out : out.e?.code).toBe('PURCHASE_ORDER_LOCK_TIMEOUT');
    } finally { await held.release(); }
    expect(await noteStatus(grn)).toBe('received');
    expect(await poState(pool, po)).toEqual({ status: 'partially_received', received: [3] });
  });

  it('a cancel waits at most the row-lock budget for a note a bill holds (holding no number lock meanwhile), then refuses typed; nothing written', async () => {
    const { po, grn } = await received();
    const another = await seedQtyPo(pool, f, { lines: [{ qty: 1, price: 10 }] });
    const bill = await openRequest(pool, f, f.owner);
    try {
      await bill.client.query('SELECT public.goods_received_note_hold($1)', [grn]);
      const pending = cancelling(grn);
      await blockedOn('goods_received_note_cancel');
      // The definer waits on the note with the PO rows held, and no 620: a create on another PO goes through meanwhile.
      const made = await callTool(pool, f, create, grnArgs(another, [[0, 1]]));
      expect(made.isError, made.text).toBe(false);
      const out = await Promise.race([pending, sleep(15_000).then(() => 'still waiting' as const)]);
      expect(out === 'still waiting' ? out : out.e?.code).toBe('ROW_LOCK_TIMEOUT');
    } finally { await bill.rollback(); }
    expect(await noteStatus(grn)).toBe('received');
    expect(await poState(pool, po)).toEqual({ status: 'partially_received', received: [3] });
  });

  it('a create racing a cancel never leaves two live notes with one external reference', async () => {
    const ref = (k: string) => ({ external_system: 'fibreflow', external_ref: `locks-${k}-${Date.now()}` });
    // Deterministic: the cancel has run but not committed; a create with the same reference on another PO is refused, not blocked.
    const first = ref('held');
    const { grn } = await received(first);
    const req = await openRequest(pool, f, f.owner);
    try {
      await req.run(() => cancelGoodsReceived(f.co, grn, 'held', { userId: f.owner, via: 'test' }));
      const dup = await callTool(pool, f, create, grnArgs(await seedQtyPo(pool, f, { lines: [{ qty: 1, price: 1 }] }), [[0, 1]], first));
      expect(refusal(dup.text)).toMatchObject({ code: 'duplicate_external_ref', existing_goods_received: { id: grn } });
      await req.commit();
    } catch (err) { await req.rollback(); throw err; }
    const again = await callTool(pool, f, create, grnArgs(await seedQtyPo(pool, f, { lines: [{ qty: 1, price: 1 }] }), [[0, 1]], first));
    expect(again.isError, again.text).toBe(false);
    // Raced: whichever order they land in, at most one live note holds the reference and neither call fails untyped.
    for (let round = 0; round < 6; round++) {
      const r = ref(`race-${round}`);
      const { grn: g } = await received(r);
      const other = await seedQtyPo(pool, f, { lines: [{ qty: 1, price: 1 }] });
      const [c, m] = await Promise.allSettled([callTool(pool, f, cancel, { grn_id: g, reason: 'race' }), callTool(pool, f, create, grnArgs(other, [[0, 1]], r))]);
      expect(c.status === 'fulfilled' && !c.value.isError, `round ${round}: ${JSON.stringify(c)}`).toBe(true);
      expect(m.status, `round ${round}: ${JSON.stringify(m)}`).toBe('fulfilled');
      if (m.status === 'fulfilled' && m.value.isError) expect(refusal(m.value.text).code).toBe('duplicate_external_ref');
      const live = (await pool.query("SELECT count(*)::INT AS n FROM goods_received_notes WHERE company_id = $1 AND external_ref = $2 AND status <> 'cancelled'", [f.co, r.external_ref])).rows[0].n;
      expect(live, `round ${round}`).toBeLessThanOrEqual(1);
    }
  });
});
