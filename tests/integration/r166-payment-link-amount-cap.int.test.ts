/**
 * R-166 — a payment link may not ask for more than the invoice still owes.
 *
 * POST /api/portal/payment-link accepted any amount up to the column's maximum, so a link on a
 * fully paid invoice (INV-00553 on prod) or one larger than the balance could be paid. It now
 * refuses amount > total_amount - COALESCE(amount_paid, 0) with 400, before any write. A part
 * payment, up to the balance, is still allowed.
 *
 * Runs through the real route: withAuth as app_user with RLS, withCsrf, withWriteAccess.
 */
import { afterAll, beforeAll, expect, it } from 'vitest';
import { Pool } from 'pg';
import { randomUUID } from 'crypto';
import { SignJWT } from 'jose';
import { assertDisposable, request, response } from './mfa-impersonation-postgres.helpers';
import paymentLink from '../../pages/api/portal/payment-link';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
const CO = randomUUID();
const CUSTOMER = randomUUID();
const USER = randomUUID();
let jwt = '';

/** An approved invoice for R115.00, with `paid` already received (null leaves the column NULL). */
async function invoice(paid: number | null): Promise<string> {
  const id = randomUUID();
  await pool.query(
    `INSERT INTO customer_invoices (id, company_id, invoice_number, customer_id, client_id, invoice_date,
       subtotal, tax_amount, total_amount, amount_paid, status, created_by)
     VALUES ($1, $2, $3, $4, $4, CURRENT_DATE, 100, 15, 115, $5, 'approved', $6)`,
    [id, CO, `R166-${id.slice(0, 8)}`, CUSTOMER, paid, USER]);
  return id;
}

async function post(invoiceId: string, amount: number | string) {
  const req = request({ 'sb-access-token': jwt, active_company_id: CO }, 'POST') as never as { body: unknown; url: string };
  req.body = { invoiceId, clientId: CUSTOMER, amount };
  req.url = '/api/portal/payment-link';
  const out = response();
  await paymentLink(req as never, out.res as never);
  return out.state as { statusCode: number; body: { success?: boolean; error?: { message?: string } } };
}

const links = async (invoiceId: string) => (await pool.query(
  'SELECT amount::text AS amount FROM portal_payment_links WHERE invoice_id = $1 ORDER BY amount', [invoiceId]))
  .rows.map((r: { amount: string }) => r.amount);

beforeAll(async () => {
  await pool.query('INSERT INTO companies (id, name, is_active) VALUES ($1, $2, true)', [CO, 'R166 amount cap']);
  await pool.query('INSERT INTO customers (id, company_id, name) VALUES ($1, $2, $3)', [CUSTOMER, CO, 'R166 customer']);
  await pool.query("INSERT INTO users (id, email, role, is_active) VALUES ($1, $2, 'admin', true)",
    [USER, `r166-${USER}@isaflow.test`]);
  await pool.query("INSERT INTO company_users (company_id, user_id, role, is_default) VALUES ($1, $2, 'admin', true)",
    [CO, USER]);
  jwt = await new SignJWT({ sub: USER, aal: 'aal2' }).setProtectedHeader({ alg: 'HS256' })
    .setExpirationTime('1h').sign(new TextEncoder().encode(process.env.JWT_SECRET));
});

afterAll(async () => {
  try {
    await pool.query(
      'DELETE FROM portal_payment_links WHERE invoice_id IN (SELECT id FROM customer_invoices WHERE company_id = $1)', [CO]);
    for (const t of ['customer_invoices', 'company_users', 'customers']) {
      await pool.query(`DELETE FROM ${t} WHERE company_id = $1`, [CO]);
    }
    await pool.query('DELETE FROM companies WHERE id = $1', [CO]);
    await pool.query('DELETE FROM users WHERE id = $1', [USER]);
  } finally {
    await pool.end();
  }
});

it('an unpaid invoice: the full balance and a part payment are allowed, a cent over is refused', async () => {
  const id = await invoice(0);
  for (const amount of [115.01, '115.01', 116]) {
    const r = await post(id, amount);
    expect(r.statusCode, JSON.stringify({ amount, body: r.body })).toBe(400);
    expect(r.body.error?.message).toMatch(/outstanding balance of 115\.00/);
  }
  expect(await links(id)).toEqual([]);
  for (const amount of [115, '115.00', 40.5]) {
    const r = await post(id, amount);
    expect(r.statusCode, JSON.stringify({ amount, body: r.body })).toBe(200);
  }
  expect(await links(id)).toEqual(['115.00', '115.00', '40.50']);
});

it('a part-paid invoice is capped at what is still owed', async () => {
  const id = await invoice(100);
  const over = await post(id, 15.01);
  expect(over.statusCode).toBe(400);
  expect(over.body.error?.message).toMatch(/outstanding balance of 15\.00$/);
  expect((await post(id, 115)).statusCode).toBe(400);
  expect(await links(id)).toEqual([]);
  expect((await post(id, 15)).statusCode).toBe(200);
  expect((await post(id, 0.01)).statusCode).toBe(200);
  expect(await links(id)).toEqual(['0.01', '15.00']);
});

it('a fully paid or overpaid invoice gets no link at all', async () => {
  for (const paid of [115, 120]) {
    const id = await invoice(paid);
    const r = await post(id, 0.01);
    expect(r.statusCode, JSON.stringify({ paid, body: r.body })).toBe(400);
    expect(await links(id)).toEqual([]);
  }
});

it('a negative amount_paid counts as nothing paid, so the cap never exceeds the total', async () => {
  const id = await invoice(-50);
  const over = await post(id, 115.01);
  expect(over.statusCode).toBe(400);
  expect(over.body.error?.message).toMatch(/outstanding balance of 115\.00$/);
  expect((await post(id, 165)).statusCode).toBe(400);
  expect(await links(id)).toEqual([]);
  expect((await post(id, 115)).statusCode).toBe(200);
  expect(await links(id)).toEqual(['115.00']);
});

it('a NaN balance is refused, not treated as unlimited', async () => {
  const id = await invoice(0);
  await pool.query("UPDATE customer_invoices SET amount_paid = 'NaN' WHERE id = $1", [id]);
  const r = await post(id, 0.01);
  expect(r.statusCode, JSON.stringify(r.body)).toBe(400);
  expect(await links(id)).toEqual([]);
});

it('a soft-deleted invoice gets no link (404), like pay-now and payment-gateway', async () => {
  const id = await invoice(0);
  await pool.query('UPDATE customer_invoices SET deleted_at = NOW() WHERE id = $1', [id]);
  expect((await post(id, 10)).statusCode).toBe(404);
  expect(await links(id)).toEqual([]);
});

it('a NULL amount_paid counts as nothing paid', async () => {
  const id = await invoice(null);
  const over = await post(id, 115.01);
  expect(over.statusCode).toBe(400);
  expect(over.body.error?.message).toMatch(/outstanding balance of 115\.00$/);
  expect(await links(id)).toEqual([]);
  expect((await post(id, 115)).statusCode).toBe(200);
  expect(await links(id)).toEqual(['115.00']);
});
