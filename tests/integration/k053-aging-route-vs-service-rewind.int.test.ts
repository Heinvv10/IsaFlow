/**
 * K-053 round 8 (LOW) — the ageing ROUTES and the ageing SERVICES on a book
 * that can tell them apart.
 *
 * `k053-figure-surfaces-tie-to-gl` asserts route total === service total at two
 * as-at dates. That equality held only because its fixture carried no document
 * dated after the as-at date and no payments: the two implementations differ on
 * more than the soft-delete predicate, and neither difference could show.
 *
 * This fixture seeds both. Each side carries three documents:
 *   D  raised before the as-at date, soft-deleted through the real service, its
 *      GL reversal dated TODAY — the K-053 subject;
 *   S  raised before the as-at date and SETTLED after it;
 *   L  raised AFTER the as-at date.
 *
 * What that proves, and what it does not:
 *
 *   K-053 holds in both implementations. D is carried by the route AND by the
 *   service at the earlier date and dropped by BOTH at today, by exactly its
 *   own balance. That is this branch's claim and it survives the noise.
 *
 *   The two are NOT the same report otherwise, and this file pins the size of
 *   the gap rather than hiding it. `arAgingService`/`apAgingService` bound the
 *   population by `invoice_date <= as-at` and rewind `amount_paid` to the
 *   as-at date (services/shared/agingRewind); `reports-ar-aging` and
 *   `reports-ap-aging` do neither, so at the earlier date they include L and
 *   they take S's later payment off. That is a real defect in the two routes,
 *   registered as R-056; it predates this branch and is not a soft-delete
 *   question. When it is fixed the deltas below become zero and this file goes
 *   red on the two assertions that name it — which is the point.
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
import { postCustomerInvoiceToGL } from '@/modules/accounting/services/ar/customerPaymentAllocationService';
import { postSupplierInvoiceToGL } from '@/modules/accounting/services/ap/supplierInvoiceWorkflowService';
import { softDelete } from '@/modules/accounting/services/core/softDeleteService';
import arAgingRoute from '../../pages/api/accounting/reports-ar-aging';
import apAgingRoute from '../../pages/api/accounting/reports-ap-aging';
import { assertDisposable, request, response } from './mfa-impersonation-postgres.helpers';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;

const COMPANY = randomUUID();
const USER = randomUUID();
const TAG = `K053RWD-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
/** `payment_number` is varchar(30), so the payments carry a short unique tag. */
const PAYTAG = `K53-${Math.floor(Math.random() * 1e9)}`;

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
const AS_AT_BEFORE = shift(-90);
/** After the as-at date, so the service rewinds it and the routes do not. */
const PAY_DATE = shift(-70);
/** After the as-at date, so the service excludes it and the routes do not. */
const LATE_DATE = shift(-30);
const LATE_DUE = shift(-10);

const DELETED = 1150;
const SETTLED = 2300;
const PAID = 800;
const LATE = 500;

const receivable = randomUUID();
const payable = randomUUID();
const revenue = randomUUID();
const expense = randomUUID();
const vatOutput = randomUUID();
const vatInput = randomUUID();
const bank = randomUUID();

let customer: string;
let supplier: string;
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

async function account(id: string, code: string, name: string, type: string, normal: string, subtype: string) {
  await sql`
    INSERT INTO gl_accounts (id, company_id, account_code, account_name, account_type,
      normal_balance, level, is_active, is_system_account, account_subtype)
    VALUES (${id}::UUID, ${COMPANY}::UUID, ${code}, ${name}, ${type}, ${normal}, 3, true, true, ${subtype})`;
}

async function arInvoice(number: string, gross: number, date: string, due: string, paid: number): Promise<string> {
  const rows = (await sql`
    INSERT INTO customer_invoices (company_id, client_id, customer_id, invoice_number, invoice_date,
      due_date, status, subtotal, tax_rate, tax_amount, total_amount, amount_paid, created_by)
    VALUES (${COMPANY}::UUID, ${customer}::UUID, ${customer}::UUID, ${number}, ${date}::date,
      ${due}::date, 'approved', ${gross}, 0, 0, ${gross}, ${paid}, ${USER}::UUID)
    RETURNING id`) as { id: string }[];
  return rows[0]!.id;
}

async function apInvoice(number: string, gross: number, date: string, due: string, paid: number): Promise<string> {
  const rows = (await sql`
    INSERT INTO supplier_invoices (company_id, supplier_id, invoice_number, invoice_date, due_date,
      status, subtotal, tax_amount, total_amount, amount_paid, created_by)
    VALUES (${COMPANY}::UUID, ${supplier}::UUID, ${number}, ${date}::date, ${due}::date,
      'approved', ${gross}, 0, ${gross}, ${paid}, ${USER}::UUID)
    RETURNING id`) as { id: string }[];
  const id = rows[0]!.id;
  await sql`
    INSERT INTO supplier_invoice_items (supplier_invoice_id, description, quantity, unit_price, tax_rate, tax_amount, line_total, gl_account_id)
    VALUES (${id}::UUID, ${'line ' + number}, 1, ${gross}, 0, 0, ${gross}, ${expense}::UUID)`;
  return id;
}

type Envelope<T> = { data: T };
type AgingBody = { summary: { bucket: string; count: number; total: number }[] };

async function routeTotal(
  route: (req: never, res: never) => unknown | Promise<unknown>,
  asAt: string,
): Promise<number> {
  const req = request({ 'sb-access-token': token, active_company_id: COMPANY }, 'GET');
  (req as unknown as { query: unknown }).query = { as_at_date: asAt };
  const result = response();
  await (route as unknown as (a: unknown, b: unknown) => Promise<void>)(req, result.res);
  expect(result.state.statusCode).toBe(200);
  const body = (result.state.body as Envelope<AgingBody>).data;
  return body.summary.reduce((sum, b) => sum + Number(b.total), 0);
}

describeIfDb('K-053 the ageing routes and services on a book with settlements and later documents', () => {
  beforeAll(async () => {
    assertDisposable();
    await sql`INSERT INTO companies (id, name, registration_number)
              VALUES (${COMPANY}::UUID, ${'K053RWD ' + TAG}, ${TAG})`;
    await sql`INSERT INTO users (id, email, role, is_active)
              VALUES (${USER}, ${USER + '@test.local'}, 'admin', true)`;
    await sql`INSERT INTO company_users (company_id, user_id, role)
              VALUES (${COMPANY}::UUID, ${USER}, 'admin')`;
    await sql`INSERT INTO fiscal_periods (company_id, period_name, period_number, fiscal_year, start_date, end_date, status)
              VALUES (${COMPANY}::UUID, ${'K053RWD prior ' + TAG}, 1, 2026, '2020-01-01', ${CLOSED_END}::date, 'open'),
                     (${COMPANY}::UUID, ${'K053RWD current ' + TAG}, 2, 2026, ${OPEN_START}::date, ${OPEN_END}::date, 'open')`;
    await account(receivable, '1120', 'Trade Debtors', 'asset', 'debit', 'receivable');
    await account(payable, '2100', 'Trade Creditors', 'liability', 'credit', 'payable');
    await account(revenue, '4000', 'Sales', 'revenue', 'credit', 'default_revenue');
    await account(expense, '5000', 'Materials', 'expense', 'debit', 'default_expense');
    await account(vatOutput, '2200', 'VAT Output', 'liability', 'credit', 'vat_output');
    await account(vatInput, '1300', 'VAT Input', 'asset', 'debit', 'vat_input');
    await account(bank, '1010', 'Bank', 'asset', 'debit', 'bank');

    customer = ((await sql`INSERT INTO customers (company_id, name)
                           VALUES (${COMPANY}::UUID, ${'cust ' + TAG}) RETURNING id`) as { id: string }[])[0]!.id;
    supplier = ((await sql`INSERT INTO suppliers (company_id, name)
                           VALUES (${COMPANY}::UUID, ${'supp ' + TAG}) RETURNING id`) as { id: string }[])[0]!.id;

    const arDeleted = await arInvoice(TAG + '-AR-D', DELETED, DOC_DATE, DUE_DATE, 0);
    const arSettled = await arInvoice(TAG + '-AR-S', SETTLED, DOC_DATE, DUE_DATE, PAID);
    const arLate = await arInvoice(TAG + '-AR-L', LATE, LATE_DATE, LATE_DUE, 0);
    const apDeleted = await apInvoice(TAG + '-AP-D', DELETED, DOC_DATE, DUE_DATE, 0);
    const apSettled = await apInvoice(TAG + '-AP-S', SETTLED, DOC_DATE, DUE_DATE, PAID);
    const apLate = await apInvoice(TAG + '-AP-L', LATE, LATE_DATE, LATE_DUE, 0);

    for (const id of [arDeleted, arSettled, arLate]) {
      await inTx(() => postCustomerInvoiceToGL(COMPANY, id, USER));
    }
    for (const id of [apDeleted, apSettled, apLate]) {
      await inTx(() => postSupplierInvoiceToGL(COMPANY, id, USER));
    }

    // The settlements the ageing SERVICES rewind and the routes do not.
    const arPayment = ((await sql`
      INSERT INTO customer_payments (company_id, payment_number, client_id, payment_date,
        total_amount, status, created_by)
      VALUES (${COMPANY}::UUID, ${PAYTAG + '-CP'}, ${customer}::UUID, ${PAY_DATE}::date,
        ${PAID}, 'confirmed', ${USER}::UUID)
      RETURNING id`) as { id: string }[])[0]!.id;
    await sql`INSERT INTO customer_payment_allocations (payment_id, invoice_id, amount_allocated)
              VALUES (${arPayment}::UUID, ${arSettled}::UUID, ${PAID})`;
    const apPayment = ((await sql`
      INSERT INTO supplier_payments (company_id, payment_number, supplier_id, payment_date,
        total_amount, status, created_by)
      VALUES (${COMPANY}::UUID, ${PAYTAG + '-SP'}, ${supplier}::UUID, ${PAY_DATE}::date,
        ${PAID}, 'processed', ${USER}::UUID)
      RETURNING id`) as { id: string }[])[0]!.id;
    await sql`INSERT INTO payment_allocations (payment_id, invoice_id, amount_allocated)
              VALUES (${apPayment}::UUID, ${apSettled}::UUID, ${PAID})`;

    await sql`UPDATE fiscal_periods SET status = 'closed'
              WHERE company_id = ${COMPANY}::UUID AND end_date = ${CLOSED_END}::date`;

    token = await new SignJWT({ sub: USER, aal: 'aal2' })
      .setProtectedHeader({ alg: 'HS256' })
      .setExpirationTime('1h')
      .sign(new TextEncoder().encode(process.env.JWT_SECRET));

    await inTx(() => softDelete(COMPANY, 'customer_invoice', arDeleted, USER));
    await inTx(() => softDelete(COMPANY, 'supplier_invoice', apDeleted, USER));
  }, 180000);

  afterAll(async () => {
    await sql`DELETE FROM soft_delete_journal_reversals WHERE company_id = ${COMPANY}::UUID`;
    await sql`DELETE FROM customer_payment_allocations WHERE payment_id IN
                (SELECT id FROM customer_payments WHERE company_id = ${COMPANY}::UUID)`;
    await sql`DELETE FROM payment_allocations WHERE payment_id IN
                (SELECT id FROM supplier_payments WHERE company_id = ${COMPANY}::UUID)`;
    await sql`DELETE FROM customer_payments WHERE company_id = ${COMPANY}::UUID`;
    await sql`DELETE FROM supplier_payments WHERE company_id = ${COMPANY}::UUID`;
    await sql`DELETE FROM supplier_invoice_items WHERE supplier_invoice_id IN
                (SELECT id FROM supplier_invoices WHERE company_id = ${COMPANY}::UUID)`;
    await sql`DELETE FROM customer_invoices WHERE company_id = ${COMPANY}::UUID`;
    await sql`DELETE FROM supplier_invoices WHERE company_id = ${COMPANY}::UUID`;
    await sql`DELETE FROM gl_journal_lines WHERE company_id = ${COMPANY}::UUID`;
    await sql`DELETE FROM gl_journal_entries WHERE company_id = ${COMPANY}::UUID`;
    await sql`DELETE FROM gl_account_balances WHERE gl_account_id IN
                (${receivable}::UUID, ${payable}::UUID, ${revenue}::UUID, ${expense}::UUID,
                 ${vatOutput}::UUID, ${vatInput}::UUID, ${bank}::UUID)`;
    await sql`DELETE FROM gl_accounts WHERE company_id = ${COMPANY}::UUID`;
    await sql`DELETE FROM fiscal_periods WHERE company_id = ${COMPANY}::UUID`;
    await sql`DELETE FROM customers WHERE company_id = ${COMPANY}::UUID`;
    await sql`DELETE FROM suppliers WHERE company_id = ${COMPANY}::UUID`;
    await sql`DELETE FROM company_users WHERE user_id = ${USER}`;
    await sql`DELETE FROM companies WHERE id = ${COMPANY}::UUID`;
    await sql`DELETE FROM users WHERE id = ${USER}`;
  }, 120000);

  it('the premise: the two deletes reversed today, and the settlement is dated after the as-at', async () => {
    const rows = (await sql`
      SELECT e.entry_date
      FROM soft_delete_journal_reversals r
      JOIN gl_journal_entries e ON e.id = r.reversal_journal_entry_id
      WHERE r.company_id = ${COMPANY}::UUID
    `) as { entry_date: unknown }[];
    expect(rows).toHaveLength(2);
    for (const row of rows) expect(fmtDate(new Date(String(row.entry_date)))).toBe(TODAY);
    expect(PAY_DATE > AS_AT_BEFORE).toBe(true);
    expect(LATE_DATE > AS_AT_BEFORE).toBe(true);
  });

  it('both the AR service and the AR route carry the deleted invoice until its reversal', async () => {
    const svcBefore = (await getARAging(COMPANY, AS_AT_BEFORE)).reduce((s, b) => s + b.total, 0);
    const svcToday = (await getARAging(COMPANY, TODAY)).reduce((s, b) => s + b.total, 0);
    // Service: D + S at its full face value (the later payment rewound); L not
    // yet raised. Today: D gone, S net of the payment, L in.
    expect(svcBefore).toBeCloseTo(DELETED + SETTLED, 2);
    expect(svcToday).toBeCloseTo(SETTLED - PAID + LATE, 2);

    const rtBefore = await routeTotal(arAgingRoute, AS_AT_BEFORE);
    const rtToday = await routeTotal(arAgingRoute, TODAY);
    expect(rtBefore).toBeCloseTo(DELETED + (SETTLED - PAID) + LATE, 2);
    expect(rtToday).toBeCloseTo(SETTLED - PAID + LATE, 2);

    // The K-053 claim, in both implementations: the ONLY thing the reversal
    // takes out is the deleted document, and it takes out exactly its balance.
    expect(rtBefore - rtToday).toBeCloseTo(DELETED, 2);
    expect(svcBefore - svcToday).toBeCloseTo(DELETED + PAID - LATE, 2);
  });

  it('both the AP service and the AP route carry the deleted bill until its reversal', async () => {
    const svcBefore = (await getAPAging(COMPANY, AS_AT_BEFORE)).reduce((s, b) => s + b.total, 0);
    const svcToday = (await getAPAging(COMPANY, TODAY)).reduce((s, b) => s + b.total, 0);
    expect(svcBefore).toBeCloseTo(DELETED + SETTLED, 2);
    expect(svcToday).toBeCloseTo(SETTLED - PAID + LATE, 2);

    const rtBefore = await routeTotal(apAgingRoute, AS_AT_BEFORE);
    const rtToday = await routeTotal(apAgingRoute, TODAY);
    expect(rtBefore).toBeCloseTo(DELETED + (SETTLED - PAID) + LATE, 2);
    expect(rtToday).toBeCloseTo(SETTLED - PAID + LATE, 2);

    expect(rtBefore - rtToday).toBeCloseTo(DELETED, 2);
  });

  /**
   * R-056, measured. The routes and the services are not the same report at any
   * as-at date in the past: the route includes documents raised since, and
   * takes off settlements made since. Both are zero at TODAY, which is why no
   * earlier fixture could see them.
   */
  it('the route-vs-service gap at an earlier date is exactly the later document less the later payment', async () => {
    const arGap = (await routeTotal(arAgingRoute, AS_AT_BEFORE))
      - (await getARAging(COMPANY, AS_AT_BEFORE)).reduce((s, b) => s + b.total, 0);
    const apGap = (await routeTotal(apAgingRoute, AS_AT_BEFORE))
      - (await getAPAging(COMPANY, AS_AT_BEFORE)).reduce((s, b) => s + b.total, 0);
    expect(arGap).toBeCloseTo(LATE - PAID, 2);
    expect(apGap).toBeCloseTo(LATE - PAID, 2);

    // And at today, where every earlier fixture measured, the gap is zero.
    expect(await routeTotal(arAgingRoute, TODAY))
      .toBeCloseTo((await getARAging(COMPANY, TODAY)).reduce((s, b) => s + b.total, 0), 2);
    expect(await routeTotal(apAgingRoute, TODAY))
      .toBeCloseTo((await getAPAging(COMPANY, TODAY)).reduce((s, b) => s + b.total, 0), 2);
  });
});
