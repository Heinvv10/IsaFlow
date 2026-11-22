/**
 * #1699 review: a supplier merge against a bill create / edit that is still open on the source and links to one of its POs.
 * Final-state assertions: no link ever joins a PO and a bill of two suppliers, and the merge waits for the open bill, then
 * refuses cleanly (PO_BILL_LINKS_REFUSAL). The create path is serialised by the supplier row lock; the edit path only by the
 * PO row lock (FOR UPDATE: it goes red under FOR NO KEY UPDATE, which lets the merge reach the bill update and fail on the
 * link guard as a raw database error).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { als } from '@/lib/als';
import { sql } from '@/lib/neon';
import { createSupplierInvoice } from '@/modules/accounting/services/ap/supplierInvoiceService';
import { refreshAppBillLinks } from '@/modules/accounting/services/ap/billPurchaseOrderLinks';
import { SupplierMergeRefusal, mergeEntities, PO_BILL_LINKS_REFUSAL } from '@/modules/accounting/services/core/duplicateMergeService';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { sageMergedWorld } from './helpers/sageMergedSupplierWorld';
import { autoPostApprovalGuard } from '@/modules/accounting/services/bank/bankRuleAutoPostApproval';
/** #1656: mergeEntities' bank-rule guard (a customer merge's); a supplier merge re-points no bank rule. */
const NO_RULE_GUARD = autoPostApprovalGuard(true);

assertDisposable();
const w = sageMergedWorld('races');
const { pool, companyId, userId, tag, inRequestTx, insPlain, bill, billSupplier } = w;

const merge = (survivor: string, gone: string) => inRequestTx(() => mergeEntities(companyId, 'supplier', survivor, gone, userId, NO_RULE_GUARD, 'admin'), true);
const seedPo = async (supplierId: string, number: string) => String((await pool.query(
  "INSERT INTO purchase_orders (company_id, po_number, supplier_id, status, approved_by) VALUES ($1, $2, $3, 'approved', 'original-approver') RETURNING id",
  [companyId, `${number}-${tag}`, supplierId])).rows[0].id);
const ownerOf = async (id: string) => String((await pool.query('SELECT supplier_id FROM purchase_orders WHERE id = $1', [id])).rows[0].supplier_id);

const insertedLink = async (db: { query: typeof pool.query }, po: string) => Number((await db.query('SELECT count(*) AS n FROM purchase_order_bill_links WHERE purchase_order_id = $1', [po])).rows[0].n);
/** True once a session of this suite other than the holder is waiting on a lock (the merge, blocked by the held transaction). */
async function mergeBlockedBehind(holderPid: number): Promise<boolean> {
  for (let i = 0; i < 100; i++) {
    const { rows } = await pool.query(
      "SELECT 1 FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND application_name = $1 AND pid <> $2", [w.applicationName, holderPid]);
    if (rows.length > 0) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
}

beforeAll(() => w.seed(), 60000);
afterAll(() => w.drop(), 60000);

describe('a merge against an open bill create / edit (#1699 review)', () => {
  it('a bill being created on the source that links to its PO (uncommitted) is never left linked across suppliers by a merge', async () => {
    const survivor = await insPlain('Race Survivor');
    const gone = await insPlain('Race Gone');
    const po = await seedPo(gone, 'PO-RACE');
    // The real bill-create path on a second connection, held open: INSERT bill, FOR KEY SHARE the PO, INSERT the link.
    const creator = await pool.connect();
    let merged: Promise<unknown>;
    let blocked = false;
    const creatorPid = Number((await creator.query('SELECT pg_backend_pid() AS pid')).rows[0].pid);
    try {
      await creator.query('BEGIN');
      await als.run({ client: creator, userId, companyId, claims: {} } as never, () => createSupplierInvoice(companyId, {
        trustSourceTax: true, supplierId: gone, invoiceNumber: `AP-RACE-${tag}`, invoiceDate: '2026-04-02', purchaseOrderId: po,
        taxRate: 15, items: [{ description: 'Race bill', quantity: 1, unitPrice: 100, taxRate: 15, taxAmount: 15 }],
      } as never, userId));
      expect(await insertedLink(creator, po)).toBe(1);
      // The merge now runs against the open bill. A bill create holds a KEY SHARE on its supplier row, which the merge's
      // FOR UPDATE on both supplier rows (the DRC check) conflicts with, so this path is serialised by the SUPPLIER lock
      // before the merge reaches the PO rows; the edit test below is the one that needs the PO lock.
      merged = merge(survivor, gone).then(() => 'merged', (err: unknown) => err);
      blocked = await mergeBlockedBehind(creatorPid);
      await creator.query('COMMIT');
    } finally {
      await creator.query('ROLLBACK').catch(() => undefined);
      creator.release();
    }
    const outcome = await merged!;
    // Whatever the merge did, no link joins a PO and a bill of two suppliers, and the merge did not finish before the bill did.
    const crossed = await pool.query(
      `SELECT l.id FROM purchase_order_bill_links l
         JOIN purchase_orders p ON p.id = l.purchase_order_id JOIN supplier_invoices b ON b.id = l.supplier_invoice_id
        WHERE l.company_id = $1 AND p.supplier_id <> b.supplier_id`, [companyId]);
    expect(crossed.rows).toEqual([]);
    expect(blocked).toBe(true);
    expect(outcome).toBeInstanceOf(SupplierMergeRefusal);
    expect((outcome as Error).message).toBe(PO_BILL_LINKS_REFUSAL);
    expect(await ownerOf(po)).toBe(gone);
  });
  it('a bill EDIT on the source that links it to the PO (uncommitted) makes the merge wait for it and refuse cleanly, not fail on the database guard', async () => {
    // An existing bill takes the PO as its header (the draft edit path: UPDATE the bill, then refreshAppBillLinks) and holds that
    // open. It holds no KEY SHARE on the supplier row, so only the merge's lock on the PO rows can see it: FOR NO KEY UPDATE lets
    // the merge through to the bill update, where the link guard (23514) refuses it as a raw database error.
    const survivor = await insPlain('Edit Survivor');
    const gone = await insPlain('Edit Gone', 'sage', '984');
    const po = await seedPo(gone, 'PO-EDIT');
    await bill('AP-EDIT-1', 'Edit Gone', 984);
    const billId = String((await pool.query('SELECT id FROM supplier_invoices WHERE company_id = $1 AND invoice_number = $2',
      [companyId, `AP-EDIT-1-${tag}`])).rows[0].id);
    const editor = await pool.connect();
    let merged: Promise<unknown>;
    let blocked = false;
    const editorPid = Number((await editor.query('SELECT pg_backend_pid() AS pid')).rows[0].pid);
    try {
      await editor.query('BEGIN');
      await als.run({ client: editor, userId, companyId, claims: {} } as never, async () => {
        await sql`UPDATE supplier_invoices SET purchase_order_id = ${po}::UUID WHERE id = ${billId}::UUID AND company_id = ${companyId}::UUID`;
        await refreshAppBillLinks(companyId, billId, userId);
      });
      expect(await insertedLink(editor, po)).toBe(1);
      merged = merge(survivor, gone).then(() => 'merged', (err: unknown) => err);
      blocked = await mergeBlockedBehind(editorPid);
      await editor.query('COMMIT');
    } finally {
      await editor.query('ROLLBACK').catch(() => undefined);
      editor.release();
    }
    const outcome = await merged!;
    const crossed = await pool.query(
      `SELECT l.id FROM purchase_order_bill_links l
         JOIN purchase_orders p ON p.id = l.purchase_order_id JOIN supplier_invoices b ON b.id = l.supplier_invoice_id
        WHERE l.company_id = $1 AND p.supplier_id <> b.supplier_id`, [companyId]);
    expect(crossed.rows).toEqual([]);
    expect(blocked).toBe(true);
    expect(outcome).toBeInstanceOf(SupplierMergeRefusal);
    expect((outcome as Error).message).toBe(PO_BILL_LINKS_REFUSAL);
    expect(await ownerOf(po)).toBe(gone);
    expect(await billSupplier('AP-EDIT-1')).toBe(gone);
  });
});
