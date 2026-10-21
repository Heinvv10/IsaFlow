/**
 * A customer credit note's own remainder is judged in whole cents; a supplier note keeps the cent tolerance.
 *
 * A customer note with R0.01 unapplied read 'applied' (status within a cent of its total), so the cent was stranded:
 * `applyCreditNoteToDocument` refused it as having nothing left and the unapplied back-fill never picked it up.
 * Asserted by OUTCOME: the note row's status / applied_amount, the invoice row, and what the calls return or refuse.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { sql } from '@/lib/neon';
import { applyCreditNoteToDocument, CreditNoteApplyRefusal } from '@/modules/accounting/services/shared/creditNoteDocumentApply';
import { autoApplyUnapplied } from '@/modules/accounting/services/shared/autoApplyBackfillService';
import { assertNotProductionDb } from '../helpers/assertNotProductionDb';
import {
  dropFixture, inTx, seedBill, seedFixture, seedInvoice, seedSupplier, type Fixture,
} from './helpers/l1FifoFixture';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;

let fx: Fixture;

async function seedCustomer(name: string): Promise<string> {
  return ((await sql`INSERT INTO customers (name, company_id) VALUES (${`${name} ${fx.tag}`}, ${fx.companyId}::UUID)
    RETURNING id`) as { id: string }[])[0]!.id;
}

/** An approved, unapplied credit note with a posted journal, as approval leaves one. */
async function seedNote(side: 'customer' | 'supplier', counterparty: string, number: string, total: number): Promise<string> {
  const je = String(((await sql`
    INSERT INTO gl_journal_entries (company_id, entry_number, entry_date, description, status, created_by, fiscal_period_id, posted_at)
    VALUES (${fx.companyId}::UUID, ${`JE-${number}-${fx.tag}`}, '2026-03-01'::DATE, 'CN', 'posted', ${fx.userId}::UUID,
            (SELECT id FROM fiscal_periods WHERE company_id = ${fx.companyId}::UUID LIMIT 1), NOW())
    RETURNING id`) as { id: string }[])[0]!.id);
  return ((await sql`
    INSERT INTO credit_notes (company_id, type, supplier_id, client_id, credit_note_number, credit_date,
                              subtotal, total_amount, applied_amount, status, created_by, gl_journal_entry_id)
    VALUES (${fx.companyId}::UUID, ${side}, ${side === 'supplier' ? counterparty : null}::UUID,
            ${side === 'customer' ? counterparty : null}::UUID, ${`${number}-${fx.tag}`}, '2026-03-01'::DATE,
            ${total}, ${total}, 0, 'approved', ${fx.userId}::UUID, ${je}::UUID)
    RETURNING id`) as { id: string }[])[0]!.id;
}

async function noteRow(id: string): Promise<{ status: string; applied: number }> {
  const r = ((await sql`SELECT status, applied_amount FROM credit_notes
    WHERE id = ${id}::UUID AND company_id = ${fx.companyId}::UUID`) as Record<string, unknown>[])[0]!;
  return { status: String(r.status), applied: Number(r.applied_amount) };
}

async function invoiceRow(id: string): Promise<{ status: string; paid: number }> {
  const r = ((await sql`SELECT status, amount_paid::float8 AS paid FROM customer_invoices
    WHERE id = ${id}::UUID AND company_id = ${fx.companyId}::UUID`) as Record<string, unknown>[])[0]!;
  return { status: String(r.status), paid: Number(r.paid) };
}

const apply = (creditNoteId: string, invoiceId: string, amount?: number) =>
  inTx(fx, () => applyCreditNoteToDocument(fx.companyId, { creditNoteId, invoiceId, amount }, fx.userId));

describeIfDb('credit-note remainder, whole cents', () => {
  beforeAll(async () => {
    assertNotProductionDb('This test creates and applies credit notes.');
    fx = await seedFixture('CNR', DATABASE_URL!);
  }, 120000);
  afterAll(async () => {
    await sql`DELETE FROM credit_note_allocations WHERE company_id = ${fx.companyId}::UUID`;
    await sql`DELETE FROM credit_notes WHERE company_id = ${fx.companyId}::UUID`;
    await dropFixture(fx);
  }, 120000);

  it('customer: a note left with R0.01 is partially_applied and can apply that cent', async () => {
    const cust = await seedCustomer('CUS-N1');
    const big = await seedInvoice(fx, { number: 'N1', date: '2026-03-01', total: 50, customerId: cust });
    const cent = await seedInvoice(fx, { number: 'N2', date: '2026-03-02', total: 0.01, customerId: cust });
    const note = await seedNote('customer', cust, 'CNR1', 50.01);

    await apply(note, big, 50);
    expect(await noteRow(note)).toEqual({ status: 'partially_applied', applied: 50 });

    const second = await apply(note, cent);

    expect(second.amount).toBe(0.01);
    expect(await noteRow(note)).toEqual({ status: 'applied', applied: 50.01 });
    expect(await invoiceRow(cent)).toEqual({ status: 'paid', paid: 0.01 });
  }, 60000);

  it('customer: the unapplied back-fill picks up a note with R0.01 left, dry run and live alike', async () => {
    const cust = await seedCustomer('CUS-N2');
    const cent = await seedInvoice(fx, { number: 'N3', date: '2026-03-01', total: 0.01, customerId: cust });
    const note = await seedNote('customer', cust, 'CNR2', 0.01);
    const run = { companyId: fx.companyId, userId: fx.userId, subledger: 'ar' as const, entityId: cust };
    const lines = (p: Awaited<ReturnType<typeof autoApplyUnapplied>>) =>
      p.applications.map((a) => ({ id: a.payment_id, lines: a.lines.map((l) => [l.document_id, l.amount]) }));

    const dry = await inTx(fx, () => autoApplyUnapplied({ ...run, dryRun: true }));
    const live = await inTx(fx, () => autoApplyUnapplied({ ...run, dryRun: false, idempotencyKey: 'cnr-ar-1' }));

    expect(lines(dry)).toEqual([{ id: note, lines: [[cent, 0.01]] }]);
    expect(lines(live)).toEqual(lines(dry));
    expect(await noteRow(note)).toEqual({ status: 'applied', applied: 0.01 });
    expect(await invoiceRow(cent)).toEqual({ status: 'paid', paid: 0.01 });
  }, 60000);

  it('supplier: unchanged - a note within a cent of its total reads applied and a further cent is refused', async () => {
    const sup = await seedSupplier(fx, 'SUP-N1');
    const big = await seedBill(fx, { number: 'NB1', date: '2026-03-01', total: 50, supplierId: sup });
    const other = await seedBill(fx, { number: 'NB2', date: '2026-03-02', total: 100, supplierId: sup });
    const note = await seedNote('supplier', sup, 'CNR3', 50.01);

    await apply(note, big, 50);
    expect(await noteRow(note)).toEqual({ status: 'applied', applied: 50 });

    const err = await apply(note, other).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(CreditNoteApplyRefusal);
    expect((err as Error).message).toContain('nothing left');
  }, 60000);
});
