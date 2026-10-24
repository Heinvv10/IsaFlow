/**
 * D7 round 2 — the VAT reconciliation's GL leg leaves out a soft-deleted
 * document's WHOLE reversal chain, not only the entry the delete recorded.
 *
 * The reconciliation ties a GL leg (revenue, output and input VAT by journal
 * month) to an INVOICE leg that is deliberately undated: it keeps a deleted
 * invoice in the month it was raised, as the document-based VAT201 did when
 * that month was filed. So the REVENUE arm must carry the document's ORIGINAL
 * journal O and nothing past it. It used to drop only the reversal R recorded
 * in `soft_delete_journal_reversals`; once R was reversed by hand (R2) — or a
 * journal was reversed by hand before the delete (M) — that link landed in its
 * own month as revenue the invoice leg never had: a variance no operator can
 * reconcile away. The chain is the one the AR/AP reconciliation excludes
 * (shared/softDeleteLedgerPresence `deletedDocumentChainLinkFragment`).
 *
 * The VAT arms are compared with returns filed from the LEDGER, so they carry
 * the ledger as it stands, chain and all (round 3 — see
 * k053-vat-recon-vs-filed-return), and so does the multi-year summary, which is
 * compared with no document at all.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'crypto';
import type { PoolClient } from 'pg';
import { als } from '@/lib/als';
import { sql, getPoolForTests } from '@/lib/neon';
import { fmtDate } from '@/lib/fmtDate';
import {
  getVatReconciliation, getVatMultiYearSummary,
} from '@/modules/accounting/services/reports/vatReconciliationService';
import { postCustomerInvoiceToGL } from '@/modules/accounting/services/ar/customerPaymentAllocationService';
import { postSupplierInvoiceToGL } from '@/modules/accounting/services/ap/supplierInvoiceWorkflowService';
import { reverseJournalEntry } from '@/modules/accounting/services/gl/journalEntryPostingService';
import { softDelete } from '@/modules/accounting/services/core/softDeleteService';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { seedFiscalYears, setPeriodsEndingBy } from './helpers/fiscalYearSeed';

const describeIfDb = process.env.DATABASE_URL ? describe : describe.skip;

const COMPANY = randomUUID();
const USER = randomUUID();
const TAG = `D7VAT-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

function shift(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return fmtDate(d);
}
const CLOSED_END = shift(-60);
const OPEN_END = shift(400);
const DOC_DATE = shift(-120);
/** The hand reversals land a month on — a month the invoice leg has nothing in. */
const LATER = shift(35);
const RANGE_FROM = shift(-150);
const RANGE_TO = shift(60);

const SUB = 1000;
const VAT = 150;
/** The document whose journal is reversed by hand BEFORE its delete. */
const SUB_M = 400;
const VAT_M = 60;

const receivable = randomUUID();
const payable = randomUUID();
const revenue = randomUUID();
const expense = randomUUID();
const vatOutput = randomUUID();
const vatInput = randomUUID();

let customer: string;
let supplier: string;
const head: Record<'ar' | 'ap', string> = { ar: '', ap: '' };

async function inTx<T>(fn: () => Promise<T>): Promise<T> {
  const client: PoolClient = await getPoolForTests().connect();
  try {
    await client.query('BEGIN');
    const result = await als.run({ client, userId: USER, companyId: COMPANY, claims: {} }, fn);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

async function account(id: string, code: string, name: string, type: string, normal: string, subtype: string) {
  await sql`
    INSERT INTO gl_accounts (id, company_id, account_code, account_name, account_type,
      normal_balance, level, is_active, is_system_account, account_subtype)
    VALUES (${id}::UUID, ${COMPANY}::UUID, ${code}, ${name}, ${type}, ${normal}, 3, true, true, ${subtype})`;
}

/** An approved invoice and bill, posted into the prior period, which is then closed. */
async function postPair(suffix: string, sub: number, vat: number): Promise<{ ar: string; ap: string }> {
  await setPeriodsEndingBy(COMPANY, CLOSED_END, 'open');
  const ar = ((await sql`
    INSERT INTO customer_invoices (company_id, client_id, customer_id, invoice_number, invoice_date,
      due_date, status, subtotal, tax_rate, tax_amount, total_amount, amount_paid, created_by)
    VALUES (${COMPANY}::UUID, ${customer}::UUID, ${customer}::UUID, ${TAG + '-AR' + suffix}, ${DOC_DATE}::date,
      ${DOC_DATE}::date, 'approved', ${sub}, 15, ${vat}, ${sub + vat}, 0, ${USER}::UUID)
    RETURNING id`) as { id: string }[])[0]!.id;
  const ap = ((await sql`
    INSERT INTO supplier_invoices (company_id, supplier_id, invoice_number, invoice_date, due_date,
      status, subtotal, tax_amount, total_amount, amount_paid, created_by)
    VALUES (${COMPANY}::UUID, ${supplier}::UUID, ${TAG + '-AP' + suffix}, ${DOC_DATE}::date, ${DOC_DATE}::date,
      'approved', ${sub}, ${vat}, ${sub + vat}, 0, ${USER}::UUID)
    RETURNING id`) as { id: string }[])[0]!.id;
  await sql`
    INSERT INTO supplier_invoice_items (supplier_invoice_id, description, quantity, unit_price, tax_rate, tax_amount, line_total, gl_account_id)
    VALUES (${ap}::UUID, ${'D7 line'}, 1, ${sub}, 15, ${vat}, ${sub}, ${expense}::UUID)`;
  await inTx(() => postCustomerInvoiceToGL(COMPANY, ar, USER));
  await inTx(() => postSupplierInvoiceToGL(COMPANY, ap, USER));
  await setPeriodsEndingBy(COMPANY, CLOSED_END, 'closed');
  return { ar, ap };
}

async function journalOf(id: string): Promise<string> {
  return ((await sql`
    SELECT gl_journal_entry_id AS j FROM customer_invoices WHERE company_id = ${COMPANY}::UUID AND id = ${id}::UUID
    UNION ALL
    SELECT gl_journal_entry_id FROM supplier_invoices WHERE company_id = ${COMPANY}::UUID AND id = ${id}::UUID`) as { j: string }[])[0]!.j;
}

async function reverseHeadByHand(role: 'ar' | 'ap'): Promise<void> {
  head[role] = (await inTx(() => reverseJournalEntry(COMPANY, head[role], USER, { reversalDate: LATER }))).id;
}

/** The ledger's own revenue and VAT by month, straight from the lines. */
async function ledger(): Promise<Map<string, [number, number, number]>> {
  const rows = (await sql`
    SELECT TO_CHAR(e.entry_date, 'YYYY-MM') AS month,
      SUM(CASE WHEN a.account_type = 'revenue' THEN l.credit - l.debit ELSE 0 END)::float8 AS rev,
      SUM(CASE WHEN a.account_subtype = 'vat_output' THEN l.credit - l.debit ELSE 0 END)::float8 AS out,
      SUM(CASE WHEN a.account_subtype = 'vat_input' THEN l.debit - l.credit ELSE 0 END)::float8 AS inp
    FROM gl_journal_lines l JOIN gl_journal_entries e ON e.id = l.journal_entry_id
    JOIN gl_accounts a ON a.id = l.gl_account_id
    WHERE l.company_id = ${COMPANY}::UUID AND e.status = 'posted'
    GROUP BY 1`) as { month: string; rev: number; out: number; inp: number }[];
  return new Map(rows.map((r) => [r.month, [r.rev, r.out, r.inp]]));
}

/**
 * Revenue carries the original journals and nothing past them, in every month;
 * the VAT arms and the multi-year summary carry the ledger as it stands.
 */
async function assertArms(sub: number): Promise<void> {
  const recon = await getVatReconciliation(COMPANY, RANGE_FROM, RANGE_TO);
  const book = await ledger();
  const docMonth = DOC_DATE.slice(0, 7);
  expect(recon.months.map((m) => `${m.month} rev ${m.glRevenue} var ${m.revenueVariance}`))
    .toEqual(recon.months.map((m) => `${m.month} rev ${m.month === docMonth ? sub : 0} var 0`));
  expect(recon.months.map((m) => [m.month, m.glOutputVat, m.glInputVat]))
    .toEqual(recon.months.map((m) => [m.month, book.get(m.month)?.[1] ?? 0, book.get(m.month)?.[2] ?? 0]));
  expect(recon.totals.invoiceRevenue).toBeCloseTo(sub, 2);
  expect(recon.issues.filter((i) => i.message.includes('Revenue variance'))).toEqual([]);

  const year = (await getVatMultiYearSummary(COMPANY, 2)).find((y) => y.year === Number(DOC_DATE.slice(0, 4)));
  const sum = (k: 0 | 1 | 2) => [...book.values()].reduce((a, v) => a + v[k], 0);
  expect([year?.totalRevenue, year?.totalOutputVat, year?.totalInputVat]).toEqual([sum(0), sum(1), sum(2)]);
}

describeIfDb('D7 the VAT reconciliation\'s revenue arm excludes a deleted document\'s whole reversal chain', () => {
  beforeAll(async () => {
    assertDisposable();
    // The hand reversals and the delete must not straddle a year boundary, or
    // the multi-year summary would split them; the clock decides that, so say so.
    expect(LATER.slice(0, 4)).toBe(DOC_DATE.slice(0, 4));
    await sql`INSERT INTO companies (id, name, registration_number) VALUES (${COMPANY}::UUID, ${'D7VAT ' + TAG}, ${TAG})`;
    await seedFiscalYears(COMPANY, shift(-400), OPEN_END);
    await account(receivable, '1120', 'Trade Debtors', 'asset', 'debit', 'receivable');
    await account(payable, '2100', 'Trade Creditors', 'liability', 'credit', 'payable');
    await account(revenue, '4000', 'Sales', 'revenue', 'credit', 'default_revenue');
    await account(expense, '5000', 'Materials', 'expense', 'debit', 'default_expense');
    await account(vatOutput, '2200', 'VAT Output', 'liability', 'credit', 'vat_output');
    await account(vatInput, '1300', 'VAT Input', 'asset', 'debit', 'vat_input');
    customer = ((await sql`INSERT INTO customers (company_id, name) VALUES (${COMPANY}::UUID, ${'cust ' + TAG}) RETURNING id`) as { id: string }[])[0]!.id;
    supplier = ((await sql`INSERT INTO suppliers (company_id, name) VALUES (${COMPANY}::UUID, ${'supp ' + TAG}) RETURNING id`) as { id: string }[])[0]!.id;

    const { ar, ap } = await postPair('', SUB, VAT);
    await inTx(() => softDelete(COMPANY, 'customer_invoice', ar, USER));
    await inTx(() => softDelete(COMPANY, 'supplier_invoice', ap, USER));
    const recorded = (await sql`
      SELECT entity_type, reversal_journal_entry_id AS id FROM soft_delete_journal_reversals
      WHERE company_id = ${COMPANY}::UUID`) as { entity_type: string; id: string }[];
    head.ar = recorded.find((r) => r.entity_type === 'customer_invoice')!.id;
    head.ap = recorded.find((r) => r.entity_type === 'supplier_invoice')!.id;
  }, 180000);

  afterAll(async () => {
    await sql`DELETE FROM soft_delete_journal_reversals WHERE company_id = ${COMPANY}::UUID`;
    await sql`DELETE FROM supplier_invoice_items WHERE supplier_invoice_id IN
                (SELECT id FROM supplier_invoices WHERE company_id = ${COMPANY}::UUID)`;
    await sql`DELETE FROM customer_invoices WHERE company_id = ${COMPANY}::UUID`;
    await sql`DELETE FROM supplier_invoices WHERE company_id = ${COMPANY}::UUID`;
    await sql`DELETE FROM gl_journal_lines WHERE company_id = ${COMPANY}::UUID`;
    await sql`DELETE FROM gl_journal_entries WHERE company_id = ${COMPANY}::UUID`;
    await sql`DELETE FROM gl_account_balances WHERE gl_account_id IN
                (${receivable}::UUID, ${payable}::UUID, ${revenue}::UUID, ${expense}::UUID, ${vatOutput}::UUID, ${vatInput}::UUID)`;
    await sql`DELETE FROM gl_accounts WHERE company_id = ${COMPANY}::UUID`;
    await sql`DELETE FROM fiscal_periods WHERE company_id = ${COMPANY}::UUID`;
    await sql`DELETE FROM customers WHERE company_id = ${COMPANY}::UUID`;
    await sql`DELETE FROM suppliers WHERE company_id = ${COMPANY}::UUID`;
    await sql`DELETE FROM companies WHERE id = ${COMPANY}::UUID`;
  }, 120000);

  it('the premise: the delete alone leaves only the originals on the revenue arm', async () => {
    await assertArms(SUB);
  });

  it('the delete reversal reversed by hand a month later: no revenue in that month, the ledger\'s VAT', async () => {
    await reverseHeadByHand('ar');
    await reverseHeadByHand('ap');
    await assertArms(SUB);
  });

  it('and that hand reversal reversed again: still only the originals', async () => {
    await reverseHeadByHand('ar');
    await reverseHeadByHand('ap');
    await assertArms(SUB);
  });

  it('a journal reversed by hand BEFORE the delete is left out once the document is deleted', async () => {
    const { ar, ap } = await postPair('-M', SUB_M, VAT_M);
    const arJournal = await journalOf(ar);
    const apJournal = await journalOf(ap);
    await inTx(() => reverseJournalEntry(COMPANY, arJournal, USER, { reversalDate: LATER }));
    await inTx(() => reverseJournalEntry(COMPANY, apJournal, USER, { reversalDate: LATER }));
    await inTx(() => softDelete(COMPANY, 'customer_invoice', ar, USER));
    await inTx(() => softDelete(COMPANY, 'supplier_invoice', ap, USER));
    await assertArms(SUB + SUB_M);
  });

  it('the mirror: a LIVE invoice\'s hand reversal still shows as a variance in its month', async () => {
    const { ar, ap } = await postPair('-LIVE', SUB_M, VAT_M);
    const arJournal = await journalOf(ar);
    const apJournal = await journalOf(ap);
    await inTx(() => reverseJournalEntry(COMPANY, arJournal, USER, { reversalDate: LATER }));
    await inTx(() => reverseJournalEntry(COMPANY, apJournal, USER, { reversalDate: LATER }));

    const recon = await getVatReconciliation(COMPANY, RANGE_FROM, RANGE_TO);
    const later = recon.months.find((m) => m.month === LATER.slice(0, 7));
    expect([later?.glRevenue, later?.revenueVariance]).toEqual([-SUB_M, -SUB_M]);
  });
});
