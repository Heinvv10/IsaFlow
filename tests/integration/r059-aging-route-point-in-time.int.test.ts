/**
 * R-059 — `reports-ar-aging` / `reports-ap-aging` honour `as_at_date`.
 *
 * The routes used to bind the as-at date only into `days_overdue`: they read
 * TODAY's amount_paid, had no `invoice_date <= as-at` bound, and dropped
 * status='paid'. A past-dated report therefore netted off settlement made since,
 * showed documents raised since, and erased invoices settled since. They agreed
 * with arAgingService / apAgingService at TODAY only, which is where every
 * earlier fixture measured.
 *
 * Each side carries two documents, both raised on INV_DATE and due on DUE_DATE:
 *   S  total 1000, 400 paid by a payment dated PAY_S — still open today;
 *   P  total  500, fully paid by a payment dated PAY_P — status 'paid' today.
 *
 * Asserted at six as-at dates, as figures and buckets (route AND service) and
 * as the route's per-invoice rows:
 *   BEFORE   (before INV_DATE)          0, no rows
 *   INV_DATE (the invoice day itself)   1500, current — raised that day counts
 *   BETWEEN  (after INV_DATE, before any payment)  1000 + 500 = 1500, 1-30
 *   PAY_S    (S's payment day itself)   600 + 500 = 1100, 31-60 — paid that
 *                                       day counts as paid
 *   AFTER    (after both payments)      600, 31-60
 *   TODAY                               600, 61-90  — unchanged by the fix
 * The two boundary days are what pin the direction of each bound.
 *
 * The one row the fix DOES change at today is a status='paid' document that
 * still carries a balance: the service always aged it, the route did not. It
 * is seeded in its own test, asserted, and removed.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'crypto';
import { SignJWT } from 'jose';
import { sql } from '@/lib/neon';
import { fmtDate } from '@/lib/fmtDate';
import { getARAging } from '@/modules/accounting/services/ar/arAgingService';
import { getAPAging } from '@/modules/accounting/services/ap/apAgingService';
import type { AgingBucket } from '@/modules/accounting/types/ap.types';
import arAgingRoute from '../../pages/api/accounting/reports-ar-aging';
import apAgingRoute from '../../pages/api/accounting/reports-ap-aging';
import { assertDisposable, request, response } from './mfa-impersonation-postgres.helpers';

const describeIfDb = process.env.DATABASE_URL ? describe : describe.skip;

const COMPANY = randomUUID();
const USER = randomUUID();
const TAG = `R059-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const PAYTAG = `R59-${Math.floor(Math.random() * 1e9)}`;

function shift(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return fmtDate(d);
}
const TODAY = fmtDate(new Date());
const INV_DATE = shift(-100);
const DUE_DATE = shift(-90);
const PAY_S = shift(-50);
const PAY_P = shift(-40);
const BEFORE = shift(-120);
const BETWEEN = shift(-70); // 20 days overdue
const AFTER = shift(-30); // 60 days overdue; TODAY is 90

let customer = '';
let supplier = '';
let token = '';

type Summary = { bucket: string; count: number; total: number };
type Row = { invoice_number: string; amount_paid: number; balance_due: number; bucket: string };
type Body = { rows: Row[]; summary: Summary[] };

async function callRoute(route: unknown, asAt: string): Promise<Body> {
  const req = request({ 'sb-access-token': token, active_company_id: COMPANY }, 'GET');
  (req as unknown as { query: unknown }).query = { as_at_date: asAt };
  const result = response();
  await (route as (a: unknown, b: unknown) => Promise<void>)(req, result.res);
  expect(result.state.statusCode).toBe(200);
  return (result.state.body as { data: Body }).data;
}

const total = (b: Body) => b.summary.reduce((s, x) => s + Number(x.total), 0);
const nonZeroBuckets = (b: Body) =>
  Object.fromEntries(b.summary.filter(x => Number(x.total) !== 0).map(x => [x.bucket, Number(x.total)]));
const svcTotal = (bs: AgingBucket[]) => bs.reduce((s, b) => s + b.total, 0);

/** Route bucket label -> service bucket field, for the same day ranges. */
const SVC_FIELD: Record<string, keyof AgingBucket> = {
  current: 'current', '1-30': 'days30', '31-60': 'days60', '61-90': 'days90', '90+': 'days120Plus',
};
function svcBuckets(bs: AgingBucket[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [label, field] of Object.entries(SVC_FIELD)) {
    const v = bs.reduce((s, b) => s + Number(b[field] ?? 0), 0);
    if (v !== 0) out[label] = v;
  }
  return out;
}

async function arInvoice(n: string, gross: number, paid: number, status: string): Promise<string> {
  return ((await sql`
    INSERT INTO customer_invoices (company_id, client_id, customer_id, invoice_number, invoice_date,
      due_date, status, subtotal, tax_rate, tax_amount, total_amount, amount_paid, created_by)
    VALUES (${COMPANY}::UUID, ${customer}::UUID, ${customer}::UUID, ${TAG + n}, ${INV_DATE}::date,
      ${DUE_DATE}::date, ${status}, ${gross}, 0, 0, ${gross}, ${paid}, ${USER}::UUID)
    RETURNING id`) as { id: string }[])[0]!.id;
}
async function apInvoice(n: string, gross: number, paid: number, status: string): Promise<string> {
  return ((await sql`
    INSERT INTO supplier_invoices (company_id, supplier_id, invoice_number, invoice_date, due_date,
      status, subtotal, tax_amount, total_amount, amount_paid, created_by)
    VALUES (${COMPANY}::UUID, ${supplier}::UUID, ${TAG + n}, ${INV_DATE}::date, ${DUE_DATE}::date,
      ${status}, ${gross}, 0, ${gross}, ${paid}, ${USER}::UUID)
    RETURNING id`) as { id: string }[])[0]!.id;
}
async function arPay(n: string, invoice: string, amount: number, date: string) {
  const id = ((await sql`
    INSERT INTO customer_payments (company_id, payment_number, client_id, payment_date, total_amount, status, created_by)
    VALUES (${COMPANY}::UUID, ${PAYTAG + n}, ${customer}::UUID, ${date}::date, ${amount}, 'confirmed', ${USER}::UUID)
    RETURNING id`) as { id: string }[])[0]!.id;
  await sql`INSERT INTO customer_payment_allocations (payment_id, invoice_id, amount_allocated)
            VALUES (${id}::UUID, ${invoice}::UUID, ${amount})`;
}
async function apPay(n: string, invoice: string, amount: number, date: string) {
  const id = ((await sql`
    INSERT INTO supplier_payments (company_id, payment_number, supplier_id, payment_date, total_amount, status, created_by)
    VALUES (${COMPANY}::UUID, ${PAYTAG + n}, ${supplier}::UUID, ${date}::date, ${amount}, 'processed', ${USER}::UUID)
    RETURNING id`) as { id: string }[])[0]!.id;
  await sql`INSERT INTO payment_allocations (payment_id, invoice_id, amount_allocated)
            VALUES (${id}::UUID, ${invoice}::UUID, ${amount})`;
}

const SIDES = [
  { name: 'AR', route: arAgingRoute, service: (d: string) => getARAging(COMPANY, d) },
  { name: 'AP', route: apAgingRoute, service: (d: string) => getAPAging(COMPANY, d) },
] as const;

describeIfDb('R-059 the ageing routes are point-in-time and agree with the services', () => {
  beforeAll(async () => {
    assertDisposable();
    await sql`INSERT INTO companies (id, name, registration_number) VALUES (${COMPANY}::UUID, ${'R059 ' + TAG}, ${TAG})`;
    await sql`INSERT INTO users (id, email, role, is_active) VALUES (${USER}, ${USER + '@test.local'}, 'admin', true)`;
    await sql`INSERT INTO company_users (company_id, user_id, role) VALUES (${COMPANY}::UUID, ${USER}, 'admin')`;
    customer = ((await sql`INSERT INTO customers (company_id, name) VALUES (${COMPANY}::UUID, ${'cust ' + TAG}) RETURNING id`) as { id: string }[])[0]!.id;
    supplier = ((await sql`INSERT INTO suppliers (company_id, name) VALUES (${COMPANY}::UUID, ${'supp ' + TAG}) RETURNING id`) as { id: string }[])[0]!.id;

    const arS = await arInvoice('-AR-S', 1000, 400, 'partially_paid');
    const arP = await arInvoice('-AR-P', 500, 500, 'paid');
    await arPay('-CS', arS, 400, PAY_S);
    await arPay('-CP', arP, 500, PAY_P);
    const apS = await apInvoice('-AP-S', 1000, 400, 'partially_paid');
    const apP = await apInvoice('-AP-P', 500, 500, 'paid');
    await apPay('-SS', apS, 400, PAY_S);
    await apPay('-SP', apP, 500, PAY_P);

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

  const CASES: { label: string; asAt: () => string; total: number; buckets: Record<string, number>; rows: number }[] = [
    { label: 'before the invoice date', asAt: () => BEFORE, total: 0, buckets: {}, rows: 0 },
    { label: 'on the invoice date', asAt: () => INV_DATE, total: 1500, buckets: { current: 1500 }, rows: 2 },
    { label: 'between invoice and payment', asAt: () => BETWEEN, total: 1500, buckets: { '1-30': 1500 }, rows: 2 },
    { label: "on S's payment day", asAt: () => PAY_S, total: 1100, buckets: { '31-60': 1100 }, rows: 2 },
    { label: 'after both payments', asAt: () => AFTER, total: 600, buckets: { '31-60': 600 }, rows: 1 },
    { label: 'today', asAt: () => TODAY, total: 600, buckets: { '61-90': 600 }, rows: 1 },
  ];

  for (const side of SIDES) {
    for (const c of CASES) {
      it(`${side.name} ${c.label}: route and service both report R${c.total}`, async () => {
        const body = await callRoute(side.route, c.asAt());
        const svc = await side.service(c.asAt());
        expect(total(body)).toBeCloseTo(c.total, 2);
        expect(svcTotal(svc)).toBeCloseTo(c.total, 2);
        expect(nonZeroBuckets(body)).toEqual(c.buckets);
        expect(svcBuckets(svc)).toEqual(c.buckets);
        // The per-invoice rows the page renders come from a SEPARATE query with
        // its own bounds; the summary above cannot vouch for them.
        expect(body.rows).toHaveLength(c.rows);
        expect(body.rows.reduce((s, r) => s + Number(r.balance_due), 0)).toBeCloseTo(c.total, 2);
      });
    }

    it(`${side.name} rows at the in-between date carry the rewound balance, not today's`, async () => {
      const body = await callRoute(side.route, BETWEEN);
      const byNumber = Object.fromEntries(body.rows.map(r => [r.invoice_number.slice(TAG.length), r]));
      expect(Object.keys(byNumber).sort()).toEqual([`-${side.name}-P`, `-${side.name}-S`]);
      expect(Number(byNumber[`-${side.name}-S`]!.balance_due)).toBeCloseTo(1000, 2);
      expect(Number(byNumber[`-${side.name}-S`]!.amount_paid)).toBeCloseTo(0, 2);
      expect(Number(byNumber[`-${side.name}-P`]!.balance_due)).toBeCloseTo(500, 2);
    });

    it(`${side.name} today: the route equals total - amount_paid over the open documents (unchanged)`, async () => {
      const body = await callRoute(side.route, TODAY);
      const direct = side.name === 'AR'
        ? (await sql`SELECT COALESCE(SUM(total_amount - COALESCE(amount_paid, 0)), 0)::numeric AS v
                      FROM customer_invoices WHERE company_id = ${COMPANY}::UUID
                        AND status NOT IN ('paid', 'cancelled', 'draft')`) as { v: string }[]
        : (await sql`SELECT COALESCE(SUM(balance), 0)::numeric AS v
                      FROM supplier_invoices WHERE company_id = ${COMPANY}::UUID
                        AND status NOT IN ('paid', 'cancelled', 'draft')`) as { v: string }[];
      expect(total(body)).toBeCloseTo(Number(direct[0]!.v), 2);
      expect(total(body)).toBeCloseTo(600, 2);
    });
  }

  it('the one change at today: a status=paid document still carrying a balance is aged, as the service always did', async () => {
    const ar = await arInvoice('-AR-R', 300, 100, 'paid');
    const ap = await apInvoice('-AP-R', 300, 100, 'paid');
    try {
      for (const side of SIDES) {
        const body = await callRoute(side.route, TODAY);
        expect(total(body)).toBeCloseTo(800, 2);
        expect(svcTotal(await side.service(TODAY))).toBeCloseTo(800, 2);
      }
    } finally {
      await sql`DELETE FROM customer_invoices WHERE id = ${ar}::UUID AND company_id = ${COMPANY}::UUID`;
      await sql`DELETE FROM supplier_invoices WHERE id = ${ap}::UUID AND company_id = ${COMPANY}::UUID`;
    }
  });
});
