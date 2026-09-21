/**
 * The back-fill against a real ledger: what a dry run promises, what a live run
 * writes, that a second live run writes nothing, and that a void takes it back.
 *
 * The population is built the way production built it — bank lines allocated to
 * a supplier with `auto_apply: 'none'`, which creates the payment document and
 * applies none of it. That is exactly the row `list_unapplied_payments` reports
 * and exactly what the back-fill exists to clear, so the test cannot be passing
 * against a population the tool would never see.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { sql } from '@/lib/neon';
import { allocateTransaction } from '@/modules/accounting/services/bank/bankAllocationService';
import { voidSupplierPayment } from '@/modules/accounting/services/ap/supplierPaymentWorkflowService';
import { autoApplyUnapplied } from '@/modules/accounting/services/shared/autoApplyBackfillService';
import { cancelCreditNote } from '@/modules/accounting/services/ar/creditNoteCancelService';
import {
  SKIP_NO_FISCAL_PERIOD, skipUnapplicableStatus,
} from '@/modules/accounting/services/shared/autoApplyBackfillSkips';
import { assertNotProductionDb } from '../helpers/assertNotProductionDb';
import {
  billState, dropFixture, inTx, runOn, seedBankTx, seedBill, seedFixture, seedSupplier,
  type Fixture,
} from './helpers/l1FifoFixture';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;

let fx: Fixture;
/** Supplier A carries the bills; supplier B has none at all. */
let supA: string;
let supB: string;
let bills: { b1: string; b2: string; b3: string };
let creditNoteId: string;

/** A supplier payment document with nothing applied to it, as production made them. */
async function seedUnappliedPayment(
  supplierId: string, date: string, amount: number, tag: string,
): Promise<string> {
  const tx = await seedBankTx(fx, { date, amount: -amount, description: tag });
  const result = await inTx(fx, () => allocateTransaction(
    fx.companyId, tx, null, fx.userId, undefined, 'supplier', supplierId,
    undefined, undefined, undefined, undefined, undefined, { autoApply: 'none' },
  ));
  const rows = (await sql`
    SELECT id FROM supplier_payments
    WHERE company_id = ${fx.companyId}::UUID
      AND gl_journal_entry_id = ${result.journalEntryId}::UUID`) as Record<string, unknown>[];
  return String(rows[0]!.id);
}

/**
 * An approved, unapplied credit note WITH a journal in an open period.
 *
 * The journal is not decoration. The back-fill withholds any source whose
 * journal is in no fiscal period — crediting a bill off an entry that appears
 * in no period-scoped report is the same invisible settlement the cash side
 * refuses — so a note seeded without one is reported as skipped, which is
 * correct behaviour and a useless fixture.
 */
async function seedCreditNote(
  supplierId: string, number: string, date: string, total: number,
): Promise<string> {
  const je = String(((await sql`
    INSERT INTO gl_journal_entries
      (company_id, entry_number, entry_date, description, status, created_by,
       fiscal_period_id, posted_at)
    VALUES (${fx.companyId}::UUID, ${`JE-${number}-${fx.tag}`}, ${date}::DATE, 'CN', 'posted',
            ${fx.userId}::UUID,
            (SELECT id FROM fiscal_periods WHERE company_id = ${fx.companyId}::UUID LIMIT 1),
            NOW())
    RETURNING id`) as { id: string }[])[0]!.id);
  const rows = (await sql`
    INSERT INTO credit_notes
      (company_id, type, supplier_id, credit_note_number, credit_date,
       subtotal, total_amount, applied_amount, status, created_by, gl_journal_entry_id)
    VALUES (${fx.companyId}::UUID, 'supplier', ${supplierId}::UUID, ${`${number}-${fx.tag}`},
            ${date}::DATE, ${total}, ${total}, 0, 'approved', ${fx.userId}::UUID, ${je}::UUID)
    RETURNING id`) as { id: string }[];
  return rows[0]!.id;
}

async function allocationCount(): Promise<number> {
  const rows = (await sql`
    SELECT COUNT(*)::INT AS n FROM payment_allocations pa
    JOIN supplier_payments sp ON sp.id = pa.payment_id
    WHERE sp.company_id = ${fx.companyId}::UUID`) as Record<string, unknown>[];
  return Number(rows[0]!.n);
}

async function journalCount(): Promise<number> {
  const rows = (await sql`
    SELECT COUNT(*)::INT AS n FROM gl_journal_entries
    WHERE company_id = ${fx.companyId}::UUID`) as Record<string, unknown>[];
  return Number(rows[0]!.n);
}

async function creditNoteState(): Promise<{ status: string; appliedAmount: number }> {
  const rows = (await sql`
    SELECT status, applied_amount FROM credit_notes
    WHERE id = ${creditNoteId}::UUID AND company_id = ${fx.companyId}::UUID`) as Record<string, unknown>[];
  return { status: String(rows[0]!.status), appliedAmount: Number(rows[0]!.applied_amount) };
}

async function paymentStatus(paymentId: string): Promise<string> {
  const rows = (await sql`
    SELECT status FROM supplier_payments
    WHERE id = ${paymentId}::UUID AND company_id = ${fx.companyId}::UUID`) as Record<string, unknown>[];
  return String(rows[0]!.status);
}

describeIfDb('back-fill — auto_apply_unapplied over a real AP ledger', () => {
  beforeAll(async () => {
    assertNotProductionDb('This test creates and applies supplier payments.');
    fx = await seedFixture('BF', DATABASE_URL!);
    supA = await seedSupplier(fx, 'BF-A');
    supB = await seedSupplier(fx, 'BF-B');
    bills = {
      b1: await seedBill(fx, { supplierId: supA, number: 'BF1', date: '2026-02-01', total: 100 }),
      b2: await seedBill(fx, { supplierId: supA, number: 'BF2', date: '2026-02-02', total: 200 }),
      b3: await seedBill(fx, { supplierId: supA, number: 'BF3', date: '2026-02-03', total: 300 }),
    };
    // Dated BEFORE every payment, so the ordering contract puts it first and a
    // dry run has to show it consuming the oldest bill.
    creditNoteId = await seedCreditNote(supA, 'BFCN', '2026-02-15', 50);
  }, 120000);

  afterAll(async () => {
    await sql`DELETE FROM credit_note_allocations WHERE company_id = ${fx.companyId}::UUID`;
    await sql`DELETE FROM credit_notes WHERE company_id = ${fx.companyId}::UUID`;
    await dropFixture(fx);
  }, 60000);

  let p1 = '';
  let p2 = '';
  let journalsBefore = 0;

  it('plans oldest-cash-first, consumes balances in turn, and writes NOTHING', async () => {
    p1 = await seedUnappliedPayment(supA, '2026-03-01', 250, 'BF-P1');
    p2 = await seedUnappliedPayment(supA, '2026-03-02', 400, 'BF-P2');
    await seedUnappliedPayment(supB, '2026-03-03', 500, 'BF-P3');

    const before = await allocationCount();
    const plan = await inTx(fx, () => autoApplyUnapplied({
      companyId: fx.companyId, userId: fx.userId, subledger: 'ap', dryRun: true,
    }));

    expect(plan.dry_run).toBe(true);
    expect(plan.processed).toBe(4);
    // The credit note is oldest, so it takes 50 of BF1 before any payment does.
    expect(plan.applications.map((a) => ({
      id: a.payment_id, lines: a.lines.map((l) => [l.document_id, l.amount]),
      on_account: a.on_account_after,
    }))).toEqual([
      { id: creditNoteId, lines: [[bills.b1, 50]], on_account: 0 },
      { id: p1, lines: [[bills.b1, 50], [bills.b2, 200]], on_account: 0 },
      { id: p2, lines: [[bills.b3, 300]], on_account: 100 },
    ]);
    expect(plan.no_open_documents).toHaveLength(1);
    expect(plan.no_open_documents[0]).toMatchObject({ amount: 500 });
    expect(plan.skipped).toEqual([]);
    expect(plan.totals).toEqual({
      applied: 600,
      left_on_account: 100,
      no_open_documents_amount: 500,
      payments_with_no_open_documents: 1,
      skipped_amount: 0,
      payments_skipped: 0,
      population_amount: 1200,
    });
    // Everything read is in exactly one bucket.
    const t = plan.totals;
    expect(t.applied + t.left_on_account + t.no_open_documents_amount + t.skipped_amount)
      .toBe(t.population_amount);
    // Every line carries the document's own date, not a placeholder.
    expect(plan.applications[1]!.lines[0]!.invoice_date).toBe('2026-02-01');

    // A dry run writes nothing. Row counts, not a claim about intent.
    expect(await allocationCount()).toBe(before);
    journalsBefore = await journalCount();
    expect(await billState(fx, bills.b1)).toMatchObject({ amountPaid: 0 });
  }, 120000);

  it('applies live EXACTLY what the dry run promised, credit note included', async () => {
    const plan = await inTx(fx, () => autoApplyUnapplied({
      companyId: fx.companyId, userId: fx.userId, subledger: 'ap', dryRun: false,
      idempotencyKey: 'bf-live-1',
    }));

    expect(plan.failed).toEqual([]);
    // THE SAME LINES THE DRY RUN SHOWED. A preview that disagreed with the run
    // it previews is worse than no preview at all.
    expect(plan.applications.map((a) => ({
      id: a.payment_id, lines: a.lines.map((l) => [l.document_id, l.amount]),
      on_account: a.on_account_after,
    }))).toEqual([
      { id: creditNoteId, lines: [[bills.b1, 50]], on_account: 0 },
      { id: p1, lines: [[bills.b1, 50], [bills.b2, 200]], on_account: 0 },
      { id: p2, lines: [[bills.b3, 300]], on_account: 100 },
    ]);
    expect(plan.totals).toMatchObject({ applied: 600, left_on_account: 100 });

    expect(await billState(fx, bills.b1)).toMatchObject({ status: 'paid', amountPaid: 100 });
    expect(await billState(fx, bills.b2)).toMatchObject({ status: 'paid', amountPaid: 200 });
    expect(await billState(fx, bills.b3)).toMatchObject({ status: 'paid', amountPaid: 300 });
    // Fully applied becomes reconciled; part-applied KEEPS processed.
    expect(await paymentStatus(p1)).toBe('reconciled');
    expect(await paymentStatus(p2)).toBe('processed');
    expect(await creditNoteState()).toEqual({ status: 'applied', appliedAmount: 50 });

    // NO JOURNAL WAS POSTED BY ANY OF IT: the cash and the credit were already
    // in the ledger.
    expect(await journalCount()).toBe(journalsBefore);
  }, 120000);

  it('is idempotent — a second live run applies nothing', async () => {
    const before = await allocationCount();
    const plan = await inTx(fx, () => autoApplyUnapplied({
      companyId: fx.companyId, userId: fx.userId, subledger: 'ap', dryRun: false,
      idempotencyKey: 'bf-live-2',
    }));

    expect(plan.applications).toEqual([]);
    expect(plan.totals.applied).toBe(0);
    expect(plan.failed).toEqual([]);
    expect(await allocationCount()).toBe(before);
    expect(await billState(fx, bills.b3)).toMatchObject({ amountPaid: 300 });
  }, 120000);

  it('refuses the second of two concurrent runs at the credit note\'s row lock', async () => {
    // THE DEFECT THIS PINS. The population's remainder is read before the
    // transaction that spends it. Two runs over one company both read "R100
    // unapplied" and both write R100, and because the allocation row
    // ACCUMULATES on conflict the note ends consumed for twice its own total
    // with `applied_amount` to match — bills credited for money the note never
    // carried. The lock is what makes the second run re-read a zero.
    const sup = await seedSupplier(fx, 'BF-CN');
    const bill = await seedBill(fx, {
      supplierId: sup, number: 'BFCN1', date: '2026-02-01', total: 500,
    });
    const noteId = await seedCreditNote(sup, 'BFCN2', '2026-02-20', 100);

    const run = { companyId: fx.companyId, userId: fx.userId, subledger: 'ap' as const,
      entityId: sup, dryRun: false };

    const a = await fx.pool.connect();
    const b = await fx.pool.connect();
    try {
      await a.query('BEGIN');
      await b.query('BEGIN');

      // A applies the note but has NOT committed.
      const planA = await runOn(fx, a, () => autoApplyUnapplied({
        ...run, idempotencyKey: 'bf-cn-a',
      }));
      expect(planA.applications.map((x) => x.payment_id)).toEqual([noteId]);

      // B starts while A is still open, so B's POPULATION read sees the note
      // as wholly unapplied — the stale figure the old code would have spent.
      // It then blocks on the note's row lock.
      const planBPromise = runOn(fx, b, () => autoApplyUnapplied({
        ...run, idempotencyKey: 'bf-cn-b',
      }));
      await new Promise((resolve) => { setTimeout(resolve, 300); });
      await a.query('COMMIT');

      const planB = await planBPromise;
      await b.query('COMMIT');

      // B re-read the remainder under the lock and found nothing left.
      expect(planB.applications).toEqual([]);
      expect(planB.failed).toEqual([]);
      expect(planB.totals.applied).toBe(0);
    } finally {
      await a.query('ROLLBACK').catch(() => {});
      await b.query('ROLLBACK').catch(() => {});
      a.release();
      b.release();
    }

    // ONE application, not two. The figure that proves the lock did its job.
    const allocated = (await sql`
      SELECT COALESCE(SUM(amount_allocated), 0)::float8 AS total
      FROM credit_note_allocations
      WHERE credit_note_id = ${noteId}::UUID`) as Record<string, unknown>[];
    expect(Number(allocated[0]!.total)).toBe(100);
    const note = (await sql`
      SELECT status, applied_amount::float8 AS applied FROM credit_notes
      WHERE id = ${noteId}::UUID`) as Record<string, unknown>[];
    expect(note[0]).toMatchObject({ status: 'applied', applied: 100 });
    expect(await billState(fx, bill)).toMatchObject({ amountPaid: 100 });
  }, 120000);

  it('reports the one source it could not apply, and still applies the rest', async () => {
    // A peer holding the middle payment's row is the realistic version of "one
    // source fails": every other source is fine and must still be applied. The
    // per-source savepoint is the only thing that allows the run to continue
    // after a throw — without it the request transaction is aborted (25P02) and
    // nothing after the failure can run at all.
    const sup = await seedSupplier(fx, 'BF-FAIL');
    await seedBill(fx, { supplierId: sup, number: 'BFF1', date: '2026-02-01', total: 1000 });
    const q1 = await seedUnappliedPayment(sup, '2026-04-01', 100, 'BF-Q1');
    const q2 = await seedUnappliedPayment(sup, '2026-04-02', 100, 'BF-Q2');
    const q3 = await seedUnappliedPayment(sup, '2026-04-03', 100, 'BF-Q3');

    const blocker = await fx.pool.connect();
    let plan;
    try {
      await blocker.query('BEGIN');
      await blocker.query(
        'SELECT id FROM supplier_payments WHERE id = $1::UUID FOR UPDATE', [q2],
      );
      // 5s of it is the payment lock's own lock_timeout elapsing on q2.
      plan = await inTx(fx, () => autoApplyUnapplied({
        companyId: fx.companyId, userId: fx.userId, subledger: 'ap', entityId: sup,
        dryRun: false, idempotencyKey: 'bf-fail-1',
      }));
    } finally {
      await blocker.query('ROLLBACK').catch(() => {});
      blocker.release();
    }

    // The reply is NOT shaped as a full success: one source is named in
    // `failed`, with wording that tells the caller to retry it.
    expect(plan.failed).toHaveLength(1);
    expect(plan.failed[0]!.payment_id).toBe(q2);
    expect(plan.failed[0]!.error).toMatch(/retry/i);

    // The sources either side of it applied and COMMITTED.
    expect(plan.applications.map((a) => a.payment_id)).toEqual([q1, q3]);
    expect(plan.processed).toBe(2);
    expect(plan.totals.applied).toBe(200);
    const rows = (await sql`
      SELECT pa.payment_id FROM payment_allocations pa
      WHERE pa.payment_id = ANY(ARRAY[${q1}::UUID, ${q2}::UUID, ${q3}::UUID])`
    ) as Record<string, unknown>[];
    expect(rows.map((r) => String(r.payment_id)).sort()).toEqual([q1, q3].sort());
  }, 120000);

  it('is reversible — voiding a back-filled payment restores the bills', async () => {
    await inTx(fx, () => voidSupplierPayment(fx.companyId, p2, fx.userId));

    expect(await billState(fx, bills.b3)).toMatchObject({ status: 'approved', amountPaid: 0 });
    // b2 was settled by p1, not p2 — a void takes back only its own rows.
    expect(await billState(fx, bills.b2)).toMatchObject({ status: 'paid', amountPaid: 200 });
    expect(await paymentStatus(p2)).toBe('cancelled');
    // The other back-filled payment is untouched by the void.
    expect(await billState(fx, bills.b1)).toMatchObject({ status: 'paid', amountPaid: 100 });
  }, 120000);
});
