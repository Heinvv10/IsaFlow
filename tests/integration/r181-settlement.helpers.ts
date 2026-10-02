/**
 * R-181 fixture: two companies, each with a bank and a receivable account, invoices and Paystack
 * requests written straight into the tables, and callers for the signed webhook and the return
 * page's verify route. The suite mocks `@/modules/billing/services/paystackClient`; the routes are
 * imported lazily, so they resolve against that mock.
 */
import { Readable } from 'stream';
import { createHmac, randomUUID } from 'crypto';
import { Pool } from 'pg';
import type { NextApiRequest } from 'next';
import { response } from './mfa-impersonation-postgres.helpers';

export const SECRET = 'sk_test_r181_disposable_secret';
export const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });

export interface Co { id: string; user: string; customer: string }
export const A: Co = { id: randomUUID(), user: randomUUID(), customer: randomUUID() };
export const B: Co = { id: randomUUID(), user: randomUUID(), customer: randomUUID() };

type Route = (req: never, res: never) => unknown;
const route = async (path: string) => (await import(path)).default as Route;
/** A client address no request in this run has used: verify rate-limits per address. */
const freshIp = () => `10.${[0, 0, 0].map(() => Math.floor(Math.random() * 250) + 1).join('.')}`;

export async function verify(ref: string): Promise<{ statusCode: number; body: { data?: { status?: string } } }> {
  const handler = await route('../../pages/api/portal/payments/paystack/verify');
  const out = response();
  await handler({ method: 'GET', url: `/api/portal/payments/paystack/verify?ref=${ref}`, query: { ref },
    headers: {}, cookies: {}, socket: { remoteAddress: freshIp() } } as never, out.res as never);
  return out.state as never;
}

/** A signed charge.success carrying what Paystack says it received. */
export async function deliver(reference: string, cents: number, currency = 'ZAR'): Promise<{ statusCode: number }> {
  const webhook = await route('../../pages/api/webhooks/paystack');
  const body = JSON.stringify({ event: 'charge.success', data: {
    id: 181, reference, status: 'success', amount: cents, currency, channel: 'card',
    customer: { email: 'payer@r181.test', customer_code: 'CUS_r181' } } });
  const req = Readable.from([Buffer.from(body)]) as unknown as NextApiRequest;
  Object.assign(req, { method: 'POST', headers: { 'content-type': 'application/json',
    'x-paystack-signature': createHmac('sha512', SECRET).update(body).digest('hex') } });
  const out = response();
  await (webhook as (r: never, s: never) => Promise<unknown>)(req as never, out.res as never);
  return out.state;
}

/** An R115.00 invoice in `co` at `status`, nothing paid; `deleted` soft-deletes it. */
export async function invoice(co: Co, status = 'sent', deleted = false): Promise<string> {
  const id = randomUUID();
  await pool.query(
    `INSERT INTO customer_invoices (id, company_id, customer_id, client_id, invoice_number, invoice_date,
       subtotal, tax_amount, total_amount, amount_paid, status, created_by, deleted_at)
     VALUES ($1, $2, $3, $3, $4, CURRENT_DATE, 100, 15, 115, 0, $5, $6, CASE WHEN $7 THEN NOW() END)`,
    [id, co.id, co.customer, `R181-${id.slice(0, 8)}`, status, co.user, deleted]);
  return id;
}

/** A pending customer-invoice checkout in `co` for `cents`; returns its reference. */
export async function checkout(co: Co, invoiceId: string, cents = 11500): Promise<string> {
  const ref = `r181_${randomUUID().slice(0, 12)}`;
  await pool.query(
    `INSERT INTO paystack_payment_requests (company_id, purpose, customer_invoice_id, paystack_reference, amount_cents, status)
     VALUES ($1, 'customer_invoice', $2, $3, $4, 'pending')`, [co.id, invoiceId, ref, cents]);
  return ref;
}

export interface Settlement {
  payments: { total: string; allocated: string; status: string }[];
  bankDebit: string;
  invoicePaid: string;
  review: string | null;
}

/** What one reference left behind in `co`: receipts, their allocations, the bank leg, the flag. */
export async function settlement(co: Co, ref: string, invoiceId: string): Promise<Settlement> {
  const payments = (await pool.query<{ total: string; allocated: string; status: string }>(
    `SELECT cp.total_amount::text AS total, COALESCE(SUM(a.amount_allocated), 0)::numeric(15,2)::text AS allocated, cp.status
     FROM customer_payments cp LEFT JOIN customer_payment_allocations a ON a.payment_id = cp.id
     WHERE cp.company_id = $1 AND cp.bank_reference = $2 GROUP BY cp.id`, [co.id, ref])).rows;
  const bank = await pool.query<{ d: string }>(
    `SELECT COALESCE(SUM(l.debit), 0)::numeric(15,2)::text AS d FROM gl_journal_lines l
     JOIN gl_journal_entries e ON e.id = l.journal_entry_id
     JOIN customer_payments cp ON cp.gl_journal_entry_id = e.id
     JOIN gl_accounts g ON g.id = l.gl_account_id AND g.account_subtype = 'bank'
     WHERE cp.company_id = $1 AND cp.bank_reference = $2`, [co.id, ref]);
  const inv = await pool.query<{ p: string }>('SELECT amount_paid::text AS p FROM customer_invoices WHERE id = $1', [invoiceId]);
  const pr = await pool.query<{ r: string | null }>(
    'SELECT failure_reason AS r FROM paystack_payment_requests WHERE paystack_reference = $1', [ref]);
  return { payments, bankDebit: bank.rows[0]!.d, invoicePaid: inv.rows[0]!.p, review: pr.rows[0]?.r ?? null };
}

export async function seed(co: Co): Promise<void> {
  await pool.query('INSERT INTO companies (id, name, is_active) VALUES ($1, $2, true)', [co.id, `R181 ${co.id.slice(0, 8)}`]);
  await pool.query("INSERT INTO users (id, email, role, is_active, account_type) VALUES ($1, $2, 'admin', true, 'direct')",
    [co.user, `r181-${co.user}@isaflow.test`]);
  await pool.query("INSERT INTO company_users (company_id, user_id, role, is_default) VALUES ($1, $2, 'admin', true)", [co.id, co.user]);
  await pool.query('INSERT INTO customers (id, company_id, name) VALUES ($1, $2, $3)', [co.customer, co.id, 'R181 customer']);
  await pool.query(
    `INSERT INTO gl_accounts (id, company_id, account_code, account_name, account_type, account_subtype, normal_balance,
       is_active, is_system_account)
     VALUES ($1, $2, '1100', 'Bank', 'asset', 'bank', 'debit', true, true),
            ($3, $2, '1120', 'Accounts Receivable', 'asset', 'receivable', 'debit', true, true)`,
    [randomUUID(), co.id, randomUUID()]);
}

export async function cleanup(cos: Co[]): Promise<void> {
  try {
    for (const co of cos) {
      await pool.query('DELETE FROM paystack_webhook_events WHERE reference IN (SELECT paystack_reference FROM paystack_payment_requests WHERE company_id = $1)', [co.id]);
      await pool.query('DELETE FROM paystack_payment_requests WHERE company_id = $1', [co.id]);
      await pool.query('DELETE FROM customer_payment_allocations WHERE payment_id IN (SELECT id FROM customer_payments WHERE company_id = $1)', [co.id]);
      await pool.query('DELETE FROM customer_payments WHERE company_id = $1', [co.id]);
      await pool.query('DELETE FROM gl_journal_lines WHERE company_id = $1', [co.id]);
      await pool.query('DELETE FROM gl_journal_entries WHERE company_id = $1', [co.id]);
      await pool.query('DELETE FROM gl_account_balances WHERE gl_account_id IN (SELECT id FROM gl_accounts WHERE company_id = $1)', [co.id]);
      for (const t of ['customer_invoices', 'fiscal_periods', 'gl_accounts', 'company_users', 'customers']) {
        await pool.query(`DELETE FROM ${t} WHERE company_id = $1`, [co.id]);
      }
      await pool.query('DELETE FROM companies WHERE id = $1', [co.id]);
      await pool.query('DELETE FROM users WHERE id = $1', [co.user]);
    }
  } finally {
    await pool.end();
  }
}
