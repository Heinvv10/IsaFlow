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
import { creditNoteAllocationsExist } from '@/modules/accounting/services/shared/autoApplyBackfillPopulation';
import { assertNotProductionDb } from '../helpers/assertNotProductionDb';
import {
  billState, dropFixture, inTx, seedBankTx, seedBill, seedFixture, seedSupplier, type Fixture,
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
    creditNoteId = String(((await sql`
      INSERT INTO credit_notes
        (company_id, type, supplier_id, credit_note_number, credit_date,
         subtotal, total_amount, applied_amount, status, created_by)
      VALUES (${fx.companyId}::UUID, 'supplier', ${supA}::UUID, ${`BFCN-${fx.tag}`},
              '2026-02-15'::DATE, 50, 50, 0, 'approved', ${fx.userId}::UUID)
      RETURNING id`) as { id: string }[])[0]!.id);
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
    expect(plan.no_open_documents[0]).toMatchObject({ amount: 500, skipped_reason: null });
    expect(plan.totals).toEqual({
      applied: 600,
      left_on_account: 100,
      no_open_documents_amount: 500,
      payments_with_no_open_documents: 1,
    });
    // Every line carries the document's own date, not a placeholder.
    expect(plan.applications[1]!.lines[0]!.invoice_date).toBe('2026-02-01');

    // A dry run writes nothing. Row counts, not a claim about intent.
    expect(await allocationCount()).toBe(before);
    journalsBefore = await journalCount();
    expect(await billState(fx, bills.b1)).toMatchObject({ amountPaid: 0 });
  }, 120000);

  it('applies live EXACTLY what the dry run promised, credit note included', async () => {
    // The credit-note half depends on a table this branch does not create — see
    // autoApplyBackfillCreditNote. Stated rather than assumed, so a database
    // without it fails this assertion instead of quietly testing less.
    expect(await inTx(fx, () => creditNoteAllocationsExist())).toBe(true);

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

    // NO JOURNAL WAS POSTED BY ANY OF IT: the cash was already in the ledger.
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
