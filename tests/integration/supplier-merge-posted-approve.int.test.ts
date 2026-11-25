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
import { Pool, type PoolClient } from 'pg';
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
    await pool.query('DELETE FROM supplier_payments WHERE company_id = $1 AND batch_id IS NOT NULL', [fx.co]);
    await pool.query('DELETE FROM supplier_payment_batches WHERE company_id = $1', [fx.co]);
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
        'approve a supplier merge that moves posted documents (1 approved, partly paid, paid or once-posted bill, 1 approved, batched, processed or reconciled payment)');
      expect([await on('supplier_invoices', bill), await on('supplier_payments', pay), await live(fx.supplier)]).toEqual([fx.supplier, fx.supplier, true]);
    });
  }, 30_000);

  it('a manager without Suppliers Approve: a processed payment is refused too', async () => {
    await withFixture('smpa-pay', async (fx, target) => {
      await withholdApprove(fx);
      const pay = await payment(fx, 'processed');
      const { err } = await merge(fx, fx.manager, 'manager', target);
      expect(err).toBeInstanceOf(ApprovePermissionError);
      expect((err as Error).message).toContain('1 approved, batched, processed or reconciled payment');
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
});

/**
 * Each document UPDATE's RETURNING is checked again under the merge's lock: a document approved / processed while the merge waited on
 * its row is refused there (the pre-check read it as a draft), and the whole merge rolls back. A second connection holds the flip
 * UNCOMMITTED (the test's own status change, triggers off, standing in for an approval); the merge starts, the probe waits until it
 * is seen blocked on that row (sawWait, asserted: without it the pre-check could have refused and the test would pass without
 * reaching RETURNING), the flip commits. Both entry points, as app_user, through withAuth for the route.
 */
interface RaceOutcome { refused: boolean; status?: number; message: string }
const PATHS: Array<[string, (fx: BillFixture, target: string) => Promise<RaceOutcome>]> = [
  ['mergeEntities (POST /duplicates-merge)', async (fx, target) => {
    const { err } = await merge(fx, fx.manager, 'manager', target);
    return { refused: err instanceof ApprovePermissionError, message: err instanceof Error ? err.message : '' };
  }],
  ['POST /supplier-merge', async (fx, target) => {
    const out = await callRoute(supplierMergeRoute as never, fx, fx.manager, '/api/accounting/supplier-merge', { source_id: fx.supplier, target_id: target });
    return { refused: out.statusCode === 403, status: out.statusCode, message: JSON.stringify(out.body) };
  }],
];
const RACES: Array<[string, string, string, string, string]> = [
  // label, table the merge blocks on, held status flip, needle in the refusal, kind (a label and the fixture-tag suffix only)
  ['a draft bill approved', 'supplier_invoices', 'approved', '1 approved, partly paid, paid or once-posted bill', 'bill'],
  ['a draft payment approved', 'supplier_payments', 'approved', '1 approved, batched, processed or reconciled payment', 'payment'],
  ['a draft payment processed', 'supplier_payments', 'processed', '1 approved, batched, processed or reconciled payment', 'payment'],
  ['a draft credit note approved', 'credit_notes', 'approved', '1 approved, applied or once-posted credit note', 'credit_note'],
];

describe.each(PATHS)('the RETURNING re-check under the merge\'s lock: %s', (_name, run) => {
  it.each(RACES)('%s while the merge waited: refused (403-typed), the whole merge rolled back', async (_label, table, status, needle, kind) => {
    await withFixture(`smpa-race-${kind}-${status}`, async (fx, target) => {
      await withholdApprove(fx);
      // One draft of each kind, so a refusal part-way through shows that what moved before it was taken back.
      const bill = await makeBill(pool, fx, [{ acct: fx.acc.opex, amount: 100 }]);
      const pay = await payment(fx, 'draft');
      const note = String((await pool.query(`INSERT INTO credit_notes (company_id, credit_note_number, type, supplier_id, credit_date, total_amount, status, created_by)
        VALUES ($1, $2, 'supplier', $3, '2026-06-10', 10, 'draft', $4) RETURNING id`, [fx.co, `SMPA-R-${kind}-${status}`, fx.supplier, fx.owner])).rows[0].id);
      const held = { supplier_invoices: bill, supplier_payments: pay, credit_notes: note }[table]!;
      const hold: PoolClient = await pool.connect();
      const holdPid = Number((await hold.query('SELECT pg_backend_pid() AS pid')).rows[0].pid);
      let sawWait = false;
      let merging: Promise<RaceOutcome> | undefined;
      try {
        await hold.query('BEGIN');
        await hold.query('SET LOCAL session_replication_role = replica');
        await hold.query(`UPDATE ${table} SET status = $2 WHERE id = $1`, [held, status]);
        merging = run(fx, target);
        for (let i = 0; i < 200 && !sawWait; i++) {
          sawWait = (await pool.query(
            // Blocked BY the hold connection itself (not any session waiting on a lock): no other suite's waiter can match.
            `SELECT 1 FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND $1 = ANY (pg_blocking_pids(pid)) AND query LIKE $2`,
            [holdPid, `%UPDATE ${table}%SET supplier_id%`])).rows.length > 0;
          if (!sawWait) await new Promise((r) => setTimeout(r, 25));
        }
        await hold.query('COMMIT');
        const out = await merging;
        // Without an observed wait the merge never reached the RETURNING check, and this test would prove nothing.
        expect(sawWait).toBe(true);
        expect(out.refused, out.message).toBe(true);
        expect(out.message).toContain(needle);
        if (out.status !== undefined) expect(out.status).toBe(403);
        expect([await on('supplier_invoices', bill), await on('supplier_payments', pay), await on('credit_notes', note), await live(fx.supplier)])
          .toEqual([fx.supplier, fx.supplier, fx.supplier, true]);
      } finally {
        await hold.query('ROLLBACK').catch(() => undefined);
        hold.release();
        // Never leave the merge pending (a throw in the probe loop skips the COMMIT): the rollback frees its row, and it is settled here.
        await merging?.catch(() => undefined);
      }
    });
  }, 40_000);
});

describe('posted, on the safer side (breaker of #1900: M1, M2)', () => {
  const refused = async (fx: BillFixture, target: string, needle: string) => {
    await withholdApprove(fx);
    const { err } = await merge(fx, fx.manager, 'manager', target);
    expect(err).toBeInstanceOf(ApprovePermissionError);
    expect((err as Error).message).toContain(needle);
    expect(await live(fx.supplier)).toBe(true);
  };

  it('an approved, unprocessed payment (it will pay the payee\'s bank details) needs Approve', async () => {
    await withFixture('smpa-m1-approved', async (fx, target) => {
      await payment(fx, 'approved');
      await refused(fx, target, '1 approved, batched, processed or reconciled payment');
    });
  }, 30_000);

  it('a draft payment already in a payment batch needs Approve', async () => {
    await withFixture('smpa-m1-batch', async (fx, target) => {
      const batch = String((await pool.query(`INSERT INTO supplier_payment_batches (company_id, batch_date, payment_method, payment_count, total_amount, created_by)
        VALUES ($1, '2026-06-20', 'eft', 1, 50, $2) RETURNING id`, [fx.co, fx.owner])).rows[0].id);
      await pool.query(`INSERT INTO supplier_payments (company_id, supplier_id, payment_date, total_amount, payment_method, status, batch_id, created_by)
        VALUES ($1, $2, '2026-06-20', 50, 'eft', 'draft', $3, $4)`, [fx.co, fx.supplier, batch, fx.owner]); // membership is set at insert only
      await refused(fx, target, '1 approved, batched, processed or reconciled payment');
    });
  }, 30_000);

  it('a bill approved and then cancelled (its journal pair, link nulled) needs Approve: approved_at says it was posted', async () => {
    await withFixture('smpa-m2-cancelled', async (fx, target) => {
      const bill = await makeBill(pool, fx, [{ acct: fx.acc.opex, amount: 100 }], { status: 'cancelled' });
      await pool.query('UPDATE supplier_invoices SET approved_at = now() WHERE id = $1', [bill]);
      await refused(fx, target, '1 approved, partly paid, paid or once-posted bill');
    });
  }, 30_000);

  it('a cancelled bill with no stamp or link left, but a journal sourced from it (a DRC self-assessment), needs Approve', async () => {
    await withFixture('smpa-m2-sourced', async (fx, target) => {
      const bill = await makeBill(pool, fx, [{ acct: fx.acc.opex, amount: 100 }], { status: 'cancelled' });
      const je = String((await pool.query(`INSERT INTO gl_journal_entries (company_id, entry_number, entry_date, description, status, source, source_record_id, created_by)
        VALUES ($1, $2, '2026-06-15', 'DRC VAT', 'posted', 'auto_vat_adjustment', $3, $4) RETURNING id`, [fx.co, `SMPA-S-${bill.slice(0, 8)}`, bill, fx.owner])).rows[0].id);
      try { await refused(fx, target, '1 approved, partly paid, paid or once-posted bill'); } finally {
        await pool.query('DELETE FROM gl_journal_entries WHERE id = $1', [je]);
      }
    });
  }, 30_000);

  it('a credit note approved and then cancelled (approved_by kept) needs Approve', async () => {
    await withFixture('smpa-m2-note', async (fx, target) => {
      await pool.query(`INSERT INTO credit_notes (company_id, credit_note_number, type, supplier_id, credit_date, total_amount, status, approved_by, created_by)
        VALUES ($1, 'SMPA-CN-1', 'supplier', $2, '2026-06-10', 10, 'cancelled', $3, $3)`, [fx.co, fx.supplier, fx.owner]);
      await refused(fx, target, '1 approved, applied or once-posted credit note');
    });
  }, 30_000);

  it('a payment cancelled after it was processed (processed_at kept) needs Approve', async () => {
    await withFixture('smpa-m2-pay', async (fx, target) => {
      const pay = await payment(fx, 'cancelled');
      await pool.query('UPDATE supplier_payments SET processed_at = now() WHERE id = $1', [pay]);
      await refused(fx, target, '1 approved, batched, processed or reconciled payment');
    });
  }, 30_000);

  it('a bill sent back to pending approval that still carries its journal needs Approve', async () => {
    await withFixture('smpa-m2-journal', async (fx, target) => {
      const bill = await makeBill(pool, fx, [{ acct: fx.acc.opex, amount: 100 }], { status: 'pending_approval' });
      const je = String((await pool.query(`INSERT INTO gl_journal_entries (company_id, entry_number, entry_date, description, status, source, created_by)
        VALUES ($1, $2, '2026-06-15', 'bill journal', 'posted', 'auto_supplier_invoice', $3) RETURNING id`, [fx.co, `SMPA-${bill.slice(0, 8)}`, fx.owner])).rows[0].id);
      await pool.query('UPDATE supplier_invoices SET gl_journal_entry_id = $2 WHERE id = $1', [bill, je]);
      try { await refused(fx, target, '1 approved, partly paid, paid or once-posted bill'); } finally {
        await pool.query('UPDATE supplier_invoices SET gl_journal_entry_id = NULL WHERE id = $1', [bill]);
        await pool.query('DELETE FROM gl_journal_entries WHERE id = $1', [je]);
      }
    });
  }, 30_000);

  it.each([['approved_at', 'now()', 'NULL'], ['approved_by', 'NULL', '$3']])('a purchase order approved and then cancelled (stamp: %s) needs Approve', async (_stamp, at, by) => {
    await withFixture('smpa-m2-po', async (fx, target) => {
      await pool.query(`INSERT INTO purchase_orders (company_id, po_number, supplier_id, order_date, status, subtotal, tax_amount, total, approved_at, approved_by)
        VALUES ($1, 'SMPA-PO-1', $2, '2026-06-02', 'cancelled', 10, 0, 10, ${at}, ${by}::TEXT)`, by === '$3' ? [fx.co, fx.supplier, fx.owner] : [fx.co, fx.supplier]);
      try { await refused(fx, target, '1 approved, received or once-approved purchase order'); } finally {
        await pool.query("DELETE FROM purchase_orders WHERE company_id = $1 AND po_number = 'SMPA-PO-1'", [fx.co]);
      }
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
      expect(JSON.stringify(out.body)).toContain('1 approved, partly paid, paid or once-posted bill, 1 approved, batched, processed or reconciled payment');
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
