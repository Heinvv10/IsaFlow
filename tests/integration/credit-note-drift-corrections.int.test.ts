/**
 * A note ALREADY a cent apart — CN-388's shape: its allocation rows hold R490.45
 * (what its bill was credited) while `applied_amount` says R490.44, and the
 * reverse — must be refused MORE credit by name, and must always be correctable.
 *
 * The exact rows-vs-applied check guards only what INCREASES the applied amount
 * (apply, adjust up, …). What DECREASES or removes it (unapply, adjust down / to
 * 0, cancel) keeps a cent of tolerance, re-derives the note's figure from the
 * rows that remain, and so ends exactly consistent: rows 0, applied 0, the bill's
 * amount_paid moved by exactly what the rows held.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { sql } from '@/lib/neon';
import { applyCreditNoteToDocument } from '@/modules/accounting/services/shared/creditNoteDocumentApply';
import { adjustCreditNoteApplication } from '@/modules/accounting/services/shared/creditNoteApplicationAdjust';
import { unapplyCreditNote } from '@/modules/accounting/services/shared/creditNoteUnapply';
import { cancelCreditNote } from '@/modules/accounting/services/ar/creditNoteCancelService';
import { assertNotProductionDb } from '../helpers/assertNotProductionDb';
import { dropFixture, inTx, seedBill, seedFixture, type Fixture } from './helpers/l1FifoFixture';
import { seedPostedNote } from './helpers/creditNoteJournalFixture';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;

let fx: Fixture;
let seq = 0;

interface Planted { note: string; bill: string; other: string; rows: number }

/**
 * A supplier note of R1 000 (journal whole, so it still has credit to give) whose rows hold `rows` on its R490.45
 * bill and whose column says `applied`.
 */
async function plant(rows: number, applied: number): Promise<Planted> {
  seq += 1;
  const bill = await seedBill(fx, { number: `D${seq}`, date: '2026-02-01', total: 490.45 });
  const other = await seedBill(fx, { number: `O${seq}`, date: '2026-02-02', total: 1000 });
  const note = await seedPostedNote(fx, { side: 'supplier', number: `ND${seq}`, total: 1000, posted: 1000, status: 'partially_applied' });
  await sql`INSERT INTO credit_note_allocations (company_id, credit_note_id, invoice_id, amount_allocated)
            VALUES (${fx.companyId}::UUID, ${note}::UUID, ${bill}::UUID, ${rows})`;
  await sql`UPDATE supplier_invoices SET amount_paid = ${rows}, status = 'paid' WHERE id = ${bill}::UUID`;
  await sql`UPDATE credit_notes SET applied_amount = ${applied} WHERE id = ${note}::UUID`;
  return { note, bill, other, rows };
}

async function state(p: Planted): Promise<{ applied: number; rows: number; billPaid: number; otherPaid: number; status: string }> {
  const r = ((await sql`
    SELECT cn.applied_amount, cn.status,
           (SELECT COALESCE(SUM(amount_allocated), 0) FROM credit_note_allocations WHERE credit_note_id = cn.id) AS rows,
           (SELECT amount_paid FROM supplier_invoices WHERE id = ${p.bill}::UUID) AS bill_paid,
           (SELECT amount_paid FROM supplier_invoices WHERE id = ${p.other}::UUID) AS other_paid
    FROM credit_notes cn WHERE cn.id = ${p.note}::UUID`) as Record<string, unknown>[])[0]!;
  return {
    applied: Number(r.applied_amount), rows: Number(r.rows), billPaid: Number(r.bill_paid),
    otherPaid: Number(r.other_paid), status: String(r.status),
  };
}

async function errorOf(p: Promise<unknown>): Promise<string> {
  const err = await p.then(() => null, (e: unknown) => e);
  expect(err).toBeInstanceOf(Error);
  return (err as Error).message;
}

describeIfDb('a note a cent apart: refused more, always correctable', () => {
  beforeAll(async () => {
    assertNotProductionDb('This test creates and applies credit notes.');
    fx = await seedFixture('CND', DATABASE_URL!);
  }, 120000);

  afterAll(async () => {
    await sql`DELETE FROM credit_note_allocations WHERE company_id = ${fx.companyId}::UUID`;
    await sql`DELETE FROM credit_notes WHERE company_id = ${fx.companyId}::UUID`;
    await dropFixture(fx);
  }, 120000);

  for (const [rows, applied] of [[490.45, 490.44], [490.44, 490.45]] as const) {
    const shape = `rows ${rows} / applied ${applied}`;

    it(`${shape}: applying more is refused by name, and nothing moves`, async () => {
      const p = await plant(rows, applied);
      const before = await state(p);

      expect(await errorOf(inTx(fx, () => applyCreditNoteToDocument(
        fx.companyId, { creditNoteId: p.note, invoiceId: p.other }, fx.userId)))).toContain(`allocation rows totalling ${rows}`);
      expect(await errorOf(inTx(fx, () => adjustCreditNoteApplication(
        fx.companyId, { creditNoteId: p.note, documentId: p.other, newAmount: 5 }, fx.userId)))).toContain(`allocation rows totalling ${rows}`);
      expect(await errorOf(inTx(fx, () => adjustCreditNoteApplication(
        fx.companyId, { creditNoteId: p.note, documentId: p.bill, newAmount: 490.45 }, fx.userId))))
        .toMatch(rows === 490.45 ? /nothing to change/ : /allocation rows totalling 490.44/);
      expect(await state(p)).toEqual(before);
    });

    for (const [how, run] of [
      ['unapply', (p: Planted) => unapplyCreditNote(fx.companyId, { creditNoteId: p.note }, fx.userId)],
      ['adjust to 0', (p: Planted) => adjustCreditNoteApplication(fx.companyId, { creditNoteId: p.note, documentId: p.bill, newAmount: 0 }, fx.userId)],
      ['cancel_credit_note', (p: Planted) => cancelCreditNote(fx.companyId, p.note, fx.userId)],
    ] as const) {
      it(`${shape}: ${how} succeeds and ends exactly consistent`, async () => {
        const p = await plant(rows, applied);

        await inTx(fx, () => run(p));

        const after = await state(p);
        expect(after).toMatchObject({ applied: 0, rows: 0, billPaid: 0, otherPaid: 0 });
        expect(after.status).toBe(how === 'cancel_credit_note' ? 'cancelled' : 'approved');
      });
    }
  }

  it('a PARTIAL take-back of a note a cent apart re-derives the note from its rows', async () => {
    const p = await plant(490.45, 490.44);

    await inTx(fx, () => adjustCreditNoteApplication(
      fx.companyId, { creditNoteId: p.note, documentId: p.bill, newAmount: 100 }, fx.userId));

    expect(await state(p)).toMatchObject({ applied: 100, rows: 100, billPaid: 100, status: 'partially_applied' });
  });
});
