/**
 * R-167 — a portal payment link charges its own amount, capped at what the invoice still owes,
 * and a successful payment spends the link.
 *
 * paystack/create charged the invoice's whole outstanding balance and never read the link's
 * amount, so a R40.50 part-payment link showed R40.50 and charged R115. It also charged a
 * cancelled or soft-deleted invoice, sent NaN cents to the gateway on a NaN amount_paid, and a
 * negative legacy amount_paid raised the charge above the invoice total. Nothing marked a link
 * paid, so a paid link stayed payable.
 *
 * Paystack is mocked: initializeTransaction records the amount it was asked to charge; the
 * webhook is delivered signed; verifyTransaction is stubbed for the return-page route.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Readable } from 'stream';
import { createHmac, randomUUID } from 'crypto';
import { Pool } from 'pg';
import type { NextApiRequest } from 'next';
import { assertDisposable, response } from './mfa-impersonation-postgres.helpers';
import { clearSystemAccountCache } from '@/modules/accounting/services/gl/systemAccountResolver';

assertDisposable();

const h = vi.hoisted(() => ({ charged: [] as number[], verifyTransaction: vi.fn() }));
vi.mock('@/modules/billing/services/paystackClient', () => ({
  initializeTransaction: async (input: { amountCents: number; reference: string }) => {
    h.charged.push(input.amountCents);
    return { reference: input.reference, accessCode: 'ac_r167', authorizationUrl: 'https://checkout.test/r167' };
  },
  verifyTransaction: (...a: unknown[]) => h.verifyTransaction(...a),
  chargeAuthorization: vi.fn(async () => { throw new Error('Paystack must not be charged in this test'); }),
}));

const createRoute = (await import('../../pages/api/portal/payments/paystack/create')).default;
const verifyRoute = (await import('../../pages/api/portal/payments/paystack/verify')).default;
const webhook = (await import('../../pages/api/webhooks/paystack')).default;
const linkRoute = (await import('../../pages/api/portal/payment-link')).default;

const SECRET = 'sk_test_r167_disposable_secret';
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
const CO = randomUUID();
const USER = randomUUID();
const CUSTOMER = randomUUID();
const BANK = randomUUID();
const AR = randomUUID();

type Res = { statusCode: number; body: { data?: Record<string, unknown>; error?: { message?: string } } };
const call = async (route: (req: never, res: never) => unknown, req: Record<string, unknown>): Promise<Res> => {
  const out = response();
  await route({ headers: {}, cookies: {}, socket: { remoteAddress: '127.0.1.67' }, ...req } as never, out.res as never);
  return out.state as unknown as Res;
};
const create = (token: string) => call(createRoute, { method: 'POST', url: '/api/portal/payments/paystack/create', body: { token } });
const getLink = (token: string) => call(linkRoute, { method: 'GET', url: `/api/portal/payment-link?token=${token}`, query: { token } });
const verify = (ref: string) => call(verifyRoute, { method: 'GET', url: `/api/portal/payments/paystack/verify?ref=${ref}`, query: { ref } });
function deliver(reference: string, cents: number) {
  const body = JSON.stringify({ event: 'charge.success', data: {
    id: 167, reference, status: 'success', amount: cents, currency: 'ZAR', channel: 'card',
    customer: { email: 'payer@r167.test', customer_code: 'CUS_r167' } } });
  const req = Readable.from([Buffer.from(body)]) as unknown as NextApiRequest;
  Object.assign(req, { method: 'POST', headers: { 'content-type': 'application/json',
    'x-paystack-signature': createHmac('sha512', SECRET).update(body).digest('hex') } });
  const out = response();
  return (webhook as (r: never, s: never) => Promise<unknown>)(req as never, out.res as never).then(() => out.state);
}

/** An invoice for R115.00 with `paid` received (a string for NaN), and one link on it. */
async function invoiceWithLink(paid: number | string | null, linkAmount: number, extra = '') {
  const id = randomUUID();
  await pool.query(
    `INSERT INTO customer_invoices (id, company_id, customer_id, client_id, invoice_number, invoice_date,
       subtotal, tax_amount, total_amount, amount_paid, status, created_by)
     VALUES ($1, $2, $3, $3, $4, CURRENT_DATE, 100, 15, 115, $5, 'sent', $6)`,
    [id, CO, CUSTOMER, `R167-${id.slice(0, 8)}`, paid, USER]);
  if (extra) await pool.query(`UPDATE customer_invoices SET ${extra} WHERE id = $1`, [id]);
  const link = await addLink(id, linkAmount);
  return { invoiceId: id, ...link };
}
async function addLink(invoiceId: string, amount: number) {
  const { rows } = await pool.query<{ id: string; token: string }>(
    'INSERT INTO portal_payment_links (invoice_id, client_id, amount) VALUES ($1, $2, $3) RETURNING id, token',
    [invoiceId, CUSTOMER, amount]);
  return { linkId: rows[0]!.id, token: rows[0]!.token };
}
const requests = async (invoiceId: string) => (await pool.query<{ amount_cents: string; link: string | null; ref: string }>(
  `SELECT amount_cents::text, portal_payment_link_id::text AS link, paystack_reference AS ref
   FROM paystack_payment_requests WHERE customer_invoice_id = $1 ORDER BY created_at`, [invoiceId])).rows;
const linkRow = async (linkId: string) => (await pool.query<{ status: string; paid_at: Date | null; payment_reference: string | null }>(
  'SELECT status, paid_at, payment_reference FROM portal_payment_links WHERE id = $1', [linkId])).rows[0]!;

beforeAll(async () => {
  vi.stubEnv('PAYSTACK_SECRET_KEY', SECRET);
  vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://app.r167.test');
  await pool.query('INSERT INTO companies (id, name, is_active) VALUES ($1, $2, true)', [CO, 'R167 link charge']);
  await pool.query("INSERT INTO users (id, email, role, is_active, account_type) VALUES ($1, $2, 'admin', true, 'direct')",
    [USER, `r167-${USER}@isaflow.test`]);
  await pool.query("INSERT INTO company_users (company_id, user_id, role, is_default) VALUES ($1, $2, 'admin', true)", [CO, USER]);
  await pool.query('INSERT INTO customers (id, company_id, name) VALUES ($1, $2, $3)', [CUSTOMER, CO, 'R167 customer']);
  await pool.query(
    `INSERT INTO gl_accounts (id, company_id, account_code, account_name, account_type, account_subtype, normal_balance,
       is_active, is_system_account)
     VALUES ($1, $2, '1100', 'Bank', 'asset', 'bank', 'debit', true, true),
            ($3, $2, '1120', 'Accounts Receivable', 'asset', 'receivable', 'debit', true, true)`, [BANK, CO, AR]);
  clearSystemAccountCache();
});

beforeEach(() => { h.charged.length = 0; h.verifyTransaction.mockReset(); });

afterAll(async () => {
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
    vi.unstubAllEnvs();
  }
});

describe('create charges the link amount, capped at the balance', () => {
  it.each([
    ['a part-payment link on an unpaid invoice', 0, 40.5, 4050],
    ['a link over what is left after a part payment', 85, 40.5, 3000],
    ['a legacy link over a negative amount_paid (never above the total)', -50, 200, 11500],
  ] as const)('%s', async (_n, paid, linkAmount, cents) => {
    const { invoiceId, linkId, token } = await invoiceWithLink(paid, linkAmount);
    const r = await create(token);
    expect(r.statusCode, JSON.stringify(r.body)).toBe(200);
    expect(h.charged).toEqual([cents]);
    expect(await requests(invoiceId)).toEqual([expect.objectContaining({ amount_cents: String(cents), link: linkId })]);
  });

  it.each([
    ['a paid invoice', 115, '', 400],
    ['a NaN amount_paid', 'NaN', '', 400],
    ['a cancelled invoice', 0, "status = 'cancelled'", 404],
    ['a soft-deleted invoice', 0, 'deleted_at = NOW()', 404],
  ] as const)('%s is refused before the gateway is called', async (_n, paid, extra, status) => {
    const { invoiceId, token } = await invoiceWithLink(paid, 10, extra);
    const r = await create(token);
    expect(r.statusCode, JSON.stringify(r.body)).toBe(status);
    expect(h.charged).toEqual([]);
    expect(await requests(invoiceId)).toEqual([]);
  });
});

describe('the link itself must be payable', () => {
  it('an unknown token is 404', async () => {
    const r = await create('0'.repeat(64));
    expect(r.statusCode).toBe(404);
    expect(r.body.error?.message).toMatch(/^Payment link/);
    expect(h.charged).toEqual([]);
  });

  it('an expired link is refused', async () => {
    const { linkId, token } = await invoiceWithLink(0, 10);
    await pool.query("UPDATE portal_payment_links SET expires_at = NOW() - INTERVAL '1 minute' WHERE id = $1", [linkId]);
    const r = await create(token);
    expect(r.statusCode).toBe(400);
    expect(r.body.error?.message).toBe('Payment link expired');
    expect(h.charged).toEqual([]);
  });
});

describe('a completed payment spends the link it came from', () => {
  it('the webhook marks the link paid, once, and banks what was charged', async () => {
    const { invoiceId, linkId, token } = await invoiceWithLink(0, 40.5);
    const other = await addLink(invoiceId, 10);
    expect((await create(token)).statusCode).toBe(200);
    const [req] = await requests(invoiceId);
    await deliver(req!.ref, 4050);
    await deliver(req!.ref, 4050); // redelivery
    expect(await linkRow(linkId)).toMatchObject({ status: 'paid', payment_reference: req!.ref });
    expect((await linkRow(linkId)).paid_at).not.toBeNull();
    expect((await linkRow(other.linkId)).status).toBe('active');
    const paid = await pool.query('SELECT total_amount::text AS t FROM customer_payments WHERE bank_reference = $1', [req!.ref]);
    expect(paid.rows).toEqual([{ t: '40.50' }]);
    expect((await getLink(token)).statusCode).toBe(404);
    const again = await create(token);
    expect(again.statusCode).toBe(400);
    expect(again.body.error?.message).toBe('Payment link not active');
  });

  it('a link cancelled after checkout started is not turned into a paid one', async () => {
    const { invoiceId, linkId, token } = await invoiceWithLink(0, 20);
    expect((await create(token)).statusCode).toBe(200);
    await pool.query("UPDATE portal_payment_links SET status = 'cancelled' WHERE id = $1", [linkId]);
    const [req] = await requests(invoiceId);
    await deliver(req!.ref, 2000);
    expect((await linkRow(linkId)).status).toBe('cancelled');
  });

  it('the verify route marks the link paid when it settles first', async () => {
    const { invoiceId, linkId, token } = await invoiceWithLink(0, 20);
    expect((await create(token)).statusCode).toBe(200);
    const [req] = await requests(invoiceId);
    h.verifyTransaction.mockResolvedValue({ status: 'success', id: 1671, paidAt: new Date().toISOString(), channel: 'card' });
    expect((await verify(req!.ref)).statusCode).toBe(200);
    expect(await linkRow(linkId)).toMatchObject({ status: 'paid', payment_reference: req!.ref });
  });

  it('a request with no link (made before R-167) settles and touches no link', async () => {
    const { invoiceId, linkId } = await invoiceWithLink(0, 20);
    const ref = `r167_legacy_${randomUUID().slice(0, 8)}`;
    await pool.query(`INSERT INTO paystack_payment_requests (company_id, purpose, customer_invoice_id, paystack_reference,
      amount_cents, status) VALUES ($1, 'customer_invoice', $2, $3, 2000, 'pending')`, [CO, invoiceId, ref]);
    await deliver(ref, 2000);
    expect((await linkRow(linkId)).status).toBe('active');
  });
});

describe('the pay page shows what will be charged', () => {
  it('the public GET gives the link amount capped at the balance', async () => {
    const { token } = await invoiceWithLink(85, 40.5);
    const r = await getLink(token);
    expect(r.statusCode).toBe(200);
    expect(r.body.data?.amount).toBe(30);
  });

  it.each([['paid', 115, ''], ['cancelled', 0, "status = 'cancelled'"]] as const)(
    'a link on a %s invoice is not offered for payment', async (_n, paid, extra) => {
      const { token } = await invoiceWithLink(paid, 10, extra);
      expect((await getLink(token)).statusCode).toBe(404);
    });
});
