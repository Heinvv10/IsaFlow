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
import { assertNotProductionDb } from '../helpers/assertNotProductionDb';
import { billState, dropFixture, inTx, seedBill, seedFixture, type Fixture } from './helpers/l1FifoFixture';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;
let fx: Fixture;

async function journalCount(): Promise<number> {
  return Number(((await sql`
    SELECT COUNT(*)::INT AS n FROM gl_journal_entries WHERE company_id = ${fx.companyId}::UUID`) as Record<string, unknown>[])[0]!.n);
}

/** A payment already applied: allocation rows and the bills' amount_paid agree, as the apply path leaves them. */
async function seedAppliedPayment(
  number: string, total: number, allocs: { bill: string; amount: number }[],
  opts: { status?: string; batchId?: string } = {},
): Promise<string> {
  const pay = String(((await sql`
    INSERT INTO supplier_payments
      (company_id, supplier_id, payment_number, payment_date, total_amount, status, created_by, batch_id)
    VALUES (${fx.companyId}::UUID, ${fx.supplierId}::UUID, ${`${number}-${fx.tag}`.slice(0, 30)}, '2026-06-01',
            ${total}, ${opts.status ?? 'processed'}, ${fx.userId}::UUID, ${opts.batchId ?? null}::UUID)
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
async function seedAppliedNote(number: string, total: number, allocs: { bill: string; amount: number }[], status?: string): Promise<string> {
  const applied = allocs.reduce((s, a) => s + a.amount, 0);
  const note = String(((await sql`
    INSERT INTO credit_notes
      (company_id, type, supplier_id, credit_note_number, credit_date, subtotal, total_amount, applied_amount, status, created_by)
    VALUES (${fx.companyId}::UUID, 'supplier', ${fx.supplierId}::UUID, ${`${number}-${fx.tag}`.slice(0, 30)}, '2026-06-02',
            ${total}, ${total}, ${applied}, ${status ?? (applied >= total ? 'applied' : 'partially_applied')}, ${fx.userId}::UUID)
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
