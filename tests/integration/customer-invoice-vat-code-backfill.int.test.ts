/**
 * Customer invoices, as credit notes (Hein, 2026-10-05): postCustomerInvoiceToGL
 * posts its VAT Output leg coded 'standard' — what the VAT201 already assumed
 * for an uncoded leg (`vatType ?? 'standard'`, reports/vatBoxBasis; the legacy
 * getVATReturn puts an uncoded output leg in box 1, the 'standard' box) — and
 * migration 856 backfills the legs already posted. Velocity Fibre carried 179
 * such lines Jan–Aug 2026, the last blocking pre-filing category.
 *
 * VAT201-NEUTRAL: for a company holding posted customer invoices (one
 * reversed and that reversal reversed again, one cancelled through the real
 * cancel path, which NULLs the invoice's journal link), every VAT201 field,
 * box and rate check, the lock snapshot, the legacy return and journal
 * membership are identical before and after; only the uncoded-line exception
 * changes. A non-invoice journal's uncoded leg is left alone, and a re-run
 * changes nothing.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sql } from '@/lib/neon';
import { postCustomerInvoiceToGL } from '@/modules/accounting/services/ar/customerInvoiceGlPosting';
import { cancelCustomerInvoice } from '@/modules/accounting/services/ar/customerInvoiceCancelService';
import { createJournalEntry } from '@/modules/accounting/services/gl/journalEntryCrudService';
import { postJournalEntry } from '@/modules/accounting/services/gl/journalEntryPostService';
import { reverseJournalEntry } from '@/modules/accounting/services/gl/journalEntryPostingService';
import { getLedgerVAT201 } from '@/modules/accounting/services/reports/vat201LedgerFields';
import { getVat201Report } from '@/modules/accounting/services/reports/vat201ReportService';
import { getVATReturn } from '@/modules/accounting/services/reports/vatReturnService';
import { getVatPeriodLines } from '@/modules/accounting/services/reports/vatBoxBasisQuery';
import { computeVatLockFigures } from '@/modules/accounting/services/reports/vatPeriodLockFigures';
import { getVatExceptions } from '@/modules/accounting/services/reports/vatExceptionsService';
import type { VAT201Box } from '@/modules/accounting/types/gl.report.types';
import { assertNotProductionDb } from '../helpers/assertNotProductionDb';
import { dropFixture, inTx, seedFixture, type Fixture } from './helpers/l1FifoFixture';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;
const MIGRATION = readFileSync(join(__dirname, '../../scripts/migrations/sql/856_customer_invoice_vat_line_code_backfill.sql'), 'utf8');
const PERIOD = { start: '2026-07-01', end: '2026-08-31' };
type Row = Record<string, unknown>;
let fx: Fixture;
let manualJe = '';
let invJournals: string[] = [];
let codedAtPosting: (string | null)[] = [];
let cancelLinkCleared = false;

async function postedInvoice(number: string, date: string, subtotal: number): Promise<{ id: string; je: string }> {
  const tax = Math.round(subtotal * 15) / 100;
  const rows = (await sql`
    INSERT INTO customer_invoices
      (company_id, customer_id, invoice_number, invoice_date, due_date,
       subtotal, tax_rate, tax_amount, total_amount, amount_paid, status, created_by)
    VALUES (${fx.companyId}::UUID, ${fx.customerId}::UUID, ${`${number}-${fx.tag}`},
            ${date}::DATE, ${date}::DATE, ${subtotal}, 15, ${tax}, ${subtotal + tax}, 0, 'approved',
            ${fx.userId}::UUID)
    RETURNING id`) as { id: string }[];
  const id = rows[0]!.id;
  const je = await inTx(fx, () => postCustomerInvoiceToGL(fx.companyId, id, fx.userId));
  await sql`UPDATE customer_invoices SET gl_journal_entry_id = ${je}::UUID WHERE id = ${id}::UUID`;
  return { id, je };
}

async function figures() {
  return inTx(fx, async () => {
    const { outputInvoices: _o, inputInvoices: _i, ...ledger } = await getLedgerVAT201(fx.companyId, PERIOD.start, PERIOD.end);
    const { rows: _r, ...report } = await getVat201Report(fx.companyId, PERIOD.start, PERIOD.end, { detail: 'summary' });
    const legacy = await getVATReturn(fx.companyId, PERIOD.start, PERIOD.end);
    const box = (b: VAT201Box) => ({ box: b.box, label: b.label, amount: b.amount,
      transactions: (b.transactions ?? []).map((t) => JSON.stringify(t)).sort() });
    const lock = (await computeVatLockFigures(fx.companyId, PERIOD.start, PERIOD.end)).figures;
    const members = [...new Set((await getVatPeriodLines(fx.companyId, PERIOD.start, PERIOD.end)).lines.map((l) => l.journalEntryId))].sort();
    return { ledger, report, legacy: { ...legacy, outputBoxes: legacy.outputBoxes.map(box), inputBoxes: legacy.inputBoxes.map(box) }, lock, members };
  });
}

async function vatLegCodes(journals: string[]): Promise<(string | null)[]> {
  const rows = (await sql`
    SELECT jl.vat_type FROM gl_journal_lines jl JOIN gl_accounts ga ON ga.id = jl.gl_account_id
    WHERE jl.company_id = ${fx.companyId}::UUID AND ga.account_subtype IN ('vat_input', 'vat_output')
      AND jl.journal_entry_id = ANY(${journals}::UUID[]) ORDER BY jl.journal_entry_id`) as Row[];
  return rows.map((r) => (r.vat_type == null ? null : String(r.vat_type)));
}

async function runMigration(): Promise<number> {
  const c = await fx.pool.connect();
  try {
    await c.query('BEGIN');
    const res = await c.query(MIGRATION);
    await c.query('COMMIT');
    return res.rowCount ?? 0;
  } catch (err) {
    await c.query('ROLLBACK');
    throw err;
  } finally {
    c.release();
  }
}

let before: Awaited<ReturnType<typeof figures>>;

describeIfDb('customer-invoice VAT legs coded standard (post + migration 856), VAT201-neutral', () => {
  beforeAll(async () => {
    assertNotProductionDb('This test posts journals and runs a migration.');
    fx = await seedFixture('CIV', DATABASE_URL!);
    await sql`INSERT INTO gl_accounts (company_id, account_code, account_name, account_type, account_subtype, normal_balance, is_active, is_system_account)
      VALUES (${fx.companyId}::UUID, '4000', ${`Sales ${fx.tag}`}, 'revenue', 'default_revenue', 'credit', true, true)`;
    const a = (await postedInvoice('INV-A', '2026-07-10', 1000)).je;
    const b = (await postedInvoice('INV-B', '2026-07-11', 200)).je;
    const reversed = (await postedInvoice('INV-C', '2026-07-12', 300)).je;
    const rev = (await inTx(fx, () => reverseJournalEntry(fx.companyId, reversed, fx.userId))).id;
    // A reversal of a reversal: no invoice links it, only the chain reaches it.
    const rev2 = (await inTx(fx, () => reverseJournalEntry(fx.companyId, rev, fx.userId))).id;
    // Cancelling reverses the journal and NULLs the invoice's link to it.
    const cancelled = await postedInvoice('INV-D', '2026-07-13', 400);
    const cancelRev = (await inTx(fx, () => cancelCustomerInvoice(fx.companyId, cancelled.id, fx.userId))).reversedJournalEntryId;
    const link = (await sql`SELECT gl_journal_entry_id FROM customer_invoices WHERE id = ${cancelled.id}::UUID`) as Row[];
    cancelLinkCleared = link[0]!.gl_journal_entry_id == null;
    invJournals = [a, b, reversed, rev, rev2, cancelled.je, String(cancelRev)];
    codedAtPosting = await vatLegCodes([a, b]);
    const vout = String(((await sql`SELECT id FROM gl_accounts WHERE company_id = ${fx.companyId}::UUID AND account_subtype = 'vat_output'`) as Row[])[0]!.id);
    const sales = String(((await sql`SELECT id FROM gl_accounts WHERE company_id = ${fx.companyId}::UUID AND account_subtype = 'default_revenue'`) as Row[])[0]!.id);
    manualJe = await inTx(fx, async () => {
      const je = await createJournalEntry(fx.companyId, { entryDate: '2026-07-20', description: 'manual', source: 'manual', lines: [
        { glAccountId: fx.bankAccountId, debit: 115, credit: 0, description: 'bank' },
        { glAccountId: sales, debit: 0, credit: 100, description: 'x' },
        { glAccountId: vout, debit: 0, credit: 15, description: 'VAT' },
      ] }, fx.userId);
      await postJournalEntry(fx.companyId, je.id, fx.userId);
      return je.id;
    });
    // Legacy state: invoices posted before 2026-10-05 left the VAT leg uncoded.
    await sql`UPDATE gl_journal_lines jl SET vat_type = NULL FROM gl_accounts ga
      WHERE ga.id = jl.gl_account_id AND ga.account_subtype = 'vat_output'
        AND jl.company_id = ${fx.companyId}::UUID AND jl.journal_entry_id = ANY(${invJournals}::UUID[])`;
    before = await figures();
    await runMigration();
  }, 240000);

  afterAll(async () => {
    if (!fx) return;
    await sql`UPDATE customer_invoices SET gl_journal_entry_id = NULL WHERE company_id = ${fx.companyId}::UUID`;
    await sql`DELETE FROM customer_invoices WHERE company_id = ${fx.companyId}::UUID`;
    await sql`UPDATE gl_journal_entries SET reversal_of_id = NULL WHERE company_id = ${fx.companyId}::UUID`;
    await dropFixture(fx);
  }, 120000);

  it('postCustomerInvoiceToGL codes the VAT Output leg standard, going forward', () => {
    expect(codedAtPosting).toEqual(['standard', 'standard']);
  });

  it('the fixture puts the invoice output VAT in the return', () => {
    expect(before.members).toEqual(expect.arrayContaining(invJournals));
  });

  it('every VAT201 field, box, rate check, lock figure, legacy return and membership is identical', async () => {
    expect(await figures()).toEqual(before);
  });

  it('the cancelled invoice no longer links its journal, so only its name reaches it', () => {
    expect(cancelLinkCleared).toBe(true);
  });

  it('codes exactly the invoice VAT legs — chain and cancelled pair included; the manual journal\'s stays uncoded', async () => {
    expect(await vatLegCodes(invJournals)).toEqual(invJournals.map(() => 'standard'));
    expect(await vatLegCodes([manualJe])).toEqual([null]);
    const r = await inTx(fx, () => getVatExceptions(fx.companyId, PERIOD.start, PERIOD.end));
    expect(r.uncodedGlLines.map((l) => l.journalEntryId)).toEqual([manualJe]);
  });

  it('leaves every non-VAT leg of those journals uncoded', async () => {
    const rows = (await sql`
      SELECT count(*)::INT AS n FROM gl_journal_lines jl JOIN gl_accounts ga ON ga.id = jl.gl_account_id
      WHERE jl.company_id = ${fx.companyId}::UUID AND jl.journal_entry_id = ANY(${invJournals}::UUID[])
        AND ga.account_subtype NOT IN ('vat_input', 'vat_output') AND jl.vat_type IS NOT NULL`) as Row[];
    expect(rows[0]!.n).toBe(0);
  });

  it('is re-runnable: a second run changes nothing', async () => {
    expect(await runMigration()).toBe(0);
  });
});
