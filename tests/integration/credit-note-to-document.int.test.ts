/**
 * Applying an approved credit note to ONE named document, against a real ledger.
 *
 * FIFO (approval, auto_apply_unapplied) takes the oldest open document. A Sage
 * import's credit note usually belongs to one specific invoice, so the agent
 * must be able to name it. The engine can do that (`linkedInvoiceId` with
 * `autoApply: 'none'`), but it SKIPS a closed linked document silently — right
 * for an approval, wrong for an explicit instruction. These cases pin the
 * instruction semantics: the named document or a refusal, never a silent no-op,
 * never a different document, never a journal.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { sql } from '@/lib/neon';
import {
  applyCreditNoteToDocument, planCreditNoteToDocument, CreditNoteApplyRefusal,
} from '@/modules/accounting/services/shared/creditNoteDocumentApply';
import { cancelCreditNote } from '@/modules/accounting/services/ar/creditNoteCancelService';
import { createCreditNote } from '@/modules/accounting/services/ar/creditNoteService';
import { approveCreditNote } from '@/modules/accounting/services/ar/creditNoteApproveService';
import { assertNotProductionDb } from '../helpers/assertNotProductionDb';
import {
  billState, dropFixture, inTx, seedBill, seedFixture, seedInvoice, seedSupplier, type Fixture,
} from './helpers/l1FifoFixture';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;

let fx: Fixture;
let supB: string;

/** An approved, unapplied credit note with a posted journal, as approval leaves one. */
async function seedNote(
  side: 'supplier' | 'customer', counterpartyId: string, number: string, total: number,
  status = 'approved',
): Promise<string> {
  const je = String(((await sql`
    INSERT INTO gl_journal_entries
      (company_id, entry_number, entry_date, description, status, created_by, fiscal_period_id, posted_at)
    VALUES (${fx.companyId}::UUID, ${`JE-${number}-${fx.tag}`}, '2026-03-01'::DATE, 'CN', 'posted',
            ${fx.userId}::UUID,
            (SELECT id FROM fiscal_periods WHERE company_id = ${fx.companyId}::UUID LIMIT 1), NOW())
    RETURNING id`) as { id: string }[])[0]!.id);
  const rows = (await sql`
    INSERT INTO credit_notes
      (company_id, type, supplier_id, client_id, credit_note_number, credit_date,
       subtotal, total_amount, applied_amount, status, created_by, gl_journal_entry_id)
    VALUES (${fx.companyId}::UUID, ${side},
            ${side === 'supplier' ? counterpartyId : null}::UUID,
            ${side === 'customer' ? counterpartyId : null}::UUID,
            ${`${number}-${fx.tag}`}, '2026-03-01'::DATE, ${total}, ${total}, 0, ${status},
            ${fx.userId}::UUID, ${je}::UUID)
    RETURNING id`) as { id: string }[];
  return rows[0]!.id;
}

async function noteState(id: string): Promise<{ status: string; applied: number }> {
  const r = ((await sql`
    SELECT status, applied_amount FROM credit_notes
    WHERE id = ${id}::UUID AND company_id = ${fx.companyId}::UUID`) as Record<string, unknown>[])[0]!;
  return { status: String(r.status), applied: Number(r.applied_amount) };
}

async function allocations(noteId: string): Promise<{ invoiceId: string; amount: number }[]> {
  const rows = (await sql`
    SELECT invoice_id, amount_allocated FROM credit_note_allocations
    WHERE credit_note_id = ${noteId}::UUID AND company_id = ${fx.companyId}::UUID
    ORDER BY invoice_id`) as Record<string, unknown>[];
  return rows.map((r) => ({ invoiceId: String(r.invoice_id), amount: Number(r.amount_allocated) }));
}

/** The document's outstanding balance as the database holds it now. */
async function billOutstanding(id: string): Promise<number> {
  const r = ((await sql`
    SELECT total_amount - COALESCE(amount_paid, 0) AS o FROM supplier_invoices
    WHERE id = ${id}::UUID AND company_id = ${fx.companyId}::UUID`) as Record<string, unknown>[])[0]!;
  return Number(r.o);
}

async function journalCount(): Promise<number> {
  const rows = (await sql`
    SELECT COUNT(*)::INT AS n FROM gl_journal_entries WHERE company_id = ${fx.companyId}::UUID`) as Record<string, unknown>[];
  return Number(rows[0]!.n);
}

const apply = (input: { creditNoteId: string; invoiceId: string; amount?: number }) =>
  inTx(fx, () => applyCreditNoteToDocument(fx.companyId, input, fx.userId));
const plan = (input: { creditNoteId: string; invoiceId: string; amount?: number }) =>
  inTx(fx, () => planCreditNoteToDocument(fx.companyId, input));

async function refusal(p: Promise<unknown>): Promise<string> {
  const err = await p.then(() => null, (e: unknown) => e);
  expect(err).toBeInstanceOf(CreditNoteApplyRefusal);
  return (err as Error).message;
}

describeIfDb('credit note → one named document, over a real ledger', () => {
  beforeAll(async () => {
    assertNotProductionDb('This test creates and applies credit notes.');
    fx = await seedFixture('CND', DATABASE_URL!);
    supB = await seedSupplier(fx, 'CND-B');
    // The shared fixture has no revenue account, which a real customer-note
    // approval posts to. Added here, not in the fixture other suites share.
    await sql`
      INSERT INTO gl_accounts
        (company_id, account_code, account_name, account_type, account_subtype,
         normal_balance, is_active, is_system_account)
      VALUES (${fx.companyId}::UUID, '4000', ${`Revenue ${fx.tag}`}, 'revenue', 'default_revenue',
              'credit', true, true)`;
  }, 120000);

  afterAll(async () => {
    await sql`DELETE FROM credit_note_allocations WHERE company_id = ${fx.companyId}::UUID`;
    await sql`DELETE FROM credit_notes WHERE company_id = ${fx.companyId}::UUID`;
    await dropFixture(fx);
  }, 120000);

  it('applies to the NAMED bill, not the oldest one FIFO would pick, and posts no journal', async () => {
    const oldest = await seedBill(fx, { number: 'N1', date: '2026-01-01', total: 100 });
    const named = await seedBill(fx, { number: 'N3', date: '2026-01-03', total: 300 });
    const note = await seedNote('supplier', fx.supplierId, 'CN1', 50);
    const journalsBefore = await journalCount();

    const result = await apply({ creditNoteId: note, invoiceId: named });

    expect(result.amount).toBe(50);
    // What the call REPORTS is what the ledger now holds — the figure an agent acts on.
    expect(result.invoiceOutstandingAfter).toBe(await billOutstanding(named));
    expect(await allocations(note)).toEqual([{ invoiceId: named, amount: 50 }]);
    expect((await billState(fx, named)).amountPaid).toBe(50);
    expect((await billState(fx, oldest)).amountPaid).toBe(0);
    expect(await noteState(note)).toEqual({ status: 'applied', applied: 50 });
    expect(await journalCount()).toBe(journalsBefore);
  });

  it('applies part of a note when amount is given, then the rest to another bill', async () => {
    const b1 = await seedBill(fx, { number: 'P1', date: '2026-01-05', total: 100 });
    const b2 = await seedBill(fx, { number: 'P2', date: '2026-01-06', total: 100 });
    const note = await seedNote('supplier', fx.supplierId, 'CN2', 50);

    await apply({ creditNoteId: note, invoiceId: b1, amount: 20 });
    expect(await noteState(note)).toEqual({ status: 'partially_applied', applied: 20 });

    const second = await apply({ creditNoteId: note, invoiceId: b2 });
    expect(second.amount).toBe(30);
    expect(await noteState(note)).toEqual({ status: 'applied', applied: 50 });
    expect((await billState(fx, b1)).amountPaid).toBe(20);
    expect((await billState(fx, b2)).amountPaid).toBe(30);
  });

  it('caps at the bill\'s outstanding balance and leaves the rest on account', async () => {
    const small = await seedBill(fx, { number: 'C1', date: '2026-01-07', total: 100 });
    const note = await seedNote('supplier', fx.supplierId, 'CN3', 500);

    const result = await apply({ creditNoteId: note, invoiceId: small });

    expect(result.amount).toBe(100);
    expect(result.noteRemainderAfter).toBe(400);
    expect(result.invoiceOutstandingAfter).toBe(await billOutstanding(small));
    expect(await noteState(note)).toEqual({ status: 'partially_applied', applied: 100 });
    expect((await billState(fx, small)).status).toBe('paid');
  });

  it('refuses a bill of ANOTHER supplier and writes nothing', async () => {
    const foreign = await seedBill(fx, { number: 'F1', date: '2026-01-08', total: 100, supplierId: supB });
    const note = await seedNote('supplier', fx.supplierId, 'CN4', 50);

    const msg = await refusal(apply({ creditNoteId: note, invoiceId: foreign }));

    expect(msg).toContain('different supplier');
    expect(await allocations(note)).toEqual([]);
    expect((await billState(fx, foreign)).amountPaid).toBe(0);
  });

  it('refuses a named bill that is paid or draft — never a silent no-op', async () => {
    const paid = await seedBill(fx, { number: 'S1', date: '2026-01-09', total: 100, status: 'paid' });
    const draft = await seedBill(fx, { number: 'S2', date: '2026-01-10', total: 100, status: 'draft' });
    const note = await seedNote('supplier', fx.supplierId, 'CN5', 50);

    expect(await refusal(apply({ creditNoteId: note, invoiceId: paid }))).toContain('is paid');
    expect(await refusal(apply({ creditNoteId: note, invoiceId: draft }))).toContain('is draft');
    expect(await noteState(note)).toEqual({ status: 'approved', applied: 0 });
  });

  it('refuses a draft, cancelled or fully applied note', async () => {
    const bill = await seedBill(fx, { number: 'S3', date: '2026-01-11', total: 100 });
    const draft = await seedNote('supplier', fx.supplierId, 'CN6', 50, 'draft');
    const cancelled = await seedNote('supplier', fx.supplierId, 'CN7', 50, 'cancelled');

    expect(await refusal(apply({ creditNoteId: draft, invoiceId: bill }))).toContain('approve_credit_note');
    expect(await refusal(apply({ creditNoteId: cancelled, invoiceId: bill }))).toContain('cancelled');

    const used = await seedNote('supplier', fx.supplierId, 'CN8', 10);
    await apply({ creditNoteId: used, invoiceId: bill });
    expect(await refusal(apply({ creditNoteId: used, invoiceId: bill }))).toContain('nothing left');
  });

  it('refuses a second application of one note to the same bill, naming what is there', async () => {
    const bill = await seedBill(fx, { number: 'R1', date: '2026-01-12', total: 100 });
    const note = await seedNote('supplier', fx.supplierId, 'CN9', 80);
    await apply({ creditNoteId: note, invoiceId: bill, amount: 30 });

    const msg = await refusal(apply({ creditNoteId: note, invoiceId: bill }));

    expect(msg).toContain('already applied');
    expect(await allocations(note)).toEqual([{ invoiceId: bill, amount: 30 }]);
  });

  it('plans exactly what the live call then does, and the plan writes nothing', async () => {
    const bill = await seedBill(fx, { number: 'D1', date: '2026-01-13', total: 70 });
    const note = await seedNote('supplier', fx.supplierId, 'CN10', 100);

    const planned = await plan({ creditNoteId: note, invoiceId: bill });
    expect(await allocations(note)).toEqual([]);
    expect(await noteState(note)).toEqual({ status: 'approved', applied: 0 });

    const live = await apply({ creditNoteId: note, invoiceId: bill });
    expect(live).toEqual(planned);
  });

  it('works on the customer side, and cancel_credit_note gives the invoice back', async () => {
    const inv = await seedInvoice(fx, { number: 'AR1', date: '2026-01-14', total: 200 });
    // Built through the REAL create + approve path (auto-apply off), so the note
    // carries a real journal that cancel can reverse — a seeded, line-less
    // journal is refused by the reversal and proves nothing about the round trip.
    const created = await inTx(fx, () => createCreditNote(fx.companyId, {
      type: 'customer', clientId: fx.customerId, creditDate: '2026-03-01', subtotal: 60, taxRate: 0,
    }, fx.userId));
    await inTx(fx, () => approveCreditNote(fx.companyId, created.id, fx.userId, { autoApply: 'none' }));
    const note = created.id;
    expect(await noteState(note)).toEqual({ status: 'approved', applied: 0 });

    await apply({ creditNoteId: note, invoiceId: inv });
    const paidAfter = Number(((await sql`
      SELECT amount_paid FROM customer_invoices WHERE id = ${inv}::UUID`) as Record<string, unknown>[])[0]!.amount_paid);
    expect(paidAfter).toBe(60);

    await inTx(fx, () => cancelCreditNote(fx.companyId, note, fx.userId));
    const paidAfterCancel = Number(((await sql`
      SELECT amount_paid FROM customer_invoices WHERE id = ${inv}::UUID`) as Record<string, unknown>[])[0]!.amount_paid);
    expect(paidAfterCancel).toBe(0);
    expect(await allocations(note)).toEqual([]);
  });
});
