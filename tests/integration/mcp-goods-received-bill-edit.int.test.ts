/**
 * A draft edit keeps the bill's goods received note agreeing with the bill (merge-gate finding 3 on #1697; docs/design/mcp-goods-received.md
 * "A bill's GRN"), real PostgreSQL, as app_user through update_supplier_invoice:
 *   - changing the supplier of a draft that carries a note on the old supplier's PO is refused, naming the exit (grn_id), and nothing
 *     is written;
 *   - the same supplier change with grn_id null (the note comes off), or with a live note on a PO of the new supplier, goes through;
 *   - grn_id naming a cancelled note, or a note on another supplier's PO, is refused;
 *   - a cancel of the new note committed while the edit runs: the edit holds the note last and refuses it (never a live bill on a
 *     cancelled note).
 * Fixture route: isaflow_schema_fixture (assertDisposable). Never skips.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { dropBillFixture, openRequest, seedBillFixture, type BillFixture } from './helpers/budgetBillFixture';
import { seedSupplier } from './helpers/poBillLinkHarness';
import { callRegistry, callTool, dropGrnExtras, dropMaintExtras, grnArgs, seedQtyPo } from './helpers/grnHarness';
import { createGoodsReceivedTool as create } from '@/lib/mcp/tools/writeCreateGoodsReceived';
import { cancelGoodsReceivedTool as cancel } from '@/lib/mcp/tools/writeCancelGoodsReceived';
import { updateSupplierInvoiceTool as update } from '@/lib/mcp/tools/writeUpdateSupplierInvoice';
import { createSupplierInvoice } from '@/modules/accounting/services/ap/supplierInvoiceService';
import { getSupplierInvoices } from '@/modules/accounting/services/ap/supplierInvoiceQueryService';
import { performThreeWayMatch } from '@/modules/accounting/services/ap/supplierInvoiceWorkflowService';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 6 });
let f: BillFixture;
let supplierB: string;
let n = 0;

beforeAll(async () => {
  f = await seedBillFixture(pool, 'grn-bill-edit');
  supplierB = await seedSupplier(pool, f, 'Supplier B (edit)');
}, 60_000);
afterAll(async () => {
  try { await dropGrnExtras(pool, f); await dropMaintExtras(pool, f); await dropBillFixture(pool, f); } finally { await pool.end(); }
}, 60_000);

/** A live note receiving a one-line PO of `supplier` (default: the fixture's supplier A). */
const noteOf = async (supplier?: string): Promise<string> => {
  const po = await seedQtyPo(pool, f, { lines: [{ qty: 4, price: 10 }] });
  if (supplier) await pool.query('UPDATE purchase_orders SET supplier_id = $2 WHERE id = $1', [po.po, supplier]);
  const r = await callTool(pool, f, create, grnArgs(po, [[0, 4]]));
  expect(r.isError, r.text).toBe(false);
  return String(r.body.grn_id);
};
/** A draft bill of supplier A carrying `grn` (it names no PO, so only the supplier ties the note). */
const draftWith = async (grn: string): Promise<string> => {
  const req = await openRequest(pool, f, f.owner);
  try {
    const bill = await req.run(() => createSupplierInvoice(f.co, {
      invoiceNumber: `GRN-EDIT-${n++}-${Date.now()}`, supplierId: f.supplier, invoiceDate: '2026-06-15', grnId: grn,
      items: [{ description: 'Delivered goods', quantity: 1, unitPrice: 40, taxRate: 15, glAccountId: f.acc.opex }],
    }, f.owner));
    await req.commit();
    return bill.id;
  } catch (err) { await req.rollback(); throw err; }
};
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
/** Until a statement containing `fragment` waits on a lock, or `ms` passed (an edit that takes no hold never waits). */
async function untilBlockedOn(fragment: string, ms: number): Promise<void> {
  for (let t = 0; t < ms; t += 25) {
    const rows = (await pool.query(
      "SELECT 1 FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND datname = current_database() AND query LIKE '%' || $1 || '%'", [fragment])).rows;
    if (rows.length > 0) return;
    await sleep(25);
  }
}
const billRow = async (id: string) => (await pool.query(
  'SELECT supplier_id::text AS supplier_id, grn_id::text AS grn_id FROM supplier_invoices WHERE id = $1', [id])).rows[0] as { supplier_id: string; grn_id: string | null };

describe('a draft edit re-judges the bill\'s goods received note (gate finding 3)', () => {
  it('a supplier change is refused while the note is on the old supplier\'s PO, naming grn_id; nothing is written', async () => {
    const grn = await noteOf();
    const bill = await draftWith(grn);
    const r = await callTool(pool, f, update, { invoice_id: bill, supplier_id: supplierB });
    expect(r.isError).toBe(true);
    expect(r.text).toContain('another supplier\'s purchase order');
    expect(r.text).toContain('grn_id: null');
    expect(await billRow(bill)).toEqual({ supplier_id: f.supplier, grn_id: grn });
  });

  it('the supplier change with grn_id null takes the note off and goes through', async () => {
    const grn = await noteOf();
    const bill = await draftWith(grn);
    const r = await callTool(pool, f, update, { invoice_id: bill, supplier_id: supplierB, grn_id: null });
    expect(r.isError, r.text).toBe(false);
    expect(r.body).toMatchObject({ supplier_id: supplierB, grn_id: null });
    expect(r.body.changed).toEqual(expect.arrayContaining(['supplierId', 'grnId']));
    expect(await billRow(bill)).toEqual({ supplier_id: supplierB, grn_id: null });
  });

  it('the supplier change with a live note on the new supplier\'s PO goes through and carries that note', async () => {
    const bill = await draftWith(await noteOf());
    const theirs = await noteOf(supplierB);
    const r = await callTool(pool, f, update, { invoice_id: bill, supplier_id: supplierB, grn_id: theirs });
    expect(r.isError, r.text).toBe(false);
    expect(await billRow(bill)).toEqual({ supplier_id: supplierB, grn_id: theirs });
  });

  it('grn_id naming a cancelled note or a note on another supplier\'s PO is refused; nothing is written', async () => {
    const grn = await noteOf();
    const bill = await draftWith(grn);
    const dead = await noteOf();
    expect((await callTool(pool, f, cancel, { grn_id: dead, reason: 'wrong delivery' })).isError).toBe(false);
    const cancelled = await callTool(pool, f, update, { invoice_id: bill, grn_id: dead });
    expect(cancelled.isError).toBe(true);
    expect(cancelled.text).toContain('cancelled');
    const foreign = await callTool(pool, f, update, { invoice_id: bill, grn_id: await noteOf(supplierB) });
    expect(foreign.isError).toBe(true);
    expect(foreign.text).toContain('another supplier\'s purchase order');
    expect(await billRow(bill)).toEqual({ supplier_id: f.supplier, grn_id: grn });
  });

  it('a header naming no purchase order of the company (a legacy id) does not make every note disagree (review L2)', async () => {
    const bill = await draftWith(await noteOf());
    await pool.query('UPDATE supplier_invoices SET purchase_order_id = $2 WHERE id = $1', [bill, crypto.randomUUID()]);
    const next = await noteOf();
    const r = await callTool(pool, f, update, { invoice_id: bill, grn_id: next });
    expect(r.isError, r.text).toBe(false);
    expect(await billRow(bill)).toEqual({ supplier_id: f.supplier, grn_id: next });
  });

  it('a fully matched draft whose grn_id is cleared is re-judged and drops out of the fully matched list (gate round 3, finding 1)', async () => {
    const po = await seedQtyPo(pool, f, { lines: [{ qty: 4, price: 10 }] });
    const r = await callTool(pool, f, create, grnArgs(po, [[0, 4]]));
    expect(r.isError, r.text).toBe(false);
    const req = await openRequest(pool, f, f.owner);
    let bill: string;
    try {
      bill = (await req.run(() => createSupplierInvoice(f.co, {
        invoiceNumber: `GRN-EDIT-M-${n++}-${Date.now()}`, supplierId: f.supplier, invoiceDate: '2026-06-15', grnId: String(r.body.grn_id),
        items: [{ description: 'Matched goods', quantity: 4, unitPrice: 10, taxRate: 15, glAccountId: f.acc.opex, poItemId: po.items[0] }],
      }, f.owner))).id;
      expect((await req.run(() => performThreeWayMatch(f.co, bill))).matchStatus).toBe('fully_matched');
      await req.commit();
    } catch (err) { await req.rollback(); throw err; }
    const fullyMatched = async () => {
      const q = await openRequest(pool, f, f.owner);
      try { return (await q.run(() => getSupplierInvoices(f.co, { matchStatus: 'fully_matched', limit: 500 }))).invoices.map((i) => i.id); } finally { await q.rollback(); }
    };
    expect(await fullyMatched()).toContain(bill!);
    const edit = await callTool(pool, f, update, { invoice_id: bill!, grn_id: null });
    expect(edit.isError, edit.text).toBe(false);
    expect(await fullyMatched()).not.toContain(bill!);
    const lines = (await pool.query('SELECT line_match_status FROM supplier_invoice_items WHERE supplier_invoice_id = $1', [bill!])).rows;
    expect(lines.map((l) => l.line_match_status)).not.toContain('fully_matched');
  });

  it('a cancel of the new note running during the edit: the edit waits on the note and refuses the cancelled note (never a live bill on a cancelled note)', async () => {
    const grn = await noteOf();
    const bill = await draftWith(grn);
    const next = await noteOf();
    // The cancel has decided and holds the note FOR UPDATE, uncommitted: the edit's unlocked plan still reads the note as live.
    const cancelling = await openRequest(pool, f, f.owner);
    let edit: Promise<Awaited<ReturnType<typeof callRegistry>>> | undefined;
    try {
      expect((await cancelling.client.query('SELECT outcome FROM public.goods_received_note_cancel($1, $2)', [next, 'race'])).rows[0]).toEqual({ outcome: 'cancelled' });
      // Through a real registry: the apply's refusal is thrown, and the registry answers it as the typed refusal an agent reads.
      edit = callRegistry(pool, f, update, { invoice_id: bill, grn_id: next, idempotency_key: `edit-race-${Date.now()}` });
      await untilBlockedOn('goods_received_note_hold', 2000);
      await cancelling.commit();
    } catch (err) { await cancelling.rollback(); throw err; }
    const r = await edit!;
    expect(r.isError, r.text).toBe(true);
    expect(r.text).toContain('cancelled');
    expect(await billRow(bill)).toEqual({ supplier_id: f.supplier, grn_id: grn });
  });
});
