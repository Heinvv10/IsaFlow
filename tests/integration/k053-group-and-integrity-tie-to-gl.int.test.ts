/**
 * K-053 round 8 (M-2) — the group consolidation and the two document integrity
 * checks read the same dated question as the control account.
 *
 * Both were fixed in round 7 and neither was reconciled: reverting either to
 * the no-predicate form left the whole K-053 suite green, so nothing in the
 * branch actually held them to the GL. They need a fixture of their own — the
 * consolidation needs a company GROUP, and the integrity checks need the
 * document shapes they were written to hunt (a null due date, and a posted
 * invoice whose journal recognises no revenue), which no other k053 fixture
 * carries.
 *
 * Every case is present in BOTH shapes, so each assertion fails in both
 * directions: a document soft-deleted through the real service, whose GL
 * reversal is dated TODAY and which must therefore be GONE as at today and
 * PRESENT before it; and one in the pre-branch shape — `deleted_at` set, the
 * approval journal never reversed — which the GL still carries and which must
 * therefore be kept at every date.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'crypto';
import type { PoolClient } from 'pg';
import { als } from '@/lib/als';
import { sql, getPoolForTests } from '@/lib/neon';
import { fmtDate } from '@/lib/fmtDate';
import { getGroupDashboardStats } from '@/modules/accounting/services/reports/consolidatedReportingService';
import { invoicesNullDueDate, invoicesWithoutRevenueLine } from '@/modules/accounting/services/gl/integrityChecks/documentChecks';
import { softDelete } from '@/modules/accounting/services/core/softDeleteService';
import { postCustomerInvoiceToGL } from '@/modules/accounting/services/ar/customerPaymentAllocationService';
import { postSupplierInvoiceToGL } from '@/modules/accounting/services/ap/supplierInvoiceWorkflowService';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;

const COMPANY = randomUUID();
const GROUP = randomUUID();
const USER = randomUUID();
const TAG = `K053GRP-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

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
/** Inside the closed period, after the documents, well before the delete. */
const AS_AT_BEFORE = shift(-90);

const SUB = 1000;
const VAT = 150;
const GROSS = SUB + VAT;
const LEG_SUB = 2000;
const LEG_VAT = 300;
const LEG_GROSS = LEG_SUB + LEG_VAT;
/** The two invoices the integrity checks hunt. */
const NODUE = 400;
const NODUE_LEGACY = 700;
const NOREV = 500;
const NOREV_LEGACY = 900;

const receivable = randomUUID();
const payable = randomUUID();
const revenue = randomUUID();
const expense = randomUUID();
const vatOutput = randomUUID();
const vatInput = randomUUID();

let customer: string;
let supplier: string;
let noDueLegacy: string;
let noRevLegacy: string;

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

/** An AR invoice, optionally without a due date. */
async function arInvoice(number: string, gross: number, dueDate: string | null): Promise<string> {
  const rows = (await sql`
    INSERT INTO customer_invoices (company_id, client_id, customer_id, invoice_number, invoice_date,
      due_date, status, subtotal, tax_rate, tax_amount, total_amount, amount_paid, created_by)
    VALUES (${COMPANY}::UUID, ${customer}::UUID, ${customer}::UUID, ${number}, ${DOC_DATE}::date,
      ${dueDate}::date, 'approved', ${gross}, 0, 0, ${gross}, 0, ${USER}::UUID)
    RETURNING id`) as { id: string }[];
  return rows[0]!.id;
}

/**
 * A posted approval journal that recognises NO revenue — the shape
 * `invoicesWithoutRevenueLine` exists to find. It balances (debtors against
 * creditors and output VAT), so it is a mis-posting rather than a broken
 * journal, which is exactly how the real ones look.
 */
async function postWithoutRevenue(invoiceId: string, number: string, gross: number): Promise<void> {
  const entry = randomUUID();
  await sql`
    INSERT INTO gl_journal_entries (id, company_id, entry_number, entry_date, description,
      status, source, created_by)
    VALUES (${entry}::UUID, ${COMPANY}::UUID, ${number}, ${DOC_DATE}::date,
      ${'No-revenue approval ' + number}, 'posted', 'manual', ${USER}::UUID)`;
  await sql`
    INSERT INTO gl_journal_lines (company_id, journal_entry_id, gl_account_id, debit, credit, description)
    VALUES (${COMPANY}::UUID, ${entry}::UUID, ${receivable}::UUID, ${gross}, 0, ${'debtor'}),
           (${COMPANY}::UUID, ${entry}::UUID, ${payable}::UUID, 0, ${gross}, ${'mis-posted credit'})`;
  await sql`UPDATE customer_invoices SET gl_journal_entry_id = ${entry}::UUID
            WHERE id = ${invoiceId}::UUID AND company_id = ${COMPANY}::UUID`;
}

/** The pre-branch delete: deleted_at set, approval journal left standing. */
async function legacyDelete(invoiceId: string): Promise<void> {
  await sql`UPDATE customer_invoices SET deleted_at = NOW()
            WHERE id = ${invoiceId}::UUID AND company_id = ${COMPANY}::UUID`;
}

function ctx(asAt: string) {
  return { companyId: COMPANY, asAt, limit: 10 };
}

describeIfDb('K-053 the group dashboard and the document integrity checks tie to the GL', () => {
  beforeAll(async () => {
    assertDisposable();
    await sql`INSERT INTO companies (id, name, registration_number)
              VALUES (${COMPANY}::UUID, ${'K053GRP ' + TAG}, ${TAG})`;
    await sql`INSERT INTO users (id, email, role, is_active)
              VALUES (${USER}, ${USER + '@test.local'}, 'admin', true)`;
    await sql`INSERT INTO company_users (company_id, user_id, role)
              VALUES (${COMPANY}::UUID, ${USER}, 'admin')`;
    await sql`INSERT INTO company_groups (id, name, holding_company_id, created_by)
              VALUES (${GROUP}::UUID, ${'K053GRP group ' + TAG}, ${COMPANY}::UUID, ${USER}::UUID)`;
    await sql`INSERT INTO company_group_members (group_id, company_id, ownership_pct, consolidation_method, is_holding)
              VALUES (${GROUP}::UUID, ${COMPANY}::UUID, 100, 'full', true)`;
    await sql`INSERT INTO fiscal_periods (company_id, period_name, period_number, fiscal_year, start_date, end_date, status)
              VALUES (${COMPANY}::UUID, ${'K053GRP prior ' + TAG}, 1, 2026, '2020-01-01', ${CLOSED_END}::date, 'open'),
                     (${COMPANY}::UUID, ${'K053GRP current ' + TAG}, 2, 2026, ${OPEN_START}::date, ${OPEN_END}::date, 'open')`;
    await account(receivable, '1120', 'Trade Debtors', 'asset', 'debit', 'receivable');
    await account(payable, '2100', 'Trade Creditors', 'liability', 'credit', 'payable');
    await account(revenue, '4000', 'Sales', 'revenue', 'credit', 'default_revenue');
    await account(expense, '5000', 'Materials', 'expense', 'debit', 'default_expense');
    await account(vatOutput, '2200', 'VAT Output', 'liability', 'credit', 'vat_output');
    await account(vatInput, '1300', 'VAT Input', 'asset', 'debit', 'vat_input');

    customer = ((await sql`INSERT INTO customers (company_id, name)
                           VALUES (${COMPANY}::UUID, ${'cust ' + TAG}) RETURNING id`) as { id: string }[])[0]!.id;
    supplier = ((await sql`INSERT INTO suppliers (company_id, name)
                           VALUES (${COMPANY}::UUID, ${'supp ' + TAG}) RETURNING id`) as { id: string }[])[0]!.id;

    // ── The group dashboard's AR and AP: one real delete, one legacy delete.
    const ar = ((await sql`
      INSERT INTO customer_invoices (company_id, client_id, customer_id, invoice_number, invoice_date,
        due_date, status, subtotal, tax_rate, tax_amount, total_amount, amount_paid, created_by)
      VALUES (${COMPANY}::UUID, ${customer}::UUID, ${customer}::UUID, ${TAG + '-AR'}, ${DOC_DATE}::date,
        ${DUE_DATE}::date, 'approved', ${SUB}, 15, ${VAT}, ${GROSS}, 0, ${USER}::UUID)
      RETURNING id`) as { id: string }[])[0]!.id;
    const arLegacy = await arInvoice(TAG + '-AR-LEGACY', LEG_GROSS, DUE_DATE);
    const ap = ((await sql`
      INSERT INTO supplier_invoices (company_id, supplier_id, invoice_number, invoice_date, due_date,
        status, subtotal, tax_amount, total_amount, amount_paid, created_by)
      VALUES (${COMPANY}::UUID, ${supplier}::UUID, ${TAG + '-AP'}, ${DOC_DATE}::date, ${DUE_DATE}::date,
        'approved', ${SUB}, ${VAT}, ${GROSS}, 0, ${USER}::UUID)
      RETURNING id`) as { id: string }[])[0]!.id;
    const apLegacy = ((await sql`
      INSERT INTO supplier_invoices (company_id, supplier_id, invoice_number, invoice_date, due_date,
        status, subtotal, tax_amount, total_amount, amount_paid, created_by)
      VALUES (${COMPANY}::UUID, ${supplier}::UUID, ${TAG + '-AP-LEGACY'}, ${DOC_DATE}::date, ${DUE_DATE}::date,
        'approved', ${LEG_SUB}, ${LEG_VAT}, ${LEG_GROSS}, 0, ${USER}::UUID)
      RETURNING id`) as { id: string }[])[0]!.id;
    await sql`
      INSERT INTO supplier_invoice_items (supplier_invoice_id, description, quantity, unit_price, tax_rate, tax_amount, line_total, gl_account_id)
      VALUES (${ap}::UUID, ${'K053 line'}, 1, ${SUB}, 15, ${VAT}, ${SUB}, ${expense}::UUID),
             (${apLegacy}::UUID, ${'K053 legacy line'}, 1, ${LEG_SUB}, 15, ${LEG_VAT}, ${LEG_SUB}, ${expense}::UUID)`;

    // ── The two integrity-check shapes, each in both delete shapes.
    const noDue = await arInvoice(TAG + '-NODUE', NODUE, null);
    noDueLegacy = await arInvoice(TAG + '-NODUE-LEGACY', NODUE_LEGACY, null);
    const noRev = await arInvoice(TAG + '-NOREV', NOREV, DUE_DATE);
    noRevLegacy = await arInvoice(TAG + '-NOREV-LEGACY', NOREV_LEGACY, DUE_DATE);

    for (const id of [ar, arLegacy, noDue, noDueLegacy]) {
      await inTx(() => postCustomerInvoiceToGL(COMPANY, id, USER));
    }
    await postWithoutRevenue(noRev, TAG + '-JE-NOREV', NOREV);
    await postWithoutRevenue(noRevLegacy, TAG + '-JE-NOREV-LEG', NOREV_LEGACY);
    await inTx(() => postSupplierInvoiceToGL(COMPANY, ap, USER));
    await inTx(() => postSupplierInvoiceToGL(COMPANY, apLegacy, USER));

    await sql`UPDATE fiscal_periods SET status = 'closed'
              WHERE company_id = ${COMPANY}::UUID AND end_date = ${CLOSED_END}::date`;

    for (const id of [ar, noDue, noRev]) {
      await inTx(() => softDelete(COMPANY, 'customer_invoice', id, USER));
    }
    await inTx(() => softDelete(COMPANY, 'supplier_invoice', ap, USER));
    for (const id of [arLegacy, noDueLegacy, noRevLegacy]) await legacyDelete(id);
    await sql`UPDATE supplier_invoices SET deleted_at = NOW()
              WHERE id = ${apLegacy}::UUID AND company_id = ${COMPANY}::UUID`;
  }, 180000);

  afterAll(async () => {
    await sql`DELETE FROM soft_delete_journal_reversals WHERE company_id = ${COMPANY}::UUID`;
    await sql`DELETE FROM company_group_members WHERE group_id = ${GROUP}::UUID`;
    await sql`DELETE FROM company_groups WHERE id = ${GROUP}::UUID`;
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

  it('the premise: three deletes reversed today, four documents left standing', async () => {
    const rows = (await sql`
      SELECT e.entry_date
      FROM soft_delete_journal_reversals r
      JOIN gl_journal_entries e ON e.id = r.reversal_journal_entry_id
      WHERE r.company_id = ${COMPANY}::UUID
    `) as { entry_date: unknown }[];
    expect(rows).toHaveLength(4);
    for (const row of rows) expect(fmtDate(new Date(String(row.entry_date)))).toBe(TODAY);
  });

  it('the group dashboard combines only what the members ledgers still carry', async () => {
    const stats = await getGroupDashboardStats(GROUP);
    // The reversed deletes are out — the GL netted them to zero today. The
    // legacy deletes are in — their approval journals still stand.
    expect(stats.combinedARTotal).toBeCloseTo(LEG_GROSS + NODUE_LEGACY + NOREV_LEGACY, 2);
    expect(stats.combinedAPTotal).toBeCloseTo(LEG_GROSS, 2);
  });

  it('the null-due-date check counts the invoices the ageing is actually missing', async () => {
    const today = await invoicesNullDueDate(ctx(TODAY));
    expect(today.count).toBe(1);
    expect(today.amount).toBeCloseTo(NODUE_LEGACY, 2);
    expect(today.sample.map((s) => s.id)).toEqual([noDueLegacy]);

    // Before the reversal the GL still carried both, so the check must too.
    const before = await invoicesNullDueDate(ctx(AS_AT_BEFORE));
    expect(before.count).toBe(2);
    expect(before.amount).toBeCloseTo(NODUE + NODUE_LEGACY, 2);
  });

  it('the no-revenue-line check counts the journals the ledger still stands on', async () => {
    const today = await invoicesWithoutRevenueLine(ctx(TODAY));
    expect(today.count).toBe(1);
    expect(today.amount).toBeCloseTo(NOREV_LEGACY, 2);
    expect(today.sample.map((s) => s.id)).toEqual([noRevLegacy]);

    const before = await invoicesWithoutRevenueLine(ctx(AS_AT_BEFORE));
    expect(before.count).toBe(2);
    expect(before.amount).toBeCloseTo(NOREV + NOREV_LEGACY, 2);
  });
});
