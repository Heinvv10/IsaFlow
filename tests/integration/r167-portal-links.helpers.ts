/**
 * R-167 fixture and callers shared by the portal payment-link suites. Each suite mocks
 * `@/modules/billing/services/paystackClient` itself; the routes are imported lazily here, so
 * they resolve against that mock.
 */
import { Readable } from 'stream';
import { createHmac, randomUUID } from 'crypto';
import { Pool } from 'pg';
import type { NextApiRequest } from 'next';
import { response } from './mfa-impersonation-postgres.helpers';

export const SECRET = 'sk_test_r167_disposable_secret';
export const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
export const CO = randomUUID();
export const USER = randomUUID();
export const CUSTOMER = randomUUID();
/** One address per run: verify rate-limits per IP, and its counter outlives a run. */
const IP = `10.${[0, 0, 0].map(() => Math.floor(Math.random() * 250) + 1).join('.')}`;

export type Res = { statusCode: number; body: { data?: Record<string, unknown>; error?: { message?: string } } };
type Route = (req: never, res: never) => unknown;
const route = async (path: string) => (await import(path)).default as Route;

export async function call(handler: Route, req: Record<string, unknown>, ip = IP): Promise<Res> {
  const out = response();
  await handler({ headers: {}, cookies: {}, socket: { remoteAddress: ip }, ...req } as never, out.res as never);
  return out.state as unknown as Res;
}
/** A client address no request in this run has used (the limiter caches per address in-process). */
export const freshIp = () => `10.${[0, 0, 0].map(() => Math.floor(Math.random() * 250) + 1).join('.')}`;
export const create = async (token: string, ip = IP) => call(await route('../../pages/api/portal/payments/paystack/create'),
  { method: 'POST', url: '/api/portal/payments/paystack/create', body: { token } }, ip);
export const getLink = async (token: string) => call(await route('../../pages/api/portal/payment-link'),
  { method: 'GET', url: `/api/portal/payment-link?token=${token}`, query: { token } });
export const verify = async (ref: string) => call(await route('../../pages/api/portal/payments/paystack/verify'),
  { method: 'GET', url: `/api/portal/payments/paystack/verify?ref=${ref}`, query: { ref } });

export async function deliver(reference: string, cents: number) {
  const webhook = await route('../../pages/api/webhooks/paystack');
  const body = JSON.stringify({ event: 'charge.success', data: {
    id: 167, reference, status: 'success', amount: cents, currency: 'ZAR', channel: 'card',
    customer: { email: 'payer@r167.test', customer_code: 'CUS_r167' } } });
  const req = Readable.from([Buffer.from(body)]) as unknown as NextApiRequest;
  Object.assign(req, { method: 'POST', headers: { 'content-type': 'application/json',
    'x-paystack-signature': createHmac('sha512', SECRET).update(body).digest('hex') } });
  const out = response();
  await (webhook as (r: never, s: never) => Promise<unknown>)(req as never, out.res as never);
  return out.state;
}

/** An invoice for R115.00 with `paid` received (a string for NaN), and one link on it. */
export async function invoiceWithLink(paid: number | string | null, linkAmount: number, extra = '', chargesBalance = false) {
  const id = randomUUID();
  await pool.query(
    `INSERT INTO customer_invoices (id, company_id, customer_id, client_id, invoice_number, invoice_date,
       subtotal, tax_amount, total_amount, amount_paid, status, created_by)
     VALUES ($1, $2, $3, $3, $4, CURRENT_DATE, 100, 15, 115, $5, 'sent', $6)`,
    [id, CO, CUSTOMER, `R167-${id.slice(0, 8)}`, paid, USER]);
  if (extra) await pool.query(`UPDATE customer_invoices SET ${extra} WHERE id = $1`, [id]);
  return { invoiceId: id, ...(await addLink(id, linkAmount, chargesBalance)) };
}
export async function addLink(invoiceId: string, amount: number, chargesBalance = false) {
  const { rows } = await pool.query<{ id: string; token: string }>(
    `INSERT INTO portal_payment_links (invoice_id, client_id, amount, charges_balance)
     VALUES ($1, $2, $3, $4) RETURNING id, token`, [invoiceId, CUSTOMER, amount, chargesBalance]);
  return { linkId: rows[0]!.id, token: rows[0]!.token };
}
export const requests = async (invoiceId: string) => (await pool.query<{ amount_cents: string; link: string | null; ref: string }>(
  `SELECT amount_cents::text, portal_payment_link_id::text AS link, paystack_reference AS ref
   FROM paystack_payment_requests WHERE customer_invoice_id = $1 ORDER BY created_at`, [invoiceId])).rows;
export const linkRow = async (linkId: string) => (await pool.query<{ status: string; paid_at: Date | null; payment_reference: string | null; charges_balance: boolean }>(
  'SELECT status, paid_at, payment_reference, charges_balance FROM portal_payment_links WHERE id = $1', [linkId])).rows[0]!;

export async function seedCompany(): Promise<void> {
  await pool.query('INSERT INTO companies (id, name, is_active) VALUES ($1, $2, true)', [CO, 'R167 link charge']);
  await pool.query("INSERT INTO users (id, email, role, is_active, account_type) VALUES ($1, $2, 'admin', true, 'direct')",
    [USER, `r167-${USER}@isaflow.test`]);
  await pool.query("INSERT INTO company_users (company_id, user_id, role, is_default) VALUES ($1, $2, 'admin', true)", [CO, USER]);
  await pool.query('INSERT INTO customers (id, company_id, name) VALUES ($1, $2, $3)', [CUSTOMER, CO, 'R167 customer']);
  await pool.query(
    `INSERT INTO gl_accounts (id, company_id, account_code, account_name, account_type, account_subtype, normal_balance,
       is_active, is_system_account)
     VALUES ($1, $2, '1100', 'Bank', 'asset', 'bank', 'debit', true, true),
            ($3, $2, '1120', 'Accounts Receivable', 'asset', 'receivable', 'debit', true, true)`,
    [randomUUID(), CO, randomUUID()]);
}

export async function cleanupCompany(): Promise<void> {
  try {
    await pool.query('DELETE FROM paystack_webhook_events WHERE reference IN (SELECT paystack_reference FROM paystack_payment_requests WHERE company_id = $1)', [CO]);
    await pool.query('DELETE FROM paystack_payment_requests WHERE company_id = $1', [CO]);
    await pool.query('DELETE FROM customer_payment_allocations WHERE payment_id IN (SELECT id FROM customer_payments WHERE company_id = $1)', [CO]);
    await pool.query('DELETE FROM customer_payments WHERE company_id = $1', [CO]);
    await pool.query('DELETE FROM gl_journal_lines WHERE company_id = $1', [CO]);
    await pool.query('DELETE FROM gl_journal_entries WHERE company_id = $1', [CO]);
    await pool.query('DELETE FROM gl_account_balances WHERE gl_account_id IN (SELECT id FROM gl_accounts WHERE company_id = $1)', [CO]);
    await pool.query('DELETE FROM portal_payment_links WHERE invoice_id IN (SELECT id FROM customer_invoices WHERE company_id = $1)', [CO]);
    for (const t of ['customer_invoices', 'fiscal_periods', 'gl_accounts', 'company_users', 'customers']) {
      await pool.query(`DELETE FROM ${t} WHERE company_id = $1`, [CO]);
    }
    await pool.query('DELETE FROM companies WHERE id = $1', [CO]);
    await pool.query('DELETE FROM users WHERE id = $1', [USER]);
  } finally {
    await pool.end();
  }
}
