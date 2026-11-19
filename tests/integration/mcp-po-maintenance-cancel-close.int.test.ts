/**
 * cancel_purchase_order and close_purchase_order (docs/design/mcp-po-maintenance.md, decisions 2 and 3), real PostgreSQL, as
 * app_user (poImportHarness). Budget: BB-6100 opex at CC1 FT, 1 000 a month; no bills here (they would count as actual).
 *   - cancel per status: draft / submitted by any writer, approved by owner / admin only and refused with a receipt or bill links;
 *     partially_received / received / closed / cancelled refused with the status; a reason is required and audited;
 *   - close per status: approved / partially_received / received -> closed by owner / admin, the status it came from kept in
 *     closed_from_status, the commitment released (readCommitments before and after), the remaining ordered-not-received quantity
 *     and amount per line reported, audited with the received and billed amounts; bills and links stay;
 *   - dry runs write nothing; no ledger row is written by any of it.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { dropBillFixture, seedBillFixture, setPolicy, type BillFixture } from './helpers/budgetBillFixture';
import { asOwner } from './helpers/poImportHarness';
import { linkRows, seedBill } from './helpers/poBillLinkHarness';
import { auditOf, callTool, dropMaintExtras, glCount, poRow, seedGrn, seedQtyPo } from './helpers/poMaintHarness';
import { cancelPurchaseOrderTool as cancel } from '@/lib/mcp/tools/writeCancelPurchaseOrder';
import { closePurchaseOrderTool as close } from '@/lib/mcp/tools/writeClosePurchaseOrder';
import { linkBillsToPurchaseOrderTool as link } from '@/lib/mcp/tools/writeLinkBillsToPurchaseOrder';
import { readCommitments } from '@/modules/accounting/services/budgets/remainingCommitted';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
let f: BillFixture;
const MANAGER = { user: '', companyRole: 'manager' };

beforeAll(async () => {
  f = await seedBillFixture(pool, 'po-maint-cancel-close');
  MANAGER.user = f.manager;
  await setPolicy(pool, f, 'warn');
}, 60_000);
afterEach(async () => {
  await pool.query("UPDATE purchase_orders SET status = 'cancelled' WHERE company_id = $1 AND status IN ('approved', 'partially_received', 'received')", [f.co]);
});
afterAll(async () => {
  try { await dropMaintExtras(pool, f); await dropBillFixture(pool, f); } finally { await pool.end(); }
}, 60_000);

const committed = async () => (await asOwner(pool, f, () => readCommitments(f.co, [f.acc.opex], '2026-06-01', '2026-06-30', {}))).map((c) => c.lineTotal);

describe('cancel_purchase_order', () => {
  it.each(['draft', 'submitted'])('a %s PO is cancelled by a manager, with the reason audited', async (status) => {
    const po = await seedQtyPo(pool, f, { status, lines: [{ qty: 1, price: 100 }] });
    const gl = await glCount(pool, f);
    const noReason = await callTool(pool, f, cancel, { po_id: po.po, reason: '  ' }, MANAGER);
    expect(noReason.text).toContain('reason is required');
    const r = await callTool(pool, f, cancel, { po_number: po.number, reason: 'raised in error' }, MANAGER);
    expect(r.isError, r.text).toBe(false);
    expect(r.body).toMatchObject({ cancelled: true, status_before: status, status: 'cancelled' });
    expect((await poRow(pool, po.po)).status).toBe('cancelled');
    const audit = (await auditOf(pool, f, po.po)).at(-1)!;
    expect(audit).toMatchObject({ action: 'update', user_id: f.manager });
    expect(audit.changes.fields).toEqual([{ field: 'status', old: status, new: 'cancelled', label: 'Status' }]);
    expect(audit.changes.metadata).toMatchObject({ reason: 'raised in error', source: 'mcp:cancel_purchase_order' });
    expect(await glCount(pool, f)).toEqual(gl);
  });

  it('an approved PO: a manager is refused, an owner cancels it and the commitment is released', async () => {
    const po = await seedQtyPo(pool, f, { lines: [{ qty: 1, price: 400 }] });
    expect(await committed()).toEqual([400]);
    const denied = await callTool(pool, f, cancel, { po_id: po.po, reason: 'dup' }, MANAGER);
    expect(denied.text).toContain('only an owner or admin');
    expect((await poRow(pool, po.po)).status).toBe('approved');
    const r = await callTool(pool, f, cancel, { po_id: po.po, reason: 'duplicate of PO7' });
    expect(r.isError, r.text).toBe(false);
    expect(await committed()).toEqual([]);
    expect((await auditOf(pool, f, po.po)).at(-1)!.changes.metadata).toMatchObject({ cancelled: 'true', reason: 'duplicate of PO7' });
  });

  it('an approved PO with a goods receipt, or with a bill linked, is refused (unlink first)', async () => {
    const received = await seedQtyPo(pool, f, { lines: [{ qty: 10, price: 10, received: 3 }] });
    await seedGrn(pool, f, received);
    const a = await callTool(pool, f, cancel, { po_id: received.po, reason: 'x' });
    expect(a.isError).toBe(true);
    expect(a.text).toContain('a receipt is on record');

    const billed = await seedQtyPo(pool, f, { lines: [{ qty: 1, price: 100 }] });
    const bill = await seedBill(pool, f, { lines: [100] });
    expect((await callTool(pool, f, link, { links: [{ po_id: billed.po, bill_id: bill.id }] })).isError).toBe(false);
    const b = await callTool(pool, f, cancel, { po_id: billed.po, reason: 'x' });
    expect(b.text).toContain('unlink them first');
    expect(await linkRows(pool, f, `l.purchase_order_id = '${billed.po}'`)).toHaveLength(1);
    for (const p of [received, billed]) expect((await poRow(pool, p.po)).status).toBe('approved');
  });

  it('a draft / submitted PO with a receipt or a bill LINE tied to it is refused too, as is an approved one with only a bill line (the wide check); a bill naming it only in a header ties an approved PO (link it first) but not a draft one; the audit row says which tool', async () => {
    const draft = await seedQtyPo(pool, f, { status: 'draft', lines: [{ qty: 4, price: 25, received: 1 }] });
    await seedGrn(pool, f, draft);
    expect((await callTool(pool, f, cancel, { po_id: draft.po, reason: 'x' })).text).toContain('a receipt is on record');
    const submitted = await seedQtyPo(pool, f, { status: 'submitted', lines: [{ qty: 1, price: 100 }] });
    const billH = await seedBill(pool, f, { lines: [100] });
    await pool.query('UPDATE supplier_invoice_items SET po_item_id = $1 WHERE id = $2', [submitted.items[0], billH.lines[0]]);
    expect((await callTool(pool, f, cancel, { po_id: submitted.po, reason: 'x' })).text).toContain('Bills are linked to this purchase order');
    const approved = await seedQtyPo(pool, f, { lines: [{ qty: 1, price: 100 }] });
    const billL = await seedBill(pool, f, { lines: [100] });
    await pool.query('UPDATE supplier_invoice_items SET po_item_id = $1 WHERE id = $2', [approved.items[0], billL.lines[0]]);
    expect(await linkRows(pool, f, `l.purchase_order_id = '${approved.po}'`)).toHaveLength(0);
    const r = await callTool(pool, f, cancel, { po_id: approved.po, reason: 'x' });
    expect(r.text).toContain('unlink them first');
    for (const p of [draft, submitted, approved]) expect((await poRow(pool, p.po)).status).not.toBe('cancelled');
    const headerOnly = await seedQtyPo(pool, f, { lines: [{ qty: 1, price: 100 }] });
    const billHdr = await seedBill(pool, f, { lines: [100] });
    await pool.query('UPDATE supplier_invoices SET purchase_order_id = $1 WHERE id = $2', [headerOnly.po, billHdr.id]);
    expect((await callTool(pool, f, cancel, { po_id: headerOnly.po, reason: 'header only' })).text).toContain('link it first (link_bills_to_purchase_order)');
    const headerDraft = await seedQtyPo(pool, f, { status: 'draft', lines: [{ qty: 1, price: 100 }] });
    const billHdr2 = await seedBill(pool, f, { lines: [100] });
    await pool.query('UPDATE supplier_invoices SET purchase_order_id = $1 WHERE id = $2', [headerDraft.po, billHdr2.id]);
    expect((await callTool(pool, f, cancel, { po_id: headerDraft.po, reason: 'header only, draft PO' })).isError).toBe(false);
    const free = await seedQtyPo(pool, f, { lines: [{ qty: 1, price: 100 }] });
    expect((await callTool(pool, f, cancel, { po_id: free.po, reason: 'dup' })).isError).toBe(false);
    expect((await auditOf(pool, f, free.po)).at(-1)!.changes.metadata).toMatchObject({ source: 'mcp:cancel_purchase_order', reason: 'dup' });
  });

  it.each([['partially_received', 'partially received'], ['received', 'received'], ['closed', 'closed'], ['cancelled', 'already cancelled']])(
    'a %s PO is refused', async (status, words) => {
      const po = await seedQtyPo(pool, f, { status, lines: [{ qty: 1, price: 100 }] });
      const r = await callTool(pool, f, cancel, { po_id: po.po, reason: 'x' });
      expect(r.isError).toBe(true);
      expect(r.text).toContain(words);
      expect((await poRow(pool, po.po)).status).toBe(status);
    });

  it('dry_run changes nothing and refuses what the live call refuses', async () => {
    const po = await seedQtyPo(pool, f, { lines: [{ qty: 1, price: 100 }] });
    const audit = await auditOf(pool, f, po.po);
    const dry = await callTool(pool, f, cancel, { po_id: po.po, reason: 'x', dry_run: true });
    expect(dry.body).toMatchObject({ dry_run: true, would_cancel: true, status_before: 'approved' });
    expect(dry).toMatchObject({ wroteNothing: true });
    expect((await poRow(pool, po.po)).status).toBe('approved');
    expect(await auditOf(pool, f, po.po)).toEqual(audit);
    const denied = await callTool(pool, f, cancel, { po_id: po.po, reason: 'x', dry_run: true }, MANAGER);
    expect(denied.text).toContain('only an owner or admin');
  });
});

describe('close_purchase_order', () => {
  it.each(['approved', 'partially_received', 'received'])('a %s PO is closed: commitment released, the status it came from kept, audited', async (status) => {
    const received = status === 'received' ? 10 : status === 'partially_received' ? 4 : 0;
    const po = await seedQtyPo(pool, f, { status, lines: [{ qty: 10, price: 10, received }] });
    const gl = await glCount(pool, f);
    expect(await committed()).toEqual([100]);
    const r = await callTool(pool, f, close, { po_id: po.po, reason: 'supplier will not deliver the rest' });
    expect(r.isError, r.text).toBe(false);
    expect(r.body).toMatchObject({ closed: true, status_before: status, status: 'closed', received_amount: received * 10, billed_amount: 0 });
    expect(await poRow(pool, po.po)).toMatchObject({ status: 'closed', closed_from_status: status });
    expect(await committed()).toEqual([]);
    const audit = (await auditOf(pool, f, po.po)).at(-1)!;
    expect(audit.changes.fields).toEqual([{ field: 'status', old: status, new: 'closed', label: 'Status' }]);
    expect(audit.changes.metadata).toMatchObject({
      status_before: status, received_amount: (received * 10).toFixed(2), billed_amount: '0.00', reason: 'supplier will not deliver the rest',
    });
    expect(await glCount(pool, f)).toEqual(gl);
  });

  it('reports what was ordered and not received, per short-closed line; a fully received line is not listed', async () => {
    const po = await seedQtyPo(pool, f, { status: 'partially_received', lines: [{ qty: 10, price: 12.5, received: 4 }, { qty: 2, price: 30, received: 2 }, { qty: 3, price: 7, received: 0 }] });
    const r = await callTool(pool, f, close, { po_id: po.po, reason: 'short close' });
    expect(r.body).toMatchObject({ short_closed_lines_total: 2, remaining_amount: 96, received_amount: 110 });
    expect(r.body.short_closed_lines).toEqual([
      { po_item_id: po.items[0], description: 'Qty line 0', ordered_qty: 10, received_qty: 4, remaining_qty: 6, remaining_amount: 75 },
      { po_item_id: po.items[2], description: 'Qty line 2', ordered_qty: 3, received_qty: 0, remaining_qty: 3, remaining_amount: 21 },
    ]);
  });

  it('a manager is refused before anything is read (even for a PO that does not exist, and in a dry run)', async () => {
    const po = await seedQtyPo(pool, f, { lines: [{ qty: 1, price: 100 }] });
    for (const args of [{ po_id: po.po }, { po_id: crypto.randomUUID() }, { po_id: po.po, dry_run: true }]) {
      const r = await callTool(pool, f, close, { reason: 'x', ...args }, MANAGER);
      expect(r).toMatchObject({ isError: true, text: 'Closing a purchase order releases its commitment, which only an owner or admin may do.' });
    }
    expect((await poRow(pool, po.po)).status).toBe('approved');
  });

  it('bills and links stay, and billed_amount counts the linked bill', async () => {
    const po = await seedQtyPo(pool, f, { lines: [{ qty: 1, price: 100 }] });
    const bill = await seedBill(pool, f, { lines: [40] });
    expect((await callTool(pool, f, link, { links: [{ po_id: po.po, bill_id: bill.id }] })).isError).toBe(false);
    const r = await callTool(pool, f, close, { po_id: po.po, reason: 'rest cancelled by supplier' });
    expect(r.isError, r.text).toBe(false);
    expect(r.body).toMatchObject({ billed_amount: 40 });
    expect(await linkRows(pool, f, `l.purchase_order_id = '${po.po}'`)).toHaveLength(1);
    expect((await auditOf(pool, f, po.po)).at(-1)!.changes.metadata).toMatchObject({ billed_amount: '40.00' });
  });

  it.each(['draft', 'submitted', 'closed', 'cancelled'])('a %s PO is refused with its status; a reason is required', async (status) => {
    const po = await seedQtyPo(pool, f, { status, lines: [{ qty: 1, price: 100 }] });
    const r = await callTool(pool, f, close, { po_id: po.po, reason: 'x' });
    expect(r.isError).toBe(true);
    expect(r.text).toContain(`this one is ${status}`);
    expect((await callTool(pool, f, close, { po_id: po.po, reason: '' })).text).toContain('reason is required');
    expect((await poRow(pool, po.po)).status).toBe(status);
  });

  it('dry_run reports the short-closed lines and writes nothing', async () => {
    const po = await seedQtyPo(pool, f, { status: 'partially_received', lines: [{ qty: 10, price: 10, received: 4 }] });
    const audit = await auditOf(pool, f, po.po);
    const dry = await callTool(pool, f, close, { po_id: po.po, reason: 'x', dry_run: true });
    expect(dry.body).toMatchObject({ dry_run: true, would_close: true, remaining_amount: 60, short_closed_lines_total: 1 });
    expect(dry).toMatchObject({ wroteNothing: true });
    expect(await poRow(pool, po.po)).toMatchObject({ status: 'partially_received', closed_from_status: null });
    expect(await auditOf(pool, f, po.po)).toEqual(audit);
    expect(await committed()).toEqual([100]);
  });
});
