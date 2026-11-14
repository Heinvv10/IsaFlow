/**
 * The posted-credit invariant is a BACKSTOP: both plans already cap at what the
 * note's journal posted, so in a correct build the live check never fires. This
 * file makes the plans lie — the plan-side read reports the note's whole total
 * as posted — and proves the live paths still refuse to record an application
 * the ledger does not carry, and that the refusal unwinds the document as well.
 *
 * Only `readPostedCreditOrRefuse` (what the plans import) is replaced; the invariant
 * (`assertApplicationWithinPostedCredit`) calls the module's own, real read.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

vi.mock('@/modules/accounting/services/shared/creditNotePostedCredit', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/modules/accounting/services/shared/creditNotePostedCredit')>();
  return {
    ...real,
    readPostedCreditOrRefuse: vi.fn(async (_c: string, note: { gl_journal_entry_id?: unknown }) =>
      ({ journalId: String(note.gl_journal_entry_id), posted: 100 })),
  };
});

import { sql } from '@/lib/neon';
import { formatMoney } from '@/lib/money/formatMoney';
import { applyCreditNoteToDocument } from '@/modules/accounting/services/shared/creditNoteDocumentApply';
import { adjustCreditNoteApplication } from '@/modules/accounting/services/shared/creditNoteApplicationAdjust';
import { CreditNotePostedCreditError } from '@/modules/accounting/services/shared/creditNotePostedCredit';
import { assertNotProductionDb } from '../helpers/assertNotProductionDb';
import { dropFixture, inTx, seedBill, seedFixture, type Fixture } from './helpers/l1FifoFixture';
import { seedPostedNote } from './helpers/creditNoteJournalFixture';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;

let fx: Fixture;

async function state(noteId: string, billId: string): Promise<{ rows: number; applied: number; paid: number }> {
  const r = ((await sql`
    SELECT (SELECT COUNT(*)::INT FROM credit_note_allocations WHERE credit_note_id = ${noteId}::UUID) AS rows,
           (SELECT applied_amount FROM credit_notes WHERE id = ${noteId}::UUID) AS applied,
           (SELECT amount_paid FROM supplier_invoices WHERE id = ${billId}::UUID) AS paid`) as Record<string, unknown>[])[0]!;
  return { rows: Number(r.rows), applied: Number(r.applied), paid: Number(r.paid) };
}

async function thrown(p: Promise<unknown>): Promise<Error> {
  const err = await p.then(() => null, (e: unknown) => e);
  expect(err).toBeInstanceOf(CreditNotePostedCreditError);
  return err as Error;
}

describeIfDb('posted-credit invariant backstop', () => {
  beforeAll(async () => {
    assertNotProductionDb('This test creates and applies credit notes.');
    fx = await seedFixture('CNK', DATABASE_URL!);
  }, 120000);

  afterAll(async () => {
    await sql`DELETE FROM credit_note_allocations WHERE company_id = ${fx.companyId}::UUID`;
    await sql`DELETE FROM credit_notes WHERE company_id = ${fx.companyId}::UUID`;
    await dropFixture(fx);
  }, 120000);

  it('apply_credit_note: a plan past the posted credit is refused at the write, and nothing survives', async () => {
    const bill = await seedBill(fx, { number: 'K1', date: '2026-02-01', total: 200 });
    const note = await seedPostedNote(fx, { side: 'supplier', number: 'NK1', total: 100, posted: 99.99 });

    const err = await thrown(inTx(fx, () => applyCreditNoteToDocument(
      fx.companyId, { creditNoteId: note, invoiceId: bill }, fx.userId)));

    expect(err.message).toContain(formatMoney(99.99));
    expect(await state(note, bill)).toEqual({ rows: 0, applied: 0, paid: 0 });
  });

  it('adjust_credit_note_application: the same, for an increase', async () => {
    const bill = await seedBill(fx, { number: 'K2', date: '2026-02-02', total: 200 });
    const note = await seedPostedNote(fx, { side: 'supplier', number: 'NK2', total: 100, posted: 99.99 });

    await thrown(inTx(fx, () => adjustCreditNoteApplication(
      fx.companyId, { creditNoteId: note, documentId: bill, newAmount: 100 }, fx.userId)));

    expect(await state(note, bill)).toEqual({ rows: 0, applied: 0, paid: 0 });
  });
});
