// tests/integration/dashboard-aging-ties-to-report.int.test.ts
//
// Home's ageing donuts used to re-aggregate the ledger on their own: four
// buckets whose "90+" was really "> 60", their own status list, no disputes,
// and CURRENT_DATE (the UTC session date, the previous day in SAST for two
// hours every night). On Demo that put R 10 699 420.43 in "90+" while the
// aging report said R 10 686 885.43. The Overdue tiles kept CURRENT_DATE too.
//
// Home now reads the aging report's own population (reports/dashboardOpenBook)
// as at the SAST day: five age buckets net of disputes plus a Disputed segment,
// and the Receivables / Payables tiles from the same rows. These tests seed
// every boundary (0, 1, 30, 31, 60, 61, 90, 91 days overdue), a disputed
// invoice, a credited invoice, a future-dated invoice and a second tenant, and
// compare Home with the REPORT ROUTES (reports-ar-aging / reports-ap-aging),
// not with the service Home itself calls.
//
// Not covered: the midnight case fakes the JS clock only. The database's
// CURRENT_DATE is not faked, so a regression back to CURRENT_DATE in SQL shows
// here only when the suite runs 22:00-24:00 UTC; the "follows the date it is
// given" case is the deterministic guard for the tiles' clock.

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'crypto';
import { SignJWT } from 'jose';
import { sql } from '@/lib/neon';
import { fetchARAgingInvoices } from '@/modules/accounting/services/ar/arAgingInvoices';
import { getAgingBreakdown } from '@/modules/accounting/services/reports/kpiChartsService';
import { getDashboardKPIs } from '@/modules/accounting/services/reports/kpiDashboardService';
import { AGING_BREAKDOWN_LABELS } from '@/modules/accounting/services/reports/dashboardOpenBook';
import { todayInSast } from '@/lib/saDateParser';
import arAgingRoute from '../../pages/api/accounting/reports-ar-aging';
import apAgingRoute from '../../pages/api/accounting/reports-ap-aging';
import { assertDisposable, request, response } from './mfa-impersonation-postgres.helpers';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;

const COMPANY = randomUUID();
const OTHER = randomUUID();
const USER = randomUUID();
const TAG = `DAT-${Math.floor(Math.random() * 1e9)}`;

const TODAY = todayInSast();
/** TODAY shifted by `days`, by calendar arithmetic on the date string. */
function shift(days: number): string {
  const d = new Date(`${TODAY}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** [days overdue, amount]. Every amount is distinct so a misplaced one shows. */
const OPEN: [number, number][] = [
  [-5, 101.01], [0, 111.11], [1, 121.21], [10, 202.02], [30, 131.31], [31, 141.41], [45, 303.03],
  [60, 404.04], [61, 505.05], [75, 606.06], [90, 707.07], [91, 808.08], [120, 909.09],
];
const DISPUTED_FACE = 1000;
const DISPUTED_PART = 250;
const CREDITED_FACE = 1000;
const CREDITED = 400;
const FUTURE = 4444;
const NOISE = 77777;
const ORPHAN = 333.33;
const FOREIGN = 111.11;

const sum = (xs: number[]) => xs.reduce((s, x) => s + x, 0);
const AP_AGE = [101.01 + 111.11, 121.21 + 202.02 + 131.31, 141.41 + 303.03 + 404.04, 505.05 + 606.06 + 707.07, 808.08 + 909.09];
/** By hand, so a change to the aging's bucketing is caught too. Credited sits at 20 days. */
const AR_DASH = [AP_AGE[0]!, AP_AGE[1]! + (CREDITED_FACE - CREDITED), AP_AGE[2]!, AP_AGE[3]!,
  AP_AGE[4]! + (DISPUTED_FACE - DISPUTED_PART), DISPUTED_PART];
const AP_DASH = [...AP_AGE, 0];

let customer = '';
let supplier = '';
let otherCustomer = '';
let token = '';

type AgingBody = { summary: { bucket: string; total: number }[] };
async function reportBuckets(route: unknown): Promise<number[]> {
  const req = request({ 'sb-access-token': token, active_company_id: COMPANY }, 'GET');
  (req as unknown as { query: unknown }).query = { as_at_date: TODAY };
  const result = response();
  await (route as (a: unknown, b: unknown) => Promise<void>)(req, result.res);
  expect(result.state.statusCode).toBe(200);
  return (result.state.body as { data: AgingBody }).data.summary.map((b) => Number(b.total));
}

type ReportRow = { customer_name: string; balance_due: number };
async function reportRows(route: unknown): Promise<ReportRow[]> {
  const req = request({ 'sb-access-token': token, active_company_id: COMPANY }, 'GET');
  (req as unknown as { query: unknown }).query = { as_at_date: TODAY };
  const result = response();
  await (route as (a: unknown, b: unknown) => Promise<void>)(req, result.res);
  expect(result.state.statusCode).toBe(200);
  return (result.state.body as { data: { rows: ReportRow[] } }).data.rows.map((r) => ({ ...r, balance_due: Number(r.balance_due) }));
}

/** Home's donut, compared bucket by bucket with the report and with the by-hand figures. */
async function expectTie(reportAr: number[], reportAp: number[]): Promise<void> {
  for (const [side, report, byHand] of [['ar', reportAr, AR_DASH], ['ap', reportAp, AP_DASH]] as const) {
    const dash = await getAgingBreakdown(COMPANY, side);
    expect(dash.map((b) => b.name)).toEqual([...AGING_BREAKDOWN_LABELS]);
    dash.forEach((b, i) => expect(b.value, `${side} ${b.name}`).toBeCloseTo(byHand[i]!, 2));
    // Age buckets equal the report's once the disputed part (all 90+ here) is added back.
    for (let i = 0; i < 4; i++) expect(dash[i]!.value).toBeCloseTo(report[i]!, 2);
    expect(dash[4]!.value + dash[5]!.value).toBeCloseTo(report[4]!, 2);
    // Donut total = report total = tile.
    const kpis = await getDashboardKPIs(COMPANY, shift(-365), TODAY, todayInSast());
    const tile = side === 'ar' ? kpis.receivables : kpis.payables;
    expect(sum(dash.map((b) => b.value))).toBeCloseTo(sum(report), 2);
    expect(tile.total).toBeCloseTo(sum(report), 2);
    // Overdue: everything but the not-yet-due and due-today rows, disputed or not.
    expect(tile.overdue).toBeCloseTo(sum(report) - report[0]!, 2);
  }
}

describeIfDb('Home ageing and tiles equal the AR/AP aging report routes', () => {
  let reportAr: number[] = [];
  let reportAp: number[] = [];

  beforeAll(async () => {
    assertDisposable();
    await sql`INSERT INTO users (id, email, role, is_active) VALUES (${USER}, ${USER + '@test.local'}, 'admin', true)`;
    for (const co of [COMPANY, OTHER]) {
      await sql`INSERT INTO companies (id, name, registration_number) VALUES (${co}::UUID, ${'Dash aging ' + TAG}, ${TAG + co.slice(0, 4)})`;
    }
    await sql`INSERT INTO company_users (company_id, user_id, role) VALUES (${COMPANY}::UUID, ${USER}, 'admin')`;
    customer = await party('customers', COMPANY);
    supplier = await party('suppliers', COMPANY);
    otherCustomer = await party('customers', OTHER);

    for (const [i, [days, amount]] of OPEN.entries()) {
      await invoice(COMPANY, customer, `${TAG}-AR-${i}`, shift(-days - 30), shift(-days), amount, 0);
      await bill(`${TAG}-AP-${i}`, shift(-days - 30), shift(-days), amount);
    }
    const disputed = await invoice(COMPANY, customer, `${TAG}-AR-D`, shift(-150), shift(-120), DISPUTED_FACE, 0);
    await sql`INSERT INTO customer_invoice_disputes (company_id, customer_invoice_id, reason, raised_by, disputed_amount)
              VALUES (${COMPANY}::UUID, ${disputed}::UUID, 'fixture', ${USER}::UUID, ${DISPUTED_PART})`;
    // Credited: an approved credit note applied before today, as creditNoteApproveService leaves it.
    const credited = await invoice(COMPANY, customer, `${TAG}-AR-C`, shift(-50), shift(-20), CREDITED_FACE, CREDITED);
    const cn = ((await sql`
      INSERT INTO credit_notes (company_id, credit_note_number, type, client_id, customer_invoice_id, credit_date,
        subtotal, tax_rate, tax_amount, total_amount, applied_amount, status, created_by)
      VALUES (${COMPANY}::UUID, ${TAG + '-CN'}, 'customer', ${customer}::UUID, ${credited}::UUID, ${shift(-10)}::date,
        ${CREDITED}, 0, 0, ${CREDITED}, ${CREDITED}, 'applied', ${USER}::UUID)
      RETURNING id`) as { id: string }[])[0]!.id;
    await sql`INSERT INTO credit_note_allocations (company_id, credit_note_id, invoice_id, amount_allocated)
              VALUES (${COMPANY}::UUID, ${cn}::UUID, ${credited}::UUID, ${CREDITED})`;
    // Future-dated: raised after today, in no figure until its date.
    await invoice(COMPANY, customer, `${TAG}-AR-F`, shift(5), shift(35), FUTURE, 0);
    await bill(`${TAG}-AP-F`, shift(5), shift(35), FUTURE);
    // The other tenant's debt, in every bucket's reach.
    await invoice(OTHER, otherCustomer, `${TAG}-AR-X`, shift(-200), shift(-75), NOISE, 0);

    token = await new SignJWT({ sub: USER, aal: 'aal2' })
      .setProtectedHeader({ alg: 'HS256' }).setExpirationTime('1h')
      .sign(new TextEncoder().encode(process.env.JWT_SECRET));
    reportAr = await reportBuckets(arAgingRoute);
    reportAp = await reportBuckets(apAgingRoute);
  }, 120000);

  afterAll(async () => {
    for (const co of [COMPANY, OTHER]) {
      await sql`DELETE FROM credit_note_allocations WHERE company_id = ${co}::UUID`;
      await sql`DELETE FROM credit_notes WHERE company_id = ${co}::UUID`;
      await sql`DELETE FROM customer_invoice_disputes WHERE company_id = ${co}::UUID`;
      await sql`DELETE FROM customer_invoices WHERE company_id = ${co}::UUID`;
      await sql`DELETE FROM supplier_invoices WHERE company_id = ${co}::UUID`;
      await sql`DELETE FROM customers WHERE company_id = ${co}::UUID`;
      await sql`DELETE FROM suppliers WHERE company_id = ${co}::UUID`;
      await sql`DELETE FROM company_users WHERE company_id = ${co}::UUID`;
      await sql`DELETE FROM companies WHERE id = ${co}::UUID`;
    }
    await sql`DELETE FROM users WHERE id = ${USER}`;
  });

  it('the report routes carry the fixture: disputed inside 90+, credited net, future-dated nowhere', () => {
    expect(reportAr[4]).toBeCloseTo(AP_AGE[4]! + DISPUTED_FACE, 2);
    expect(reportAr[1]).toBeCloseTo(AP_AGE[1]! + CREDITED_FACE - CREDITED, 2);
    expect(sum(reportAp)).toBeCloseTo(sum(AP_AGE), 2);
  });

  it('donut buckets plus Disputed equal the report routes, and the tiles equal both', async () => {
    await expectTie(reportAr, reportAp);
  });

  it('61–90 is its own bucket and not inside 90+', async () => {
    const ar = await getAgingBreakdown(COMPANY, 'ar');
    expect(ar[3]!.value).toBeCloseTo(505.05 + 606.06 + 707.07, 2);
  });

  it("never counts another tenant's invoices", async () => {
    const ar = await getAgingBreakdown(COMPANY, 'ar');
    expect(sum(ar.map((b) => b.value))).toBeLessThan(NOISE);
    const other = await getAgingBreakdown(OTHER, 'ar');
    expect(other[3]!.value).toBeCloseTo(NOISE, 2);
  });

  it('the tiles follow the date they are given, not the database clock', async () => {
    // Ten days on, everything due by then is overdue; the future-dated
    // invoice (due in 35 days) is open but not yet due.
    const kpis = await getDashboardKPIs(COMPANY, shift(-365), shift(10), shift(10));
    expect(kpis.payables.total).toBeCloseTo(sum(AP_AGE) + FUTURE, 2);
    expect(kpis.payables.overdue).toBeCloseTo(sum(AP_AGE), 2);
    expect(kpis.receivables.overdue).toBeCloseTo(sum(AR_DASH), 2);
  });

  it('an invoice whose client_id points at no customer row stays on Home and in the report total', async () => {
    // client_id has no foreign key, and the report's summary reads customer_invoices
    // alone: an inner join to customers on Home dropped this invoice from the tile
    // and the donut while the report total kept it. (supplier_invoices.supplier_id is
    // NOT NULL with a foreign key, so the AP side has no equivalent row.)
    const orphanClient = randomUUID();
    // Another tenant's customer, named so a leak shows: client_id naming it is no customer of COMPANY.
    const foreignCustomer = ((await sql`
      INSERT INTO customers (company_id, name) VALUES (${OTHER}::UUID, ${'Other tenant secret ' + TAG}) RETURNING id`) as { id: string }[])[0]!.id;
    const before = sum((await getAgingBreakdown(COMPANY, 'ar')).map((b) => b.value));
    const id = ((await sql`
      INSERT INTO customer_invoices (company_id, client_id, customer_id, invoice_number, invoice_date, due_date,
        status, subtotal, tax_rate, tax_amount, total_amount, amount_paid, created_by)
      VALUES (${COMPANY}::UUID, ${orphanClient}::UUID, ${customer}::UUID, ${TAG + '-AR-ORPHAN'}, ${shift(-40)}::date, ${shift(-10)}::date,
        'approved', ${ORPHAN}, 0, 0, ${ORPHAN}, 0, ${USER}::UUID)
      RETURNING id`) as { id: string }[])[0]!.id;
    const foreignId = ((await sql`
      INSERT INTO customer_invoices (company_id, client_id, customer_id, invoice_number, invoice_date, due_date,
        status, subtotal, tax_rate, tax_amount, total_amount, amount_paid, created_by)
      VALUES (${COMPANY}::UUID, ${foreignCustomer}::UUID, ${customer}::UUID, ${TAG + '-AR-FOREIGN'}, ${shift(-40)}::date, ${shift(-10)}::date,
        'approved', ${FOREIGN}, 0, 0, ${FOREIGN}, 0, ${USER}::UUID)
      RETURNING id`) as { id: string }[])[0]!.id;
    try {
      const report = await reportBuckets(arAgingRoute);
      const dash = await getAgingBreakdown(COMPANY, 'ar');
      const tile = (await getDashboardKPIs(COMPANY, shift(-365), TODAY, todayInSast())).receivables;
      expect(sum(report)).toBeCloseTo(sum(reportAr) + ORPHAN + FOREIGN, 2);
      expect(sum(dash.map((b) => b.value))).toBeCloseTo(before + ORPHAN + FOREIGN, 2);
      expect(sum(dash.map((b) => b.value))).toBeCloseTo(sum(report), 2);
      expect(tile.total).toBeCloseTo(sum(report), 2);
      // 10 days overdue: the 1–30 bucket carries it on both surfaces.
      expect(dash[1]!.value).toBeCloseTo(report[1]!, 2);
      // Both named "Unknown customer" in the list, never the other tenant's customer.
      const names = (await fetchARAgingInvoices(COMPANY, TODAY, TODAY)).filter((i) => i.invoiceNumber.startsWith(`${TAG}-AR-`) && /ORPHAN|FOREIGN/.test(i.invoiceNumber));
      expect(names.map((i) => i.entityName)).toEqual(['Unknown customer', 'Unknown customer']);
      // The report's own rows (and so its CSV) sum to its total and carry both.
      const rows = await reportRows(arAgingRoute);
      expect(rows.reduce((s, r) => s + r.balance_due, 0)).toBeCloseTo(sum(report), 2);
      expect(rows.filter((r) => r.customer_name === 'Unknown customer').map((r) => r.balance_due).sort())
        .toEqual([FOREIGN, ORPHAN]);
      expect(JSON.stringify(rows)).not.toContain('Other tenant secret');
    } finally {
      await sql`DELETE FROM customer_invoices WHERE id IN (${id}::UUID, ${foreignId}::UUID)`;
      await sql`DELETE FROM customers WHERE id = ${foreignCustomer}::UUID`;
    }
  });

  it('just after midnight SAST (22:30 UTC the day before) it still ages from the SAST day', async () => {
    // 00:30 SAST TODAY is the previous UTC day. A UTC date would age every
    // boundary invoice one day younger: 61 → 31–60, 91 → 61–90, 1 → Current.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(`${shift(-1)}T22:30:00Z`));
    try {
      expect(todayInSast()).toBe(TODAY);
      await expectTie(reportAr, reportAp);
    } finally {
      vi.useRealTimers();
    }
  });
});

async function party(table: 'customers' | 'suppliers', co: string): Promise<string> {
  const rows = table === 'customers'
    ? await sql`INSERT INTO customers (company_id, name) VALUES (${co}::UUID, ${'cust ' + TAG}) RETURNING id`
    : await sql`INSERT INTO suppliers (company_id, name) VALUES (${co}::UUID, ${'supp ' + TAG}) RETURNING id`;
  return (rows as { id: string }[])[0]!.id;
}

async function invoice(co: string, cust: string, number: string, date: string, due: string, total: number, paid: number): Promise<string> {
  const rows = (await sql`
    INSERT INTO customer_invoices (company_id, client_id, customer_id, invoice_number, invoice_date, due_date,
      status, subtotal, tax_rate, tax_amount, total_amount, amount_paid, created_by)
    VALUES (${co}::UUID, ${cust}::UUID, ${cust}::UUID, ${number}, ${date}::date, ${due}::date,
      'approved', ${total}, 0, 0, ${total}, ${paid}, ${USER}::UUID)
    RETURNING id`) as { id: string }[];
  return rows[0]!.id;
}

async function bill(number: string, date: string, due: string, total: number): Promise<void> {
  await sql`
    INSERT INTO supplier_invoices (company_id, supplier_id, invoice_number, invoice_date, due_date,
      status, subtotal, tax_amount, total_amount, amount_paid, created_by)
    VALUES (${COMPANY}::UUID, ${supplier}::UUID, ${number}, ${date}::date, ${due}::date,
      'approved', ${total}, 0, ${total}, 0, ${USER}::UUID)`;
}
