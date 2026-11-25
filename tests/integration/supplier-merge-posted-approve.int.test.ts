/**
 * Ruling (orchestrator for Hein, 2026-11-25): a supplier merge moves POSTED documents (approved / partially paid / paid bills,
 * processed / reconciled payments, approved or applied supplier credit notes, purchase orders past submitted) only for a person who
 * holds Suppliers Approve (User Access). Without it the merge is refused, 403, before anything moves; a merge of suppliers with only
 * draft documents still goes through. Decided under the merge's locks: the pre-check reads the source's documents after both
 * supplier rows are held, and each document UPDATE's RETURNING is checked again, so a bill approved while the merge waited on it
 * is refused too (the savepoint takes the whole merge back).
 * Every entry point: mergeEntities (POST /duplicates-merge) and POST /supplier-merge. Real PostgreSQL as app_user.
 * Fixture route: isaflow_schema_fixture (assertDisposable). Never skips.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { callRoute, dropBillFixture, makeBill, openRequest, seedBillFixture, type BillFixture } from './helpers/budgetBillFixture';
import { seedSupplier } from './helpers/poBillLinkHarness';
import { mergeEntities } from '@/modules/accounting/services/core/duplicateMergeService';
import { autoPostApprovalGuard } from '@/modules/accounting/services/bank/bankRuleAutoPostApproval';
import { ApprovePermissionError } from '@/modules/accounting/services/core/approvePermission';
import supplierMergeRoute from '../../pages/api/accounting/supplier-merge';
import duplicatesMergeRoute from '../../pages/api/accounting/duplicates-merge';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 6 });
afterAll(async () => { await pool.end(); });

async function withFixture(tag: string, fn: (fx: BillFixture, target: string) => Promise<void>) {
  const fx = await seedBillFixture(pool, tag);
  const target = await seedSupplier(pool, fx, `${tag} target`);
  try { await fn(fx, target); } finally {
    await pool.query('DELETE FROM company_user_permissions WHERE company_id = $1', [fx.co]);
    await pool.query('DELETE FROM credit_notes WHERE company_id = $1', [fx.co]);
    await dropBillFixture(pool, fx);
  }
}
/** The manager with Suppliers Approve unticked in User Access (a manager holds it by default). */
const withholdApprove = (fx: BillFixture) => pool.query(
  `INSERT INTO company_user_permissions (company_id, user_id, module_key, can_read, can_write, can_delete, can_export, can_approve)
   VALUES ($1, $2, 'suppliers', true, true, true, true, false)`, [fx.co, fx.manager]);
const payment = (fx: BillFixture, status: string) => pool.query(
  `INSERT INTO supplier_payments (company_id, supplier_id, payment_date, total_amount, payment_method, status, created_by)
   VALUES ($1, $2, '2026-06-20', 50, 'eft', $3, $4) RETURNING id`, [fx.co, fx.supplier, status, fx.owner]).then((r) => String(r.rows[0].id));
const on = async (table: string, id: string) => String((await pool.query(`SELECT supplier_id FROM ${table} WHERE id = $1`, [id])).rows[0].supplier_id);
const live = async (supplier: string) => (await pool.query('SELECT deleted_at IS NULL AS live FROM suppliers WHERE id = $1', [supplier])).rows[0].live;

async function merge(fx: BillFixture, user: string, role: string, target: string) {
  const r = await openRequest(pool, fx, user);
  try {
    const out = await r.run(() => mergeEntities(fx.co, 'supplier', target, fx.supplier, user, autoPostApprovalGuard(true), role));
    await r.commit();
    return { out, err: undefined as unknown };
  } catch (err) { await r.rollback(); return { out: undefined, err }; }
}

describe('mergeEntities (the duplicates merge) and posted documents', () => {
  it('a manager without Suppliers Approve: posted documents are refused 403-typed, by the pre-check, before anything moves', async () => {
    await withFixture('smpa-bill', async (fx, target) => {
      await withholdApprove(fx);
      const bill = await makeBill(pool, fx, [{ acct: fx.acc.opex, amount: 100 }], { status: 'approved' });
      const pay = await payment(fx, 'processed');
      const { err } = await merge(fx, fx.manager, 'manager', target);
      expect(err).toBeInstanceOf(ApprovePermissionError);
      // Both kinds named: the pre-check's census of the source, not a RETURNING check (which names the first moved kind only).
      expect((err as Error).message).toContain(
        'approve a supplier merge that moves posted documents (1 approved, partly paid or paid bill, 1 processed or reconciled payment)');
      expect([await on('supplier_invoices', bill), await on('supplier_payments', pay), await live(fx.supplier)]).toEqual([fx.supplier, fx.supplier, true]);
    });
  }, 30_000);

  it('a manager without Suppliers Approve: a processed payment is refused too', async () => {
    await withFixture('smpa-pay', async (fx, target) => {
      await withholdApprove(fx);
      const pay = await payment(fx, 'processed');
      const { err } = await merge(fx, fx.manager, 'manager', target);
      expect(err).toBeInstanceOf(ApprovePermissionError);
      expect((err as Error).message).toContain('1 processed or reconciled payment');
      expect(await on('supplier_payments', pay)).toBe(fx.supplier);
    });
  }, 30_000);

  it('a manager without Suppliers Approve merges a supplier with only draft documents', async () => {
    await withFixture('smpa-draft', async (fx, target) => {
      await withholdApprove(fx);
      const bill = await makeBill(pool, fx, [{ acct: fx.acc.opex, amount: 100 }]);
      const pay = await payment(fx, 'draft');
      const { err } = await merge(fx, fx.manager, 'manager', target);
      expect(err).toBeUndefined();
      expect([await on('supplier_invoices', bill), await on('supplier_payments', pay), await live(fx.supplier)]).toEqual([target, target, false]);
    });
  }, 30_000);

  it('a manager who holds Suppliers Approve (the role default) merges posted documents', async () => {
    await withFixture('smpa-approver', async (fx, target) => {
      const bill = await makeBill(pool, fx, [{ acct: fx.acc.opex, amount: 100 }], { status: 'approved' });
      const { err } = await merge(fx, fx.manager, 'manager', target);
      expect(err).toBeUndefined();
      expect(await on('supplier_invoices', bill)).toBe(target);
    });
  }, 30_000);

  it('a draft bill approved while the merge waited on it: the UPDATE\'s RETURNING refuses it, the whole merge rolls back', async () => {
    await withFixture('smpa-race', async (fx, target) => {
      await withholdApprove(fx);
      const pay = await payment(fx, 'draft');
      const bill = await makeBill(pool, fx, [{ acct: fx.acc.opex, amount: 100 }]);
      const hold = await pool.connect();
      try {
        await hold.query('BEGIN');
        await hold.query("SET LOCAL session_replication_role = replica"); // the test's own status flip, standing in for an approval
        await hold.query("UPDATE supplier_invoices SET status = 'approved' WHERE id = $1", [bill]);
        const merging = merge(fx, fx.manager, 'manager', target);
        for (let i = 0; i < 160; i++) {
          const w = (await pool.query("SELECT 1 FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND query LIKE '%UPDATE supplier_invoices SET supplier_id%'")).rows;
          if (w.length > 0) break;
          await new Promise((r) => setTimeout(r, 25));
        }
        await hold.query('COMMIT');
        const { err } = await merging;
        expect(err).toBeInstanceOf(ApprovePermissionError);
        expect([await on('supplier_invoices', bill), await on('supplier_payments', pay), await live(fx.supplier)]).toEqual([fx.supplier, fx.supplier, true]);
      } finally { hold.release(); }
    });
  }, 30_000);
});

describe('the REST routes', () => {
  it('POST /supplier-merge: 403 for a manager without Suppliers Approve on a posted bill; nothing moved', async () => {
    await withFixture('smpa-rest', async (fx, target) => {
      await withholdApprove(fx);
      const bill = await makeBill(pool, fx, [{ acct: fx.acc.opex, amount: 100 }], { status: 'paid' });
      await payment(fx, 'reconciled');
      const out = await callRoute(supplierMergeRoute as never, fx, fx.manager, '/api/accounting/supplier-merge', { source_id: fx.supplier, target_id: target });
      expect(out.statusCode, JSON.stringify(out.body)).toBe(403);
      // The pre-check's census (both kinds), not a RETURNING check.
      expect(JSON.stringify(out.body)).toContain('1 approved, partly paid or paid bill, 1 processed or reconciled payment');
      expect(await on('supplier_invoices', bill)).toBe(fx.supplier);
    });
  }, 30_000);

  it('POST /duplicates-merge: 403 for a manager without Suppliers Approve on a posted bill; nothing moved', async () => {
    await withFixture('smpa-dup', async (fx, target) => {
      await withholdApprove(fx);
      const bill = await makeBill(pool, fx, [{ acct: fx.acc.opex, amount: 100 }], { status: 'partially_paid' });
      const out = await callRoute(duplicatesMergeRoute as never, fx, fx.manager, '/api/accounting/duplicates-merge',
        { entityType: 'supplier', primaryId: target, duplicateId: fx.supplier });
      expect(out.statusCode, JSON.stringify(out.body)).toBe(403);
      expect(await on('supplier_invoices', bill)).toBe(fx.supplier);
    });
  }, 30_000);
});
