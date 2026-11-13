/**
 * CN-388's end state, and the invariant that refuses to record it.
 *
 * Velocity's CN-2026-00388 (supplier, R490.45, journal whole) ended with R490.44
 * recorded on the note and R490.45 credited to its bill: R0.01 counted as used
 * on the document with nothing behind it on the note. A credit-note application
 * moves the document (`amount_paid`) and the note (`applied_amount`) in two
 * separate writes, so any rule that moves one without the other — here a
 * "close enough to paid" rule that settles the last cent — leaves exactly that.
 *
 * The rule is planted as a trigger scoped to this fixture's company: when an
 * increase leaves one cent owing it counts the cent as paid (and on the way down,
 * one cent left is counted as nothing). Every application path must then REFUSE
 * — the documents' measured movement differs from the note's — and leave nothing
 * written: apply_credit_note, adjust_credit_note_application, auto_apply_unapplied,
 * approval's FIFO walk, the REST apply and unapply.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { sql } from '@/lib/neon';
import { applyCreditNoteToDocument } from '@/modules/accounting/services/shared/creditNoteDocumentApply';
import { adjustCreditNoteApplication } from '@/modules/accounting/services/shared/creditNoteApplicationAdjust';
import { unapplyCreditNote } from '@/modules/accounting/services/shared/creditNoteUnapply';
import { autoApplyUnapplied } from '@/modules/accounting/services/shared/autoApplyBackfillService';
import { createCreditNote } from '@/modules/accounting/services/ar/creditNoteService';
import { approveCreditNote } from '@/modules/accounting/services/ar/creditNoteApproveService';
import { applyCreditNoteToInvoice } from '@/modules/accounting/services/ar/creditNoteApplyToInvoice';
import { cancelCreditNote } from '@/modules/accounting/services/ar/creditNoteCancelService';
import { CreditNoteApplicationDriftError } from '@/modules/accounting/services/shared/creditNoteApplicationInvariant';
import { assertNotProductionDb } from '../helpers/assertNotProductionDb';
import {
  dropFixture, inTx, seedBill, seedFixture, seedInvoice, seedSupplier, type Fixture,
} from './helpers/l1FifoFixture';
import { seedPostedNote } from './helpers/creditNoteJournalFixture';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;

let fx: Fixture;
let fn: string;

/** Plant the cent rule on `table` for this company only, run `body`, always remove it. */
async function withCentRule<T>(table: 'supplier_invoices' | 'customer_invoices', body: () => Promise<T>): Promise<T> {
  const trigger = `${fn}_${table === 'supplier_invoices' ? 's' : 'c'}`;
  await fx.pool.query(
    `CREATE TRIGGER ${trigger} BEFORE UPDATE OF amount_paid ON ${table} FOR EACH ROW EXECUTE FUNCTION public.${fn}()`);
  try {
    return await body();
  } finally {
    await fx.pool.query(`DROP TRIGGER IF EXISTS ${trigger} ON ${table}`);
  }
}

async function paid(table: 'supplier_invoices' | 'customer_invoices', id: string): Promise<number> {
  const r = await fx.pool.query(`SELECT amount_paid FROM ${table} WHERE id = $1`, [id]);
  return Number(r.rows[0].amount_paid);
}

async function noteApplied(id: string): Promise<{ applied: number; rows: number }> {
  const r = ((await sql`
    SELECT applied_amount,
           (SELECT COALESCE(SUM(amount_allocated), 0) FROM credit_note_allocations WHERE credit_note_id = ${id}::UUID) AS rows
    FROM credit_notes WHERE id = ${id}::UUID`) as Record<string, unknown>[])[0]!;
  return { applied: Number(r.applied_amount), rows: Number(r.rows) };
}

async function refusedAsDrift(p: Promise<unknown>): Promise<void> {
  const err = await p.then(() => null, (e: unknown) => e);
  expect(err).toBeInstanceOf(Error);
  const chain = [err, (err as { cause?: unknown }).cause];
  expect(chain.some((e) => e instanceof CreditNoteApplicationDriftError)).toBe(true);
}

describeIfDb('CN-388: a document never moves apart from the note that credits it', () => {
  beforeAll(async () => {
    assertNotProductionDb('This test creates and applies credit notes.');
    fx = await seedFixture('CNI', DATABASE_URL!);
    fn = `cn388_${fx.companyId.replace(/-/g, '').slice(0, 12)}`;
    await fx.pool.query(`
      CREATE OR REPLACE FUNCTION public.${fn}() RETURNS trigger LANGUAGE plpgsql AS $f$
      BEGIN
        IF NEW.company_id = '${fx.companyId}'::uuid THEN
          IF NEW.amount_paid > COALESCE(OLD.amount_paid, 0) AND NEW.total_amount - NEW.amount_paid = 0.01 THEN
            NEW.amount_paid := NEW.total_amount;
          ELSIF NEW.amount_paid < COALESCE(OLD.amount_paid, 0) AND NEW.amount_paid = 0.01 THEN
            NEW.amount_paid := 0;
          END IF;
        END IF;
        RETURN NEW;
      END $f$`);
    await sql`
      INSERT INTO gl_accounts (company_id, account_code, account_name, account_type, account_subtype,
                               normal_balance, is_active, is_system_account)
      VALUES (${fx.companyId}::UUID, '4000', ${`Revenue ${fx.tag}`}, 'revenue', 'default_revenue', 'credit', true, true)`;
  }, 120000);

  afterAll(async () => {
    await fx.pool.query(`DROP FUNCTION IF EXISTS public.${fn}() CASCADE`);
    await sql`DELETE FROM credit_note_allocations WHERE company_id = ${fx.companyId}::UUID`;
    await sql`DELETE FROM credit_notes WHERE company_id = ${fx.companyId}::UUID`;
    await dropFixture(fx);
  }, 120000);

  it('apply_credit_note: R490.44 onto a R490.45 bill whose last cent is counted as paid is refused; nothing is written', async () => {
    const bill = await seedBill(fx, { number: 'A388', date: '2026-02-01', total: 490.45 });
    const note = await seedPostedNote(fx, { side: 'supplier', number: 'NA', total: 490.44, posted: 490.44 });

    await withCentRule('supplier_invoices', () => refusedAsDrift(
      inTx(fx, () => applyCreditNoteToDocument(fx.companyId, { creditNoteId: note, invoiceId: bill }, fx.userId))));

    expect(await paid('supplier_invoices', bill)).toBe(0);
    expect(await noteApplied(note)).toEqual({ applied: 0, rows: 0 });
  });

  it('adjust_credit_note_application: the same for an increase', async () => {
    const bill = await seedBill(fx, { number: 'B388', date: '2026-02-02', total: 490.45 });
    const note = await seedPostedNote(fx, { side: 'supplier', number: 'NB', total: 490.45, posted: 490.45 });

    await withCentRule('supplier_invoices', () => refusedAsDrift(inTx(fx, () => adjustCreditNoteApplication(
      fx.companyId, { creditNoteId: note, documentId: bill, newAmount: 490.44 }, fx.userId))));

    expect(await paid('supplier_invoices', bill)).toBe(0);
    expect(await noteApplied(note)).toEqual({ applied: 0, rows: 0 });
  });

  it('auto_apply_unapplied: the source fails and is rolled back to its savepoint', async () => {
    const sup = await seedSupplier(fx, 'CNI-BF');
    const bill = await seedBill(fx, { number: 'C388', date: '2026-02-03', total: 490.45, supplierId: sup });
    const note = await seedPostedNote(fx, { side: 'supplier', number: 'NC', total: 490.44, posted: 490.44, counterpartyId: sup });

    const run = await withCentRule('supplier_invoices', () => inTx(fx, () => autoApplyUnapplied({
      companyId: fx.companyId, userId: fx.userId, subledger: 'ap', entityId: sup, dryRun: false, idempotencyKey: 'cni-1',
    })));

    expect(run.failed.map((f) => f.payment_id)).toEqual([note]);
    expect(await paid('supplier_invoices', bill)).toBe(0);
    expect(await noteApplied(note)).toEqual({ applied: 0, rows: 0 });
  });

  it('approval (FIFO walk): the approval is refused whole — no journal, no application', async () => {
    const sup = await seedSupplier(fx, 'CNI-AP');
    const bill = await seedBill(fx, { number: 'D388', date: '2026-02-04', total: 490.45, supplierId: sup });
    const created = await inTx(fx, () => createCreditNote(fx.companyId, {
      type: 'supplier', supplierId: sup, creditDate: '2026-03-01', subtotal: 490.44, taxRate: 0,
    }, fx.userId));

    await withCentRule('supplier_invoices', () => refusedAsDrift(
      inTx(fx, () => approveCreditNote(fx.companyId, created.id, fx.userId))));

    expect(await paid('supplier_invoices', bill)).toBe(0);
    const n = ((await sql`SELECT status, gl_journal_entry_id FROM credit_notes WHERE id = ${created.id}::UUID`) as Record<string, unknown>[])[0]!;
    expect(n).toEqual({ status: 'draft', gl_journal_entry_id: null });
  });

  it('REST apply (customer): refused, so the route answers 5xx and rolls back', async () => {
    const inv = await seedInvoice(fx, { number: 'E388', date: '2026-02-05', total: 50 });
    const note = await seedPostedNote(fx, { side: 'customer', number: 'NE', total: 49.99, posted: 49.99 });

    await withCentRule('customer_invoices', () => refusedAsDrift(
      inTx(fx, () => applyCreditNoteToInvoice(fx.companyId, note, inv, fx.userId))));

    expect(await paid('customer_invoices', inv)).toBe(0);
    expect(await noteApplied(note)).toEqual({ applied: 0, rows: 0 });
  });

  it('unapply: a take-back whose last cent is counted as nothing is refused; the application stands', async () => {
    const bill = await seedBill(fx, { number: 'F388', date: '2026-02-06', total: 500 });
    // A cent already settled on the bill by something else, so the take-back leaves exactly R0.01.
    await sql`UPDATE supplier_invoices SET amount_paid = 0.01 WHERE id = ${bill}::UUID`;
    const note = await seedPostedNote(fx, { side: 'supplier', number: 'NF', total: 100, posted: 100 });
    await inTx(fx, () => adjustCreditNoteApplication(
      fx.companyId, { creditNoteId: note, documentId: bill, newAmount: 100 }, fx.userId));

    await withCentRule('supplier_invoices', () => refusedAsDrift(
      inTx(fx, () => unapplyCreditNote(fx.companyId, { creditNoteId: note }, fx.userId))));

    expect(await paid('supplier_invoices', bill)).toBe(100.01);
    expect(await noteApplied(note)).toEqual({ applied: 100, rows: 100 });
  });
  it('cancel: a give-back whose last cent is counted as nothing is refused; the note stays approved and applied', async () => {
    const sup = await seedSupplier(fx, 'CNI-CX');
    const bill = await seedBill(fx, { number: 'H388', date: '2026-02-08', total: 500, supplierId: sup });
    await sql`UPDATE supplier_invoices SET amount_paid = 0.01 WHERE id = ${bill}::UUID`;
    const created = await inTx(fx, () => createCreditNote(fx.companyId, {
      type: 'supplier', supplierId: sup, creditDate: '2026-03-01', subtotal: 100, taxRate: 0,
    }, fx.userId));
    await inTx(fx, () => approveCreditNote(fx.companyId, created.id, fx.userId, { autoApply: 'none' }));
    await inTx(fx, () => adjustCreditNoteApplication(
      fx.companyId, { creditNoteId: created.id, documentId: bill, newAmount: 100 }, fx.userId));

    await withCentRule('supplier_invoices', () => refusedAsDrift(
      inTx(fx, () => cancelCreditNote(fx.companyId, created.id, fx.userId))));

    expect(await paid('supplier_invoices', bill)).toBe(100.01);
    expect(await noteApplied(created.id)).toEqual({ applied: 100, rows: 100 });
  });
});
