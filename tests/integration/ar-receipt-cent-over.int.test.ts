/**
 * 899 — a receipt allocation one cent over the invoice's balance is refused cleanly.
 *
 * `buildLine` compared `amount > outstanding + 0.01`, so a cent over passed the guard and
 * `applyLineToInvoice` then wrote total + 0.01, which `customer_invoices_amount_paid_within_total`
 * (zero tolerance) rejects with 23514 — a 500 and a rollback instead of a refusal naming the
 * balance. Through the real route (POST /api/accounting/customer-allocations: withAuth as app_user
 * with RLS, withCsrf, withWriteAccess), asserted by OUTCOME: the status, and that nothing was written.
 */
import { afterAll, beforeAll, expect, it } from 'vitest';
import { Pool } from 'pg';
import { randomUUID } from 'crypto';
import { SignJWT } from 'jose';
import { assertDisposable, request, response } from './mfa-impersonation-postgres.helpers';
import allocations from '../../pages/api/accounting/customer-allocations';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
const CO = randomUUID();
const CUSTOMER = randomUUID();
const USER = randomUUID();
let jwt = '';

/** An approved invoice for R115.00 with `paid` already received. */
async function invoice(total = 115, paid = 0): Promise<string> {
  const id = randomUUID();
  await pool.query(
    `INSERT INTO customer_invoices (id, company_id, invoice_number, customer_id, client_id, invoice_date,
       subtotal, tax_amount, total_amount, amount_paid, status, created_by)
     VALUES ($1, $2, $3, $4, $4, CURRENT_DATE, $5, 0, $5, $6, 'approved', $7)`,
    [id, CO, `AC-${id.slice(0, 8)}`, CUSTOMER, total, paid, USER]);
  return id;
}

/** A confirmed receipt for R1000.00, so the invoice's balance, not the receipt, is what limits. */
async function receipt(): Promise<string> {
  const id = randomUUID();
  await pool.query(
    `INSERT INTO customer_payments (id, company_id, client_id, payment_date, total_amount, payment_method, status, created_by)
     VALUES ($1, $2, $3, CURRENT_DATE, 1000, 'eft', 'confirmed', $4)`, [id, CO, CUSTOMER, USER]);
  return id;
}

async function post(paymentId: string, invoiceId: string, amount: number) {
  const req = request({ 'sb-access-token': jwt, active_company_id: CO }, 'POST') as never as { body: unknown; url: string };
  req.body = { paymentId, allocations: [{ invoiceId, amount }] };
  req.url = '/api/accounting/customer-allocations';
  const out = response();
  await allocations(req as never, out.res as never);
  return out.state as { statusCode: number; body: { error?: { message?: string } } };
}

const paidOf = async (id: string) => Number((await pool.query('SELECT amount_paid FROM customer_invoices WHERE id = $1', [id])).rows[0].amount_paid);
const rowsFor = async (paymentId: string) => (await pool.query(
  'SELECT count(*)::int AS n FROM customer_payment_allocations WHERE payment_id = $1', [paymentId])).rows[0].n as number;

beforeAll(async () => {
  await pool.query('INSERT INTO companies (id, name, is_active) VALUES ($1, $2, true)', [CO, 'AR cent over']);
  await pool.query('INSERT INTO customers (id, company_id, name) VALUES ($1, $2, $3)', [CUSTOMER, CO, 'AR cent over customer']);
  await pool.query("INSERT INTO users (id, email, role, is_active) VALUES ($1, $2, 'admin', true)", [USER, `acent-${USER}@isaflow.test`]);
  await pool.query("INSERT INTO company_users (company_id, user_id, role, is_default) VALUES ($1, $2, 'admin', true)", [CO, USER]);
  jwt = await new SignJWT({ sub: USER, aal: 'aal2' }).setProtectedHeader({ alg: 'HS256' })
    .setExpirationTime('1h').sign(new TextEncoder().encode(process.env.JWT_SECRET));
});

afterAll(async () => {
  try {
    await pool.query('DELETE FROM customer_payment_allocations WHERE payment_id IN (SELECT id FROM customer_payments WHERE company_id = $1)', [CO]);
    for (const t of ['customer_payments', 'customer_invoices', 'company_users', 'customers']) {
      await pool.query(`DELETE FROM ${t} WHERE company_id = $1`, [CO]);
    }
    await pool.query('DELETE FROM companies WHERE id = $1', [CO]);
    await pool.query('DELETE FROM users WHERE id = $1', [USER]);
  } finally {
    await pool.end();
  }
});

it('a cent over the balance is a 400 naming the balance, and nothing is written', async () => {
  const inv = await invoice(115, 0);
  const pay = await receipt();
  const r = await post(pay, inv, 115.01);
  expect(r.statusCode, JSON.stringify(r.body)).toBe(400);
  expect(r.body.error?.message).toMatch(/R115\.01 exceeds the R115\.00 outstanding/);
  expect(await paidOf(inv)).toBe(0);
  expect(await rowsFor(pay)).toBe(0);
});

it('a cent over a part-paid balance is refused the same way', async () => {
  const inv = await invoice(115, 100);
  const pay = await receipt();
  expect((await post(pay, inv, 15.01)).statusCode).toBe(400);
  expect(await paidOf(inv)).toBe(100);
  expect(await rowsFor(pay)).toBe(0);
});

it('the exact balance applies, and float noise on it does not make it a refusal', async () => {
  const exact = await invoice(115, 0);
  const payA = await receipt();
  expect((await post(payA, exact, 115)).statusCode).toBe(200);
  expect(await paidOf(exact)).toBe(115);

  const noisy = await invoice(0.3, 0);
  const payB = await receipt();
  expect((await post(payB, noisy, 0.1 + 0.2)).statusCode).toBe(200);
  expect(await paidOf(noisy)).toBe(0.3);
});
