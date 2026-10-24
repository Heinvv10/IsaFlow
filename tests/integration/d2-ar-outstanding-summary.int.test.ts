/**
 * D2 — the invoice list tiles and the dashboard read ONE company-wide AR
 * figure. 30 invoices for company A (page size 25, so a page-local sum cannot
 * equal it), 5 for company B. Expected totals are hand-computed from the
 * seed table below, not read back from SQL.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'crypto';
import { SignJWT } from 'jose';
import { sql } from '@/lib/neon';
import { fmtDate } from '@/lib/fmtDate';
import { getAROutstandingSummary } from '@/modules/accounting/services/ar/arOutstandingService';
import listRoute from '../../pages/api/accounting/customer-invoices-list';
import todosRoute from '../../pages/api/accounting/dashboard-todos';
import dashboardStatsRoute from '../../pages/api/accounting/dashboard-stats';
import { assertDisposable, request, response } from './mfa-impersonation-postgres.helpers';

const describeIfDb = process.env.DATABASE_URL ? describe : describe.skip;

const COMPANY = randomUUID();
const OTHER_COMPANY = randomUUID();
/** Its only overdue invoice carries the literal status 'overdue'. */
const LITERAL_COMPANY = randomUUID();
const USER = randomUUID();
const TAG = `D2AR-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

function shift(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return fmtDate(d);
}

interface Seed { key?: string; status: string; total: number; paid: number; due: number | null; invoiceDate?: number; deleted?: boolean; credited?: number }
const rep = (n: number, seed: Seed): Seed[] => Array.from({ length: n }, () => seed);
/** 35 rows (34 not soft-deleted). Overdue: 5 part-paid, 5 sent, 3 approved yesterday, 2 literal 'overdue', 1 part-credited. */
const SEEDS: Seed[] = [
  ...rep(6, { status: 'paid', total: 1000, paid: 1000, due: -40 }),
  ...rep(5, { status: 'partially_paid', total: 2000, paid: 500, due: -10 }),
  ...rep(5, { status: 'sent', total: 1000, paid: 0, due: -30 }),
  ...rep(3, { status: 'approved', total: 800, paid: 0, due: -1 }),
  ...rep(1, { key: 'today', status: 'sent', total: 700, paid: 0, due: 0 }),
  ...rep(1, { status: 'sent', total: 700, paid: 0, due: 0 }),
  ...rep(3, { status: 'sent', total: 600, paid: 0, due: 15 }),
  ...rep(2, { status: 'overdue', total: 500, paid: 0, due: -5 }),
  ...rep(2, { status: 'cancelled', total: 9000, paid: 0, due: -50 }),
  { status: 'draft', total: 9000, paid: 0, due: -50 },
  // Settled but still 'approved' with a past due date: balance 0, must not count as overdue.
  { key: 'settled', status: 'approved', total: 1234, paid: 1234, due: -20 },
  // No due date: ages from the invoice date, as aged debtors does. Old one is overdue, a fresh one is not.
  { key: 'nodue', status: 'sent', total: 900, paid: 0, due: null },
  { key: 'nodue-fresh', status: 'sent', total: 450, paid: 0, due: null, invoiceDate: 0 },
  // Soft-deleted, no journal: in neither figure.
  { key: 'deleted', status: 'sent', total: 1300, paid: 0, due: -30, deleted: true },
  // Credit notes applied: amount_paid already carries them.
  { key: 'part-credited', status: 'approved', total: 1000, paid: 600, due: -15, credited: 600 },
  { key: 'full-credited', status: 'approved', total: 750, paid: 750, due: -15, credited: 750 },
];
// outstanding: 5*1500 + 5*1000 + 3*800 + 2*700 + 3*600 + 2*500 + 900 + 450 + 400
const EXPECTED = { outstanding: 20750, overdueCount: 17, overdueAmount: 7500 + 5000 + 2400 + 1000 + 400 + 900 };
const keyNumber = (key: string): string => `${TAG}-${SEEDS.findIndex((s) => s.key === key)}`;

let token = '';

async function insert(company: string, customer: string, s: Seed, i: number) {
  const due = s.due === null ? null : shift(s.due);
  const rows = (await sql`
    INSERT INTO customer_invoices (company_id, client_id, customer_id, invoice_number, invoice_date,
      due_date, status, subtotal, tax_rate, tax_amount, total_amount, amount_paid, created_by, deleted_at)
    VALUES (${company}::UUID, ${customer}::UUID, ${customer}::UUID, ${`${TAG}-${i}`}, ${shift(s.invoiceDate ?? -60)}::date,
      ${due}::date, ${s.status}, ${s.total}, 0, 0, ${s.total}, ${s.paid}, ${USER}::UUID,
      ${s.deleted ? new Date() : null})
    RETURNING id`) as { id: string }[];
  if (s.credited) {
    await sql`
      INSERT INTO credit_notes (company_id, type, client_id, customer_invoice_id, credit_date, subtotal,
        total_amount, applied_amount, status, created_by)
      VALUES (${company}::UUID, 'customer', ${customer}::UUID, ${rows[0]!.id}::UUID, ${shift(-30)}::date,
        ${s.credited}, ${s.credited}, ${s.credited}, 'applied', ${USER}::UUID)`;
  }
}

async function call<T>(route: unknown, query: Record<string, string> = {}, company: string = COMPANY): Promise<T> {
  const req = request({ 'sb-access-token': token, active_company_id: company }, 'GET');
  (req as unknown as { query: unknown }).query = query;
  const result = response();
  await (route as (a: unknown, b: unknown) => Promise<void>)(req, result.res);
  expect(result.state.statusCode).toBe(200);
  return (result.state.body as { data: T }).data;
}

describeIfDb('D2 company-wide AR outstanding/overdue summary', () => {
  beforeAll(async () => {
    assertDisposable();
    await sql`INSERT INTO companies (id, name, registration_number)
              VALUES (${COMPANY}::UUID, ${'D2AR ' + TAG}, ${TAG}), (${OTHER_COMPANY}::UUID, ${'D2AR other ' + TAG}, ${TAG + '-O'}),
                     (${LITERAL_COMPANY}::UUID, ${'D2AR literal ' + TAG}, ${TAG + '-L'})`;
    await sql`INSERT INTO users (id, email, role, is_active) VALUES (${USER}, ${USER + '@test.local'}, 'admin', true)`;
    await sql`INSERT INTO company_users (company_id, user_id, role) VALUES (${COMPANY}::UUID, ${USER}, 'admin'), (${LITERAL_COMPANY}::UUID, ${USER}, 'admin')`;
    const custA = ((await sql`INSERT INTO customers (company_id, name) VALUES (${COMPANY}::UUID, ${'a ' + TAG}) RETURNING id`) as { id: string }[])[0]!.id;
    const custB = ((await sql`INSERT INTO customers (company_id, name) VALUES (${OTHER_COMPANY}::UUID, ${'b ' + TAG}) RETURNING id`) as { id: string }[])[0]!.id;
    const custL = ((await sql`INSERT INTO customers (company_id, name) VALUES (${LITERAL_COMPANY}::UUID, ${'l ' + TAG}) RETURNING id`) as { id: string }[])[0]!.id;
    await insert(LITERAL_COMPANY, custL, { status: 'overdue', total: 300, paid: 0, due: -5 }, 200);
    for (const [i, s] of SEEDS.entries()) await insert(COMPANY, custA, s, i);
    // Company B: large overdue balances that must not leak into A.
    for (let i = 0; i < 5; i++) await insert(OTHER_COMPANY, custB, { n: 1, status: 'sent', total: 50000, paid: 0, due: -90 }, 100 + i);
    token = await new SignJWT({ sub: USER, aal: 'aal2' })
      .setProtectedHeader({ alg: 'HS256' }).setExpirationTime('1h')
      .sign(new TextEncoder().encode(process.env.JWT_SECRET));
  }, 60000);

  afterAll(async () => {
    const all = [COMPANY, OTHER_COMPANY, LITERAL_COMPANY];
    await sql`DELETE FROM credit_notes WHERE company_id = ANY(${all}::uuid[])`;
    await sql`DELETE FROM customer_invoices WHERE company_id = ANY(${all}::uuid[])`;
    await sql`DELETE FROM customers WHERE company_id = ANY(${all}::uuid[])`;
    await sql`DELETE FROM company_users WHERE user_id = ${USER}`;
    await sql`DELETE FROM companies WHERE id = ANY(${all}::uuid[])`;
    await sql`DELETE FROM users WHERE id = ${USER}`;
  }, 60000);

  it('the service equals the hand-computed totals and excludes company B', async () => {
    expect(SEEDS).toHaveLength(35);
    expect(await getAROutstandingSummary(COMPANY)).toEqual(EXPECTED);
  });

  it('the list endpoint returns the same company-wide figures although it pages 25 of 34', async () => {
    const data = await call<{ invoices: unknown[]; total: number; arSummary: unknown }>(listRoute, { page: '1', limit: '25' });
    expect(data.invoices).toHaveLength(25);
    expect(data.total).toBe(34);
    expect(data.arSummary).toEqual(EXPECTED);
  });

  it('the dashboard receivable total is the same number the tile shows', async () => {
    const dash = await call<{ arTotal: number }>(dashboardStatsRoute);
    expect(dash.arTotal).toBe(EXPECTED.outstanding);
  });

  it('the dashboard overdue action count is the true count while the list stays at 10 rows', async () => {
    const todos = await call<{ overdueInvoiceCount: number; overdueInvoices: unknown[] }>(todosRoute);
    expect(todos.overdueInvoiceCount).toBe(EXPECTED.overdueCount);
    expect(todos.overdueInvoices).toHaveLength(10);
  });

  it('every listed overdue row has an open balance and a past due date, and the boundary rows are absent', async () => {
    const todos = await call<{ overdueInvoices: { id: string; invoiceNumber: string; amount: number; daysOverdue: number }[] }>(todosRoute);
    const ids = todos.overdueInvoices.map((r) => r.id);
    const rows = (await sql`
      SELECT id::text, COALESCE(total_amount,0) - COALESCE(amount_paid,0) AS balance, COALESCE(due_date, invoice_date) < ${shift(0)}::date AS past
      FROM customer_invoices WHERE company_id = ${COMPANY}::UUID AND id = ANY(${ids}::uuid[])
    `) as { id: string; balance: string; past: boolean }[];
    expect(rows).toHaveLength(10);
    for (const r of rows) {
      expect(Number(r.balance)).toBeGreaterThan(0);
      expect(r.past).toBe(true);
    }
    for (const r of todos.overdueInvoices) expect(r.daysOverdue).toBeGreaterThan(0);
    const numbers = todos.overdueInvoices.map((r) => r.invoiceNumber);
    for (const key of ['today', 'settled', 'nodue-fresh', 'deleted', 'full-credited']) expect(numbers).not.toContain(keyNumber(key));
  });

  it('the overdue figures exclude due-today, settled, fresh no-due-date, deleted and fully credited, and net a part-credited balance', async () => {
    const asked = await call<{ invoices: { invoice_number: string; total_amount: string; amount_paid: string }[]; total: number }>(
      listRoute, { status: 'overdue', limit: '100' });
    const numbers = asked.invoices.map((r) => r.invoice_number);
    expect(asked.total).toBe(EXPECTED.overdueCount);
    for (const key of ['today', 'settled', 'nodue-fresh', 'deleted', 'full-credited']) expect(numbers).not.toContain(keyNumber(key));
    expect(numbers).toContain(keyNumber('part-credited'));
    // a no-due-date invoice ages from its invoice date
    expect(numbers).toContain(keyNumber('nodue'));
    // uncapped: the count is the number of rows the same predicate matches
    expect(asked.invoices).toHaveLength(EXPECTED.overdueCount);
  });

  it('the Overdue status filter returns exactly the tile count, whatever the stored status', async () => {
    const asked = await call<{ invoices: { status: string }[]; total: number }>(listRoute, { status: 'overdue', limit: '100' });
    expect(asked.total).toBe((await getAROutstandingSummary(COMPANY)).overdueCount);
    expect(new Set(asked.invoices.map((r) => r.status))).toEqual(new Set(['sent', 'approved', 'partially_paid', 'overdue']));
  });

  it('a company whose only overdue invoice has the literal status overdue still shows the action row', async () => {
    const todos = await call<{ overdueInvoiceCount: number; overdueInvoices: { amount: number }[] }>(todosRoute, {}, LITERAL_COMPANY);
    expect(todos.overdueInvoiceCount).toBe(1);
    expect(todos.overdueInvoices).toHaveLength(1);
    expect(todos.overdueInvoices[0]!.amount).toBe(300);
  });
});
