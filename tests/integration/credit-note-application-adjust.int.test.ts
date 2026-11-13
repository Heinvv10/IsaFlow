/**
 * `adjust_credit_note_application` over a real ledger: set how much of an
 * approved credit note is applied to ONE document — 0 takes it all back, less
 * takes part back, more applies more — moving only the subledger (no journal),
 * bounded by the note's unapplied credit, the document's outstanding balance
 * and what the note's journal POSTED, and refused, before any write, for every
 * case apply_credit_note / unapply_credit_note refuse.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { sql } from '@/lib/neon';
import { formatMoney } from '@/lib/money/formatMoney';
import {
  adjustCreditNoteApplication, planCreditNoteApplicationAdjust, CreditNoteAdjustRefusal,
  type CreditNoteAdjustInput,
} from '@/modules/accounting/services/shared/creditNoteApplicationAdjust';
import { cancelCreditNote } from '@/modules/accounting/services/ar/creditNoteCancelService';
import { createCreditNote } from '@/modules/accounting/services/ar/creditNoteService';
import { approveCreditNote } from '@/modules/accounting/services/ar/creditNoteApproveService';
import { assertNotProductionDb } from '../helpers/assertNotProductionDb';
import {
  dropFixture, inTx, seedBill, seedFixture, seedInvoice, seedSupplier, type Fixture,
} from './helpers/l1FifoFixture';
import { seedPostedNote } from './helpers/creditNoteJournalFixture';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;

let fx: Fixture;
let other: Fixture;

const adjust = (input: CreditNoteAdjustInput) =>
  inTx(fx, () => adjustCreditNoteApplication(fx.companyId, input, fx.userId));
const plan = (input: CreditNoteAdjustInput) =>
  inTx(fx, () => planCreditNoteApplicationAdjust(fx.companyId, input));

async function refusal(p: Promise<unknown>): Promise<string> {
  const err = await p.then(() => null, (e: unknown) => e);
  expect(err).toBeInstanceOf(CreditNoteAdjustRefusal);
  return (err as Error).message;
}

interface Snapshot {
  rows: { invoiceId: string; amount: number }[];
  note: { status: string; applied: number };
  doc: { status: string; paid: number };
  journals: number;
}

async function snapshot(noteId: string, docId: string, side: 'supplier' | 'customer'): Promise<Snapshot> {
  const rows = ((await sql`
    SELECT invoice_id, amount_allocated FROM credit_note_allocations
    WHERE credit_note_id = ${noteId}::UUID AND company_id = ${fx.companyId}::UUID ORDER BY invoice_id`) as Record<string, unknown>[])
    .map((r) => ({ invoiceId: String(r.invoice_id), amount: Number(r.amount_allocated) }));
  const n = ((await sql`SELECT status, applied_amount FROM credit_notes WHERE id = ${noteId}::UUID`) as Record<string, unknown>[])[0]!;
  const d = ((side === 'supplier'
    ? await sql`SELECT status, amount_paid FROM supplier_invoices WHERE id = ${docId}::UUID`
    : await sql`SELECT status, amount_paid FROM customer_invoices WHERE id = ${docId}::UUID`) as Record<string, unknown>[])[0]!;
  const j = ((await sql`
    SELECT COUNT(*)::INT AS n FROM gl_journal_entries WHERE company_id = ${fx.companyId}::UUID`) as Record<string, unknown>[])[0]!;
  return {
    rows,
    note: { status: String(n.status), applied: Number(n.applied_amount) },
    doc: { status: String(d.status), paid: Number(d.amount_paid) },
    journals: Number(j.n),
  };
}

describeIfDb('adjust a credit note application, over a real ledger', () => {
  beforeAll(async () => {
    assertNotProductionDb('This test creates and applies credit notes.');
    fx = await seedFixture('CNA', DATABASE_URL!);
    other = await seedFixture('CNO', DATABASE_URL!);
    await sql`
      INSERT INTO gl_accounts (company_id, account_code, account_name, account_type, account_subtype,
                               normal_balance, is_active, is_system_account)
      VALUES (${fx.companyId}::UUID, '4000', ${`Revenue ${fx.tag}`}, 'revenue', 'default_revenue', 'credit', true, true)`;
  }, 120000);

  afterAll(async () => {
    for (const f of [fx, other]) {
      await sql`DELETE FROM credit_note_allocations WHERE company_id = ${f.companyId}::UUID`;
      await sql`DELETE FROM credit_notes WHERE company_id = ${f.companyId}::UUID`;
      await dropFixture(f);
    }
  }, 120000);

  it('supplier: applies, raises, lowers and takes back one application; never posts a journal', async () => {
    const bill = await seedBill(fx, { number: 'S1', date: '2026-02-01', total: 200 });
    const note = await seedPostedNote(fx, { side: 'supplier', number: 'NS1', total: 100, posted: 100 });
    const base = (await snapshot(note, bill, 'supplier')).journals;

    const first = await adjust({ creditNoteId: note, documentId: bill, newAmount: 60 });
    expect(first).toMatchObject({ appliedBefore: 0, appliedAfter: 60, change: 60, documentOutstandingAfter: 140 });
    expect(await snapshot(note, bill, 'supplier')).toEqual({
      rows: [{ invoiceId: bill, amount: 60 }], note: { status: 'partially_applied', applied: 60 },
      doc: { status: 'partially_paid', paid: 60 }, journals: base,
    });

    await adjust({ creditNoteId: note, documentId: bill, newAmount: 100 });
    expect(await snapshot(note, bill, 'supplier')).toMatchObject({
      rows: [{ invoiceId: bill, amount: 100 }], note: { status: 'applied', applied: 100 }, doc: { paid: 100 },
    });

    const lower = await adjust({ creditNoteId: note, documentId: bill, newAmount: 30 });
    expect(lower).toMatchObject({ appliedBefore: 100, appliedAfter: 30, change: -70, noteRemainderAfter: 70 });
    expect(await snapshot(note, bill, 'supplier')).toMatchObject({
      rows: [{ invoiceId: bill, amount: 30 }], note: { status: 'partially_applied', applied: 30 }, doc: { paid: 30 },
    });

    await adjust({ creditNoteId: note, documentId: bill, newAmount: 0 });
    expect(await snapshot(note, bill, 'supplier')).toEqual({
      rows: [], note: { status: 'approved', applied: 0 }, doc: { status: 'approved', paid: 0 }, journals: base,
    });
  });

  it('customer: a real approved note adjusts, and cancel_credit_note then gives back exactly what is left', async () => {
    const inv = await seedInvoice(fx, { number: 'C1', date: '2026-02-02', total: 300 });
    const created = await inTx(fx, () => createCreditNote(fx.companyId, {
      type: 'customer', clientId: fx.customerId, creditDate: '2026-03-01', subtotal: 100, taxRate: 15,
    }, fx.userId));
    await inTx(fx, () => approveCreditNote(fx.companyId, created.id, fx.userId, { autoApply: 'none' }));

    await adjust({ creditNoteId: created.id, documentId: inv, newAmount: 115 });
    const r = await adjust({ creditNoteId: created.id, documentId: inv, newAmount: 15.5 });
    expect(r.creditNoteJournalId).toBeTruthy();
    expect(await snapshot(created.id, inv, 'customer')).toMatchObject({
      rows: [{ invoiceId: inv, amount: 15.5 }], note: { status: 'partially_applied', applied: 15.5 }, doc: { paid: 15.5 },
    });

    await inTx(fx, () => cancelCreditNote(fx.companyId, created.id, fx.userId));
    expect(await snapshot(created.id, inv, 'customer')).toMatchObject({ rows: [], doc: { paid: 0 } });
  });

  it('bounds an increase by the note, the document and the posted journal, in the plan and live', async () => {
    const small = await seedBill(fx, { number: 'B1', date: '2026-02-03', total: 50 });
    const big = await seedBill(fx, { number: 'B2', date: '2026-02-04', total: 500 });
    const note = await seedPostedNote(fx, { side: 'supplier', number: 'NB1', total: 100, posted: 100 });
    const short = await seedPostedNote(fx, { side: 'supplier', number: 'NB2', total: 100, posted: 99.99 });

    for (const run of [plan, adjust]) {
      expect(await refusal(run({ creditNoteId: note, documentId: small, newAmount: 60 }))).toContain(`only ${formatMoney(50)} outstanding`);
      expect(await refusal(run({ creditNoteId: note, documentId: big, newAmount: 100.01 }))).toContain(`only ${formatMoney(100)} unapplied`);
      expect(await refusal(run({ creditNoteId: short, documentId: big, newAmount: 100 }))).toContain('never posted');
    }
    expect((await adjust({ creditNoteId: short, documentId: big, newAmount: 99.99 })).noteAppliedAfter).toBe(99.99);
    expect((await snapshot(note, small, 'supplier')).doc.paid).toBe(0);
  });

  it('refuses a draft or cancelled note, another party\'s or company\'s document, a no-op and a reversed journal', async () => {
    const bill = await seedBill(fx, { number: 'R1', date: '2026-02-05', total: 100 });
    const supB = await seedSupplier(fx, 'CNA-B');
    const foreignParty = await seedBill(fx, { number: 'R2', date: '2026-02-06', total: 100, supplierId: supB });
    const foreignCompany = await seedBill(other, { number: 'R3', date: '2026-02-07', total: 100 });
    const draft = await seedPostedNote(fx, { side: 'supplier', number: 'NR1', total: 50, posted: null, status: 'draft' });
    const cancelled = await seedPostedNote(fx, { side: 'supplier', number: 'NR2', total: 50, posted: 50, status: 'cancelled' });
    const reversed = await seedPostedNote(fx, { side: 'supplier', number: 'NR3', total: 50, posted: 50, reversed: true });
    const note = await seedPostedNote(fx, { side: 'supplier', number: 'NR4', total: 50, posted: 50 });
    const draftBill = await seedBill(fx, { number: 'R4', date: '2026-02-08', total: 100, status: 'draft' });
    const a = (creditNoteId: string, documentId: string, newAmount: number) =>
      refusal(adjust({ creditNoteId, documentId, newAmount }));

    expect(await a(draft, bill, 10)).toContain('approve_credit_note');
    expect(await a(cancelled, bill, 10)).toContain('cancelled');
    expect(await a(note, foreignParty, 10)).toContain('different supplier');
    expect(await a(note, foreignCompany, 10)).toBe('Document not found.');
    expect(await a(note, bill, 0)).toContain('nothing to change');
    expect(await a(reversed, bill, 10)).toContain('reversed');
    expect(await a(note, draftBill, 10)).toContain('is draft');
    expect(await a(note, bill, 10.005)).toContain('whole cents');
    await adjust({ creditNoteId: note, documentId: bill, newAmount: 20 });
    expect(await a(note, bill, 20)).toContain('nothing to change');
    expect((await snapshot(note, foreignCompany, 'supplier')).rows).toEqual([{ invoiceId: bill, amount: 20 }]);
  });

  it('the dry run plans exactly what the live call does, and writes nothing', async () => {
    const bill = await seedBill(fx, { number: 'D1', date: '2026-02-09', total: 80 });
    const note = await seedPostedNote(fx, { side: 'supplier', number: 'ND1', total: 100, posted: 100 });
    await adjust({ creditNoteId: note, documentId: bill, newAmount: 30 });
    const before = await snapshot(note, bill, 'supplier');

    const planned = await plan({ creditNoteId: note, documentId: bill, newAmount: 75 });
    expect(await snapshot(note, bill, 'supplier')).toEqual(before);

    expect(await adjust({ creditNoteId: note, documentId: bill, newAmount: 75 })).toEqual(planned);
  });
});
