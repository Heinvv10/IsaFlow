/**
 * R-059 round 2 (MEDIUM-2) — the period sales/purchase reports state their
 * received/outstanding figures AS AT the period end.
 *
 * sales-by-customer, purchases-by-supplier, getCustomerReport and
 * getSupplierReport said their outstanding "agrees with the ageing at that
 * date" while reading TODAY's amount_paid, so a past period netted off
 * settlement made after it. They are period-activity reports (only documents
 * raised in [from, to]), so they can never equal the ageing's TOTAL; what they
 * now equal is the ageing at "to" for the documents they cover.
 *
 * Each side: S 1000 raised on RAISED (in the period), paid in full on PAID
 * (after the period end), status 'paid' today; D a draft of 200 raised in the
 * period. The ageing at the period end is exactly S: 1000.
 *
 *   to = END   (RAISED < END < PAID): total 1000, paid 0,    outstanding 1000
 *   to = TODAY                      : total 1000, paid 1000, outstanding 0
 *
 * Before the fix the two services gave paid 1000 / outstanding 0 at to = END,
 * and the two routes also counted the draft — total 1200, paid 1000,
 * outstanding 200 at every date (measured by restoring the pre-branch files).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'crypto';
import { SignJWT } from 'jose';
import { sql } from '@/lib/neon';
import { fmtDate } from '@/lib/fmtDate';
import { getARAging } from '@/modules/accounting/services/ar/arAgingService';
import { getAPAging } from '@/modules/accounting/services/ap/apAgingService';
import { getCustomerReport, getSupplierReport } from '@/modules/accounting/services/reports/transactionReportingService';
import salesByCustomer from '../../pages/api/accounting/reports/sales-by-customer';
import purchasesBySupplier from '../../pages/api/accounting/reports/purchases-by-supplier';
import { assertDisposable, request, response } from './mfa-impersonation-postgres.helpers';

const describeIfDb = process.env.DATABASE_URL ? describe : describe.skip;

const COMPANY = randomUUID();
const USER = randomUUID();
const TAG = `R059P-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const PAYTAG = `R59P-${Math.floor(Math.random() * 1e9)}`;

function shift(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return fmtDate(d);
}
const TODAY = fmtDate(new Date());
const FROM = shift(-110);
const RAISED = shift(-100);
const END = shift(-70);
const PAID = shift(-50);

let customer = '';
let supplier = '';
let token = '';

type Line = { total: number; paid: number; outstanding: number };

async function callRoute(route: unknown, to: string): Promise<Record<string, number>[]> {
  const req = request({ 'sb-access-token': token, active_company_id: COMPANY }, 'GET');
  (req as unknown as { query: unknown }).query = { from: FROM, to };
  const result = response();
  await (route as (a: unknown, b: unknown) => Promise<void>)(req, result.res);
  expect(result.state.statusCode).toBe(200);
  return (result.state.body as { data: Record<string, number>[] }).data;
}

const SIDES = [
  {
    name: 'sales-by-customer',
    read: async (to: string): Promise<Line> => {
      const [r] = await callRoute(salesByCustomer, to);
      return { total: Number(r!.totalSales), paid: Number(r!.paymentsReceived), outstanding: Number(r!.outstanding) };
    },
    ageing: async (to: string) => (await getARAging(COMPANY, to)).reduce((s, b) => s + b.total, 0),
  },
  {
    name: 'purchases-by-supplier',
    read: async (to: string): Promise<Line> => {
      const [r] = await callRoute(purchasesBySupplier, to);
      return { total: Number(r!.totalPurchases), paid: Number(r!.paymentsMade), outstanding: Number(r!.outstanding) };
    },
    ageing: async (to: string) => (await getAPAging(COMPANY, to)).reduce((s, b) => s + b.total, 0),
  },
  {
    name: 'getCustomerReport',
    read: async (to: string): Promise<Line> => {
      const [r] = await getCustomerReport(COMPANY, FROM, to);
      return { total: r!.totalInvoiced, paid: r!.totalPaid, outstanding: r!.balance };
    },
    ageing: async (to: string) => (await getARAging(COMPANY, to)).reduce((s, b) => s + b.total, 0),
  },
  {
    name: 'getSupplierReport',
    read: async (to: string): Promise<Line> => {
      const [r] = await getSupplierReport(COMPANY, FROM, to);
      return { total: r!.totalInvoiced, paid: r!.totalPaid, outstanding: r!.balance };
    },
    ageing: async (to: string) => (await getAPAging(COMPANY, to)).reduce((s, b) => s + b.total, 0),
  },
] as const;

describeIfDb('R-059 period sales/purchase reports are as at their period end', () => {
  beforeAll(async () => {
    assertDisposable();
    await sql`INSERT INTO companies (id, name, registration_number) VALUES (${COMPANY}::UUID, ${'R059P ' + TAG}, ${TAG})`;
    await sql`INSERT INTO users (id, email, role, is_active) VALUES (${USER}, ${USER + '@test.local'}, 'admin', true)`;
    await sql`INSERT INTO company_users (company_id, user_id, role) VALUES (${COMPANY}::UUID, ${USER}, 'admin')`;
    customer = ((await sql`INSERT INTO customers (company_id, name) VALUES (${COMPANY}::UUID, ${'cust ' + TAG}) RETURNING id`) as { id: string }[])[0]!.id;
    supplier = ((await sql`INSERT INTO suppliers (company_id, name) VALUES (${COMPANY}::UUID, ${'supp ' + TAG}) RETURNING id`) as { id: string }[])[0]!.id;

    const [arS] = (await sql`
      INSERT INTO customer_invoices (company_id, client_id, customer_id, invoice_number, invoice_date,
        due_date, status, subtotal, tax_rate, tax_amount, total_amount, amount_paid, created_by)
      VALUES (${COMPANY}::UUID, ${customer}::UUID, ${customer}::UUID, ${TAG + '-AR-S'}, ${RAISED}::date,
        ${RAISED}::date, 'paid', 1000, 0, 0, 1000, 1000, ${USER}::UUID),
             (${COMPANY}::UUID, ${customer}::UUID, ${customer}::UUID, ${TAG + '-AR-D'}, ${RAISED}::date,
        ${RAISED}::date, 'draft', 200, 0, 0, 200, 0, ${USER}::UUID)
      RETURNING id`) as { id: string }[];
    const [cp] = (await sql`
      INSERT INTO customer_payments (company_id, payment_number, client_id, payment_date, total_amount, status, created_by)
      VALUES (${COMPANY}::UUID, ${PAYTAG + 'C'}, ${customer}::UUID, ${PAID}::date, 1000, 'confirmed', ${USER}::UUID)
      RETURNING id`) as { id: string }[];
    await sql`INSERT INTO customer_payment_allocations (payment_id, invoice_id, amount_allocated)
              VALUES (${cp!.id}::UUID, ${arS!.id}::UUID, 1000)`;

    const [apS] = (await sql`
      INSERT INTO supplier_invoices (company_id, supplier_id, invoice_number, invoice_date, due_date,
        status, subtotal, tax_amount, total_amount, amount_paid, created_by)
      VALUES (${COMPANY}::UUID, ${supplier}::UUID, ${TAG + '-AP-S'}, ${RAISED}::date, ${RAISED}::date,
        'paid', 1000, 0, 1000, 1000, ${USER}::UUID),
             (${COMPANY}::UUID, ${supplier}::UUID, ${TAG + '-AP-D'}, ${RAISED}::date, ${RAISED}::date,
        'draft', 200, 0, 200, 0, ${USER}::UUID)
      RETURNING id`) as { id: string }[];
    const [sp] = (await sql`
      INSERT INTO supplier_payments (company_id, payment_number, supplier_id, payment_date, total_amount, status, created_by)
      VALUES (${COMPANY}::UUID, ${PAYTAG + 'S'}, ${supplier}::UUID, ${PAID}::date, 1000, 'processed', ${USER}::UUID)
      RETURNING id`) as { id: string }[];
    await sql`INSERT INTO payment_allocations (payment_id, invoice_id, amount_allocated)
              VALUES (${sp!.id}::UUID, ${apS!.id}::UUID, 1000)`;

    token = await new SignJWT({ sub: USER, aal: 'aal2' })
      .setProtectedHeader({ alg: 'HS256' }).setExpirationTime('1h')
      .sign(new TextEncoder().encode(process.env.JWT_SECRET));
  }, 120000);

  afterAll(async () => {
    await sql`DELETE FROM customer_payment_allocations WHERE payment_id IN (SELECT id FROM customer_payments WHERE company_id = ${COMPANY}::UUID)`;
    await sql`DELETE FROM payment_allocations WHERE payment_id IN (SELECT id FROM supplier_payments WHERE company_id = ${COMPANY}::UUID)`;
    await sql`DELETE FROM customer_payments WHERE company_id = ${COMPANY}::UUID`;
    await sql`DELETE FROM supplier_payments WHERE company_id = ${COMPANY}::UUID`;
    await sql`DELETE FROM customer_invoices WHERE company_id = ${COMPANY}::UUID`;
    await sql`DELETE FROM supplier_invoices WHERE company_id = ${COMPANY}::UUID`;
    await sql`DELETE FROM customers WHERE company_id = ${COMPANY}::UUID`;
    await sql`DELETE FROM suppliers WHERE company_id = ${COMPANY}::UUID`;
    await sql`DELETE FROM company_users WHERE user_id = ${USER}`;
    await sql`DELETE FROM companies WHERE id = ${COMPANY}::UUID`;
    await sql`DELETE FROM users WHERE id = ${USER}`;
  }, 120000);

  for (const side of SIDES) {
    it(`${side.name} at a past period end: outstanding is what was owed then, and equals the ageing then`, async () => {
      const line = await side.read(END);
      expect(line).toEqual({ total: 1000, paid: 0, outstanding: 1000 });
      expect(line.outstanding).toBeCloseTo(await side.ageing(END), 2);
    });

    it(`${side.name} to today: settled, and the draft is not a sale`, async () => {
      expect(await side.read(TODAY)).toEqual({ total: 1000, paid: 1000, outstanding: 0 });
    });
  }
});
