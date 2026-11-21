/**
 * A bill and its goods received note (supplier_invoices.grn_id, no foreign key; review M1 / L3 of docs/design/mcp-goods-received.md),
 * real PostgreSQL, as app_user:
 *   - a bill create (the service and the REST route) refuses a cancelled note, another company's note, an unknown or malformed id;
 *   - a soft-deleted bill naming a note cancelled meanwhile is not restored (undo), one naming a live note is;
 *   - a cancelled or deleted bill frees the note for cancel; the refusal says so;
 *   - a bill create and a cancel of its note, interleaved both ways and raced, end in exactly one outcome: never a cancelled note
 *     with a live bill.
 * Fixture route: isaflow_schema_fixture (assertDisposable). Never skips.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { callRoute, dropBillFixture, openRequest, seedBillFixture, type BillFixture } from './helpers/budgetBillFixture';
import { seedBill } from './helpers/poBillLinkHarness';
import { callTool, dropGrnExtras, dropMaintExtras, grnArgs, refusal, seedQtyPo } from './helpers/grnHarness';
import { createGoodsReceivedTool as create } from '@/lib/mcp/tools/writeCreateGoodsReceived';
import { cancelGoodsReceivedTool as cancel } from '@/lib/mcp/tools/writeCancelGoodsReceived';
import { createSupplierInvoice } from '@/modules/accounting/services/ap/supplierInvoiceService';
import { cancelGoodsReceived } from '@/modules/accounting/services/ap/goodsReceivedCancel';
import { undoDelete } from '@/modules/accounting/services/core/softDeleteService';
import billsRoute from '../../pages/api/accounting/supplier-invoices';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 10 });
let f: BillFixture;
let other: BillFixture;
let n = 0;

beforeAll(async () => {
  f = await seedBillFixture(pool, 'grn-bills');
  other = await seedBillFixture(pool, 'grn-bills-other');
}, 60_000);
afterAll(async () => {
  try {
    for (const x of [f, other]) { await dropGrnExtras(pool, x); await dropMaintExtras(pool, x); await dropBillFixture(pool, x); }
  } finally { await pool.end(); }
}, 60_000);

const note = async (fx: BillFixture) => {
  const po = await seedQtyPo(pool, fx, { lines: [{ qty: 4, price: 10 }] });
  const r = await callTool(pool, fx, create, grnArgs(po, [[0, 4]]));
  expect(r.isError, r.text).toBe(false);
  return String(r.body.grn_id);
};
const billInput = (grnId: unknown) => ({
  invoiceNumber: `GRN-BILL-${n++}-${Date.now()}`, supplierId: f.supplier, invoiceDate: '2026-06-15', grnId: grnId as string,
  items: [{ description: 'Delivered goods', quantity: 1, unitPrice: 40, taxRate: 15, glAccountId: f.acc.opex }],
});
/** createSupplierInvoice in its own app_user request: the bill id, or the error's message. Committed only when it succeeds. */
const createBill = async (grnId: unknown, purchaseOrderId?: string): Promise<{ id?: string; error?: string }> => {
  const req = await openRequest(pool, f, f.owner);
  try {
    const bill = await req.run(() => createSupplierInvoice(f.co, { ...billInput(grnId), ...(purchaseOrderId ? { purchaseOrderId } : {}) }, f.owner));
    await req.commit();
    return { id: bill.id };
  } catch (err) {
    await req.rollback();
    return { error: (err as Error).message };
  }
};
const liveBills = async (grn: string) => Number((await pool.query(
  "SELECT count(*) AS n FROM supplier_invoices WHERE grn_id = $1 AND deleted_at IS NULL AND status <> 'cancelled'", [grn])).rows[0].n);
const noteStatus = async (grn: string) => String((await pool.query('SELECT status FROM goods_received_notes WHERE id = $1', [grn])).rows[0].status);
/** Waits until another backend is blocked on a lock while running a statement that contains `fragment`. */
async function blockedOn(fragment: string): Promise<void> {
  for (let i = 0; i < 200; i++) {
    const r = await pool.query(
      "SELECT 1 FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND datname = current_database() AND query LIKE '%' || $1 || '%'", [fragment]);
    if (r.rows.length > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`nothing blocked on ${fragment}`);
}

describe('a bill create names a live note of its company only (M1)', () => {
  it('a cancelled, another company\'s, an unknown or a malformed note is refused; a live one is stored', async () => {
    const gone = await note(f);
    expect((await callTool(pool, f, cancel, { grn_id: gone, reason: 'x' })).isError).toBe(false);
    expect((await createBill(gone)).error).toContain('is cancelled');
    expect((await createBill(await note(other))).error).toContain('not one of this company\'s');
    expect((await createBill(crypto.randomUUID())).error).toContain('not one of this company\'s');
    expect((await createBill('GRN-00001')).error).toContain('not a valid id');
    const live = await note(f);
    const made = await createBill(live.toUpperCase());
    expect(made.error).toBeUndefined();
    expect((await pool.query('SELECT grn_id::text AS g FROM supplier_invoices WHERE id = $1', [made.id])).rows[0].g).toBe(live);
  });

  it('the REST create refuses a cancelled note with a 400 before it reserves a number', async () => {
    const gone = await note(f);
    expect((await callTool(pool, f, cancel, { grn_id: gone, reason: 'x' })).isError).toBe(false);
    const counter = async () => (await pool.query(
      "SELECT next_number FROM company_document_numbers WHERE company_id = $1 AND document_type = 'supplier_invoice'", [f.co])).rows[0]?.next_number ?? null;
    const before = await counter();
    const { invoiceNumber: _n, ...body } = billInput(gone);
    const r = await callRoute(billsRoute as never, f, f.owner, '/api/accounting/supplier-invoices', { ...body, useSequence: true });
    expect(r.statusCode, JSON.stringify(r.body)).toBe(400);
    expect(JSON.stringify(r.body)).toContain('is cancelled');
    expect(await counter()).toBe(before);
    // A user of both companies, working in this one: the other company's note is visible to row security, and still refused first.
    const theirs = await note(other);
    await pool.query("INSERT INTO company_users (company_id, user_id, role) VALUES ($1, $2, 'owner') ON CONFLICT DO NOTHING", [other.co, f.owner]);
    try {
      const foreign = await callRoute(billsRoute as never, f, f.owner, '/api/accounting/supplier-invoices', { ...billInput(theirs), invoiceNumber: undefined, useSequence: true });
      expect(foreign.statusCode, JSON.stringify(foreign.body)).toBe(400);
      expect(JSON.stringify(foreign.body)).toContain('not one of this company');
      expect(await counter()).toBe(before);
    } finally {
      await pool.query('DELETE FROM company_users WHERE company_id = $1 AND user_id = $2', [other.co, f.owner]);
    }
  });
});

describe('restore and the exits (M1, L3)', () => {
  it('undo of a deleted bill whose note was cancelled meanwhile is refused; with a live note it restores', async () => {
    const grn = await note(f);
    const bill = await seedBill(pool, f, { status: 'draft', lines: [40] });
    await pool.query('UPDATE supplier_invoices SET grn_id = $2, deleted_at = now() WHERE id = $1', [bill.id, grn]);
    expect((await callTool(pool, f, cancel, { grn_id: grn, reason: 'x' })).isError).toBe(false);
    const undo = async (id: string) => {
      const req = await openRequest(pool, f, f.owner);
      try { const r = await req.run(() => undoDelete(f.co, 'supplier_invoice', id, f.owner)); await req.commit(); return String(r); } catch (e) { await req.rollback(); return (e as Error).message; }
    };
    expect(await undo(bill.id)).toContain('has since been cancelled');
    expect((await pool.query('SELECT deleted_at IS NOT NULL AS d FROM supplier_invoices WHERE id = $1', [bill.id])).rows[0].d).toBe(true);
    const liveNote = await note(f);
    const kept = await seedBill(pool, f, { status: 'draft', lines: [40] });
    await pool.query('UPDATE supplier_invoices SET grn_id = $2, deleted_at = now() WHERE id = $1', [kept.id, liveNote]);
    expect(await undo(kept.id)).toBe('true');
  });

  it('a cancelled bill frees the note as a deleted one does; the refusal names the way out', async () => {
    const grn = await note(f);
    const bill = await seedBill(pool, f, { status: 'draft', lines: [40] });
    const done = await seedBill(pool, f, { status: 'cancelled', lines: [40] });
    await pool.query('UPDATE supplier_invoices SET grn_id = $2 WHERE id = ANY($1::UUID[])', [[bill.id, done.id], grn]);
    const refused = refusal((await callTool(pool, f, cancel, { grn_id: grn, reason: 'x' })).text);
    expect(refused).toMatchObject({ code: 'grn_on_bill', bills_total: 1, bills: [expect.objectContaining({ id: bill.id })] });
    expect(refused.message).toContain('Cancel or delete that bill first');
    await pool.query("UPDATE supplier_invoices SET status = 'cancelled' WHERE id = $1", [bill.id]);
    expect((await callTool(pool, f, cancel, { grn_id: grn, reason: 'x' })).isError).toBe(false);
  });
});

describe('a bill create racing a cancel of its note (M1)', () => {
  it('bill first: the cancel waits for the bill to commit, then refuses grn_on_bill', async () => {
    const grn = await note(f);
    const req = await openRequest(pool, f, f.owner);
    const bill = await req.run(() => createSupplierInvoice(f.co, billInput(grn), f.owner));
    const cancelling = callTool(pool, f, cancel, { grn_id: grn, reason: 'race' });
    // At its first lock, the note's PO FOR UPDATE: the bill holds that PO FOR KEY SHARE (lockNotePo, Codex gate at 42de08b3, 4).
    await blockedOn('FOR UPDATE OF po');
    await req.commit();
    expect(refusal((await cancelling).text)).toMatchObject({ code: 'grn_on_bill', bills: [expect.objectContaining({ id: bill.id })] });
    expect(await noteStatus(grn)).toBe('received');
  });

  it('cancel first: the bill waits for the cancel to commit, then refuses the cancelled note', async () => {
    const grn = await note(f);
    const req = await openRequest(pool, f, f.owner);
    await req.run(() => cancelGoodsReceived(f.co, grn, 'race', { userId: f.owner, via: 'test' }));
    const billing = createBill(grn);
    // At the note's PO (lockNotePo's FOR KEY SHARE, before the INSERT whose grn-live trigger takes the note): the cancel holds it.
    await blockedOn('FOR KEY SHARE OF po');
    await req.commit();
    expect((await billing).error).toContain('is cancelled');
    expect(await liveBills(grn)).toBe(0);
  });

  it('a cancel holding the PO the bill also names: the bill waits on the PO, never holds the note first (no deadlock)', async () => {
    const po = await seedQtyPo(pool, f, { lines: [{ qty: 4, price: 10 }] });
    const made = await callTool(pool, f, create, grnArgs(po, [[0, 4]]));
    const grn = String(made.body.grn_id);
    // The cancel's own order, by hand, paused after the PO row: number lock 620 -> PO FOR UPDATE.
    const req = await openRequest(pool, f, f.owner);
    await req.client.query('SELECT public.take_number_lock($1::text, 620)', [f.co]);
    await req.client.query('SELECT id FROM purchase_orders WHERE id = $1 FOR UPDATE', [po.po]);
    const billing = (async () => {
      const b = await openRequest(pool, f, f.owner);
      try {
        await b.run(() => createSupplierInvoice(f.co, { ...billInput(grn), purchaseOrderId: po.po }, f.owner));
        await b.commit();
        return 'created';
      } catch (err) { await b.rollback(); return (err as Error).message; }
    })();
    await blockedOn('FOR KEY SHARE');
    const out = (await req.client.query('SELECT outcome FROM public.goods_received_note_cancel($1, $2)', [grn, 'race'])).rows[0];
    await req.commit();
    expect(out).toEqual({ outcome: 'cancelled' });
    expect(await billing).toContain('is cancelled');
    expect(await liveBills(grn)).toBe(0);
  });

  it('raced at once: exactly one wins, never a cancelled note with a live bill', async () => {
    for (let round = 0; round < 8; round++) {
      // Odd rounds: the bill also names the note's PO, so both sides lock that PO row too.
      const po = await seedQtyPo(pool, f, { lines: [{ qty: 4, price: 10 }] });
      const grn = String((await callTool(pool, f, create, grnArgs(po, [[0, 4]]))).body.grn_id);
      const [bill, cancelled] = await Promise.all([createBill(grn, round % 2 ? po.po : undefined), callTool(pool, f, cancel, { grn_id: grn, reason: 'race' })]);
      const outcome = `round ${round}: bill ${bill.error ?? 'created'}, cancel ${cancelled.isError ? refusal(cancelled.text).code : 'cancelled'}`;
      expect(bill.error ?? '', outcome).not.toContain('deadlock');
      expect([bill.error === undefined, !cancelled.isError].filter(Boolean), outcome).toHaveLength(1);
      expect((await noteStatus(grn)) === 'cancelled' && (await liveBills(grn)) > 0, outcome).toBe(false);
    }
  });
});
