/**
 * R-059 round 2 (HIGH-1) — the year-end receivables and payables notes agree
 * with the ageing at the fiscal year end.
 *
 * Disclosure notes 3/4 and AFS notes 10/16 each ran their own year-end query:
 * TODAY's amount_paid (the AFS pair netted no settlement at all), 'paid'
 * excluded, drafts counted. They now sum getARAging / getAPAging at the year
 * end (reports/agedBucketTotals). The year end is the last day of the month
 * two months back, so a payment dated three days after it is always in the
 * past.
 *
 * Each side, all documents with the year end FYE:
 *   X  raised FYE−10, due FYE+20, paid in full on FYE+3 — status 'paid' today;
 *      owed at FYE, not yet due (Current)
 *   Y  raised FYE−60, due FYE−40, unpaid — 40 days overdue (60 days)
 *   D  a draft raised FYE−5 — never owed
 *   L  raised FYE+1 — after the year end
 *
 *   AR: X 700, Y 300, D 200, L 50  -> 1000 at FYE (Current 700, 60 days 200,
 *       Disputed 100 — Y carries an open dispute of 100, which the aged report
 *       holds outside the buckets and the note must still count)
 *   AP: X 400, Y 150, D  80, L 50  ->  550 at FYE (Current 400, 60 days 150)
 *
 * Before the fix both notes read AR 500 and AP 230: Y plus the draft, X gone.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'crypto';
import { SignJWT } from 'jose';
import { sql } from '@/lib/neon';
import { fmtDate } from '@/lib/fmtDate';
import { noteReceivables, notePayables } from '@/modules/accounting/services/reports/disclosureNoteGenerators';
import { generateNote10TradeReceivables } from '@/modules/accounting/services/afs/noteGenerators/notes6to10';
import { generateNote16TradePayables } from '@/modules/accounting/services/afs/noteGenerators/notes16to20';
import arAgingRoute from '../../pages/api/accounting/reports-ar-aging';
import apAgingRoute from '../../pages/api/accounting/reports-ap-aging';
import { assertDisposable, request, response } from './mfa-impersonation-postgres.helpers';

const describeIfDb = process.env.DATABASE_URL ? describe : describe.skip;

const COMPANY = randomUUID();
const USER = randomUUID();
const TAG = `R059YE-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const PAYTAG = `R59Y-${Math.floor(Math.random() * 1e9)}`;

/** The last day of the month two months before this one, and the fiscal year it closes. */
const now = new Date();
const fyeDate = new Date(now.getFullYear(), now.getMonth() - 1, 0);
const FYE = fmtDate(fyeDate);
const FYE_MONTH = fyeDate.getMonth() + 1;
const START_MONTH = FYE_MONTH === 12 ? 1 : FYE_MONTH + 1;
const FISCAL_YEAR = fyeDate.getFullYear();

function fromFye(days: number): string {
  const d = new Date(fyeDate);
  d.setDate(d.getDate() + days);
  return fmtDate(d);
}

let customer = '';
let supplier = '';
let token = '';

function fmt(n: number): string {
  return new Intl.NumberFormat('en-ZA', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n);
}

async function routeTotal(route: unknown): Promise<number> {
  const req = request({ 'sb-access-token': token, active_company_id: COMPANY }, 'GET');
  (req as unknown as { query: unknown }).query = { as_at_date: FYE };
  const result = response();
  await (route as (a: unknown, b: unknown) => Promise<void>)(req, result.res);
  expect(result.state.statusCode).toBe(200);
  const body = (result.state.body as { data: { summary: { total: number }[] } }).data;
  return body.summary.reduce((s, x) => s + Number(x.total), 0);
}

async function arDoc(n: string, gross: number, raised: string, due: string, status: string, paid: number) {
  return ((await sql`
    INSERT INTO customer_invoices (company_id, client_id, customer_id, invoice_number, invoice_date,
      due_date, status, subtotal, tax_rate, tax_amount, total_amount, amount_paid, created_by)
    VALUES (${COMPANY}::UUID, ${customer}::UUID, ${customer}::UUID, ${TAG + n}, ${raised}::date,
      ${due}::date, ${status}, ${gross}, 0, 0, ${gross}, ${paid}, ${USER}::UUID)
    RETURNING id`) as { id: string }[])[0]!.id;
}
async function apDoc(n: string, gross: number, raised: string, due: string, status: string, paid: number) {
  return ((await sql`
    INSERT INTO supplier_invoices (company_id, supplier_id, invoice_number, invoice_date, due_date,
      status, subtotal, tax_amount, total_amount, amount_paid, created_by)
    VALUES (${COMPANY}::UUID, ${supplier}::UUID, ${TAG + n}, ${raised}::date, ${due}::date,
      ${status}, ${gross}, 0, ${gross}, ${paid}, ${USER}::UUID)
    RETURNING id`) as { id: string }[])[0]!.id;
}

describeIfDb('R-059 the year-end receivables and payables notes are the ageing at the year end', () => {
  beforeAll(async () => {
    assertDisposable();
    await sql`INSERT INTO companies (id, name, registration_number, financial_year_start)
              VALUES (${COMPANY}::UUID, ${'R059YE ' + TAG}, ${TAG}, ${START_MONTH})`;
    await sql`INSERT INTO users (id, email, role, is_active) VALUES (${USER}, ${USER + '@test.local'}, 'admin', true)`;
    await sql`INSERT INTO company_users (company_id, user_id, role) VALUES (${COMPANY}::UUID, ${USER}, 'admin')`;
    customer = ((await sql`INSERT INTO customers (company_id, name) VALUES (${COMPANY}::UUID, ${'cust ' + TAG}) RETURNING id`) as { id: string }[])[0]!.id;
    supplier = ((await sql`INSERT INTO suppliers (company_id, name) VALUES (${COMPANY}::UUID, ${'supp ' + TAG}) RETURNING id`) as { id: string }[])[0]!.id;

    const arX = await arDoc('-AR-X', 700, fromFye(-10), fromFye(20), 'paid', 700);
    const arY = await arDoc('-AR-Y', 300, fromFye(-60), fromFye(-40), 'approved', 0);
    await sql`INSERT INTO customer_invoice_disputes (company_id, customer_invoice_id, reason, raised_by, disputed_amount)
              VALUES (${COMPANY}::UUID, ${arY}::UUID, ${'R059 disputed'}, ${'customer'}, 100)`;
    await arDoc('-AR-D', 200, fromFye(-5), fromFye(25), 'draft', 0);
    await arDoc('-AR-L', 50, fromFye(1), fromFye(31), 'approved', 0);
    const cp = ((await sql`
      INSERT INTO customer_payments (company_id, payment_number, client_id, payment_date, total_amount, status, created_by)
      VALUES (${COMPANY}::UUID, ${PAYTAG + 'C'}, ${customer}::UUID, ${fromFye(3)}::date, 700, 'confirmed', ${USER}::UUID)
      RETURNING id`) as { id: string }[])[0]!.id;
    await sql`INSERT INTO customer_payment_allocations (payment_id, invoice_id, amount_allocated)
              VALUES (${cp}::UUID, ${arX}::UUID, 700)`;

    const apX = await apDoc('-AP-X', 400, fromFye(-10), fromFye(20), 'paid', 400);
    await apDoc('-AP-Y', 150, fromFye(-60), fromFye(-40), 'approved', 0);
    await apDoc('-AP-D', 80, fromFye(-5), fromFye(25), 'draft', 0);
    await apDoc('-AP-L', 50, fromFye(1), fromFye(31), 'approved', 0);
    const sp = ((await sql`
      INSERT INTO supplier_payments (company_id, payment_number, supplier_id, payment_date, total_amount, status, created_by)
      VALUES (${COMPANY}::UUID, ${PAYTAG + 'S'}, ${supplier}::UUID, ${fromFye(3)}::date, 400, 'processed', ${USER}::UUID)
      RETURNING id`) as { id: string }[])[0]!.id;
    await sql`INSERT INTO payment_allocations (payment_id, invoice_id, amount_allocated)
              VALUES (${sp}::UUID, ${apX}::UUID, 400)`;

    token = await new SignJWT({ sub: USER, aal: 'aal2' })
      .setProtectedHeader({ alg: 'HS256' }).setExpirationTime('1h')
      .sign(new TextEncoder().encode(process.env.JWT_SECRET));
  }, 120000);

  afterAll(async () => {
    await sql`DELETE FROM customer_payment_allocations WHERE payment_id IN (SELECT id FROM customer_payments WHERE company_id = ${COMPANY}::UUID)`;
    await sql`DELETE FROM payment_allocations WHERE payment_id IN (SELECT id FROM supplier_payments WHERE company_id = ${COMPANY}::UUID)`;
    await sql`DELETE FROM customer_payments WHERE company_id = ${COMPANY}::UUID`;
    await sql`DELETE FROM supplier_payments WHERE company_id = ${COMPANY}::UUID`;
    await sql`DELETE FROM customer_invoice_disputes WHERE company_id = ${COMPANY}::UUID`;
    await sql`DELETE FROM customer_invoices WHERE company_id = ${COMPANY}::UUID`;
    await sql`DELETE FROM supplier_invoices WHERE company_id = ${COMPANY}::UUID`;
    await sql`DELETE FROM customers WHERE company_id = ${COMPANY}::UUID`;
    await sql`DELETE FROM suppliers WHERE company_id = ${COMPANY}::UUID`;
    await sql`DELETE FROM company_users WHERE user_id = ${USER}`;
    await sql`DELETE FROM companies WHERE id = ${COMPANY}::UUID`;
    await sql`DELETE FROM users WHERE id = ${USER}`;
  }, 120000);

  it('the premise: the payment after the year end is in the past, and the route reads the ageing', async () => {
    expect(fromFye(3) < fmtDate(new Date())).toBe(true);
    expect(await routeTotal(arAgingRoute)).toBeCloseTo(1000, 2);
    expect(await routeTotal(apAgingRoute)).toBeCloseTo(550, 2);
  });

  const AGE_ROW_AR = [fmt(700), fmt(0), fmt(200), fmt(0), fmt(0), fmt(100), fmt(1000)];
  const AGE_ROW_AP = [fmt(400), fmt(0), fmt(150), fmt(0), fmt(0), fmt(550)];

  it('disclosure note 3 (receivables) is the AR ageing at the year end', async () => {
    const note = await noteReceivables(COMPANY, FISCAL_YEAR);
    expect(note.tables![0]!.rows[0]).toEqual(['Gross trade receivables', fmt(1000)]);
    expect(note.tables![1]!.rows[0]).toEqual(AGE_ROW_AR);
  });

  it('disclosure note 4 (payables) is the AP ageing at the year end', async () => {
    const note = await notePayables(COMPANY, FISCAL_YEAR);
    expect(note.tables![0]!.rows[0]).toEqual(['Trade payables', fmt(550)]);
    expect(note.tables![1]!.rows[0]).toEqual(AGE_ROW_AP);
  });

  it('AFS note 10 (receivables) is the AR ageing at the year end', async () => {
    const note = await generateNote10TradeReceivables(COMPANY, FISCAL_YEAR);
    const tables = note.content.blocks.filter(b => b.type === 'table') as { rows: string[][] }[];
    expect(tables[0]!.rows[0]).toEqual(['Gross trade receivables', fmt(1000)]);
    expect(tables[1]!.rows[0]).toEqual(AGE_ROW_AR);
  });

  it('AFS note 16 (payables) is the AP ageing at the year end', async () => {
    const note = await generateNote16TradePayables(COMPANY, FISCAL_YEAR);
    const tables = note.content.blocks.filter(b => b.type === 'table') as { rows: string[][] }[];
    expect(tables[0]!.rows[0]).toEqual(['Trade payables', fmt(550)]);
    expect(tables[1]!.rows[0]).toEqual(AGE_ROW_AP);
  });
});
