/**
 * BREAKER 7a round 2: adjust-down on a note whose chain is OUT (unapply's guard bypassed), odd/even chain depth,
 * and addToExisting followed by take-backs.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { sql } from '@/lib/neon';
import { adjustCreditNoteApplication } from '@/modules/accounting/services/shared/creditNoteApplicationAdjust';
import { applyCreditNoteToDocument } from '@/modules/accounting/services/shared/creditNoteDocumentApply';
import { unapplyCreditNote } from '@/modules/accounting/services/shared/creditNoteUnapply';
import { autoApplyUnapplied } from '@/modules/accounting/services/shared/autoApplyBackfillService';
import { getUnappliedCreditNotes } from '@/modules/accounting/services/reconciliation/unappliedCreditNoteService';
import { reverseJournalEntry } from '@/modules/accounting/services/gl/journalEntryService';
import { assertNotProductionDb } from '../helpers/assertNotProductionDb';
import { dropFixture, inTx, seedBill, seedFixture, seedSupplier, type Fixture } from './helpers/l1FifoFixture';
import { seedPostedNote } from './helpers/creditNoteJournalFixture';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;
let fx: Fixture;
const msg = (p: Promise<unknown>) => p.then(() => null, (e: unknown) => (e as Error).message);
const journalOf = async (note: string) =>
  String(((await sql`SELECT gl_journal_entry_id FROM credit_notes WHERE id = ${note}::UUID`) as Record<string, unknown>[])[0]!.gl_journal_entry_id);
async function reverseHead(o: string): Promise<void> {
  let head = o;
  for (;;) {
    const next = (await sql`SELECT id FROM gl_journal_entries WHERE reversal_of_id = ${head}::UUID`) as Record<string, unknown>[];
    if (next.length === 0) break;
    head = String(next[0]!.id);
  }
  await inTx(fx, () => reverseJournalEntry(fx.companyId, head, fx.userId));
}
const state = async (note: string, bill: string) => {
  const n = ((await sql`SELECT applied_amount, total_amount, status FROM credit_notes WHERE id = ${note}::UUID`) as Record<string, unknown>[])[0]!;
  const b = ((await sql`SELECT amount_paid FROM supplier_invoices WHERE id = ${bill}::UUID`) as Record<string, unknown>[])[0]!;
  return { applied: Number(n.applied_amount), remainder: Number(n.total_amount) - Number(n.applied_amount), paid: Number(b.amount_paid) };
};

describeIfDb('breaker 7a r2', () => {
  beforeAll(async () => { assertNotProductionDb('breaker'); fx = await seedFixture('BRK7R2', DATABASE_URL!); }, 120000);
  afterAll(async () => {
    await sql`DELETE FROM credit_note_allocations WHERE company_id = ${fx.companyId}::UUID`;
    await sql`DELETE FROM credit_notes WHERE company_id = ${fx.companyId}::UUID`;
    await dropFixture(fx).catch(() => undefined);
  }, 120000);

  it('(3) chain OUT: unapply refuses to mint unbacked on-account credit — adjust to 0 must refuse too', async () => {
    const bill = await seedBill(fx, { number: 'X1', date: '2026-02-01', total: 200 });
    const note = await seedPostedNote(fx, { side: 'supplier', number: 'NX', total: 100, posted: 100 });
    await inTx(fx, () => adjustCreditNoteApplication(fx.companyId, { creditNoteId: note, documentId: bill, newAmount: 100 }, fx.userId));
    await reverseHead(await journalOf(note)); // O <- R: the GL no longer carries the credit; the note is NOT cancelled
    expect(await msg(inTx(fx, () => unapplyCreditNote(fx.companyId, { creditNoteId: note }, fx.userId)))).toMatch(/reversed/);
    const adj = await msg(inTx(fx, () => adjustCreditNoteApplication(fx.companyId, { creditNoteId: note, documentId: bill, newAmount: 0 }, fx.userId)));
    const after = await state(note, bill);
    const unapplied = (await getUnappliedCreditNotes(fx.companyId, 'ap', '2026-12-31', []).catch(() => [])) as unknown[];
    // eslint-disable-next-line no-console
    process.stderr.write(`ADJUST-TO-0 RESULT: ${adj ?? 'SUCCEEDED'} state=${JSON.stringify(after)} unappliedRows=${JSON.stringify(unapplied).slice(0, 300)}\n`);
    expect(adj).not.toBeNull();
    expect(after).toEqual({ applied: 100, remainder: 0, paid: 100 });
  });

  it('(2) chain depth: O<-R<-R2<-R3 is out (apply refused), <-R4 stands again (apply works)', async () => {
    const bill = await seedBill(fx, { number: 'X2', date: '2026-02-02', total: 200 });
    const note = await seedPostedNote(fx, { side: 'supplier', number: 'NY', total: 100, posted: 100 });
    const o = await journalOf(note);
    for (let i = 0; i < 3; i++) await reverseHead(o);
    expect(await msg(inTx(fx, () => applyCreditNoteToDocument(fx.companyId, { creditNoteId: note, invoiceId: bill }, fx.userId)))).toMatch(/reversed/);
    await reverseHead(o);
    expect(await msg(inTx(fx, () => applyCreditNoteToDocument(fx.companyId, { creditNoteId: note, invoiceId: bill }, fx.userId)))).toBeNull();
    expect(await state(note, bill)).toMatchObject({ applied: 100, paid: 100 });
  });

  it('(1) addToExisting: name 30, back-fill adds 70 on the same row, adjust 50, unapply — no double count', async () => {
    const sup = await seedSupplier(fx, 'AE');
    const bill = await seedBill(fx, { number: 'X3', date: '2026-02-03', total: 500, supplierId: sup });
    const note = await seedPostedNote(fx, { side: 'supplier', number: 'NZ', total: 100, posted: 100, counterpartyId: sup });
    await inTx(fx, () => applyCreditNoteToDocument(fx.companyId, { creditNoteId: note, invoiceId: bill, amount: 30 }, fx.userId));
    const run = await inTx(fx, () => autoApplyUnapplied({ companyId: fx.companyId, userId: fx.userId, subledger: 'ap', entityId: sup, dryRun: false, idempotencyKey: `ae-${fx.tag}` }));
    expect(run.failed).toEqual([]);
    const rows = (await sql`SELECT amount_allocated FROM credit_note_allocations WHERE credit_note_id = ${note}::UUID`) as Record<string, unknown>[];
    expect(rows.map((r) => Number(r.amount_allocated))).toEqual([100]);
    expect(await state(note, bill)).toMatchObject({ applied: 100, paid: 100 });
    await inTx(fx, () => adjustCreditNoteApplication(fx.companyId, { creditNoteId: note, documentId: bill, newAmount: 50 }, fx.userId));
    expect(await state(note, bill)).toMatchObject({ applied: 50, paid: 50 });
    await inTx(fx, () => unapplyCreditNote(fx.companyId, { creditNoteId: note }, fx.userId));
    expect(await state(note, bill)).toMatchObject({ applied: 0, paid: 0 });
  });
});
