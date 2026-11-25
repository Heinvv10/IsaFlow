/**
 * #1882 blind breaker: lock-order gaps against the REAL supplier merge (helpers/mergeRace), on PostgreSQL as app_user.
 *   M1  confirmPurchaseOrderMatch (bank-match-confirm, purchase order) locked the PO FOR UPDATE and reached the supplier only through
 *       the payment INSERT's FK, the reverse of the merge's supplier -> POs: a 40P01. It now locks the supplier live first.
 *   M2  a draft bill edit moving the bill to supplier X with a note on X's PO took the note's PO FOR KEY SHARE (lockNotePo) and X
 *       only at its UPDATE's FK: a 40P01 against a merge of X. It now locks the new supplier live first.
 *   L1  a bank-line allocation to a supplier merged away meanwhile (allocateTransaction's supplier arm, a split's supplier line, a
 *       supplier refund) is a typed refusal before the journal, not the payment trigger's raw 23503 after it.
 *   L3  the expectation engine's supplier lock is bounded inside a request, and one supplier's failure leaves the request usable.
 *   L2  migration 1023's trigger: a payment moved onto a deleted supplier is refused; the merge's own re-point of the source's
 *       payments onto its live survivor runs through it; it fires after the FK's RI trigger.
 * Fixture route: isaflow_schema_fixture (assertDisposable). Never skips.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { dropBillFixture, makeBill, openRequest, seedBillFixture, type BillFixture } from './helpers/budgetBillFixture';
import { seedSupplier } from './helpers/poBillLinkHarness';
import { callTool, dropGrnExtras, dropMaintExtras, grnArgs, seedQtyPo } from './helpers/grnHarness';
import {
  isDeadlockVictim, dropMergeRaceExtras, holdRow, pausedMerge, seedBankLine, startRequest, waitsOnLock,
} from './helpers/mergeRace';
import { mergeEntities } from '@/modules/accounting/services/core/duplicateMergeService';
import { autoPostApprovalGuard } from '@/modules/accounting/services/bank/bankRuleAutoPostApproval';
import { confirmPurchaseOrderMatch } from '@/modules/accounting/services/bank/confirmPurchaseOrderMatch';
import { allocateTransaction } from '@/modules/accounting/services/bank/bankAllocationService';
import { splitAllocateTransaction } from '@/modules/accounting/services/bank/bankSplitAllocate';
import { planSupplierRefund } from '@/modules/accounting/services/ap/supplierRefundDocument';
import { autoPostRuleLine } from '@/modules/accounting/services/bank/bankRuleAutoPostLine';
import { applyRules } from '@/modules/accounting/services/bank/bankRulesMatchingService';
import {
  applySupplierInvoiceDraftUpdate, lockAndPlanSupplierInvoiceDraftUpdate,
} from '@/modules/accounting/services/ap/supplierInvoiceDraftUpdate';
import { BillSupplierDeletedError } from '@/modules/accounting/services/ap/billSupplierLive';
import { SUPPLIER_NOT_LIVE_REFUSAL } from '@/modules/accounting/services/core/supplierLiveLock';
import { createGoodsReceivedTool } from '@/lib/mcp/tools/writeCreateGoodsReceived';
import { recomputeAllForCompany } from '@/modules/accounting/services/capture/expectationEngineService';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 8 });
afterAll(async () => { await pool.end(); });

async function withFixture(tag: string, fn: (fx: BillFixture, target: string) => Promise<void>) {
  const fx = await seedBillFixture(pool, tag);
  const target = await seedSupplier(pool, fx, `${tag} target`);
  try { await fn(fx, target); } finally {
    await dropMergeRaceExtras(pool, fx); await dropGrnExtras(pool, fx); await dropMaintExtras(pool, fx); await dropBillFixture(pool, fx);
  }
}
const mergeOf = (fx: BillFixture, target: string) =>
  () => mergeEntities(fx.co, 'supplier', target, fx.supplier, fx.owner, autoPostApprovalGuard(true), 'owner');
const journals = async (fx: BillFixture) =>
  Number((await pool.query('SELECT count(*) AS n FROM gl_journal_entries WHERE company_id = $1', [fx.co])).rows[0].n);

/**
 * The deadlock shape: the merge queues first on the held supplier row, then the writer starts and waits; released, the merge takes the
 * supplier and wants what the writer took before it waited. Without the writer's supplier lock first, Postgres kills one (40P01).
 */
async function queuedBehindMerge<T>(fx: BillFixture, target: string, write: () => Promise<T>) {
  const hold = await holdRow(pool, 'SELECT id FROM suppliers WHERE id = $1 FOR UPDATE', [fx.supplier]);
  let merge: Awaited<ReturnType<typeof startRequest>> | undefined;
  let writer: Awaited<ReturnType<typeof startRequest<T>>> | undefined;
  try {
    merge = await startRequest(pool, fx, mergeOf(fx, target));
    expect(await waitsOnLock(pool, merge.pid)).toBe(true);
    writer = await startRequest(pool, fx, write);
    expect(await waitsOnLock(pool, writer.pid)).toBe(true);
  } finally { await hold.release(); }
  const merged = await merge!.done;
  const written = await writer!.done;
  return { merged, written, deadlocked: isDeadlockVictim(merged.e) || isDeadlockVictim(written.e) };
}

describe('M1: a bank line matched to a purchase order of the supplier being merged', () => {
  it('waits for the merge at the supplier, then is refused before any write; no 40P01', async () => {
    await withFixture('i1882-m1', async (fx, target) => {
      const po = await seedQtyPo(pool, fx, { lines: [{ qty: 1, price: 100 }] });
      const line = await seedBankLine(pool, fx, -100);
      const out = await queuedBehindMerge(fx, target, () => confirmPurchaseOrderMatch(fx.co, line, po.po, fx.owner, 100));
      expect(out.deadlocked).toBe(false);
      expect(out.merged.e).toBeUndefined();
      expect(out.written.e).toBeUndefined();
      expect(out.written.v).toMatchObject({ ok: false, kind: 'refused', message: expect.stringContaining('was merged into i1882-m1 target') });
      expect(await journals(fx)).toBe(0);
      expect((await pool.query('SELECT status FROM bank_transactions WHERE id = $1', [line])).rows[0].status).toBe('imported');
    });
  }, 30_000);
});

describe('M2: a draft bill moved to the supplier being merged, with a note on its PO', () => {
  it('waits for the merge at the new supplier, then is refused typed; the bill keeps its supplier; no 40P01', async () => {
    await withFixture('i1882-m2', async (fx, target) => {
      const other = await seedSupplier(pool, fx, 'i1882 bill owner');
      const po = await seedQtyPo(pool, fx, { lines: [{ qty: 2, price: 10 }] });
      const note = String((await callTool(pool, fx, createGoodsReceivedTool, grnArgs(po, [[0, 2]]))).body.grn_id);
      const bill = await makeBill(pool, fx, [{ acct: fx.acc.opex, amount: 20 }]);
      await pool.query('UPDATE supplier_invoices SET supplier_id = $2 WHERE id = $1', [bill, other]);
      const out = await queuedBehindMerge(fx, target, async () => {
        const plan = await lockAndPlanSupplierInvoiceDraftUpdate(fx.co, bill, { supplierId: fx.supplier, grnId: note });
        await applySupplierInvoiceDraftUpdate(fx.co, plan, fx.owner);
      });
      expect(out.deadlocked).toBe(false);
      expect(out.merged.e).toBeUndefined();
      expect(out.written.e).toBeInstanceOf(BillSupplierDeletedError);
      expect((await pool.query('SELECT supplier_id::text AS s, grn_id FROM supplier_invoices WHERE id = $1', [bill])).rows)
        .toEqual([{ s: other, grn_id: null }]);
    });
  }, 30_000);
});

describe('M2: a draft bill moved to the supplier its own supplier is being merged into (fix-verify M2)', () => {
  it('locks both suppliers before the bill, so the merge wins and the edit then finds the bill on the survivor; no 40P01', async () => {
    await withFixture('i1882-m2-survivor', async (fx) => {
      // The survivor sorts first: the merge holds it, then waits on the held source row.
      const survivor = `00000000-0000-4000-8000-${crypto.randomUUID().slice(-12)}`;
      await pool.query("INSERT INTO suppliers (id, company_id, name, is_active) VALUES ($1, $2, 'i1882 survivor', true)", [survivor, fx.co]);
      const bill = await makeBill(pool, fx, [{ acct: fx.acc.opex, amount: 20 }]);
      const out = await queuedBehindMerge(fx, survivor, async () => {
        const plan = await lockAndPlanSupplierInvoiceDraftUpdate(fx.co, bill, { supplierId: survivor, notes: 'moved' });
        await applySupplierInvoiceDraftUpdate(fx.co, plan, fx.owner);
      });
      expect(out.deadlocked).toBe(false);
      expect(out.merged.e).toBeUndefined();
      expect(out.written.e).toBeUndefined();
      expect((await pool.query('SELECT supplier_id::text AS s, notes FROM supplier_invoices WHERE id = $1', [bill])).rows)
        .toEqual([{ s: survivor, notes: 'moved' }]);
    });
  }, 30_000);
});

describe('L1: a bank-line allocation to a supplier merged away meanwhile is refused before its journal', () => {
  async function againstPausedMerge<T>(fx: BillFixture, target: string, write: () => Promise<T>) {
    const { merge, release } = await pausedMerge(pool, fx, target);
    let w: Awaited<ReturnType<typeof startRequest<T>>> | undefined;
    try {
      w = await startRequest(pool, fx, write);
      expect(await waitsOnLock(pool, w.pid)).toBe(true);
    } finally { await release(); }
    expect((await merge.done).e).toBeUndefined();
    return w!.done;
  }

  it('allocateTransaction (supplier arm, money out)', async () => {
    await withFixture('i1882-l1-alloc', async (fx, target) => {
      const line = await seedBankLine(pool, fx, -50);
      const out = await againstPausedMerge(fx, target, () => allocateTransaction(fx.co, line, null, fx.owner, undefined, 'supplier', fx.supplier));
      expect((out.e as Error | undefined)?.message).toBe(SUPPLIER_NOT_LIVE_REFUSAL);
      expect((out.e as { name?: string }).name).toBe('BankAllocationRefusal');
      expect(await journals(fx)).toBe(0);
    });
  }, 30_000);

  it('a split with a supplier line', async () => {
    await withFixture('i1882-l1-split', async (fx, target) => {
      const line = await seedBankLine(pool, fx, -60);
      const out = await againstPausedMerge(fx, target, () => splitAllocateTransaction(fx.co, line, [
        { contactType: 'supplier', contactId: fx.supplier, amount: 40 }, { contraAccountId: fx.acc.opex, amount: 20 },
      ], fx.owner));
      expect((out.e as Error | undefined)?.message).toBe(SUPPLIER_NOT_LIVE_REFUSAL);
      expect(await journals(fx)).toBe(0);
    });
  }, 30_000);

  it('a supplier bank rule (autoPostRuleLine): the supplier_merged skip, no journal', async () => {
    await withFixture('i1882-l1-rule', async (fx, target) => {
      const line = await seedBankLine(pool, fx, -70);
      const row = (await pool.query('SELECT * FROM bank_transactions WHERE id = $1', [line])).rows[0];
      const out = await againstPausedMerge(fx, target, () => autoPostRuleLine({
        companyId: fx.co, userId: fx.owner, tx: row, rule: { id: crypto.randomUUID(), description_template: null }, ruleName: 'i1882 rule',
        allocType: 'supplier', ruleGlAccountId: null, bankGlAccountId: String(row.bank_account_id), apAccountId: fx.acc.ap,
        arAccountId: null, supplierName: 'P5-2 Supplies', supplierId: fx.supplier, customerName: null,
      }));
      expect(out.e).toBeUndefined();
      expect(out.v).toEqual({ kind: 'supplier_merged' });
      expect(await journals(fx)).toBe(0);
    });
  }, 30_000);

  it('a supplier refund (planSupplierRefund), the supplier already merged away', async () => {
    await withFixture('i1882-l1-refund', async (fx, target) => {
      await pool.query('UPDATE suppliers SET deleted_at = now(), merged_into_id = $2 WHERE id = $1', [fx.supplier, target]);
      const r = await openRequest(pool, fx, fx.owner);
      try {
        const err = await r.run(() => planSupplierRefund(fx.co, fx.supplier, 10, '2026-06-20')).then(() => null, (e: unknown) => e);
        expect((err as Error | null)?.message).toBe(SUPPLIER_NOT_LIVE_REFUSAL);
      } finally { await r.rollback(); }
    });
  }, 30_000);
});

describe('fix-verify M1: supplier rules left on a merged-away supplier', () => {
  it('are a supplier_merged skip in both directions, naming the survivor; never raced or a refund over the ceiling', async () => {
    await withFixture('i1882-rules-merged', async (fx, target) => {
      const out = await seedBankLine(pool, fx, -40);
      const bank = String((await pool.query('SELECT bank_account_id FROM bank_transactions WHERE id = $1', [out])).rows[0].bank_account_id);
      await pool.query("UPDATE bank_transactions SET description = 'MERGEDPAY 1' WHERE id = $1", [out]);
      await pool.query(`INSERT INTO bank_transactions (company_id, bank_account_id, transaction_date, amount, description, status)
                        VALUES ($1, $2, '2026-06-21', 30, 'MERGEDREF 1', 'imported')`, [fx.co, bank]);
      await pool.query(`INSERT INTO bank_categorisation_rules (company_id, rule_name, match_field, match_type, match_pattern, supplier_id, priority, auto_create_entry, vat_code)
                        VALUES ($1, 'i1882 pay rule', 'description', 'contains', 'MERGEDPAY', $2, 1, true, 'none'),
                               ($1, 'i1882 refund rule', 'description', 'contains', 'MERGEDREF', $2, 2, true, 'none')`, [fx.co, fx.supplier]);
      await pool.query('UPDATE suppliers SET deleted_at = now(), merged_into_id = $2 WHERE id = $1', [fx.supplier, target]);
      const r = await startRequest(pool, fx, () => applyRules(fx.co, bank, fx.owner));
      const res = await r.done;
      try {
        expect(res.e).toBeUndefined();
        expect(res.v).toMatchObject({ applied: 0, autoPostSkippedSupplierMerged: 2, autoPostSkippedRaced: 0, autoPostSkippedRefundCeiling: 0 });
        expect((res.v as { autoPostSupplierMergedRules: unknown[] }).autoPostSupplierMergedRules).toEqual(expect.arrayContaining([
          { ruleName: 'i1882 pay rule', supplierName: 'P5-2 Supplies', merged: true, survivorName: 'i1882-rules-merged target', lines: 1 },
          { ruleName: 'i1882 refund rule', supplierName: 'P5-2 Supplies', merged: true, survivorName: 'i1882-rules-merged target', lines: 1 },
        ]));
        expect(await journals(fx)).toBe(0);
      } finally { await pool.query('DELETE FROM bank_categorisation_rules WHERE company_id = $1', [fx.co]); }
    });
  }, 30_000);
});

describe('L2: migration 1023 trigger cases', () => {
  const insertPayment = (fx: BillFixture, supplier: string) => pool.query(
    `INSERT INTO supplier_payments (company_id, supplier_id, payment_date, total_amount, payment_method, created_by)
     VALUES ($1, $2, '2026-06-01', 50, 'eft', $3) RETURNING id`, [fx.co, supplier, fx.owner]).then((r) => String(r.rows[0].id));

  it('an UPDATE moving a payment from a live supplier onto a deleted one is refused', async () => {
    await withFixture('i1882-l2-move', async (fx, target) => {
      const pay = await insertPayment(fx, target);
      await pool.query('UPDATE suppliers SET deleted_at = now(), merged_into_id = $2 WHERE id = $1', [fx.supplier, target]);
      const r = await openRequest(pool, fx, fx.owner);
      try {
        const err = await r.client.query('UPDATE supplier_payments SET supplier_id = $2 WHERE id = $1', [pay, fx.supplier]).then(() => null, (e: unknown) => e);
        expect(err).toMatchObject({ code: '23503', constraint: 'supplier_payments_supplier_live' });
      } finally { await r.rollback(); }
    });
  }, 30_000);

  it('the merge re-points the source\'s payments onto its live survivor through the trigger', async () => {
    await withFixture('i1882-l2-repoint', async (fx, target) => {
      const pay = await insertPayment(fx, fx.supplier);
      const r = await startRequest(pool, fx, mergeOf(fx, target));
      expect((await r.done).e).toBeUndefined();
      expect((await pool.query('SELECT supplier_id::text AS s FROM supplier_payments WHERE id = $1', [pay])).rows).toEqual([{ s: target }]);
    });
  }, 30_000);

  it('fires after the FK\'s RI trigger (name order) and is enabled ALWAYS', async () => {
    const rows = (await pool.query(
      `SELECT t.tgname, t.tgname::text COLLATE "C" < 'trg_supplier_payments_supplier_live' AS before FROM pg_trigger t
         JOIN pg_constraint c ON c.oid = t.tgconstraint
        WHERE t.tgrelid = 'public.supplier_payments'::regclass AND c.contype = 'f'
          AND c.conkey = ARRAY[(SELECT attnum FROM pg_attribute WHERE attrelid = 'public.supplier_payments'::regclass AND attname = 'supplier_id')]::smallint[]`)).rows;
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) expect(r.before, String(r.tgname)).toBe(true);
    expect((await pool.query("SELECT count(*)::int AS n FROM pg_trigger WHERE tgname = 'trg_supplier_payments_supplier_live' AND tgenabled = 'A'")).rows[0].n).toBe(1);
  });
});

describe('L3: recomputeAllForCompany inside a request, one supplier row held past the lock budget', () => {
  it('that supplier times out (bounded, 5 s), the other is still recomputed, and the request commits', async () => {
    await withFixture('i1882-l3', async (fx, target) => {
      await makeBill(pool, fx, [{ acct: fx.acc.opex, amount: 10 }], { status: 'approved' });
      const theirs = await makeBill(pool, fx, [{ acct: fx.acc.opex, amount: 10 }], { status: 'approved' });
      await pool.query('UPDATE supplier_invoices SET supplier_id = $2 WHERE id = $1', [theirs, target]);
      const hold = await holdRow(pool, 'SELECT id FROM suppliers WHERE id = $1 FOR UPDATE', [fx.supplier]);
      try {
        const r = await startRequest(pool, fx, () => recomputeAllForCompany(fx.co));
        const out = await r.done;
        expect(out.e).toBeUndefined();
        expect(out.v).toMatchObject({ processed: 1 });
      } finally { await hold.release(); }
      expect(Number((await pool.query('SELECT count(*) AS n FROM supplier_expectations WHERE supplier_id = $1', [target])).rows[0].n)).toBe(1);
    });
  }, 30_000);
});

