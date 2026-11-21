/**
 * The undo of a deleted bill takes no supplier lock (review of 0d51f4a5, M1; docs/design/mcp-po-bill-links.md lock census), real
 * PostgreSQL, as app_user. A supplier FOR KEY SHARE before the bill row was redundant (a merge meets a restore on the bill row) and
 * closed a cycle: the undo of an APPROVED bill posts its journal again (reinstateInvoiceJournal), taking journal number lock 857 while it
 * holds what it locked before; a transaction that holds 857 and then takes the supplier FOR UPDATE (a rule sweep or bulk accept, then a
 * refund plan's lockContactForRefund) waited on that KEY SHARE while the undo waited on 857: 40P01. The reviewer's repro, as a
 * regression: neither side is a deadlock victim and both finish.
 * Fixture route: isaflow_schema_fixture (assertDisposable). Never skips.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { dropBillFixture, openRequest, seedBillFixture, type BillFixture } from './helpers/budgetBillFixture';
import { dropGrnExtras, dropMaintExtras } from './helpers/grnHarness';
import { createSupplierInvoice } from '@/modules/accounting/services/ap/supplierInvoiceService';
import { approveSupplierInvoice } from '@/modules/accounting/services/ap/supplierInvoiceWorkflowService';
import { softDelete, undoDelete } from '@/modules/accounting/services/core/softDeleteService';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 8 });
afterAll(async () => { await pool.end(); });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitsOnLock(fragment: string, ms = 4000): Promise<boolean> {
  for (let t = 0; t < ms; t += 25) {
    const rows = (await pool.query(
      "SELECT 1 FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND datname = current_database() AND query LIKE '%' || $1 || '%'", [fragment])).rows;
    if (rows.length > 0) return true;
    await sleep(25);
  }
  return false;
}
async function inReq<T>(fx: BillFixture, user: string, fn: () => Promise<T>): Promise<T> {
  const r = await openRequest(pool, fx, user);
  try { const v = await r.run(fn); await r.commit(); return v; } catch (e) { await r.rollback(); throw e; }
}

describe('the undo of an approved bill and a holder of journal lock 857 that then locks the supplier', () => {
  it('no 40P01: the holder gets the supplier, the undo waits on 857 and then restores the bill', async () => {
    const fx = await seedBillFixture(pool, 'restore-857');
    try {
      const bill = await inReq(fx, fx.owner, () => createSupplierInvoice(fx.co, {
        invoiceNumber: `R857-${crypto.randomUUID().slice(0, 8)}`, supplierId: fx.supplier, invoiceDate: '2026-06-15',
        items: [{ description: 'Goods', quantity: 1, unitPrice: 40, taxRate: 15, glAccountId: fx.acc.opex }],
      }, fx.owner));
      await inReq(fx, fx.manager, () => approveSupplierInvoice(fx.co, bill.id, fx.manager));
      await inReq(fx, fx.owner, () => softDelete(fx.co, 'supplier_invoice', bill.id, fx.owner));
      expect((await pool.query('SELECT status, deleted_at IS NOT NULL AS deleted FROM supplier_invoices WHERE id = $1', [bill.id])).rows[0])
        .toEqual({ status: 'approved', deleted: true });

      // T3 holds the bill row, so the undo stops at its bill lock (having taken whatever it takes before it).
      const t3 = await pool.connect();
      await t3.query('BEGIN');
      await t3.query('SELECT id FROM supplier_invoices WHERE id = $1 FOR UPDATE', [bill.id]);
      const u = await openRequest(pool, fx, fx.owner);
      const undoing = u.run(() => undoDelete(fx.co, 'supplier_invoice', bill.id, fx.owner))
        .then(async (v) => { await u.commit(); return v as unknown; }, async (e: { code?: string }) => { await u.rollback(); return e; });
      const t1 = await pool.connect();
      let holder: unknown;
      try {
        expect(await waitsOnLock('FROM supplier_invoices')).toBe(true);
        // T1: the journal number lock of the year, then the supplier FOR UPDATE (lockContactForRefund's statement).
        await t1.query('BEGIN');
        await t1.query("SELECT pg_advisory_xact_lock(hashtextextended($1 || ':2026', 857))", [fx.co]);
        const locking = t1.query('SELECT id FROM suppliers WHERE id = $1 AND company_id = $2 FOR UPDATE', [fx.supplier, fx.co])
          .then(() => 'ok', (e: { code?: string }) => String(e.code));
        await sleep(300);
        await t3.query('ROLLBACK');
        holder = await locking;
      } finally {
        await t1.query(holder === 'ok' ? 'COMMIT' : 'ROLLBACK').catch(() => undefined);
        t1.release();
        await t3.query('ROLLBACK').catch(() => undefined);
        t3.release();
      }
      const undone = await undoing;
      expect(holder).toBe('ok');
      expect(undone).toBe(true);
      expect((await pool.query('SELECT deleted_at IS NULL AS live FROM supplier_invoices WHERE id = $1', [bill.id])).rows[0].live).toBe(true);
    } finally { await dropGrnExtras(pool, fx); await dropMaintExtras(pool, fx); await dropBillFixture(pool, fx); }
  }, 60_000);
});
