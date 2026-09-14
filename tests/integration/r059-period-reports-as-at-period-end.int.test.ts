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
 *
 * Round 3 (LOW-4) adds sales-by-item, whose comment claims it is dated
 * "exactly as sales-by-customer over the same range" while it kept counting
 * drafts. Each AR invoice carries one line for its full amount, so the two
 * reports' revenue must agree: 1000, not 1200.
 *
 * ROUND 4 adds N, a real invoice of 300 whose `status` is NULL — the column is
 * nullable and defaults to 'draft' only when the column is omitted, so rows
 * carrying NULL exist. `NULL NOT IN ('draft','cancelled')` is NULL, not TRUE,
 * so every one of these reports SILENTLY DROPPED such an invoice; K-091 fixed
 * exactly that on sales-by-customer and round 3 re-introduced it next door.
 * N is unpaid, so it lands in outstanding at both dates and every figure below
 * carries it: 1300 / 0 / 1300 at END, 1300 / 1000 / 300 today. Drop the
 * COALESCE from any one of the five surfaces and that surface alone reads
 * 1000 / … again, which is what the arithmetic here is for.
 *
 * ROUND 5 adds K on the AR side only: a real invoice of 400 carrying ONLY
 * `customer_id`, with `client_id` NULL — the K-093 shape. `sales-by-customer`
 * joins and groups on `COALESCE(client_id, customer_id)`, so it counted K,
 * while `getCustomerReport` joined `ci.client_id = c.id` and dropped it: the
 * two reports claim to agree and did not. The mirror row cannot be seeded —
 * `customer_invoices.customer_id` is NOT NULL, so "client_id only" is the only
 * one-sided shape the schema permits. Both AR surfaces now read 1700 where the
 * two AP surfaces read 1300; suppliers have one key, so there is nothing to
 * mirror there. The old fixture set BOTH ids on every row, which is exactly why
 * it could not fail on this.
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
import salesByItem from '../../pages/api/accounting/reports/sales-by-item';
import purchasesBySupplier from '../../pages/api/accounting/reports/purchases-by-supplier';
import { assertDisposable, request, response } from './mfa-impersonation-postgres.helpers';

const describeIfDb = process.env.DATABASE_URL ? describe : describe.skip;

const COMPANY = randomUUID();
const USER = randomUUID();
const TAG = `R059P-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const PAYTAG = `R59P-${Math.floor(Math.random() * 1e9)}`;
/** The one item description both AR invoices are billed under. */
const ITEM = `R059P item ${TAG}`;

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

/** AR carries K (400, customer_id only); AP has no second key and so no K. */
const AR_EXTRA = 400;
const AP_EXTRA = 0;

const SIDES = [
  {
    name: 'sales-by-customer',
    extra: AR_EXTRA,
    read: async (to: string): Promise<Line> => {
      const [r] = await callRoute(salesByCustomer, to);
      return { total: Number(r!.totalSales), paid: Number(r!.paymentsReceived), outstanding: Number(r!.outstanding) };
    },
    ageing: async (to: string) => (await getARAging(COMPANY, to)).reduce((s, b) => s + b.total, 0),
  },
  {
    name: 'purchases-by-supplier',
    extra: AP_EXTRA,
    read: async (to: string): Promise<Line> => {
      const [r] = await callRoute(purchasesBySupplier, to);
      return { total: Number(r!.totalPurchases), paid: Number(r!.paymentsMade), outstanding: Number(r!.outstanding) };
    },
    ageing: async (to: string) => (await getAPAging(COMPANY, to)).reduce((s, b) => s + b.total, 0),
  },
  {
    name: 'getCustomerReport',
    extra: AR_EXTRA,
    read: async (to: string): Promise<Line> => {
      const [r] = await getCustomerReport(COMPANY, FROM, to);
      return { total: r!.totalInvoiced, paid: r!.totalPaid, outstanding: r!.balance };
    },
    ageing: async (to: string) => (await getARAging(COMPANY, to)).reduce((s, b) => s + b.total, 0),
  },
  {
    name: 'getSupplierReport',
    extra: AP_EXTRA,
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

    const [arS, arD, arN, arK] = (await sql`
      INSERT INTO customer_invoices (company_id, client_id, customer_id, invoice_number, invoice_date,
        due_date, status, subtotal, tax_rate, tax_amount, total_amount, amount_paid, created_by)
      VALUES (${COMPANY}::UUID, ${customer}::UUID, ${customer}::UUID, ${TAG + '-AR-S'}, ${RAISED}::date,
        ${RAISED}::date, 'paid', 1000, 0, 0, 1000, 1000, ${USER}::UUID),
             (${COMPANY}::UUID, ${customer}::UUID, ${customer}::UUID, ${TAG + '-AR-D'}, ${RAISED}::date,
        ${RAISED}::date, 'draft', 200, 0, 0, 200, 0, ${USER}::UUID),
             (${COMPANY}::UUID, ${customer}::UUID, ${customer}::UUID, ${TAG + '-AR-N'}, ${RAISED}::date,
        ${RAISED}::date, NULL, 300, 0, 0, 300, 0, ${USER}::UUID),
             (${COMPANY}::UUID, NULL, ${customer}::UUID, ${TAG + '-AR-K'}, ${RAISED}::date,
        ${RAISED}::date, 'approved', 400, 0, 0, 400, 0, ${USER}::UUID)
      RETURNING id`) as { id: string }[];
    // One line per AR invoice, so sales-by-item has something to aggregate and
    // the draft's 200 is visible to it if it counts drafts (LOW-4).
    await sql`INSERT INTO customer_invoice_items (invoice_id, description, quantity, unit_price, amount)
              VALUES (${arS!.id}::UUID, ${ITEM}, 1, 1000, 1000),
                     (${arD!.id}::UUID, ${ITEM}, 1, 200, 200),
                     (${arN!.id}::UUID, ${ITEM}, 1, 300, 300),
                     (${arK!.id}::UUID, ${ITEM}, 1, 400, 400)`;
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
        'draft', 200, 0, 200, 0, ${USER}::UUID),
             (${COMPANY}::UUID, ${supplier}::UUID, ${TAG + '-AP-N'}, ${RAISED}::date, ${RAISED}::date,
        NULL, 300, 0, 300, 0, ${USER}::UUID)
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
    await sql`DELETE FROM customer_invoice_items WHERE invoice_id IN (SELECT id FROM customer_invoices WHERE company_id = ${COMPANY}::UUID)`;
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
      // 1000 (S) + 300 (N, null status) + 400 (K, customer_id only; AR only).
      // The draft is not a sale.
      const gross = 1300 + side.extra;
      expect(line).toEqual({ total: gross, paid: 0, outstanding: gross });
      expect(line.outstanding).toBeCloseTo(await side.ageing(END), 2);
    });

    it(`${side.name} to today: settled, and the draft is not a sale`, async () => {
      expect(await side.read(TODAY)).toEqual({
        total: 1300 + side.extra, paid: 1000, outstanding: 300 + side.extra,
      });
    });
  }

  it('the premise: N really carries a NULL status on both sides', async () => {
    const rows = (await sql`
      SELECT (SELECT COUNT(*)::INT FROM customer_invoices
              WHERE company_id = ${COMPANY}::UUID AND status IS NULL) AS ar,
             (SELECT COUNT(*)::INT FROM supplier_invoices
              WHERE company_id = ${COMPANY}::UUID AND status IS NULL) AS ap
    `) as { ar: number; ap: number }[];
    expect(rows[0]).toEqual({ ar: 1, ap: 1 });
    // And Postgres really answers NULL, not TRUE, to the bare comparison —
    // the reason every predicate above needs the COALESCE.
    const [probe] = (await sql`
      SELECT (NULL::text NOT IN ('draft','cancelled')) IS NULL AS bare_is_null,
             COALESCE(NULL::text, '') NOT IN ('draft','cancelled') AS coalesced
    `) as { bare_is_null: boolean; coalesced: boolean }[];
    expect(probe).toEqual({ bare_is_null: true, coalesced: true });
  });

  it('the premise: K really carries customer_id only, and its mirror cannot exist', async () => {
    const [row] = (await sql`
      SELECT COUNT(*)::INT AS customer_only
      FROM customer_invoices
      WHERE company_id = ${COMPANY}::UUID AND client_id IS NULL AND customer_id IS NOT NULL
    `) as { customer_only: number }[];
    expect(row!.customer_only).toBe(1);
    // customer_id is NOT NULL, so a client_id-only invoice is unrepresentable —
    // stated here so the missing mirror case reads as the schema, not an omission.
    const [col] = (await sql`
      SELECT is_nullable FROM information_schema.columns
      WHERE table_name = 'customer_invoices' AND column_name = 'customer_id'
    `) as { is_nullable: string }[];
    expect(col!.is_nullable).toBe('NO');
  });

  async function itemRevenue(to: string): Promise<number> {
    const rows = await callRoute(salesByItem, to);
    return rows.reduce((s, r) => s + Number(r.totalRevenue), 0);
  }

  for (const to of [END, TODAY]) {
    it(`sales-by-item to ${to === TODAY ? 'today' : 'a past period end'} counts the same sales as sales-by-customer`, async () => {
      const [byCustomer] = await callRoute(salesByCustomer, to);
      expect(await itemRevenue(to)).toBeCloseTo(1300 + AR_EXTRA, 2);
      expect(await itemRevenue(to)).toBeCloseTo(Number(byCustomer!.totalSales), 2);
    });
  }
});
