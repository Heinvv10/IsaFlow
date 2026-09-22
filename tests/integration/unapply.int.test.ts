/**
 * Un-applying cash and credit without voiding the payment or cancelling the
 * note, against a real ledger.
 *
 * A wrong oldest-first application used to be undoable only by voiding the
 * payment (which reverses its journal and cancels the document) or cancelling
 * the note. These pin the targeted undo: the named document gets its balance
 * back, the allocation row goes, the source keeps its journal and gains an
 * unapplied remainder, and nothing else moves.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { sql } from '@/lib/neon';
import {
  UnapplyRefusal, planSupplierPaymentUnapply, unapplySupplierPayment,
} from '@/modules/accounting/services/ap/supplierPaymentUnapply';
import { planCreditNoteUnapply, unapplyCreditNote } from '@/modules/accounting/services/shared/creditNoteUnapply';
import { cancelCreditNote } from '@/modules/accounting/services/ar/creditNoteCancelService';
import { unwindOnePayment } from '@/modules/accounting/services/bank/bankAllocationUnwind';
import { runOn } from './helpers/l1FifoFixture';
import { assertNotProductionDb } from '../helpers/assertNotProductionDb';
import { billState, dropFixture, inTx, seedBill, seedFixture, type Fixture } from './helpers/l1FifoFixture';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;
let fx: Fixture;

async function journalCount(): Promise<number> {
  return Number(((await sql`
    SELECT COUNT(*)::INT AS n FROM gl_journal_entries WHERE company_id = ${fx.companyId}::UUID`) as Record<string, unknown>[])[0]!.n);
}

/** A posted journal with two balanced lines — the source document's own journal. */
async function seedPostedJournal(tag: string, amount: number, reversed = false): Promise<string> {
  const acct = String(((await sql`
    SELECT id FROM gl_accounts WHERE company_id = ${fx.companyId}::UUID AND account_subtype = 'payable' LIMIT 1`) as Record<string, unknown>[])[0]!.id);
  const bank = String(((await sql`
    SELECT id FROM gl_accounts WHERE company_id = ${fx.companyId}::UUID AND account_subtype = 'bank' LIMIT 1`) as Record<string, unknown>[])[0]!.id);
  const je = String(((await sql`
    INSERT INTO gl_journal_entries
      (company_id, entry_number, entry_date, description, status, created_by, fiscal_period_id, posted_at, reversed_at)
    VALUES (${fx.companyId}::UUID, ${`JE-${tag}-${fx.tag}`}, '2026-06-01'::DATE, ${tag}, 'posted', ${fx.userId}::UUID,
            (SELECT id FROM fiscal_periods WHERE company_id = ${fx.companyId}::UUID LIMIT 1), NOW(),
            ${reversed ? new Date().toISOString() : null}::TIMESTAMPTZ)
    RETURNING id`) as { id: string }[])[0]!.id);
  await sql`
    INSERT INTO gl_journal_lines (company_id, journal_entry_id, gl_account_id, debit, credit)
    VALUES (${fx.companyId}::UUID, ${je}::UUID, ${acct}::UUID, ${amount}, 0),
           (${fx.companyId}::UUID, ${je}::UUID, ${bank}::UUID, 0, ${amount})`;
  return je;
}

/** A payment already applied: allocation rows and the bills' amount_paid agree, as the apply path leaves them. */
async function seedAppliedPayment(
  number: string, total: number, allocs: { bill: string; amount: number }[],
  opts: { status?: string; batchId?: string; journal?: 'posted' | 'none' | 'reversed' } = {},
): Promise<string> {
  // A processed payment carries its DR AP / CR Bank journal; 'none' and
  // 'reversed' are the shapes the unapply must refuse.
  const journal = opts.journal ?? 'posted';
  const je = journal === 'none' ? null : await seedPostedJournal(`P-${number}`, total, journal === 'reversed');
  const pay = String(((await sql`
    INSERT INTO supplier_payments
      (company_id, supplier_id, payment_number, payment_date, total_amount, status, created_by, batch_id,
       gl_journal_entry_id)
    VALUES (${fx.companyId}::UUID, ${fx.supplierId}::UUID, ${`${number}-${fx.tag}`.slice(0, 30)}, '2026-06-01',
            ${total}, ${opts.status ?? 'processed'}, ${fx.userId}::UUID, ${opts.batchId ?? null}::UUID, ${je}::UUID)
    RETURNING id`) as { id: string }[])[0]!.id);
  for (const a of allocs) {
    await sql`INSERT INTO payment_allocations (payment_id, invoice_id, amount_allocated) VALUES (${pay}::UUID, ${a.bill}::UUID, ${a.amount})`;
    await sql`UPDATE supplier_invoices SET amount_paid = amount_paid + ${a.amount},
                status = CASE WHEN total_amount - (amount_paid + ${a.amount}) <= 0.01 THEN 'paid' ELSE 'partially_paid' END
              WHERE id = ${a.bill}::UUID`;
  }
  return pay;
}

async function paymentState(id: string): Promise<{ status: string; allocated: number }> {
  const r = ((await sql`
    SELECT sp.status, COALESCE((SELECT SUM(amount_allocated) FROM payment_allocations WHERE payment_id = sp.id), 0) AS a
    FROM supplier_payments sp WHERE sp.id = ${id}::UUID`) as Record<string, unknown>[])[0]!;
  return { status: String(r.status), allocated: Number(r.a) };
}

/** An approved supplier note already applied to bills: rows, column and bills agree. */
async function seedAppliedNote(
  number: string, total: number, allocs: { bill: string; amount: number }[], status?: string,
  journal: 'posted' | 'none' = 'posted',
): Promise<string> {
  const applied = allocs.reduce((s, a) => s + a.amount, 0);
  const je = journal === 'none' ? null : await seedPostedJournal(`N-${number}`, total);
  const note = String(((await sql`
    INSERT INTO credit_notes
      (company_id, type, supplier_id, credit_note_number, credit_date, subtotal, total_amount, applied_amount, status,
       created_by, gl_journal_entry_id)
    VALUES (${fx.companyId}::UUID, 'supplier', ${fx.supplierId}::UUID, ${`${number}-${fx.tag}`.slice(0, 30)}, '2026-06-02',
            ${total}, ${total}, ${applied}, ${status ?? (applied >= total ? 'applied' : 'partially_applied')},
            ${fx.userId}::UUID, ${je}::UUID)
    RETURNING id`) as { id: string }[])[0]!.id);
  for (const a of allocs) {
    await sql`INSERT INTO credit_note_allocations (company_id, credit_note_id, invoice_id, amount_allocated)
              VALUES (${fx.companyId}::UUID, ${note}::UUID, ${a.bill}::UUID, ${a.amount})`;
    await sql`UPDATE supplier_invoices SET amount_paid = amount_paid + ${a.amount},
                status = CASE WHEN total_amount - (amount_paid + ${a.amount}) <= 0.01 THEN 'paid' ELSE 'partially_paid' END
              WHERE id = ${a.bill}::UUID`;
  }
  return note;
}

async function noteState(id: string): Promise<{ status: string; applied: number; rows: number }> {
  const r = ((await sql`
    SELECT cn.status, cn.applied_amount,
           (SELECT COUNT(*)::INT FROM credit_note_allocations WHERE credit_note_id = cn.id) AS n
    FROM credit_notes cn WHERE cn.id = ${id}::UUID`) as Record<string, unknown>[])[0]!;
  return { status: String(r.status), applied: Number(r.applied_amount), rows: Number(r.n) };
}

async function refusal(p: Promise<unknown>): Promise<string> {
  const err = await p.then(() => null, (e: unknown) => e);
  expect(err).toBeInstanceOf(UnapplyRefusal);
  return (err as Error).message;
}

describeIfDb('unapply — cash and credit taken back from named documents', () => {
  beforeAll(async () => {
    assertNotProductionDb('This test moves supplier balances.');
    fx = await seedFixture('UNA', DATABASE_URL!);
  }, 120000);

  afterAll(async () => {
    await sql`DELETE FROM credit_note_allocations WHERE company_id = ${fx.companyId}::UUID`;
    await sql`DELETE FROM credit_notes WHERE company_id = ${fx.companyId}::UUID`;
    await dropFixture(fx);
  }, 120000);

  describe('unapply_supplier_payment', () => {
    it('takes one allocation back: the bill reopens, the payment keeps its journal and gains a remainder', async () => {
      const b1 = await seedBill(fx, { number: 'P1', date: '2026-05-01', total: 100 });
      const b2 = await seedBill(fx, { number: 'P2', date: '2026-05-02', total: 200 });
      const pay = await seedAppliedPayment('UP1', 300, [{ bill: b1, amount: 100 }, { bill: b2, amount: 200 }], { status: 'reconciled' });
      const journals = await journalCount();

      const r = await inTx(fx, () => unapplySupplierPayment(fx.companyId, { paymentId: pay, invoiceId: b2 }, fx.userId));

      expect(r.amountUnapplied).toBe(200);
      expect(await billState(fx, b2)).toMatchObject({ status: 'approved', amountPaid: 0 });
      expect(await billState(fx, b1)).toMatchObject({ status: 'paid', amountPaid: 100 });
      expect(await paymentState(pay)).toEqual({ status: 'processed', allocated: 100 });
      expect(await journalCount()).toBe(journals);
    });

    it('takes every allocation back when no invoice is named, and the plan matches the write', async () => {
      const b = await seedBill(fx, { number: 'P3', date: '2026-05-03', total: 50 });
      const pay = await seedAppliedPayment('UP2', 80, [{ bill: b, amount: 50 }]);

      const planned = await inTx(fx, () => planSupplierPaymentUnapply(fx.companyId, { paymentId: pay }));
      expect(await paymentState(pay)).toEqual({ status: 'processed', allocated: 50 });
      const done = await inTx(fx, () => unapplySupplierPayment(fx.companyId, { paymentId: pay }, fx.userId));

      expect(done).toEqual(planned);
      expect(await paymentState(pay)).toEqual({ status: 'processed', allocated: 0 });
      expect((await billState(fx, b)).amountPaid).toBe(0);
    });

    it('refuses a draft payment, a batch member, and a bill the payment never touched', async () => {
      const b = await seedBill(fx, { number: 'P4', date: '2026-05-04', total: 40 });
      const other = await seedBill(fx, { number: 'P5', date: '2026-05-05', total: 40 });
      const draft = await seedAppliedPayment('UP3', 40, [{ bill: b, amount: 10 }], { status: 'draft' });
      const batchId = String(((await sql`SELECT gen_random_uuid() AS id`) as Record<string, unknown>[])[0]!.id);
      const member = await seedAppliedPayment('UP4', 40, [{ bill: b, amount: 10 }], { batchId });
      const plain = await seedAppliedPayment('UP5', 40, [{ bill: b, amount: 10 }]);

      expect(await refusal(inTx(fx, () => planSupplierPaymentUnapply(fx.companyId, { paymentId: draft })))).toContain('draft');
      expect(await refusal(inTx(fx, () => planSupplierPaymentUnapply(fx.companyId, { paymentId: member })))).toContain('batch');
      expect(await refusal(inTx(fx, () => planSupplierPaymentUnapply(fx.companyId, { paymentId: plain, invoiceId: other }))))
        .toContain('not applied to');
    });
  });

  /**
   * Ledger review MEDIUM: a source with no live journal has no cash (or credit)
   * behind it in the GL. Un-applying it would mint on-account credit that
   * auto_apply_unapplied and the supplier-refund ceiling would then spend.
   */
  /**
   * Ledger review MEDIUM, reproduced: unwindOnePayment (void_payment,
   * reverse_bank_allocation) read the allocation rows BEFORE taking the payment
   * row lock. An unapply that committed in between had already deleted a row
   * and restored the bill; the unwind then subtracted the stale row again and
   * R1,150 left the AP subledger. The unwind must lock the payment first.
   */
  describe('racing an unwind', () => {
    it('an unwind that waited on an unapply does not subtract the allocation twice', async () => {
      const bill = await seedBill(fx, { number: 'RC1', date: '2026-05-25', total: 2300 });
      const p = await seedAppliedPayment('URP', 1150, [{ bill, amount: 1150 }]);
      const q = await seedAppliedPayment('URQ', 1150, [{ bill, amount: 1150 }]);
      expect((await billState(fx, bill)).amountPaid).toBe(2300);

      // T1: unapply P and hold the transaction open. T2: unwind P, which must
      // block on P's row until T1 commits, then see NO rows for P.
      const c1 = await fx.pool.connect();
      const c2 = await fx.pool.connect();
      try {
        await c1.query('BEGIN');
        await runOn(fx, c1, () => unapplySupplierPayment(fx.companyId, { paymentId: p }, fx.userId));
        await c2.query('BEGIN');
        const t2 = runOn(fx, c2, () => unwindOnePayment(fx.companyId, 'supplier', p));
        await new Promise((r) => setTimeout(r, 400));
        await c1.query('COMMIT');
        const unwound = await t2;
        await c2.query('COMMIT');
        expect(unwound.amountUnapplied).toBe(0);
      } finally {
        c1.release(); c2.release();
      }

      // Q's R1,150 is still applied; the bill must still show it.
      expect(await billState(fx, bill)).toMatchObject({ amountPaid: 1150, status: 'partially_paid' });
      expect(await paymentState(q)).toEqual({ status: 'processed', allocated: 1150 });
    });
  });

  describe('sources with no live journal', () => {
    it('refuses a payment with no journal, or a reversed one, and a note with no journal', async () => {
      const b = await seedBill(fx, { number: 'J1', date: '2026-05-22', total: 90 });
      const none = await seedAppliedPayment('UJ1', 30, [{ bill: b, amount: 30 }], { journal: 'none' });
      const reversed = await seedAppliedPayment('UJ2', 30, [{ bill: b, amount: 30 }], { journal: 'reversed' });
      const note = await seedAppliedNote('UJ3', 30, [{ bill: b, amount: 30 }], undefined, 'none');

      expect(await refusal(inTx(fx, () => planSupplierPaymentUnapply(fx.companyId, { paymentId: none }))))
        .toContain('no posted journal');
      expect(await refusal(inTx(fx, () => planSupplierPaymentUnapply(fx.companyId, { paymentId: reversed }))))
        .toContain('reversed');
      expect(await refusal(inTx(fx, () => planCreditNoteUnapply(fx.companyId, { creditNoteId: note }))))
        .toContain('no posted journal');
    });
  });

  describe('documents that cannot take a balance back', () => {
    it('refuses a soft-deleted bill and a cancelled bill, for a payment and for a note', async () => {
      const deleted = await seedBill(fx, { number: 'D1', date: '2026-05-20', total: 70 });
      const cancelledBill = await seedBill(fx, { number: 'D2', date: '2026-05-21', total: 70 });
      const pay = await seedAppliedPayment('UP9', 140, [{ bill: deleted, amount: 70 }, { bill: cancelledBill, amount: 70 }]);
      const note = await seedAppliedNote('UN9', 140, [{ bill: deleted, amount: 70 }, { bill: cancelledBill, amount: 70 }]);
      // A soft-delete reverses the bill's journal and leaves its status alone.
      await sql`UPDATE supplier_invoices SET deleted_at = NOW() WHERE id = ${deleted}::UUID`;
      await sql`UPDATE supplier_invoices SET status = 'cancelled' WHERE id = ${cancelledBill}::UUID`;

      const plan = (invoiceId: string) => inTx(fx, () => planSupplierPaymentUnapply(fx.companyId, { paymentId: pay, invoiceId }));
      const notePlan = (invoiceId: string) => inTx(fx, () => planCreditNoteUnapply(fx.companyId, { creditNoteId: note, invoiceId }));
      expect(await refusal(plan(deleted))).toContain('deleted');
      expect(await refusal(plan(cancelledBill))).toContain('is cancelled');
      expect(await refusal(notePlan(deleted))).toContain('deleted');
      expect(await refusal(notePlan(cancelledBill))).toContain('is cancelled');
    });
  });

  describe('unapply_credit_note', () => {
    it('takes one application back: the bill reopens, the note keeps its journal and gains a remainder', async () => {
      const b1 = await seedBill(fx, { number: 'N1', date: '2026-05-06', total: 60 });
      const b2 = await seedBill(fx, { number: 'N2', date: '2026-05-07', total: 40 });
      const note = await seedAppliedNote('UN1', 100, [{ bill: b1, amount: 60 }, { bill: b2, amount: 40 }]);
      const journals = await journalCount();

      const r = await inTx(fx, () => unapplyCreditNote(fx.companyId, { creditNoteId: note, invoiceId: b1 }, fx.userId));

      expect(r.amountUnapplied).toBe(60);
      expect(await billState(fx, b1)).toMatchObject({ status: 'approved', amountPaid: 0 });
      expect((await billState(fx, b2)).amountPaid).toBe(40);
      expect(await noteState(note)).toEqual({ status: 'partially_applied', applied: 40, rows: 1 });
      expect(await journalCount()).toBe(journals);
    });

    it('takes every application back when no invoice is named', async () => {
      const b = await seedBill(fx, { number: 'N3', date: '2026-05-08', total: 30 });
      const note = await seedAppliedNote('UN2', 30, [{ bill: b, amount: 30 }]);

      await inTx(fx, () => unapplyCreditNote(fx.companyId, { creditNoteId: note }, fx.userId));
      expect(await noteState(note)).toEqual({ status: 'approved', applied: 0, rows: 0 });
      expect((await billState(fx, b)).amountPaid).toBe(0);
    });

    it('refuses a legacy note whose applied_amount has no allocation rows behind it', async () => {
      const b = await seedBill(fx, { number: 'N4', date: '2026-05-09', total: 30 });
      const note = await seedAppliedNote('UN3', 30, []);
      await sql`UPDATE credit_notes SET applied_amount = 30, status = 'applied' WHERE id = ${note}::UUID`;

      expect(await refusal(inTx(fx, () => planCreditNoteUnapply(fx.companyId, { creditNoteId: note, invoiceId: b }))))
        .toContain('allocation');
    });

    it('refuses a draft or cancelled note, and a document the note never credited', async () => {
      const b = await seedBill(fx, { number: 'N5', date: '2026-05-10', total: 30 });
      const other = await seedBill(fx, { number: 'N6', date: '2026-05-11', total: 30 });
      const cancelled = await seedAppliedNote('UN4', 30, [], 'cancelled');
      const live = await seedAppliedNote('UN5', 30, [{ bill: b, amount: 10 }]);

      expect(await refusal(inTx(fx, () => planCreditNoteUnapply(fx.companyId, { creditNoteId: cancelled }))))
        .toContain('cancelled');
      expect(await refusal(inTx(fx, () => planCreditNoteUnapply(fx.companyId, { creditNoteId: live, invoiceId: other }))))
        .toContain('not applied to');
    });

    it('leaves a note that cancel_credit_note can still reverse exactly', async () => {
      const b1 = await seedBill(fx, { number: 'N7', date: '2026-05-12', total: 50 });
      const b2 = await seedBill(fx, { number: 'N8', date: '2026-05-13', total: 50 });
      const note = await seedAppliedNote('UN6', 100, [{ bill: b1, amount: 50 }, { bill: b2, amount: 50 }]);
      await inTx(fx, () => unapplyCreditNote(fx.companyId, { creditNoteId: note, invoiceId: b1 }, fx.userId));

      // No journal on this fixture note, so the cancel runs only its application
      // half — which must restore exactly what the unapply left, and no more.
      await inTx(fx, () => cancelCreditNote(fx.companyId, note, fx.userId));
      expect((await billState(fx, b2)).amountPaid).toBe(0);
      expect((await billState(fx, b1)).amountPaid).toBe(0);
      expect(await noteState(note)).toMatchObject({ status: 'cancelled', rows: 0 });
    });
  });
});
