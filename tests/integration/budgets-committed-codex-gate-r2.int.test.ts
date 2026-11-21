/**
 * PR #1703 Codex gate, review of c2f1687472..c0ff1b11a6.
 *  M2: a bulk cancel through the REAL route, one store: a PO closed by billing that two bills of the batch tie. The first cancel
 *      reopens it (to what it was closed from), the second finds it open, and the route's pre-lock is the one waiting lock of it
 *      (M1: the held set is handed to each cancel; no request cache re-takes it).
 *  M5: a PO a cancel could not re-check is still closed and get_purchase_order says it is closed under-billed.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';

// Counts the waiting lock of the POs closed by billing (`closedByBillingPoIds` with FOR NO KEY UPDATE): the pre-lock's statement.
const counter = vi.hoisted(() => ({ poLocks: 0 }));
vi.mock('@/lib/neon', async (orig) => {
  const real = await orig<Record<string, unknown>>();
  const realSql = real.sql as (strings: TemplateStringsArray, ...values: unknown[]) => Promise<unknown>;
  const sql = Object.assign((strings: TemplateStringsArray, ...values: unknown[]) => {
    const waiting = values.some((v) => (v as { text?: unknown } | null)?.text === 'FOR NO KEY UPDATE');
    if (waiting && /po\.closed_by_billing AND po\.id IN/.test(strings.join('?'))) counter.poLocks += 1;
    return realSql(strings, ...values);
  }, realSql);
  return { ...real, sql };
});

import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { callRoute, dropBillFixture, seedBillFixture, setPolicy, type BillFixture } from './helpers/budgetBillFixture';
import bulkRoute from '../../pages/api/accounting/supplier-invoices-bulk-action';
import { callTool } from './helpers/poImportHarness';
import { approveBill, seedBill, seedPo, type SeededPo } from './helpers/poBillLinkHarness';
import { cancelSupplierInvoiceTool as cancelBill } from '@/lib/mcp/tools/writeCancelSupplierInvoice';
import { getPurchaseOrderTool as getPo } from '@/lib/mcp/tools/getPurchaseOrder';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 8 });
let f: BillFixture;
beforeAll(async () => { f = await seedBillFixture(pool, 'codex-gate-r2'); await setPolicy(pool, f, 'warn'); }, 60_000);
afterAll(async () => { try { await dropBillFixture(pool, f); } finally { await pool.end(); } }, 60_000);

const flag = async (po: SeededPo) => (await pool.query('SELECT status, closed_by_billing FROM purchase_orders WHERE id = $1', [po.po])).rows[0];
async function approvedOnHeader(po: SeededPo, amount: number): Promise<string> {
  const b = await seedBill(pool, f, { status: 'draft', lines: [amount] });
  await approveBill(pool, f, b.id);
  await pool.query('UPDATE supplier_invoices SET purchase_order_id = $2 WHERE id = $1', [b.id, po.po]);
  return b.id;
}
const closeByBilling = (po: SeededPo) =>
  pool.query(`UPDATE purchase_orders SET status = 'closed', closed_from_status = 'approved', closed_by_billing = true WHERE id = $1`, [po.po]);

describe('M2: bulk cancel of two bills on one PO closed by billing', () => {
  it('the first cancel reopens it once, the second finds it open; the PO is lock-waited once (the route pre-lock)', async () => {
    const p = await seedPo(pool, f, { lines: [1000] });
    const a = await approvedOnHeader(p, 600);
    const b = await approvedOnHeader(p, 400);
    await closeByBilling(p);
    counter.poLocks = 0;
    const r = await callRoute(bulkRoute as never, f, f.owner, '/api/accounting/supplier-invoices-bulk-action', { action: 'cancel', invoiceIds: [b, a] });
    expect(r.statusCode).toBe(200);
    const results = (r.body.data as { results: Array<{ invoiceId: string; ok: boolean; reopenedPurchaseOrders?: Array<Record<string, unknown>>; uncheckedPurchaseOrders?: unknown[] }> }).results;
    expect(results.map((x) => x.ok)).toEqual([true, true]);
    const reopened = results.flatMap((x) => x.reopenedPurchaseOrders ?? []);
    expect(reopened).toEqual([expect.objectContaining({ poId: p.po, poNumber: p.number, reopenedTo: 'approved' })]);
    // The first in id order did it: after it, P is billed by the other bill alone (R400 of R1000).
    expect(results[0]!.reopenedPurchaseOrders).toHaveLength(1);
    expect(results.flatMap((x) => x.uncheckedPurchaseOrders ?? [])).toEqual([]);
    expect(counter.poLocks).toBe(1);
    expect(await flag(p)).toEqual({ status: 'approved', closed_by_billing: false });
    const st = (await pool.query('SELECT status FROM supplier_invoices WHERE id = ANY($1::UUID[])', [[a, b]])).rows.map((x) => x.status);
    expect(st).toEqual(['cancelled', 'cancelled']);
    const audits = (await pool.query(`SELECT count(*)::INT AS n FROM audit_log WHERE entity_type = 'purchase_order' AND entity_id = $1 AND changes->'metadata'->>'reopened' = 'true'`, [p.po])).rows[0].n;
    expect(audits).toBe(1);
  }, 60_000);
});

describe('M5: a PO the cancel could not re-check', () => {
  it('is still closed, and get_purchase_order reads it closed under-billed', async () => {
    const p = await seedPo(pool, f, { lines: [1000] });
    const h = await approvedOnHeader(p, 1000);
    const x = await pool.connect(); // holds the bill, so the cancel's pre-read (P approved) is done and it waits on the bill
    const z = await pool.connect(); // then holds P, so the cancel's NOWAIT re-check of P finds it busy
    try {
      await x.query('BEGIN');
      await x.query('SELECT 1 FROM supplier_invoices WHERE id = $1 FOR UPDATE', [h]);
      const c = callTool(pool, f, cancelBill, { invoice_id: h });
      for (let i = 0; i < 200; i++) {
        if ((await pool.query("SELECT 1 FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND datname = current_database()")).rows.length > 0) break;
        await new Promise((res) => setTimeout(res, 25));
      }
      await closeByBilling(p);
      await z.query('BEGIN');
      await z.query('SELECT 1 FROM purchase_orders WHERE id = $1 FOR SHARE', [p.po]);
      await x.query('COMMIT');
      const r = await c;
      expect(r.isError, r.text).toBe(false);
      expect(r.body.unchecked_purchase_orders).toEqual([{ purchase_order_id: p.po, po_number: p.number }]);
      expect((r.body.budget_warnings as string[]).join(' ')).toContain(
        `Purchase order ${p.number} could not be re-checked just now; if it is still closed, it still counts its unbilled remainder in committed and reopens when a bill on it is next unlinked, cancelled or deleted.`);
    } finally {
      await x.query('ROLLBACK').catch(() => undefined); x.release();
      await z.query('ROLLBACK').catch(() => undefined); z.release();
    }
    expect(await flag(p)).toEqual({ status: 'closed', closed_by_billing: true });
    expect((await callTool(pool, f, getPo, { po_id: p.po })).body).toMatchObject({ purchase_order: expect.objectContaining({ status: 'closed' }), billed_total: 0, fully_billed: false, closed_under_billed: true });
  }, 60_000);
});
