/**
 * GAP (Hein, 2026-09-27): `findUnpostedInvoiceVat` blocked a customer
 * invoice dated in the period when its journal was missing, unposted, or
 * reversed by period end — but NOT when its journal was posted with an
 * `entry_date` AFTER the period end. Time of supply is the invoice date, so
 * that invoice's output VAT was silently absent from the period it belongs
 * to (the ledger VAT201 reads by journal date), and the period's output VAT
 * under-declared with no exception raised.
 *
 * DECISION: CUSTOMER invoices only — a posted, unreversed journal dated
 * after the invoice's own period now blocks as `journal_dated_after_period`,
 * in the same blocking list/count as the other unposted-invoice reasons.
 * SUPPLIER bills are unchanged: a later journal date there is a legitimate
 * late input-VAT claim (s16(3)).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from '@/lib/neon';
import { createJournalEntry } from '@/modules/accounting/services/gl/journalEntryCrudService';
import { postJournalEntry } from '@/modules/accounting/services/gl/journalEntryPostService';
import { getVatExceptions } from '@/modules/accounting/services/reports/vatExceptionsService';
import { evaluateEfilingGate } from '@/modules/accounting/services/reports/sarsEfilingSubmissionService';
import { assertVatGateClear, VatGateBlockedError } from '@/modules/accounting/services/reports/vatGateOverrideService';
import { markVatDeclaredElsewhere } from '@/modules/accounting/services/reports/vatDeclaredElsewhereService';
import type { GLEntrySource, JournalLineInput } from '@/modules/accounting/types/gl.types';
import { assertNotProductionDb } from '../helpers/assertNotProductionDb';
import { dropFixture, inTx, seedBill, seedFixture, seedInvoice, type Fixture } from './helpers/l1FifoFixture';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;
type Row = Record<string, unknown>;

let fx: Fixture;
const acct: Record<string, string> = {};

async function post(date: string, source: GLEntrySource, lines: JournalLineInput[]): Promise<string> {
  return inTx(fx, async () => {
    const je = await createJournalEntry(fx.companyId, {
      entryDate: date, description: `after-period ${source}`, source, lines,
    }, fx.userId);
    await postJournalEntry(fx.companyId, je.id, fx.userId);
    return je.id;
  });
}

const report = (s: string, e: string) => inTx(fx, () => getVatExceptions(fx.companyId, s, e));
const actor = () => ({ userId: fx.userId, role: 'owner' as const });

async function acctId(subtype: string): Promise<string> {
  const rows = (await sql`
    SELECT id FROM gl_accounts WHERE company_id = ${fx.companyId}::UUID AND account_subtype = ${subtype} LIMIT 1
  `) as Row[];
  return String(rows[0]!.id);
}

async function postInvoiceJournal(invoiceId: string, date: string): Promise<string> {
  const je = await post(date, 'auto_invoice', [
    { glAccountId: acct.receivable!, debit: 1150, credit: 0, description: 'AR' },
    { glAccountId: acct.sales!, debit: 0, credit: 1000, description: 'sale', vatType: 'standard' },
    { glAccountId: acct.vat_output!, debit: 0, credit: 150, description: 'VAT', vatType: 'standard' },
  ]);
  await sql`UPDATE customer_invoices SET gl_journal_entry_id = ${je}::UUID WHERE id = ${invoiceId}::UUID AND company_id = ${fx.companyId}::UUID`;
  return je;
}

async function postBillJournal(billId: string, date: string): Promise<string> {
  const je = await post(date, 'manual', [
    { glAccountId: fx.bankAccountId, debit: 0, credit: 1150, description: 'paid' },
    { glAccountId: acct.expense!, debit: 1000, credit: 0, description: 'cost', vatType: 'standard' },
    { glAccountId: acct.vat_input!, debit: 150, credit: 0, description: 'VAT', vatType: 'standard' },
  ]);
  await sql`UPDATE supplier_invoices SET gl_journal_entry_id = ${je}::UUID WHERE id = ${billId}::UUID AND company_id = ${fx.companyId}::UUID`;
  return je;
}

describeIfDb('a customer invoice whose journal posts after its VAT period (Hein, 2026-09-27)', () => {
  beforeAll(async () => {
    assertNotProductionDb('vat-journal-after-period');
    fx = await seedFixture('VJAP', DATABASE_URL!);
    acct.receivable = await acctId('receivable');
    acct.vat_output = await acctId('vat_output');
    acct.vat_input = await acctId('vat_input');
    acct.expense = await acctId('default_expense');
    acct.sales = String(((await sql`
      INSERT INTO gl_accounts (company_id, account_code, account_name, account_type, account_subtype, normal_balance, is_active)
      VALUES (${fx.companyId}::UUID, '4000', ${`Sales ${fx.tag}`}, 'revenue', 'sales', 'credit', true) RETURNING id`) as Row[])[0]!.id);
    // A real users row: markVatDeclaredElsewhere's audit log has an FK to it.
    await sql`INSERT INTO users (id, email, role, is_active) VALUES (${fx.userId}, ${`vjap-${fx.userId}@isaflow.test`}, 'admin', true)`;
  }, 180000);

  afterAll(async () => {
    if (fx) {
      await sql`DELETE FROM audit_log WHERE company_id = ${fx.companyId}::UUID`;
      await sql`DELETE FROM users WHERE id = ${fx.userId}`;
      await dropFixture(fx);
    }
  }, 120000);

  it('1. invoice in period, journal posted after period end: blocks as journal_dated_after_period, gate refuses without override', async () => {
    const S = '2026-01-01', E = '2026-02-28';
    const inv = await seedInvoice(fx, { number: 'VJAP-1', date: '2026-02-15', total: 1150, status: 'sent' });
    await sql`UPDATE customer_invoices SET subtotal = 1000, tax_rate = 15, tax_amount = 150 WHERE id = ${inv}::UUID AND company_id = ${fx.companyId}::UUID`;
    await postInvoiceJournal(inv, '2026-03-05');

    const rep = await report(S, E);
    expect(rep.unpostedInvoiceVat.map((u) => [u.invoiceId, u.reason, u.vat])).toEqual([[inv, 'journal_dated_after_period', 150]]);
    expect(rep.totalExceptions).toBeGreaterThanOrEqual(1);
    expect(evaluateEfilingGate(rep).allowed).toBe(false);

    await expect(
      inTx(fx, () => assertVatGateClear(fx.companyId, S, E, 'vat_period_lock', null, actor(), undefined)),
    ).rejects.toBeInstanceOf(VatGateBlockedError);
    await expect(
      inTx(fx, () => assertVatGateClear(fx.companyId, S, E, 'sars_submission', null, actor(), undefined)),
    ).rejects.toBeInstanceOf(VatGateBlockedError);
  });

  it('2. same invoice is not listed for the LATER period the journal actually dates into (invoice not dated in it)', async () => {
    const S = '2026-01-01', E = '2026-02-28';
    const LATER_S = '2026-03-01', LATER_E = '2026-04-30';
    const inv = await seedInvoice(fx, { number: 'VJAP-2', date: '2026-02-16', total: 1150, status: 'sent' });
    await sql`UPDATE customer_invoices SET subtotal = 1000, tax_rate = 15, tax_amount = 150 WHERE id = ${inv}::UUID AND company_id = ${fx.companyId}::UUID`;
    await postInvoiceJournal(inv, '2026-03-06');

    const original = await report(S, E);
    expect(original.unpostedInvoiceVat.map((u) => u.invoiceId)).toContain(inv);

    const later = await report(LATER_S, LATER_E);
    expect(later.unpostedInvoiceVat.map((u) => u.invoiceId)).not.toContain(inv);
  });

  it('3. journal dated the same day / within the period: not listed', async () => {
    const S = '2026-01-01', E = '2026-02-28';
    const inv = await seedInvoice(fx, { number: 'VJAP-3', date: '2026-02-17', total: 1150, status: 'sent' });
    await sql`UPDATE customer_invoices SET subtotal = 1000, tax_rate = 15, tax_amount = 150 WHERE id = ${inv}::UUID AND company_id = ${fx.companyId}::UUID`;
    await postInvoiceJournal(inv, '2026-02-17');

    const rep = await report(S, E);
    expect(rep.unpostedInvoiceVat.map((u) => u.invoiceId)).not.toContain(inv);
  });

  it('4. supplier bill dated in period with journal dated after: NOT listed — a legitimate late input-VAT claim', async () => {
    const S = '2026-01-01', E = '2026-02-28';
    const bill = await seedBill(fx, { number: 'VJAP-4', date: '2026-02-18', total: 1150, status: 'approved' });
    await sql`UPDATE supplier_invoices SET subtotal = 1000, tax_rate = 15, tax_amount = 150 WHERE id = ${bill}::UUID AND company_id = ${fx.companyId}::UUID`;
    await postBillJournal(bill, '2026-03-07');

    const rep = await report(S, E);
    expect(rep.unpostedInvoiceVat.map((u) => u.invoiceId)).not.toContain(bill);
  });

  it('5. journal dated after period AND reversed by period end: listed once, as journal_reversed (deterministic, never both)', async () => {
    // `reverseJournalEntry` refuses to date a reversal before the entry it
    // reverses (journalEntryReversalDate.ts), so this exact combination can
    // never arise through the app itself — it is inserted directly to pin the
    // query's tie-break for whatever data DOES reach it (a historical import,
    // a direct fix, a future relaxation of that guard). The B3 `journal_reversed`
    // check (rev.entry_date <= periodEnd) wins over the new after-period check,
    // consistent with its existing priority ahead of `journal_not_posted`.
    const S = '2026-01-01', E = '2026-02-28';
    const inv = await seedInvoice(fx, { number: 'VJAP-5', date: '2026-02-19', total: 1150, status: 'sent' });
    await sql`UPDATE customer_invoices SET subtotal = 1000, tax_rate = 15, tax_amount = 150 WHERE id = ${inv}::UUID AND company_id = ${fx.companyId}::UUID`;
    const je = await postInvoiceJournal(inv, '2026-03-08');
    await sql`INSERT INTO gl_journal_entries
        (company_id, entry_date, description, source, status, reversal_of_id, created_by, posted_by, posted_at, entry_number)
      VALUES
        (${fx.companyId}::UUID, '2026-02-20'::DATE, 'direct reversal (test)', 'manual', 'posted', ${je}::UUID,
         ${fx.userId}::UUID, ${fx.userId}::UUID, NOW(), ${`REV-${fx.tag}-5`})`;

    const rep = await report(S, E);
    const rows = rep.unpostedInvoiceVat.filter((u) => u.invoiceId === inv);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.reason).toBe('journal_reversed');
  });

  it('6. HIGH fix — marked invoice with a DRAFT journal dated after the period stays declared-elsewhere ONLY, never blocking', async () => {
    // The mark-ignoring OR in the customer branch's WHERE must require
    // je.status = 'posted' before comparing entry_date — entry_date is
    // NOT NULL even on a draft, so an unguarded `je.entry_date > periodEnd`
    // overrode the mark for a document whose journal never even posted.
    const S = '2026-01-01', E = '2026-02-28';
    const inv = await seedInvoice(fx, { number: 'VJAP-6', date: '2026-02-21', total: 1150, status: 'sent' });
    await sql`UPDATE customer_invoices SET subtotal = 1000, tax_rate = 15, tax_amount = 150 WHERE id = ${inv}::UUID AND company_id = ${fx.companyId}::UUID`;
    // Mark while eligible: no journal yet.
    await inTx(fx, () => markVatDeclaredElsewhere(fx.companyId, 'customer', inv, actor(), 'Historical import'));
    // Attach a DRAFT (never posted) journal dated after the period end.
    const je = await inTx(fx, () => createJournalEntry(fx.companyId, {
      entryDate: '2026-03-09', description: 'draft after period', source: 'manual', lines: [
        { glAccountId: acct.receivable!, debit: 1150, credit: 0, description: 'AR' },
        { glAccountId: acct.sales!, debit: 0, credit: 1000, description: 'sale', vatType: 'standard' },
        { glAccountId: acct.vat_output!, debit: 0, credit: 150, description: 'VAT', vatType: 'standard' },
      ],
    }, fx.userId));
    await sql`UPDATE customer_invoices SET gl_journal_entry_id = ${je.id}::UUID WHERE id = ${inv}::UUID AND company_id = ${fx.companyId}::UUID`;

    const rep = await report(S, E);
    expect(rep.unpostedInvoiceVat.map((u) => u.invoiceId)).not.toContain(inv);
    expect(rep.declaredElsewhereVat.map((d) => d.invoiceId)).toContain(inv);
  });

  it('7. complement — marked invoice with a POSTED journal dated after the period moves to blocking ONLY', async () => {
    const S = '2026-01-01', E = '2026-02-28';
    const inv = await seedInvoice(fx, { number: 'VJAP-7', date: '2026-02-22', total: 1150, status: 'sent' });
    await sql`UPDATE customer_invoices SET subtotal = 1000, tax_rate = 15, tax_amount = 150 WHERE id = ${inv}::UUID AND company_id = ${fx.companyId}::UUID`;
    // Mark while eligible: no journal yet.
    await inTx(fx, () => markVatDeclaredElsewhere(fx.companyId, 'customer', inv, actor(), 'Historical import'));
    // Post its journal, dated after the period end — the mark must not hide
    // VAT that has now genuinely (if mis-dated) reached the GL.
    await postInvoiceJournal(inv, '2026-03-10');

    const rep = await report(S, E);
    expect(rep.unpostedInvoiceVat.map((u) => [u.invoiceId, u.reason])).toEqual(
      expect.arrayContaining([[inv, 'journal_dated_after_period']]),
    );
    expect(rep.declaredElsewhereVat.map((d) => d.invoiceId)).not.toContain(inv);
  });
});
