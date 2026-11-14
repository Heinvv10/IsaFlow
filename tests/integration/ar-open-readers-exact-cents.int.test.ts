/**
 * The customer-invoice READERS decide open / settled in whole cents, like the writers.
 *
 * Receipts and recomputeInvoiceStatus already write 'paid' only when nothing is owing, so an invoice with one cent
 * left reads 'partially_paid'. These readers still treated R0.01 owing as settled, so one row got two answers:
 *  - the FIFO open set (fetchOpenCustomerInvoices) dropped it;
 *  - the bank-line receipt-match shortlist (getReceiptMatchCandidates) never offered it;
 *  - a credit note could not be applied to it, by name or via applyCreditNoteToInvoice.
 * Asserted by OUTCOME: what the call returns, and the invoice / credit-note rows afterwards.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { sql } from '@/lib/neon';
import { applyCreditNoteToDocument, planCreditNoteToDocument } from '@/modules/accounting/services/shared/creditNoteDocumentApply';
import { applyCreditNoteToInvoice } from '@/modules/accounting/services/ar/creditNoteCancelService';
import { fetchOpenCustomerInvoices } from '@/modules/accounting/services/ar/openCustomerInvoices';
import { getReceiptMatchCandidates } from '@/modules/accounting/services/ar/receiptMatchService';
import { assertNotProductionDb } from '../helpers/assertNotProductionDb';
import { dropFixture, inTx, seedBankTx, seedFixture, seedInvoice, type Fixture } from './helpers/l1FifoFixture';
import { seedPostedNote } from './helpers/creditNoteJournalFixture';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;

let fx: Fixture;

/** A partly paid invoice that owes exactly `owing`. */
async function invoiceOwing(number: string, total: number, owing: number): Promise<string> {
  const id = await seedInvoice(fx, { number, date: '2026-02-01', total, status: 'partially_paid' });
  await sql`UPDATE customer_invoices SET amount_paid = ${Math.round((total - owing) * 100) / 100}
            WHERE id = ${id}::UUID AND company_id = ${fx.companyId}::UUID`;
  return id;
}

async function invoiceRow(id: string): Promise<{ status: string; paid: number; paidAt: Date | null }> {
  const r = ((await sql`SELECT status, amount_paid, paid_at FROM customer_invoices
    WHERE id = ${id}::UUID AND company_id = ${fx.companyId}::UUID`) as Record<string, unknown>[])[0]!;
  return { status: String(r.status), paid: Number(r.amount_paid), paidAt: (r.paid_at as Date | null) ?? null };
}

/** An approved, unapplied customer credit note whose journal posted its whole total, as approval leaves one. */
function seedNote(number: string, total: number): Promise<string> {
  return seedPostedNote(fx, { side: 'customer', number, total, posted: total });
}

async function noteRow(id: string): Promise<{ status: string; applied: number }> {
  const r = ((await sql`SELECT status, applied_amount FROM credit_notes
    WHERE id = ${id}::UUID AND company_id = ${fx.companyId}::UUID`) as Record<string, unknown>[])[0]!;
  return { status: String(r.status), applied: Number(r.applied_amount) };
}

describeIfDb('customer-invoice readers, whole cents', () => {
  beforeAll(async () => {
    assertNotProductionDb('This test creates and applies credit notes.');
    fx = await seedFixture('ARX', DATABASE_URL!);
  }, 120000);

  afterAll(async () => {
    await sql`DELETE FROM credit_note_allocations WHERE company_id = ${fx.companyId}::UUID`;
    await sql`DELETE FROM credit_notes WHERE company_id = ${fx.companyId}::UUID`;
    await dropFixture(fx);
  }, 120000);

  it('the FIFO open set includes an invoice owing one cent, and excludes one owing nothing', async () => {
    const cent = await invoiceOwing('OPEN-1', 115, 0.01);
    const none = await invoiceOwing('OPEN-0', 115, 0);

    const open = await inTx(fx, () => fetchOpenCustomerInvoices(fx.companyId, fx.customerId, true, { forUpdate: false }));

    const ids = open.map((d) => d.invoiceId);
    expect(ids).toContain(cent);
    expect(ids).not.toContain(none);
    expect(open.find((d) => d.invoiceId === cent)!.outstanding).toBeCloseTo(0.01, 2);
  });

  it('the receipt-match shortlist offers an invoice owing one cent', async () => {
    const cent = await invoiceOwing('MATCH-1', 200, 0.01);
    const tx = await seedBankTx(fx, { date: '2026-03-05', amount: 0.01, description: 'EFT receipt' });

    const { candidates } = await inTx(fx, () => getReceiptMatchCandidates(tx, fx.companyId));

    expect(candidates.map((c) => c.id)).toContain(cent);
  });

  it('a credit note can clear a one-cent remnant by name: invoice paid and dated, note partially_applied', async () => {
    const inv = await invoiceOwing('CN-1', 115, 0.01);
    const note = await seedNote('CNX1', 50);

    const planned = await inTx(fx, () => planCreditNoteToDocument(fx.companyId, { creditNoteId: note, invoiceId: inv }));
    expect(planned.amount).toBe(0.01);
    const done = await inTx(fx, () => applyCreditNoteToDocument(fx.companyId, { creditNoteId: note, invoiceId: inv }, fx.userId));

    expect(done.amount).toBe(0.01);
    const row = await invoiceRow(inv);
    expect(row).toMatchObject({ status: 'paid', paid: 115 });
    expect(row.paidAt).toBeInstanceOf(Date);
    expect(await noteRow(note)).toEqual({ status: 'partially_applied', applied: 0.01 });
  });

  it('applyCreditNoteToInvoice clears a one-cent remnant too', async () => {
    const inv = await invoiceOwing('CN-2', 115, 0.01);
    const note = await seedNote('CNX2', 50);

    await inTx(fx, () => applyCreditNoteToInvoice(fx.companyId, note, inv, fx.userId));

    expect(await invoiceRow(inv)).toMatchObject({ status: 'paid', paid: 115 });
    expect(await noteRow(note)).toEqual({ status: 'partially_applied', applied: 0.01 });
  });

  it('a credit note still refuses an invoice owing nothing', async () => {
    const inv = await invoiceOwing('CN-3', 115, 0);
    await sql`UPDATE customer_invoices SET status = 'approved' WHERE id = ${inv}::UUID AND company_id = ${fx.companyId}::UUID`;
    const note = await seedNote('CNX3', 50);

    await expect(inTx(fx, () => planCreditNoteToDocument(fx.companyId, { creditNoteId: note, invoiceId: inv })))
      .rejects.toThrow(/nothing outstanding/);
  });
});
