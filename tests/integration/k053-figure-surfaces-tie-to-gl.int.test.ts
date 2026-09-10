/**
 * K-053 round 7 — EVERY surface that reports an AR/AP figure ties to the GL.
 *
 * Rounds 4-6 enumerated the surfaces by grepping for `deleted_at`. That census
 * can only find code that ALREADY had a soft-delete predicate, so every surface
 * that never had one was invisible to it — and those are exactly the ones this
 * branch breaks, because it now reverses the approval journal: the control
 * account nets to zero at the reversal date while a surface with no predicate
 * carries the document for ever.
 *
 * This test re-derives the population from the OTHER direction: the readers of
 * `customer_invoices` / `supplier_invoices` that report a balance. It pins the
 * tie in both directions, which is the whole point of the dated predicate:
 *
 *   - as at a date BEFORE the delete's reversal, every surface still carries
 *     the document, and each one equals the control account drawn to that date;
 *   - as at a date ON OR AFTER the reversal, every surface has dropped it, and
 *     so has the control account.
 *
 * A surface that answers only one of those is not fixed: dropping the document
 * unconditionally (`deleted_at IS NULL`) passes the second and fails the first.
 *
 * A SECOND document carries the other half of the proof. It is the pre-branch
 * population — soft-deleted while the delete still left the approval journal
 * standing — so the control account carries it for ever and the dated predicate
 * keeps it on every surface at every date, including today. An undated
 * `deleted_at IS NULL` drops it, and that is what makes today's figures
 * mutation-sensitive on the surfaces that take no as-at date at all.
 *
 * Fixture: the ordinary production shape — a document raised in a month that
 * has since CLOSED, so reverseJournalEntry dates the delete's reversal to TODAY
 * rather than to the document.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'crypto';
import type { PoolClient } from 'pg';
import { SignJWT } from 'jose';
import { als } from '@/lib/als';
import { sql, getPoolForTests } from '@/lib/neon';
import { fmtDate } from '@/lib/fmtDate';
import { getARAging } from '@/modules/accounting/services/ar/arAgingService';
import { getAPAging } from '@/modules/accounting/services/ap/apAgingService';
import { getDashboardKPIs } from '@/modules/accounting/services/reports/kpiDashboardService';
import { clientMetricsSnapshot } from '@/modules/bureau/services/bureauClientMetricsService';
import { getDebtorsSummary, getCollectionStats } from '@/modules/accounting/services/ar/debtorsManagerService';
import { getUnpostedSubledgerDocuments } from '@/modules/accounting/services/reconciliation/unpostedDocumentService';
import { loadSupplierInvoices } from '@/modules/accounting/services/capture/supplierStatementReconDb';
import { documentInLedgerAsAtFragmentForRowTenant } from '@/modules/accounting/services/shared/softDeleteLedgerPresence';
import { postCustomerInvoiceToGL } from '@/modules/accounting/services/ar/customerPaymentAllocationService';
import { postSupplierInvoiceToGL } from '@/modules/accounting/services/ap/supplierInvoiceWorkflowService';
import { softDelete } from '@/modules/accounting/services/core/softDeleteService';
import arAgingRoute from '../../pages/api/accounting/reports-ar-aging';
import apAgingRoute from '../../pages/api/accounting/reports-ap-aging';
import supplierStatementDetailRoute from '../../pages/api/accounting/supplier-statement-detail';
import customerStatementDetailRoute from '../../pages/api/accounting/customer-statement-detail';
import customerStatementsRoute from '../../pages/api/accounting/customer-statements';
import dashboardStatsRoute from '../../pages/api/accounting/dashboard-stats';
import { assertDisposable, request, response } from './mfa-impersonation-postgres.helpers';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;

const COMPANY = randomUUID();
/** A second tenant, so the multi-tenant roll-up fragment can be exercised. */
const OTHER_COMPANY = randomUUID();
const USER = randomUUID();
const TAG = `K053FIG-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

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
/** Inside the closed period, after the document, well before the delete. */
const AS_AT_BEFORE = shift(-90);
const KPI_FROM = shift(-365);

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
let token = '';

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

async function account(id: string, code: string, name: string, type: string, normal: string, subtype: string) {
  await sql`
    INSERT INTO gl_accounts (id, company_id, account_code, account_name, account_type,
      normal_balance, level, is_active, is_system_account, account_subtype)
    VALUES (${id}::UUID, ${COMPANY}::UUID, ${code}, ${name}, ${type}, ${normal}, 3, true, true, ${subtype})`;
}

type Envelope<T> = { data: T };
async function callRoute<T>(
  route: (req: never, res: never) => unknown | Promise<unknown>,
  query: Record<string, string>,
): Promise<T> {
  const req = request({ 'sb-access-token': token, active_company_id: COMPANY }, 'GET');
  (req as unknown as { query: unknown }).query = query;
  const result = response();
  await (route as unknown as (a: unknown, b: unknown) => Promise<void>)(req, result.res);
  expect(result.state.statusCode).toBe(200);
  return (result.state.body as Envelope<T>).data;
}

type AgingBody = { summary: { bucket: string; count: number; total: number }[]; rows: { id: string }[] };
/** Sum of the SQL bucket aggregate — a separate query from the row list, so both halves are checked. */
function bucketTotal(body: AgingBody): number {
  return body.summary.reduce((sum, b) => sum + Number(b.total), 0);
}

describeIfDb('K-053 every AR/AP figure surface ties to the GL at the same as-at date', () => {
  beforeAll(async () => {
    assertDisposable();
    await sql`INSERT INTO companies (id, name, registration_number)
              VALUES (${COMPANY}::UUID, ${'K053FIG ' + TAG}, ${TAG}),
                     (${OTHER_COMPANY}::UUID, ${'K053FIG other ' + TAG}, ${TAG + '-O'})`;
    await sql`INSERT INTO users (id, email, role, is_active)
              VALUES (${USER}, ${USER + '@test.local'}, 'admin', true)`;
    await sql`INSERT INTO company_users (company_id, user_id, role)
              VALUES (${COMPANY}::UUID, ${USER}, 'admin')`;
    await sql`INSERT INTO fiscal_periods (company_id, period_name, period_number, fiscal_year, start_date, end_date, status)
              VALUES (${COMPANY}::UUID, ${'K053FIG prior ' + TAG}, 1, 2026, '2020-01-01', ${CLOSED_END}::date, 'open'),
                     (${COMPANY}::UUID, ${'K053FIG current ' + TAG}, 2, 2026, ${OPEN_START}::date, ${OPEN_END}::date, 'open')`;
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
    apInvoice = ((await sql`
      INSERT INTO supplier_invoices (company_id, supplier_id, invoice_number, invoice_date, due_date,
        status, subtotal, tax_amount, total_amount, amount_paid, created_by)
      VALUES (${COMPANY}::UUID, ${supplier}::UUID, ${TAG + '-AP'}, ${DOC_DATE}::date, ${DUE_DATE}::date,
        'approved', ${SUB}, ${VAT}, ${GROSS}, 0, ${USER}::UUID)
      RETURNING id`) as { id: string }[])[0]!.id;
    legacyArInvoice = ((await sql`
      INSERT INTO customer_invoices (company_id, client_id, customer_id, invoice_number, invoice_date,
        due_date, status, subtotal, tax_rate, tax_amount, total_amount, amount_paid, created_by)
      VALUES (${COMPANY}::UUID, ${customer}::UUID, ${customer}::UUID, ${TAG + '-AR-LEGACY'}, ${DOC_DATE}::date,
        ${DUE_DATE}::date, 'approved', ${LEG_SUB}, 15, ${LEG_VAT}, ${LEG_GROSS}, 0, ${USER}::UUID)
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
    await inTx(() => postSupplierInvoiceToGL(COMPANY, apInvoice, USER));
    await inTx(() => postCustomerInvoiceToGL(COMPANY, legacyArInvoice, USER));
    await inTx(() => postSupplierInvoiceToGL(COMPANY, legacyApInvoice, USER));
    await sql`UPDATE fiscal_periods SET status = 'closed'
              WHERE company_id = ${COMPANY}::UUID AND end_date = ${CLOSED_END}::date`;

    token = await new SignJWT({ sub: USER, aal: 'aal2' })
      .setProtectedHeader({ alg: 'HS256' })
      .setExpirationTime('1h')
      .sign(new TextEncoder().encode(process.env.JWT_SECRET));

    await inTx(() => softDelete(COMPANY, 'customer_invoice', arInvoice, USER));
    await inTx(() => softDelete(COMPANY, 'supplier_invoice', apInvoice, USER));

    // The pre-branch shape: deleted_at set, approval journal left standing.
    // This is what softDeleteRow did on its own before the reversal existed,
    // and it is the population no historical repair can reach.
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
    await sql`DELETE FROM companies WHERE id IN (${COMPANY}::UUID, ${OTHER_COMPANY}::UUID)`;
    await sql`DELETE FROM users WHERE id = ${USER}`;
  }, 120000);

  it('the premise: the reversal lands TODAY, so the GL still carries both documents at AS_AT_BEFORE', async () => {
    const rows = (await sql`
      SELECT e.entry_date
      FROM soft_delete_journal_reversals r
      JOIN gl_journal_entries e ON e.id = r.reversal_journal_entry_id
      WHERE r.company_id = ${COMPANY}::UUID
    `) as { entry_date: unknown }[];
    expect(rows).toHaveLength(2);
    for (const row of rows) expect(fmtDate(new Date(String(row.entry_date)))).toBe(TODAY);

    expect(await controlBalance(receivable, AS_AT_BEFORE)).toBeCloseTo(GROSS + LEG_GROSS, 2);
    expect(await controlBalance(payable, AS_AT_BEFORE)).toBeCloseTo(-(GROSS + LEG_GROSS), 2);
    // Only the reversed one leaves; the legacy delete's journal still stands.
    expect(await controlBalance(receivable, TODAY)).toBeCloseTo(LEG_GROSS, 2);
    expect(await controlBalance(payable, TODAY)).toBeCloseTo(-LEG_GROSS, 2);
  });

  it('the AR Age Analysis REPORT agrees with the AR ageing service and the control account', async () => {
    const glBefore = await controlBalance(receivable, AS_AT_BEFORE);
    const serviceBefore = (await getARAging(COMPANY, AS_AT_BEFORE)).reduce((s, b) => s + b.total, 0);
    const reportBefore = await callRoute<AgingBody>(arAgingRoute, { as_at_date: AS_AT_BEFORE });
    expect(serviceBefore).toBeCloseTo(glBefore, 2);
    expect(bucketTotal(reportBefore)).toBeCloseTo(glBefore, 2);
    expect(reportBefore.rows).toHaveLength(2);

    const glAfter = await controlBalance(receivable, TODAY);
    const serviceAfter = (await getARAging(COMPANY, TODAY)).reduce((s, b) => s + b.total, 0);
    const reportAfter = await callRoute<AgingBody>(arAgingRoute, { as_at_date: TODAY });
    expect(glAfter).toBeCloseTo(LEG_GROSS, 2);
    expect(serviceAfter).toBeCloseTo(glAfter, 2);
    expect(bucketTotal(reportAfter)).toBeCloseTo(glAfter, 2);
    expect(reportAfter.rows.map((r) => r.id)).toEqual([legacyArInvoice]);
  });

  it('the AP Age Analysis REPORT agrees with the AP ageing service and the control account', async () => {
    const glBefore = -(await controlBalance(payable, AS_AT_BEFORE));
    const serviceBefore = (await getAPAging(COMPANY, AS_AT_BEFORE)).reduce((s, b) => s + b.total, 0);
    const reportBefore = await callRoute<AgingBody>(apAgingRoute, { as_at_date: AS_AT_BEFORE });
    expect(serviceBefore).toBeCloseTo(glBefore, 2);
    expect(bucketTotal(reportBefore)).toBeCloseTo(glBefore, 2);
    expect(reportBefore.rows).toHaveLength(2);

    const glAfter = -(await controlBalance(payable, TODAY));
    const reportAfter = await callRoute<AgingBody>(apAgingRoute, { as_at_date: TODAY });
    expect(glAfter).toBeCloseTo(LEG_GROSS, 2);
    expect((await getAPAging(COMPANY, TODAY)).reduce((s, b) => s + b.total, 0)).toBeCloseTo(glAfter, 2);
    expect(bucketTotal(reportAfter)).toBeCloseTo(glAfter, 2);
    expect(reportAfter.rows.map((r) => r.id)).toEqual([legacyApInvoice]);
  });

  it('the supplier statement DETAIL route carries the bill before the reversal and drops it after', async () => {
    type Body = { transactions: { reference: string }[]; summary: { totalInvoiced: number; balance: number } };
    const before = await callRoute<Body>(supplierStatementDetailRoute, {
      supplier_id: supplier, as_at_date: AS_AT_BEFORE,
    });
    expect(before.transactions.map((t) => t.reference).sort()).toEqual([TAG + '-AP', TAG + '-AP-LEGACY']);
    expect(before.summary.balance).toBeCloseTo(-(await controlBalance(payable, AS_AT_BEFORE)), 2);

    const after = await callRoute<Body>(supplierStatementDetailRoute, {
      supplier_id: supplier, as_at_date: TODAY,
    });
    // The reversed delete has gone; the legacy one the GL still carries has not.
    expect(after.transactions.map((t) => t.reference)).toEqual([TAG + '-AP-LEGACY']);
    expect(after.summary.totalInvoiced).toBeCloseTo(LEG_GROSS, 2);
    expect(after.summary.balance).toBeCloseTo(-(await controlBalance(payable, TODAY)), 2);
  });

  it('the undated AR surfaces read as at today, and today the GL is zero', async () => {
    type DetailBody = { transactions: unknown[]; summary: { totalInvoiced: number; balance: number } };
    const ar = await controlBalance(receivable, TODAY);
    const ap = -(await controlBalance(payable, TODAY));
    expect(ar).toBeCloseTo(LEG_GROSS, 2);

    const detail = await callRoute<DetailBody>(customerStatementDetailRoute, { client_id: customer });
    expect(detail.transactions).toHaveLength(1);
    expect(detail.summary.totalInvoiced).toBeCloseTo(ar, 2);

    type SummaryBody = { customers: { client_id: string; balance: number }[] };
    const summary = await callRoute<SummaryBody>(customerStatementsRoute, {});
    const mine = summary.customers.filter((c) => c.client_id === customer);
    expect(mine).toHaveLength(1);
    expect(Number(mine[0]!.balance)).toBeCloseTo(ar, 2);

    type StatsBody = { arTotal: number; apTotal: number };
    const stats = await callRoute<StatsBody>(dashboardStatsRoute, {});
    expect(stats.arTotal).toBeCloseTo(ar, 2);
    expect(stats.apTotal).toBeCloseTo(ap, 2);

    const kpis = await getDashboardKPIs(COMPANY, KPI_FROM, TODAY);
    expect(kpis.receivables.total).toBeCloseTo(ar, 2);
    expect(kpis.payables.total).toBeCloseTo(ap, 2);

    const metrics = await clientMetricsSnapshot(COMPANY);
    expect(metrics.ar).toBeCloseTo(ar, 2);
    expect(metrics.ap).toBeCloseTo(ap, 2);

    const debtors = await getDebtorsSummary(COMPANY);
    expect(debtors).toHaveLength(1);
    expect(debtors[0]!.totalOutstanding).toBeCloseTo(ar, 2);
    expect((await getCollectionStats(COMPANY)).totalOutstanding).toBeCloseTo(ar, 2);
  });

  /**
   * unpostedDocumentService is deliberately NOT dated: its control-account half
   * reads only the lines of the document's OWN journal (`jl.journal_entry_id =
   * ci.gl_journal_entry_id`), never the reversal that the delete posts as a
   * separate entry. Both halves therefore still carry the document at every
   * date and the decomposition nets to nothing — which is the right answer,
   * because the aggregate it decomposes (subledger snapshot vs control account)
   * is itself zero. Dating only the sub-ledger half would manufacture a false
   * shortfall the size of the whole document; moving the GL half with it means
   * walking the reversal chain there too, and that is a separate change.
   */
  it('the sub-ledger vs control-account reconciliation reports no shortfall on either date', async () => {
    for (const asAt of [AS_AT_BEFORE, TODAY]) {
      const ar = await getUnpostedSubledgerDocuments(COMPANY, 'ar', asAt, [receivable]);
      const ap = await getUnpostedSubledgerDocuments(COMPANY, 'ap', asAt, [payable]);
      expect(ar.filter((d) => d.id === arInvoice || d.id === legacyArInvoice)).toEqual([]);
      expect(ap.filter((d) => d.id === apInvoice || d.id === legacyApInvoice)).toEqual([]);
    }
  });

  it('the supplier statement reconciliation loader matches the period it is drawn for', async () => {
    const before = await loadSupplierInvoices(COMPANY, supplier, null, AS_AT_BEFORE);
    expect(before.map((i) => i.id).sort()).toEqual([apInvoice, legacyApInvoice].sort());
    const after = await loadSupplierInvoices(COMPANY, supplier, null, TODAY);
    expect(after.map((i) => i.id)).toEqual([legacyApInvoice]);
  });

  it('the multi-tenant roll-up fragment answers per row, scoped to the row own tenant', async () => {
    const rows = (await sql`
      SELECT ci.id, ${documentInLedgerAsAtFragmentForRowTenant('ci', AS_AT_BEFORE)} AS before_reversal,
             ${documentInLedgerAsAtFragmentForRowTenant('ci', TODAY)} AS after_reversal
      FROM customer_invoices ci
      WHERE ci.company_id = ANY(ARRAY[${COMPANY}::UUID, ${OTHER_COMPANY}::UUID])
    `) as { id: string; before_reversal: boolean; after_reversal: boolean }[];
    const byId = new Map(rows.map((r) => [r.id, r]));
    expect(rows).toHaveLength(2);
    expect(byId.get(arInvoice)!.before_reversal).toBe(true);
    expect(byId.get(arInvoice)!.after_reversal).toBe(false);
    // The legacy delete never had its journal reversed, so parity stays odd.
    expect(byId.get(legacyArInvoice)!.before_reversal).toBe(true);
    expect(byId.get(legacyArInvoice)!.after_reversal).toBe(true);
  });
});
