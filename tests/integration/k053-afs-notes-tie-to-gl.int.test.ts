/**
 * K-053 round 8 (M-2) — the annual-statement notes and the disclosure notes
 * read the same dated question as the control account.
 *
 * These four surfaces were fixed in round 7 but never reconciled: the round-7
 * mutation sweep reverted each one to the undated form and the suite stayed
 * green, so the branch's claim to "reconcile every fixed surface" did not hold
 * for them. They need a fixture of their own because their as-at date is not a
 * parameter but a FISCAL YEAR END (`getFiscalRange`, resolved from
 * `companies.financial_year_start`).
 *
 * The fixture drives the year end from BOTH sides of the delete's reversal by
 * moving `financial_year_start`: one fiscal year ends on the last day of the
 * PREVIOUS month — before the reversal, so the GL still carries the document
 * and the note must too — and one ends on the last day of the CURRENT month,
 * on or after the reversal, so both have dropped it. A note that asked the
 * undated question would report the same figure at both year ends.
 *
 * The legacy document (deleted_at set, approval journal never reversed — the
 * pre-branch population) must be KEPT at both year ends, because the GL keeps
 * it at both. That is the other direction of the same guard.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'crypto';
import type { PoolClient } from 'pg';
import { als } from '@/lib/als';
import { sql, getPoolForTests } from '@/lib/neon';
import { fmtDate } from '@/lib/fmtDate';
import { generateNote10TradeReceivables } from '@/modules/accounting/services/afs/noteGenerators/notes6to10';
import { generateNote16TradePayables } from '@/modules/accounting/services/afs/noteGenerators/notes16to20';
import { noteReceivables, notePayables } from '@/modules/accounting/services/reports/disclosureNoteGenerators';
import { postCustomerInvoiceToGL } from '@/modules/accounting/services/ar/customerPaymentAllocationService';
import { postSupplierInvoiceToGL } from '@/modules/accounting/services/ap/supplierInvoiceWorkflowService';
import { softDelete } from '@/modules/accounting/services/core/softDeleteService';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;

const COMPANY = randomUUID();
const USER = randomUUID();
const TAG = `K053AFS-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

function shift(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return fmtDate(d);
}
const TODAY = fmtDate(new Date());
const CLOSED_END = shift(-60);
const OPEN_START = shift(-59);
const OPEN_END = shift(400);
const DOC_DATE = shift(-120);
const DUE_DATE = shift(-100);

/**
 * A fiscal year whose END is the last day of a chosen month, expressed as the
 * `(financial_year_start, fiscal_year)` pair that produces it. `fiscalRangeFor`
 * ends fiscal year N on the last day of month `start - 1` in calendar year N,
 * and collapses to the calendar year when the start month is January.
 */
function fiscalYearEndingAtMonthEnd(year: number, month: number): { startMonth: number; fiscalYear: number } {
  if (month === 12) return { startMonth: 1, fiscalYear: year };
  return { startMonth: month + 1, fiscalYear: year };
}
const now = new Date();
const CUR_Y = now.getFullYear();
const CUR_M = now.getMonth() + 1;
/** Ends on the last day of last month — strictly before the delete's reversal. */
const FY_BEFORE = CUR_M === 1
  ? fiscalYearEndingAtMonthEnd(CUR_Y - 1, 12)
  : fiscalYearEndingAtMonthEnd(CUR_Y, CUR_M - 1);
/** Ends on the last day of this month — on or after the delete's reversal. */
const FY_AFTER = fiscalYearEndingAtMonthEnd(CUR_Y, CUR_M);

const SUB = 1000;
const VAT = 150;
const GROSS = SUB + VAT;
/** The legacy (pre-branch) delete, whose journal was never reversed. */
const LEG_SUB = 2000;
const LEG_VAT = 300;
const LEG_GROSS = LEG_SUB + LEG_VAT;

const receivable = randomUUID();
const payable = randomUUID();
const revenue = randomUUID();
const expense = randomUUID();
const vatOutput = randomUUID();
const vatInput = randomUUID();

let customer: string;
let supplier: string;
let arInvoice: string;
let apInvoice: string;
let legacyArInvoice: string;
let legacyApInvoice: string;

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

/** Net movement on an account across posted journals dated on or before `asAt`. */
async function controlBalance(accountId: string, asAt: string): Promise<number> {
  const rows = (await sql`
    SELECT COALESCE(SUM(l.debit - l.credit), 0) AS net
    FROM gl_journal_lines l
    JOIN gl_journal_entries e ON e.id = l.journal_entry_id
    WHERE l.company_id = ${COMPANY}::UUID AND l.gl_account_id = ${accountId}::UUID
      AND e.status = 'posted' AND e.entry_date <= ${asAt}::date
  `) as { net: string | number }[];
  return Number(rows[0]!.net);
}

/** The last day of the month a `(startMonth, fiscalYear)` pair ends on. */
function yearEndOf(fy: { startMonth: number; fiscalYear: number }): string {
  const endMonth = fy.startMonth === 1 ? 12 : fy.startMonth - 1;
  const day = new Date(Date.UTC(fy.fiscalYear, endMonth, 0)).getUTCDate();
  return `${fy.fiscalYear}-${String(endMonth).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

async function useFiscalYear(fy: { startMonth: number; fiscalYear: number }): Promise<void> {
  await sql`UPDATE companies SET financial_year_start = ${fy.startMonth}
            WHERE id = ${COMPANY}::UUID`;
}

/** The same formatter the note generators use, so only the FIGURE is asserted. */
function fmt(n: number): string {
  return new Intl.NumberFormat('en-ZA', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n);
}

async function account(id: string, code: string, name: string, type: string, normal: string, subtype: string) {
  await sql`
    INSERT INTO gl_accounts (id, company_id, account_code, account_name, account_type,
      normal_balance, level, is_active, is_system_account, account_subtype)
    VALUES (${id}::UUID, ${COMPANY}::UUID, ${code}, ${name}, ${type}, ${normal}, 3, true, true, ${subtype})`;
}

describeIfDb('K-053 the AFS notes and the disclosure notes tie to the GL at their own year end', () => {
  beforeAll(async () => {
    assertDisposable();
    await sql`INSERT INTO companies (id, name, registration_number, financial_year_start)
              VALUES (${COMPANY}::UUID, ${'K053AFS ' + TAG}, ${TAG}, ${FY_BEFORE.startMonth})`;
    await sql`INSERT INTO users (id, email, role, is_active)
              VALUES (${USER}, ${USER + '@test.local'}, 'admin', true)`;
    await sql`INSERT INTO company_users (company_id, user_id, role)
              VALUES (${COMPANY}::UUID, ${USER}, 'admin')`;
    await sql`INSERT INTO fiscal_periods (company_id, period_name, period_number, fiscal_year, start_date, end_date, status)
              VALUES (${COMPANY}::UUID, ${'K053AFS prior ' + TAG}, 1, 2026, '2020-01-01', ${CLOSED_END}::date, 'open'),
                     (${COMPANY}::UUID, ${'K053AFS current ' + TAG}, 2, 2026, ${OPEN_START}::date, ${OPEN_END}::date, 'open')`;
    await account(receivable, '1120', 'Trade Debtors', 'asset', 'debit', 'receivable');
    await account(payable, '2100', 'Trade Creditors', 'liability', 'credit', 'payable');
    await account(revenue, '4000', 'Sales', 'revenue', 'credit', 'default_revenue');
    await account(expense, '5000', 'Materials', 'expense', 'debit', 'default_expense');
    await account(vatOutput, '2200', 'VAT Output', 'liability', 'credit', 'vat_output');
    await account(vatInput, '1300', 'VAT Input', 'asset', 'debit', 'vat_input');

    customer = ((await sql`INSERT INTO customers (company_id, name, email)
                           VALUES (${COMPANY}::UUID, ${'cust ' + TAG}, ${TAG + '@test.local'})
                           RETURNING id`) as { id: string }[])[0]!.id;
    supplier = ((await sql`INSERT INTO suppliers (company_id, name)
                           VALUES (${COMPANY}::UUID, ${'supp ' + TAG}) RETURNING id`) as { id: string }[])[0]!.id;

    arInvoice = ((await sql`
      INSERT INTO customer_invoices (company_id, client_id, customer_id, invoice_number, invoice_date,
        due_date, status, subtotal, tax_rate, tax_amount, total_amount, amount_paid, created_by)
      VALUES (${COMPANY}::UUID, ${customer}::UUID, ${customer}::UUID, ${TAG + '-AR'}, ${DOC_DATE}::date,
        ${DUE_DATE}::date, 'approved', ${SUB}, 15, ${VAT}, ${GROSS}, 0, ${USER}::UUID)
      RETURNING id`) as { id: string }[])[0]!.id;
    legacyArInvoice = ((await sql`
      INSERT INTO customer_invoices (company_id, client_id, customer_id, invoice_number, invoice_date,
        due_date, status, subtotal, tax_rate, tax_amount, total_amount, amount_paid, created_by)
      VALUES (${COMPANY}::UUID, ${customer}::UUID, ${customer}::UUID, ${TAG + '-AR-LEGACY'}, ${DOC_DATE}::date,
        ${DUE_DATE}::date, 'approved', ${LEG_SUB}, 15, ${LEG_VAT}, ${LEG_GROSS}, 0, ${USER}::UUID)
      RETURNING id`) as { id: string }[])[0]!.id;
    apInvoice = ((await sql`
      INSERT INTO supplier_invoices (company_id, supplier_id, invoice_number, invoice_date, due_date,
        status, subtotal, tax_amount, total_amount, amount_paid, created_by)
      VALUES (${COMPANY}::UUID, ${supplier}::UUID, ${TAG + '-AP'}, ${DOC_DATE}::date, ${DUE_DATE}::date,
        'approved', ${SUB}, ${VAT}, ${GROSS}, 0, ${USER}::UUID)
      RETURNING id`) as { id: string }[])[0]!.id;
    legacyApInvoice = ((await sql`
      INSERT INTO supplier_invoices (company_id, supplier_id, invoice_number, invoice_date, due_date,
        status, subtotal, tax_amount, total_amount, amount_paid, created_by)
      VALUES (${COMPANY}::UUID, ${supplier}::UUID, ${TAG + '-AP-LEGACY'}, ${DOC_DATE}::date, ${DUE_DATE}::date,
        'approved', ${LEG_SUB}, ${LEG_VAT}, ${LEG_GROSS}, 0, ${USER}::UUID)
      RETURNING id`) as { id: string }[])[0]!.id;
    await sql`
      INSERT INTO supplier_invoice_items (supplier_invoice_id, description, quantity, unit_price, tax_rate, tax_amount, line_total, gl_account_id)
      VALUES (${apInvoice}::UUID, ${'K053 line'}, 1, ${SUB}, 15, ${VAT}, ${SUB}, ${expense}::UUID),
             (${legacyApInvoice}::UUID, ${'K053 legacy line'}, 1, ${LEG_SUB}, 15, ${LEG_VAT}, ${LEG_SUB}, ${expense}::UUID)`;

    await inTx(() => postCustomerInvoiceToGL(COMPANY, arInvoice, USER));
    await inTx(() => postCustomerInvoiceToGL(COMPANY, legacyArInvoice, USER));
    await inTx(() => postSupplierInvoiceToGL(COMPANY, apInvoice, USER));
    await inTx(() => postSupplierInvoiceToGL(COMPANY, legacyApInvoice, USER));
    await sql`UPDATE fiscal_periods SET status = 'closed'
              WHERE company_id = ${COMPANY}::UUID AND end_date = ${CLOSED_END}::date`;

    await inTx(() => softDelete(COMPANY, 'customer_invoice', arInvoice, USER));
    await inTx(() => softDelete(COMPANY, 'supplier_invoice', apInvoice, USER));
    await sql`UPDATE customer_invoices SET deleted_at = NOW()
              WHERE id = ${legacyArInvoice}::UUID AND company_id = ${COMPANY}::UUID`;
    await sql`UPDATE supplier_invoices SET deleted_at = NOW()
              WHERE id = ${legacyApInvoice}::UUID AND company_id = ${COMPANY}::UUID`;
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
    await sql`DELETE FROM company_users WHERE user_id = ${USER}`;
    await sql`DELETE FROM companies WHERE id = ${COMPANY}::UUID`;
    await sql`DELETE FROM users WHERE id = ${USER}`;
  }, 120000);

  it('the premise: the two year ends straddle the reversal, and the GL says so', async () => {
    const before = yearEndOf(FY_BEFORE);
    const after = yearEndOf(FY_AFTER);
    expect(before < TODAY).toBe(true);
    expect(after >= TODAY).toBe(true);
    expect(before > DUE_DATE).toBe(true);

    expect(await controlBalance(receivable, before)).toBeCloseTo(GROSS + LEG_GROSS, 2);
    expect(await controlBalance(receivable, after)).toBeCloseTo(LEG_GROSS, 2);
    expect(await controlBalance(payable, before)).toBeCloseTo(-(GROSS + LEG_GROSS), 2);
    expect(await controlBalance(payable, after)).toBeCloseTo(-LEG_GROSS, 2);
  });

  it('AFS note 10 shows the receivables the GL carried at its own year end', async () => {
    type Snapshot = { receivables: { gross_receivables: string | number | null }[] };

    await useFiscalYear(FY_BEFORE);
    const before = await generateNote10TradeReceivables(COMPANY, FY_BEFORE.fiscalYear);
    const grossBefore = Number((before.dataSnapshot as Snapshot).receivables[0]!.gross_receivables);
    expect(grossBefore).toBeCloseTo(await controlBalance(receivable, yearEndOf(FY_BEFORE)), 2);

    await useFiscalYear(FY_AFTER);
    const after = await generateNote10TradeReceivables(COMPANY, FY_AFTER.fiscalYear);
    const grossAfter = Number((after.dataSnapshot as Snapshot).receivables[0]!.gross_receivables);
    expect(grossAfter).toBeCloseTo(await controlBalance(receivable, yearEndOf(FY_AFTER)), 2);
    // The legacy delete is kept at BOTH year ends — its journal still stands.
    expect(grossAfter).toBeCloseTo(LEG_GROSS, 2);
  });

  it('AFS note 16 shows the payables the GL carried at its own year end', async () => {
    type Snapshot = { payables: { gross_payables: string | number | null }[] };

    await useFiscalYear(FY_BEFORE);
    const before = await generateNote16TradePayables(COMPANY, FY_BEFORE.fiscalYear);
    const grossBefore = Number((before.dataSnapshot as Snapshot).payables[0]!.gross_payables);
    expect(grossBefore).toBeCloseTo(-(await controlBalance(payable, yearEndOf(FY_BEFORE))), 2);

    await useFiscalYear(FY_AFTER);
    const after = await generateNote16TradePayables(COMPANY, FY_AFTER.fiscalYear);
    const grossAfter = Number((after.dataSnapshot as Snapshot).payables[0]!.gross_payables);
    expect(grossAfter).toBeCloseTo(-(await controlBalance(payable, yearEndOf(FY_AFTER))), 2);
    expect(grossAfter).toBeCloseTo(LEG_GROSS, 2);
  });

  it('the disclosure notes show the receivables and payables of their own year end', async () => {
    await useFiscalYear(FY_BEFORE);
    const recBefore = await noteReceivables(COMPANY, FY_BEFORE.fiscalYear);
    const payBefore = await notePayables(COMPANY, FY_BEFORE.fiscalYear);
    expect(recBefore.tables[0]!.rows[0]![1]).toBe(fmt(GROSS + LEG_GROSS));
    expect(payBefore.tables[0]!.rows[0]![1]).toBe(fmt(GROSS + LEG_GROSS));

    await useFiscalYear(FY_AFTER);
    const recAfter = await noteReceivables(COMPANY, FY_AFTER.fiscalYear);
    const payAfter = await notePayables(COMPANY, FY_AFTER.fiscalYear);
    expect(recAfter.tables[0]!.rows[0]![1]).toBe(fmt(LEG_GROSS));
    expect(payAfter.tables[0]!.rows[0]![1]).toBe(fmt(LEG_GROSS));
  });

});
