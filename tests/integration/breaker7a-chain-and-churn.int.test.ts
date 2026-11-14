/**
 * BREAKER 7a: posted-credit read on a reversal chain, churn, cash beside credit,
 * concurrent adjust + unapply, cancel after partial unapply, dry run vs live.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { sql } from '@/lib/neon';
import {
  adjustCreditNoteApplication, planCreditNoteApplicationAdjust,
} from '@/modules/accounting/services/shared/creditNoteApplicationAdjust';
import { applyCreditNoteToDocument } from '@/modules/accounting/services/shared/creditNoteDocumentApply';
import { unapplyCreditNote, planCreditNoteUnapply } from '@/modules/accounting/services/shared/creditNoteUnapply';
import { cancelCreditNote } from '@/modules/accounting/services/ar/creditNoteCancelService';
import { reverseJournalEntry } from '@/modules/accounting/services/gl/journalEntryService';
import { assertNotProductionDb } from '../helpers/assertNotProductionDb';
import { dropFixture, inTx, seedBill, seedFixture, seedInvoice, type Fixture } from './helpers/l1FifoFixture';
import { seedPostedNote } from './helpers/creditNoteJournalFixture';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;
let fx: Fixture;

async function noteState(id: string) {
  const r = ((await sql`
    SELECT status, applied_amount,
      (SELECT COALESCE(SUM(amount_allocated),0) FROM credit_note_allocations WHERE credit_note_id = ${id}::UUID) AS rows
    FROM credit_notes WHERE id = ${id}::UUID`) as Record<string, unknown>[])[0]!;
  return { status: String(r.status), applied: Number(r.applied_amount), rows: Number(r.rows) };
}
const billPaid = async (id: string) =>
  Number(((await sql`SELECT amount_paid FROM supplier_invoices WHERE id = ${id}::UUID`) as Record<string, unknown>[])[0]!.amount_paid);

describeIfDb('breaker 7a', () => {
  beforeAll(async () => {
    assertNotProductionDb('breaker');
    fx = await seedFixture('BRK7', DATABASE_URL!);
  }, 120000);
  afterAll(async () => {
    await sql`DELETE FROM credit_note_allocations WHERE company_id = ${fx.companyId}::UUID`;
    await sql`DELETE FROM credit_notes WHERE company_id = ${fx.companyId}::UUID`;
    await dropFixture(fx).catch(() => undefined);
  }, 120000);

  it('(c) reversed-then-reposted: O <- R <- R2 leaves the credit in the ledger; apply must still work', async () => {
    const inv = await seedInvoice(fx, { number: 'CH1', date: '2026-02-01', total: 300 });
    const note = await seedPostedNote(fx, { side: 'customer', number: 'NCH', total: 100, posted: 100 });
    const o = String(((await sql`SELECT gl_journal_entry_id FROM credit_notes WHERE id = ${note}::UUID`) as Record<string, unknown>[])[0]!.gl_journal_entry_id);
    await inTx(fx, () => reverseJournalEntry(fx.companyId, o, fx.userId));
    const r = String(((await sql`SELECT id FROM gl_journal_entries WHERE reversal_of_id = ${o}::UUID`) as Record<string, unknown>[])[0]!.id);
    await inTx(fx, () => reverseJournalEntry(fx.companyId, r, fx.userId));
    // The ledger: AR moved by -100 net across the chain (the note's credit stands).
    const ar = ((await sql`
      SELECT COALESCE(SUM(jl.credit - jl.debit),0) AS net FROM gl_journal_lines jl
      JOIN gl_accounts ga ON ga.id = jl.gl_account_id
      WHERE jl.company_id = ${fx.companyId}::UUID AND ga.account_subtype = 'receivable'`) as Record<string, unknown>[])[0]!;
    expect(Number(ar.net)).toBe(100);

    const err = await inTx(fx, () => applyCreditNoteToDocument(fx.companyId, { creditNoteId: note, invoiceId: inv }, fx.userId))
      .then(() => null, (e: unknown) => (e as Error).message);
    expect(err).toBeNull();
  });

  it('(b) churn: adjust up/down 15 times over two bills, partial unapply, cancel — zero drift', async () => {
    const a = await seedBill(fx, { number: 'CA', date: '2026-02-01', total: 333.33 });
    const b = await seedBill(fx, { number: 'CB', date: '2026-02-02', total: 77.77 });
    const note = await seedPostedNote(fx, { side: 'supplier', number: 'NCU', total: 250.01, posted: 250.01 });
    const amounts = [10.01, 200.5, 0.02, 199.99, 3.33, 172.24, 50, 0, 120.12, 172.23, 1.11, 100, 0, 172.24, 99.99];
    for (const [i, x] of amounts.entries()) {
      await inTx(fx, () => adjustCreditNoteApplication(fx.companyId, { creditNoteId: note, documentId: a, newAmount: x }, fx.userId))
        .catch((e: unknown) => { if (!/nothing to change/.test((e as Error).message)) throw new Error(`step ${i} ${x}: ${(e as Error).message}`); });
      const s = await noteState(note);
      expect(s.applied).toBe(s.rows);
      expect(await billPaid(a)).toBe(s.rows);
    }
    await inTx(fx, () => adjustCreditNoteApplication(fx.companyId, { creditNoteId: note, documentId: b, newAmount: 77.77 }, fx.userId));
    await inTx(fx, () => adjustCreditNoteApplication(fx.companyId, { creditNoteId: note, documentId: a, newAmount: 172.24 }, fx.userId));
    expect(await noteState(note)).toEqual({ status: 'applied', applied: 250.01, rows: 250.01 });
    await inTx(fx, () => unapplyCreditNote(fx.companyId, { creditNoteId: note, invoiceId: b }, fx.userId));
    expect(await noteState(note)).toMatchObject({ status: 'partially_applied', applied: 172.24, rows: 172.24 });
    expect(await billPaid(b)).toBe(0);
    await inTx(fx, () => cancelCreditNote(fx.companyId, note, fx.userId));
    expect(await noteState(note)).toEqual({ status: 'cancelled', applied: 0, rows: 0 });
    expect(await billPaid(a)).toBe(0);
  });

  it('(b) cash beside credit: adjust never touches the cash part of amount_paid', async () => {
    const bill = await seedBill(fx, { number: 'CC', date: '2026-02-03', total: 200 });
    await sql`UPDATE supplier_invoices SET amount_paid = 50, status = 'partially_paid' WHERE id = ${bill}::UUID`;
    const note = await seedPostedNote(fx, { side: 'supplier', number: 'NCC', total: 200, posted: 200 });
    await inTx(fx, () => adjustCreditNoteApplication(fx.companyId, { creditNoteId: note, documentId: bill, newAmount: 150 }, fx.userId));
    expect(await billPaid(bill)).toBe(200);
    const over = await inTx(fx, () => adjustCreditNoteApplication(fx.companyId, { creditNoteId: note, documentId: bill, newAmount: 151 }, fx.userId))
      .then(() => null, (e: unknown) => (e as Error).message);
    expect(over).toMatch(/outstanding/);
    await inTx(fx, () => adjustCreditNoteApplication(fx.companyId, { creditNoteId: note, documentId: bill, newAmount: 30 }, fx.userId));
    expect(await billPaid(bill)).toBe(80);
    await inTx(fx, () => unapplyCreditNote(fx.companyId, { creditNoteId: note }, fx.userId));
    expect(await billPaid(bill)).toBe(50);
  });

  it('(b) concurrent adjust + unapply on two connections: serialised, consistent', async () => {
    const a = await seedBill(fx, { number: 'PA', date: '2026-02-04', total: 100 });
    const b = await seedBill(fx, { number: 'PB', date: '2026-02-05', total: 100 });
    const note = await seedPostedNote(fx, { side: 'supplier', number: 'NPP', total: 150, posted: 150 });
    await inTx(fx, () => adjustCreditNoteApplication(fx.companyId, { creditNoteId: note, documentId: a, newAmount: 100 }, fx.userId));
    await inTx(fx, () => adjustCreditNoteApplication(fx.companyId, { creditNoteId: note, documentId: b, newAmount: 50 }, fx.userId));
    for (let i = 0; i < 5; i++) {
      const res = await Promise.allSettled([
        inTx(fx, () => adjustCreditNoteApplication(fx.companyId, { creditNoteId: note, documentId: a, newAmount: i % 2 ? 100 : 40 }, fx.userId)),
        inTx(fx, () => unapplyCreditNote(fx.companyId, { creditNoteId: note, invoiceId: b }, fx.userId)),
        inTx(fx, () => adjustCreditNoteApplication(fx.companyId, { creditNoteId: note, documentId: b, newAmount: 50 }, fx.userId)),
      ]);
      void res;
      const s = await noteState(note);
      expect(s.applied).toBe(s.rows);
      expect(round2(await billPaid(a) + await billPaid(b))).toBe(s.rows);
    }
  });

  it('(e) dry run equals live for adjust and unapply on a note a cent apart', async () => {
    const bill = await seedBill(fx, { number: 'DR', date: '2026-02-06', total: 500 });
    const note = await seedPostedNote(fx, { side: 'supplier', number: 'NDR', total: 490.45, posted: 490.45 });
    await inTx(fx, () => adjustCreditNoteApplication(fx.companyId, { creditNoteId: note, documentId: bill, newAmount: 490.45 }, fx.userId));
    await sql`UPDATE credit_notes SET applied_amount = 490.44 WHERE id = ${note}::UUID`;
    const planned = await inTx(fx, () => planCreditNoteApplicationAdjust(fx.companyId, { creditNoteId: note, documentId: bill, newAmount: 200 }));
    const live = await inTx(fx, () => adjustCreditNoteApplication(fx.companyId, { creditNoteId: note, documentId: bill, newAmount: 200 }, fx.userId));
    expect(live).toEqual(planned);
    const up = await inTx(fx, () => planCreditNoteUnapply(fx.companyId, { creditNoteId: note }));
    const ul = await inTx(fx, () => unapplyCreditNote(fx.companyId, { creditNoteId: note }, fx.userId));
    expect(ul).toEqual(up);
    expect(await noteState(note)).toMatchObject({ applied: 0, rows: 0 });
    expect(await billPaid(bill)).toBe(0);
  });
});

function round2(n: number): number { return Math.round(n * 100) / 100; }
