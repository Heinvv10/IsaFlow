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
const USER = randomUUID();
const TAG = `D2AR-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

function shift(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return fmtDate(d);
}

interface Seed { n: number; status: string; total: number; paid: number; due: number }
/** 30 rows. Open+overdue: 5 part-paid, 5 sent, 3 approved yesterday, 2 literal 'overdue'. */
const SEEDS: Seed[] = [
  ...Array.from({ length: 6 }, () => ({ n: 1, status: 'paid', total: 1000, paid: 1000, due: -40 })),
  ...Array.from({ length: 5 }, () => ({ n: 1, status: 'partially_paid', total: 2000, paid: 500, due: -10 })),
  ...Array.from({ length: 5 }, () => ({ n: 1, status: 'sent', total: 1000, paid: 0, due: -30 })),
  ...Array.from({ length: 3 }, () => ({ n: 1, status: 'approved', total: 800, paid: 0, due: -1 })),
  ...Array.from({ length: 2 }, () => ({ n: 1, status: 'sent', total: 700, paid: 0, due: 0 })),
  ...Array.from({ length: 3 }, () => ({ n: 1, status: 'sent', total: 600, paid: 0, due: 15 })),
  ...Array.from({ length: 2 }, () => ({ n: 1, status: 'overdue', total: 500, paid: 0, due: -5 })),
  ...Array.from({ length: 2 }, () => ({ n: 1, status: 'cancelled', total: 9000, paid: 0, due: -50 })),
  { n: 1, status: 'draft', total: 9000, paid: 0, due: -50 },
  // Settled but still 'approved' with a past due date: balance 0, must not count as overdue.
  { n: 1, status: 'approved', total: 1234, paid: 1234, due: -20 },
];
// outstanding: 5*1500 + 5*1000 + 3*800 + 2*700 + 3*600 + 2*500 = 7500+5000+2400+1400+1800+1000
const EXPECTED = { outstanding: 19100, overdueCount: 15, overdueAmount: 7500 + 5000 + 2400 + 1000 };

let token = '';

async function insert(company: string, customer: string, s: Seed, i: number) {
  await sql`
    INSERT INTO customer_invoices (company_id, client_id, customer_id, invoice_number, invoice_date,
      due_date, status, subtotal, tax_rate, tax_amount, total_amount, amount_paid, created_by)
    VALUES (${company}::UUID, ${customer}::UUID, ${customer}::UUID, ${`${TAG}-${i}`}, ${shift(-60)}::date,
      ${shift(s.due)}::date, ${s.status}, ${s.total}, 0, 0, ${s.total}, ${s.paid}, ${USER}::UUID)`;
}

async function call<T>(route: unknown, query: Record<string, string> = {}): Promise<T> {
  const req = request({ 'sb-access-token': token, active_company_id: COMPANY }, 'GET');
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
              VALUES (${COMPANY}::UUID, ${'D2AR ' + TAG}, ${TAG}), (${OTHER_COMPANY}::UUID, ${'D2AR other ' + TAG}, ${TAG + '-O'})`;
    await sql`INSERT INTO users (id, email, role, is_active) VALUES (${USER}, ${USER + '@test.local'}, 'admin', true)`;
    await sql`INSERT INTO company_users (company_id, user_id, role) VALUES (${COMPANY}::UUID, ${USER}, 'admin')`;
    const custA = ((await sql`INSERT INTO customers (company_id, name) VALUES (${COMPANY}::UUID, ${'a ' + TAG}) RETURNING id`) as { id: string }[])[0]!.id;
    const custB = ((await sql`INSERT INTO customers (company_id, name) VALUES (${OTHER_COMPANY}::UUID, ${'b ' + TAG}) RETURNING id`) as { id: string }[])[0]!.id;
    for (const [i, s] of SEEDS.entries()) await insert(COMPANY, custA, s, i);
    // Company B: large overdue balances that must not leak into A.
    for (let i = 0; i < 5; i++) await insert(OTHER_COMPANY, custB, { n: 1, status: 'sent', total: 50000, paid: 0, due: -90 }, 100 + i);
    token = await new SignJWT({ sub: USER, aal: 'aal2' })
      .setProtectedHeader({ alg: 'HS256' }).setExpirationTime('1h')
      .sign(new TextEncoder().encode(process.env.JWT_SECRET));
  }, 60000);

  afterAll(async () => {
    await sql`DELETE FROM customer_invoices WHERE company_id IN (${COMPANY}::UUID, ${OTHER_COMPANY}::UUID)`;
    await sql`DELETE FROM customers WHERE company_id IN (${COMPANY}::UUID, ${OTHER_COMPANY}::UUID)`;
    await sql`DELETE FROM company_users WHERE user_id = ${USER}`;
    await sql`DELETE FROM companies WHERE id IN (${COMPANY}::UUID, ${OTHER_COMPANY}::UUID)`;
    await sql`DELETE FROM users WHERE id = ${USER}`;
  }, 60000);

  it('the service equals the hand-computed totals and excludes company B', async () => {
    expect(SEEDS).toHaveLength(30);
    expect(await getAROutstandingSummary(COMPANY)).toEqual(EXPECTED);
  });

  it('the list endpoint returns the same company-wide figures although it pages 25 of 30', async () => {
    const data = await call<{ invoices: unknown[]; total: number; arSummary: unknown }>(listRoute, { page: '1', limit: '25' });
    expect(data.invoices).toHaveLength(25);
    expect(data.total).toBe(30);
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
});
