/**
 * The posted-credit rule's edges (blind review of 9406b9671d):
 *   · a write may never INCREASE applied above max(posted, applied before) — so a
 *     note ALREADY applied past its posted credit can still be brought down, by the
 *     dry run and the live call alike, customer and supplier;
 *   · a control leg on an account not typed receivable / payable reads as nothing
 *     posted, and the refusal says so;
 *   · the customer side of adjust is bounded by the posted credit too;
 *   · the journal row is share-locked, so a reversal committing mid-apply is seen.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from 'pg';
import { sql } from '@/lib/neon';
import {
  adjustCreditNoteApplication, planCreditNoteApplicationAdjust, CreditNoteAdjustRefusal,
  type CreditNoteAdjustInput,
} from '@/modules/accounting/services/shared/creditNoteApplicationAdjust';
import {
  applyCreditNoteToDocument, CreditNoteApplyRefusal,
} from '@/modules/accounting/services/shared/creditNoteDocumentApply';
import { autoApplyUnapplied } from '@/modules/accounting/services/shared/autoApplyBackfillService';
import { applyCreditNoteToInvoice } from '@/modules/accounting/services/ar/creditNoteApplyToInvoice';
import { CreditNotePostedCreditError } from '@/modules/accounting/services/shared/creditNotePostedCredit';
import { formatMoney } from '@/lib/money/formatMoney';
import { reverseJournalEntry } from '@/modules/accounting/services/gl/journalEntryService';
import { assertNotProductionDb } from '../helpers/assertNotProductionDb';
import { dropFixture, inTx, seedBill, seedFixture, seedInvoice, seedSupplier, type Fixture } from './helpers/l1FifoFixture';
import { seedPostedNote } from './helpers/creditNoteJournalFixture';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;

let fx: Fixture;

const adjust = (i: CreditNoteAdjustInput) => inTx(fx, () => adjustCreditNoteApplication(fx.companyId, i, fx.userId));
const plan = (i: CreditNoteAdjustInput) => inTx(fx, () => planCreditNoteApplicationAdjust(fx.companyId, i));

async function refusal(p: Promise<unknown>, type: new (...a: never[]) => Error = CreditNoteAdjustRefusal): Promise<string> {
  const err = await p.then(() => null, (e: unknown) => e);
  expect(err).toBeInstanceOf(type);
  return (err as Error).message;
}

/** A note of `total` whose journal posted only `posted`, already applied 600 + 400 to two documents. */
async function overApplied(side: 'supplier' | 'customer', n: string): Promise<{ note: string; a: string; b: string }> {
  const seed = side === 'supplier' ? seedBill : seedInvoice;
  const a = await seed(fx, { number: `${n}A`, date: '2026-02-01', total: 1000 });
  const b = await seed(fx, { number: `${n}B`, date: '2026-02-02', total: 1000 });
  const note = await seedPostedNote(fx, { side, number: n, total: 1000, posted: 500, status: 'applied' });
  for (const [doc, amt] of [[a, 600], [b, 400]] as const) {
    await sql`INSERT INTO credit_note_allocations (company_id, credit_note_id, invoice_id, amount_allocated)
              VALUES (${fx.companyId}::UUID, ${note}::UUID, ${doc}::UUID, ${amt})`;
    if (side === 'supplier') await sql`UPDATE supplier_invoices SET amount_paid = ${amt} WHERE id = ${doc}::UUID`;
    else await sql`UPDATE customer_invoices SET amount_paid = ${amt}, status = 'partially_paid' WHERE id = ${doc}::UUID`;
  }
  await sql`UPDATE credit_notes SET applied_amount = 1000 WHERE id = ${note}::UUID`;
  return { note, a, b };
}

describeIfDb('posted-credit rule: review edges', () => {
  beforeAll(async () => {
    assertNotProductionDb('This test creates and applies credit notes.');
    fx = await seedFixture('CNR7', DATABASE_URL!);
  }, 120000);

  afterAll(async () => {
    await sql`DELETE FROM credit_note_allocations WHERE company_id = ${fx.companyId}::UUID`;
    await sql`DELETE FROM credit_notes WHERE company_id = ${fx.companyId}::UUID`;
    await dropFixture(fx);
  }, 120000);

  for (const side of ['supplier', 'customer'] as const) {
    it(`${side}: a note applied past its posted credit can be lowered (dry run and live), never raised`, async () => {
      const { note, a } = await overApplied(side, side === 'supplier' ? 'OS' : 'OC');
      const down = { creditNoteId: note, documentId: a, newAmount: 300 };

      const planned = await plan(down);
      expect(planned).toMatchObject({ noteAppliedBefore: 1000, noteAppliedAfter: 700, notePosted: 500 });
      expect(await adjust(down)).toEqual(planned);

      expect(await refusal(plan({ ...down, newAmount: 350 }))).toContain('never posted');
      expect(await refusal(adjust({ ...down, newAmount: 350 }))).toContain('never posted');
    });
  }

  it('customer: adjust is bounded by the posted credit', async () => {
    const inv = await seedInvoice(fx, { number: 'CA', date: '2026-02-03', total: 100 });
    const note = await seedPostedNote(fx, { side: 'customer', number: 'NCA', total: 50, posted: 49.99 });

    expect(await refusal(plan({ creditNoteId: note, documentId: inv, newAmount: 50 }))).toContain('never posted');
    expect(await refusal(adjust({ creditNoteId: note, documentId: inv, newAmount: 50 }))).toContain('never posted');
    expect((await adjust({ creditNoteId: note, documentId: inv, newAmount: 49.99 })).noteAppliedAfter).toBe(49.99);
  });

  it('a control leg on an account with no receivable/payable subtype reads as nothing posted, and says so', async () => {
    const bill = await seedBill(fx, { number: 'UT', date: '2026-02-04', total: 100 });
    const note = await seedPostedNote(fx, { side: 'supplier', number: 'NUT', total: 40, posted: 40 });
    const untyped = ((await sql`
      INSERT INTO gl_accounts (company_id, account_code, account_name, account_type, account_subtype,
                               normal_balance, is_active, is_system_account)
      VALUES (${fx.companyId}::UUID, '2999', ${`Creditors (untyped) ${fx.tag}`}, 'liability', 'other_current_liability',
              'credit', true, false) RETURNING id`) as { id: string }[])[0]!.id;
    await sql`
      UPDATE gl_journal_lines SET gl_account_id = ${untyped}::UUID
      WHERE journal_entry_id = (SELECT gl_journal_entry_id FROM credit_notes WHERE id = ${note}::UUID) AND debit > 0`;

    const msg = await refusal(
      inTx(fx, () => applyCreditNoteToDocument(fx.companyId, { creditNoteId: note, invoiceId: bill }, fx.userId)),
      CreditNoteApplyRefusal);
    expect(msg).toContain('posted nothing to an AR/AP control account');
    expect(msg).toContain('Reclassify the account subtype or repost the note');
  });

  it('a reversal committed while an apply waits on the journal is seen, and the apply is refused', async () => {
    const bill = await seedBill(fx, { number: 'RC', date: '2026-02-05', total: 100 });
    const note = await seedPostedNote(fx, { side: 'supplier', number: 'NRC', total: 40, posted: 40 });
    const je = String(((await sql`SELECT gl_journal_entry_id FROM credit_notes WHERE id = ${note}::UUID`) as Record<string, unknown>[])[0]!.gl_journal_entry_id);

    const other = new Client({ connectionString: DATABASE_URL });
    await other.connect();
    try {
      await other.query('BEGIN');
      // What a reversal does (gl/journalEntryReversalClaim), uncommitted: claim O by stamping reversed_at…
      await other.query('UPDATE gl_journal_entries SET reversed_at = NOW() WHERE id = $1', [je]);
      // …and posts its contra R (reversal_of_id = O), which is what takes the chain out of the ledger.
      await other.query(`INSERT INTO gl_journal_entries (company_id, entry_number, entry_date, description, status, created_by,
                           posted_at, reversal_of_id) SELECT company_id, entry_number || '-R', entry_date, 'reversal', 'posted',
                           created_by, NOW(), id FROM gl_journal_entries WHERE id = $1`, [je]);

      let settled = false;
      const applying = inTx(fx, () => applyCreditNoteToDocument(fx.companyId, { creditNoteId: note, invoiceId: bill }, fx.userId))
        .finally(() => { settled = true; });
      await new Promise((r) => setTimeout(r, 500));
      expect(settled).toBe(false); // waiting on the journal row, not deciding from a stale read

      await other.query('COMMIT');
      expect(await refusal(applying, CreditNoteApplyRefusal)).toContain('reversed');
    } finally {
      await other.query('ROLLBACK').catch(() => undefined);
      await other.end();
    }
    const rows = (await sql`SELECT COUNT(*)::INT AS n FROM credit_note_allocations WHERE credit_note_id = ${note}::UUID`) as Record<string, unknown>[];
    expect(rows[0]!.n).toBe(0);
  });
  it('auto_apply_unapplied caps a note at its posted credit (dry run = live) and skips one whose journal is reversed', async () => {
    const sup = await seedSupplier(fx, 'CNR7-BF');
    const bill = await seedBill(fx, { number: 'BF1', date: '2026-02-06', total: 500, supplierId: sup });
    const short = await seedPostedNote(fx, { side: 'supplier', number: 'NBF1', total: 100, posted: 99.99, counterpartyId: sup });
    const gone = await seedPostedNote(fx, { side: 'supplier', number: 'NBF2', total: 50, posted: 50, reversed: true, counterpartyId: sup });
    const run = { companyId: fx.companyId, userId: fx.userId, subledger: 'ap' as const, entityId: sup };
    const lines = (p: Awaited<ReturnType<typeof autoApplyUnapplied>>) =>
      p.applications.map((a) => ({ id: a.payment_id, lines: a.lines.map((l) => [l.document_id, l.amount]) }));

    const dry = await inTx(fx, () => autoApplyUnapplied({ ...run, dryRun: true }));
    const live = await inTx(fx, () => autoApplyUnapplied({ ...run, dryRun: false, idempotencyKey: 'cnr7-bf' }));

    expect(lines(dry)).toEqual([{ id: short, lines: [[bill, 99.99]] }]);
    expect(lines(live)).toEqual(lines(dry));
    expect(dry.skipped.map((k) => [k.payment_id, k.reason])).toContainEqual([gone, 'its journal is not posted, or has been reversed']);
  });

  it('the REST apply caps at the posted credit and refuses a note whose journal is reversed', async () => {
    const inv = await seedInvoice(fx, { number: 'RA', date: '2026-02-07', total: 100 });
    const note = await seedPostedNote(fx, { side: 'customer', number: 'NRA', total: 50, posted: 49.99 });
    const gone = await seedPostedNote(fx, { side: 'customer', number: 'NRB', total: 50, posted: 50, reversed: true });

    const applied = await inTx(fx, () => applyCreditNoteToInvoice(fx.companyId, note, inv, fx.userId));
    expect(applied.appliedAmount).toBe(49.99);
    expect(await refusal(inTx(fx, () => applyCreditNoteToInvoice(fx.companyId, note, inv, fx.userId)),
      CreditNotePostedCreditError)).toContain(formatMoney(49.99));
    expect(await refusal(inTx(fx, () => applyCreditNoteToInvoice(fx.companyId, gone, inv, fx.userId)),
      CreditNotePostedCreditError)).toContain('reversed');
  });
  it('the back-fill reads the chain: a note reversed and re-reversed (O <- R <- R2) is planned and applied, dry run = live', async () => {
    const sup = await seedSupplier(fx, 'CNR7-CH');
    const bill = await seedBill(fx, { number: 'CH1', date: '2026-02-08', total: 500, supplierId: sup });
    const note = await seedPostedNote(fx, { side: 'supplier', number: 'NCH1', total: 60, posted: 60, counterpartyId: sup });
    const o = String(((await sql`SELECT gl_journal_entry_id FROM credit_notes WHERE id = ${note}::UUID`) as Record<string, unknown>[])[0]!.gl_journal_entry_id);
    await inTx(fx, () => reverseJournalEntry(fx.companyId, o, fx.userId));
    const r = String(((await sql`SELECT id FROM gl_journal_entries WHERE reversal_of_id = ${o}::UUID`) as Record<string, unknown>[])[0]!.id);
    await inTx(fx, () => reverseJournalEntry(fx.companyId, r, fx.userId));
    const run = { companyId: fx.companyId, userId: fx.userId, subledger: 'ap' as const, entityId: sup };
    const lines = (p: Awaited<ReturnType<typeof autoApplyUnapplied>>) =>
      p.applications.map((a) => ({ id: a.payment_id, lines: a.lines.map((l) => [l.document_id, l.amount]) }));

    const dry = await inTx(fx, () => autoApplyUnapplied({ ...run, dryRun: true }));
    const live = await inTx(fx, () => autoApplyUnapplied({ ...run, dryRun: false, idempotencyKey: 'cnr7-ch' }));

    expect(lines(dry)).toEqual([{ id: note, lines: [[bill, 60]] }]);
    expect(lines(live)).toEqual(lines(dry));
  });

  it('a decrease is never capped, but a note whose chain is OUT is refused every adjustment, like unapply', async () => {
    const bill = await seedBill(fx, { number: 'DN', date: '2026-02-09', total: 500 });
    const note = await seedPostedNote(fx, { side: 'supplier', number: 'NDN', total: 80, posted: 80 });
    await adjust({ creditNoteId: note, documentId: bill, newAmount: 80 });
    const o = String(((await sql`SELECT gl_journal_entry_id FROM credit_notes WHERE id = ${note}::UUID`) as Record<string, unknown>[])[0]!.gl_journal_entry_id);
    await inTx(fx, () => reverseJournalEntry(fx.companyId, o, fx.userId));

    for (const newAmount of [90, 30, 0]) {
      expect(await refusal(plan({ creditNoteId: note, documentId: bill, newAmount }))).toContain('reversed');
      expect(await refusal(adjust({ creditNoteId: note, documentId: bill, newAmount }))).toContain('reversed');
    }
    const [row] = (await sql`SELECT applied_amount FROM credit_notes WHERE id = ${note}::UUID`) as Record<string, unknown>[];
    expect(Number(row!.applied_amount)).toBe(80);
  });

});
