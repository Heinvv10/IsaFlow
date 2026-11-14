/**
 * An applied credit note must be backed by what its journal POSTED.
 *
 * Brief fix (13 Nov 2026): "re-applying CN-388 counted R0.01 as used with no
 * journal — applied amount must equal posted amount." An application posts no
 * journal of its own; the note's approval journal moved the control account,
 * and applying only moves the subledger. So when that journal is gone, or put
 * less on the control account than the note's header total, every rand applied
 * beyond it is credit the ledger never carried. `apply_credit_note` (and the
 * adjust tool built on the same rule) cap at the posted amount, refuse a note
 * whose journal is missing or reversed, and check the invariant again just
 * before recording.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { sql } from '@/lib/neon';
import { formatMoney } from '@/lib/money/formatMoney';
import {
  applyCreditNoteToDocument, planCreditNoteToDocument, CreditNoteApplyRefusal,
} from '@/modules/accounting/services/shared/creditNoteDocumentApply';
import { unapplyCreditNote } from '@/modules/accounting/services/shared/creditNoteUnapply';
import { createCreditNote } from '@/modules/accounting/services/ar/creditNoteService';
import { approveCreditNote } from '@/modules/accounting/services/ar/creditNoteApproveService';
import {
  assertApplicationWithinPostedCredit, CreditNotePostedCreditError,
} from '@/modules/accounting/services/shared/creditNotePostedCredit';
import { assertNotProductionDb } from '../helpers/assertNotProductionDb';
import { dropFixture, inTx, seedBill, seedFixture, seedInvoice, type Fixture } from './helpers/l1FifoFixture';
import { seedPostedNote } from './helpers/creditNoteJournalFixture';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;

let fx: Fixture;

const apply = (input: { creditNoteId: string; invoiceId: string; amount?: number }) =>
  inTx(fx, () => applyCreditNoteToDocument(fx.companyId, input, fx.userId));
const plan = (input: { creditNoteId: string; invoiceId: string; amount?: number }) =>
  inTx(fx, () => planCreditNoteToDocument(fx.companyId, input));

async function refusal(p: Promise<unknown>): Promise<string> {
  const err = await p.then(() => null, (e: unknown) => e);
  expect(err).toBeInstanceOf(CreditNoteApplyRefusal);
  return (err as Error).message;
}

async function allocated(noteId: string): Promise<number> {
  const r = (await sql`
    SELECT COALESCE(SUM(amount_allocated), 0) AS s FROM credit_note_allocations
    WHERE credit_note_id = ${noteId}::UUID AND company_id = ${fx.companyId}::UUID`) as Record<string, unknown>[];
  return Number(r[0]!.s);
}

async function noteApplied(noteId: string): Promise<number> {
  const r = (await sql`
    SELECT applied_amount FROM credit_notes WHERE id = ${noteId}::UUID AND company_id = ${fx.companyId}::UUID`) as Record<string, unknown>[];
  return Number(r[0]!.applied_amount);
}

describeIfDb('credit-note applications are backed by the posted journal', () => {
  beforeAll(async () => {
    assertNotProductionDb('This test creates and applies credit notes.');
    fx = await seedFixture('CNP', DATABASE_URL!);
  }, 120000);

  afterAll(async () => {
    await sql`DELETE FROM credit_note_allocations WHERE company_id = ${fx.companyId}::UUID`;
    await sql`DELETE FROM credit_notes WHERE company_id = ${fx.companyId}::UUID`;
    await dropFixture(fx);
  }, 120000);

  it('a note approved in IsaFlow posts its whole total and still applies in full', async () => {
    const bill = await seedBill(fx, { number: 'OK1', date: '2026-02-01', total: 500 });
    const created = await inTx(fx, () => createCreditNote(fx.companyId, {
      type: 'supplier', supplierId: fx.supplierId, creditDate: '2026-03-01', subtotal: 100, taxRate: 15,
    }, fx.userId));
    await inTx(fx, () => approveCreditNote(fx.companyId, created.id, fx.userId, { autoApply: 'none' }));

    const r = await apply({ creditNoteId: created.id, invoiceId: bill });

    expect(r.amount).toBe(115);
    expect(await allocated(created.id)).toBe(115);
  });

  it('CN-388: re-applying a supplier note whose journal posted R0.01 less applies only what was posted', async () => {
    const billA = await seedBill(fx, { number: 'A388', date: '2026-02-02', total: 100 });
    const billB = await seedBill(fx, { number: 'B388', date: '2026-02-03', total: 100 });
    const note = await seedPostedNote(fx, { side: 'supplier', number: 'N388', total: 100, posted: 99.99 });

    const first = await apply({ creditNoteId: note, invoiceId: billA });
    expect(first.amount).toBe(99.99);
    await inTx(fx, () => unapplyCreditNote(fx.companyId, { creditNoteId: note }, fx.userId));

    const planned = await plan({ creditNoteId: note, invoiceId: billB });
    const again = await apply({ creditNoteId: note, invoiceId: billB });

    expect(planned.amount).toBe(99.99);
    expect(again.amount).toBe(99.99);
    // Recorded = rows = posted, never the header total.
    expect(await allocated(note)).toBe(99.99);
    expect(await noteApplied(note)).toBe(99.99);
  });

  it('customer side: an explicit amount past the posted credit is capped, and the unposted cent is refused by name', async () => {
    const inv1 = await seedInvoice(fx, { number: 'C1', date: '2026-02-04', total: 100 });
    const inv2 = await seedInvoice(fx, { number: 'C2', date: '2026-02-05', total: 100 });
    const note = await seedPostedNote(fx, { side: 'customer', number: 'NC1', total: 50, posted: 49.99 });

    const r = await apply({ creditNoteId: note, invoiceId: inv1, amount: 50 });
    expect(r.amount).toBe(49.99);

    const msg = await refusal(apply({ creditNoteId: note, invoiceId: inv2 }));
    expect(msg).toContain(formatMoney(49.99));
    expect(await refusal(plan({ creditNoteId: note, invoiceId: inv2 }))).toBe(msg);
    expect(await allocated(note)).toBe(49.99);
  });

  it('refuses a note whose journal was reversed, or that has none, in the plan and live', async () => {
    const bill = await seedBill(fx, { number: 'RV1', date: '2026-02-06', total: 100 });
    const reversed = await seedPostedNote(fx, { side: 'supplier', number: 'NRV', total: 40, posted: 40, reversed: true });
    const none = await seedPostedNote(fx, { side: 'supplier', number: 'NNJ', total: 40, posted: null });

    expect(await refusal(plan({ creditNoteId: reversed, invoiceId: bill }))).toContain('reversed');
    expect(await refusal(apply({ creditNoteId: reversed, invoiceId: bill }))).toContain('reversed');
    expect(await refusal(apply({ creditNoteId: none, invoiceId: bill }))).toContain('no posted journal');
    expect(await allocated(reversed)).toBe(0);
    expect(await allocated(none)).toBe(0);
  });

  it('the invariant refuses to record an application the posted journal does not carry', async () => {
    const note = await seedPostedNote(fx, { side: 'supplier', number: 'NINV', total: 100, posted: 99.99 });
    const row = (await sql`SELECT * FROM credit_notes WHERE id = ${note}::UUID`) as Record<string, unknown>[];

    const err = await inTx(fx, () => assertApplicationWithinPostedCredit(fx.companyId, row[0]!, 'supplier', 0, 100))
      .then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(CreditNotePostedCreditError);
    expect((err as Error).message).toContain(formatMoney(99.99));

    const okay = await inTx(fx, () => assertApplicationWithinPostedCredit(fx.companyId, row[0]!, 'supplier', 0, 99.99));
    expect(okay.posted).toBe(99.99);
  });
});
