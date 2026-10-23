/**
 * The three things the adversarial review said this back-fill had to prove
 * against a real ledger, each one the reviewer's own probe.
 *
 *   1. DRY RUN == LIVE when a payment's journal is in no fiscal period. The
 *      guard used to exist only on the write path, so the plan promised an
 *      application the run then withheld — and every later payment against that
 *      supplier was planned against balances the phantom application had eaten.
 *   2. DRY RUN == LIVE for a draft customer receipt. It is unapplied cash and
 *      the report is right to list it, but no journal has posted, so there is
 *      nothing to apply and the plan must say so in both modes.
 *   3. A BACK-FILLED CREDIT NOTE IS CANCELLABLE. The back-fill used to write
 *      `credit_note_allocations` through a writer of its own; rows written by a
 *      second implementation are rows `cancelCreditNote` was not built to give
 *      back. It now goes through L2's `applyCreditNote`, so a note this tool
 *      applied unwinds exactly like a note approval applied.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { sql } from '@/lib/neon';
import { allocateTransaction } from '@/modules/accounting/services/bank/bankAllocationService';
import { autoApplyUnapplied } from '@/modules/accounting/services/shared/autoApplyBackfillService';
import { cancelCreditNote } from '@/modules/accounting/services/ar/creditNoteCancelService';
import {
  SKIP_NO_FISCAL_PERIOD, skipUnapplicableStatus,
} from '@/modules/accounting/services/shared/autoApplyBackfillSkips';
import { assertNotProductionDb } from '../helpers/assertNotProductionDb';
import {
  billState, dropFixture, inTx, seedBankTx, seedBill, seedFixture, seedInvoice, seedSupplier,
  type Fixture,
} from './helpers/l1FifoFixture';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;

let fx: Fixture;

/** The plan, with the lines flattened to what a human would compare. */
function shape(plan: Awaited<ReturnType<typeof autoApplyUnapplied>>) {
  return {
    applications: plan.applications.map((a) => ({
      id: a.payment_id,
      lines: a.lines.map((l) => [l.document_id, l.amount]),
      on_account: a.on_account_after,
    })),
    no_open_documents: plan.no_open_documents.map((r) => [r.payment_id, r.amount]),
    skipped: plan.skipped.map((r) => [r.payment_id, r.amount, r.reason]),
    totals: plan.totals,
  };
}

async function paymentFor(journalEntryId: string): Promise<string> {
  const rows = (await sql`
    SELECT id FROM supplier_payments
    WHERE company_id = ${fx.companyId}::UUID
      AND gl_journal_entry_id = ${journalEntryId}::UUID`) as Record<string, unknown>[];
  return String(rows[0]!.id);
}

describeIfDb('back-fill — dry run and live agree, and a back-filled note cancels', () => {
  beforeAll(async () => {
    assertNotProductionDb('This test creates and applies payments and credit notes.');
    fx = await seedFixture('BFP', DATABASE_URL!);
  }, 120000);

  afterAll(async () => {
    await sql`DELETE FROM credit_note_allocations WHERE company_id = ${fx.companyId}::UUID`;
    await sql`DELETE FROM credit_notes WHERE company_id = ${fx.companyId}::UUID`;
    await dropFixture(fx);
  }, 60000);

  it('plans and applies the SAME thing when one payment sits in no fiscal period', async () => {
    // The reviewer's probe: bills 100 and 200, P1 for 150 whose journal is in
    // no period, P2 for 500. The old code planned P1 as settling 100+50 and
    // then withheld it, so the dry run left 350 on account and the live run
    // left 200 — two different answers about the same books.
    const sup = await seedSupplier(fx, 'BFP-A');
    const b1 = await seedBill(fx, { supplierId: sup, number: 'BFPA1', date: '2026-02-01', total: 100 });
    const b2 = await seedBill(fx, { supplierId: sup, number: 'BFPA2', date: '2026-02-02', total: 200 });

    const tx1 = await seedBankTx(fx, { date: '2026-03-01', amount: -150, description: 'BFP-P1' });
    const r1 = await inTx(fx, () => allocateTransaction(
      fx.companyId, tx1, null, fx.userId, undefined, 'supplier', sup,
      undefined, undefined, undefined, undefined, undefined, { autoApply: 'none' },
    ));
    const p1 = await paymentFor(r1.journalEntryId);
    // Out of every period, the state `createJournalEntry` leaves when no fiscal
    // year covers the date. Done by hand because the fixture opens all of 2026.
    // A journal's period is derived from its date (migration 941), so nulling
    // the column alone is re-derived: the journal moves to a day no period
    // covers, and the trigger leaves it NULL.
    await sql`
      UPDATE gl_journal_entries SET entry_date = '2025-03-01'
      WHERE id = ${r1.journalEntryId}::UUID AND company_id = ${fx.companyId}::UUID`;
    const moved = (await sql`
      SELECT fiscal_period_id FROM gl_journal_entries
      WHERE id = ${r1.journalEntryId}::UUID AND company_id = ${fx.companyId}::UUID`) as Record<string, unknown>[];
    expect(moved[0]!.fiscal_period_id).toBeNull();

    const tx2 = await seedBankTx(fx, { date: '2026-03-02', amount: -500, description: 'BFP-P2' });
    const r2 = await inTx(fx, () => allocateTransaction(
      fx.companyId, tx2, null, fx.userId, undefined, 'supplier', sup,
      undefined, undefined, undefined, undefined, undefined, { autoApply: 'none' },
    ));
    const p2 = await paymentFor(r2.journalEntryId);

    const run = { companyId: fx.companyId, userId: fx.userId, subledger: 'ap' as const, entityId: sup };
    const dry = await inTx(fx, () => autoApplyUnapplied({ ...run, dryRun: true }));
    const live = await inTx(fx, () => autoApplyUnapplied({
      ...run, dryRun: false, idempotencyKey: 'bfp-period',
    }));

    // THE WHOLE ASSERTION. Not "both are reasonable" — identical.
    expect(shape(live)).toEqual(shape(dry));

    expect(dry.skipped).toEqual([expect.objectContaining({
      payment_id: p1, amount: 150, reason: SKIP_NO_FISCAL_PERIOD,
    })]);
    // P2 takes both bills WHOLE, because P1 consumed nothing on either side.
    expect(dry.applications).toEqual([expect.objectContaining({
      payment_id: p2, on_account_after: 200,
    })]);
    expect(dry.applications[0]!.lines.map((l) => [l.document_id, l.amount]))
      .toEqual([[b1, 100], [b2, 200]]);

    expect(await billState(fx, b1)).toMatchObject({ status: 'paid', amountPaid: 100 });
    expect(await billState(fx, b2)).toMatchObject({ status: 'paid', amountPaid: 200 });
    // The withheld payment is untouched, and still unapplied for a human.
    const alloc = (await sql`
      SELECT COUNT(*)::INT AS n FROM payment_allocations
      WHERE payment_id = ${p1}::UUID`) as Record<string, unknown>[];
    expect(Number(alloc[0]!.n)).toBe(0);
  }, 120000);

  it('plans and applies the SAME thing for a draft receipt beside a confirmed one', async () => {
    // The reviewer's probe: invoice 300, a DRAFT receipt of 100 and a confirmed
    // receipt of 300. The draft is in the report's population — it is unapplied
    // cash — but no journal has posted for it, so it can settle nothing.
    const inv = await seedInvoice(fx, { number: 'BFPI1', date: '2026-02-01', total: 300 });

    const draft = String(((await sql`
      INSERT INTO customer_payments
        (company_id, client_id, payment_date, total_amount, payment_method, status, created_by)
      VALUES (${fx.companyId}::UUID, ${fx.customerId}::UUID, '2026-03-01'::DATE, 100,
              'eft', 'draft', ${fx.userId}::UUID)
      RETURNING id`) as { id: string }[])[0]!.id);

    const tx = await seedBankTx(fx, { date: '2026-03-02', amount: 300, description: 'BFP-R2' });
    await inTx(fx, () => allocateTransaction(
      fx.companyId, tx, null, fx.userId, undefined, 'customer', fx.customerId,
      undefined, undefined, undefined, undefined, undefined, { autoApply: 'none' },
    ));

    const run = { companyId: fx.companyId, userId: fx.userId, subledger: 'ar' as const };
    const dry = await inTx(fx, () => autoApplyUnapplied({ ...run, dryRun: true }));
    const live = await inTx(fx, () => autoApplyUnapplied({
      ...run, dryRun: false, idempotencyKey: 'bfp-draft',
    }));

    expect(shape(live)).toEqual(shape(dry));
    expect(live.failed).toEqual([]);
    expect(dry.skipped).toEqual([expect.objectContaining({
      payment_id: draft, amount: 100, reason: skipUnapplicableStatus('draft'),
    })]);
    // The confirmed receipt takes the whole invoice — the draft consumed none
    // of it in either mode.
    expect(dry.applications).toHaveLength(1);
    expect(dry.applications[0]!.lines.map((l) => [l.document_id, l.amount])).toEqual([[inv, 300]]);

    const invoice = (await sql`
      SELECT amount_paid::float8 AS paid, status FROM customer_invoices
      WHERE id = ${inv}::UUID`) as Record<string, unknown>[];
    expect(invoice[0]).toMatchObject({ paid: 300, status: 'paid' });
  }, 120000);

  it('cancels a back-filled credit note and gives both bills their balance back', async () => {
    const sup = await seedSupplier(fx, 'BFP-CN');
    const b1 = await seedBill(fx, { supplierId: sup, number: 'BFPC1', date: '2026-02-01', total: 100 });
    const b2 = await seedBill(fx, { supplierId: sup, number: 'BFPC2', date: '2026-02-02', total: 200 });
    // Approved, unlinked and unapplied — the note this tool exists to finish.
    // A journal in an open period, because the back-fill withholds cash that
    // has none.
    const je = String(((await sql`
      INSERT INTO gl_journal_entries
        (company_id, entry_number, entry_date, description, status, created_by,
         fiscal_period_id, posted_at)
      VALUES (${fx.companyId}::UUID, ${`JE-CN-${fx.tag}`}, '2026-02-15'::DATE, 'CN', 'posted',
              ${fx.userId}::UUID,
              (SELECT id FROM fiscal_periods WHERE company_id = ${fx.companyId}::UUID LIMIT 1),
              NOW())
      RETURNING id`) as { id: string }[])[0]!.id);
    // With LINES, because cancelling the note reverses this entry and a
    // reversal of nothing is refused.
    await sql`
      INSERT INTO gl_journal_lines (company_id, journal_entry_id, gl_account_id, debit, credit)
      SELECT ${fx.companyId}::UUID, ${je}::UUID, id, 150, 0 FROM gl_accounts
      WHERE company_id = ${fx.companyId}::UUID AND account_code = '2100'`;
    await sql`
      INSERT INTO gl_journal_lines (company_id, journal_entry_id, gl_account_id, debit, credit)
      SELECT ${fx.companyId}::UUID, ${je}::UUID, id, 0, 150 FROM gl_accounts
      WHERE company_id = ${fx.companyId}::UUID AND account_code = '6000'`;
    const noteId = String(((await sql`
      INSERT INTO credit_notes
        (company_id, type, supplier_id, credit_note_number, credit_date,
         subtotal, total_amount, applied_amount, status, created_by, gl_journal_entry_id)
      VALUES (${fx.companyId}::UUID, 'supplier', ${sup}::UUID, ${`BFPCN-${fx.tag}`},
              '2026-02-15'::DATE, 150, 150, 0, 'approved', ${fx.userId}::UUID, ${je}::UUID)
      RETURNING id`) as { id: string }[])[0]!.id);

    const plan = await inTx(fx, () => autoApplyUnapplied({
      companyId: fx.companyId, userId: fx.userId, subledger: 'ap', entityId: sup,
      dryRun: false, idempotencyKey: 'bfp-cn',
    }));

    expect(plan.failed).toEqual([]);
    // 150 across TWO bills: 100 on the oldest, 50 on the next.
    expect(plan.applications[0]!.lines.map((l) => [l.document_id, l.amount]))
      .toEqual([[b1, 100], [b2, 50]]);
    expect(await billState(fx, b1)).toMatchObject({ status: 'paid', amountPaid: 100 });
    expect(await billState(fx, b2)).toMatchObject({ status: 'partially_paid', amountPaid: 50 });

    // TWO allocation rows, written by L2's writer, which is what makes the next
    // line work at all.
    const rows = (await sql`
      SELECT COUNT(*)::INT AS n FROM credit_note_allocations
      WHERE credit_note_id = ${noteId}::UUID`) as Record<string, unknown>[];
    expect(Number(rows[0]!.n)).toBe(2);

    await inTx(fx, () => cancelCreditNote(fx.companyId, noteId, fx.userId, 'test'));

    // BOTH bills restored, not just the one a link column could have named.
    expect(await billState(fx, b1)).toMatchObject({ status: 'approved', amountPaid: 0 });
    expect(await billState(fx, b2)).toMatchObject({ status: 'approved', amountPaid: 0 });
    const after = (await sql`
      SELECT cn.status, cn.applied_amount::float8 AS applied,
             (SELECT COUNT(*)::INT FROM credit_note_allocations a
               WHERE a.credit_note_id = cn.id) AS rows_left
      FROM credit_notes cn WHERE cn.id = ${noteId}::UUID`) as Record<string, unknown>[];
    // No orphan rows left behind to credit a bill twice on a later pass.
    expect(after[0]).toMatchObject({ status: 'cancelled', applied: 0, rows_left: 0 });
  }, 120000);
});
