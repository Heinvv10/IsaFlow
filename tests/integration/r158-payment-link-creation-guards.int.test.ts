/**
 * R-158 — the two other routes that create a portal payment link (found by the
 * R-155..R-157 adversarial review), driven through the real routes (withAuth as
 * app_user, withErrorHandler, withCsrf, withWriteAccess):
 *
 * - POST /api/accounting/customer-invoices/[id]/pay-now cast a non-UUID id (500)
 *   and created a link for a cancelled or soft-deleted invoice;
 * - POST /api/accounting/payment-gateway cast a non-UUID invoiceId (500), and
 *   enableOnlinePayment linked `ci.client_id` only (a legacy invoice holding its
 *   customer in customer_id 500'd on the NOT NULL column), with no status,
 *   deleted_at or balance filter, and threw (500) for an unknown invoice.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import { randomUUID } from 'crypto';
import { SignJWT } from 'jose';
import payNow from '../../pages/api/accounting/customer-invoices/[id]/pay-now';
import paymentGateway from '../../pages/api/accounting/payment-gateway';
import { assertDisposable, request, response } from './mfa-impersonation-postgres.helpers';

vi.mock('@/modules/billing/services/paystackClient', () => ({
  initializeTransaction: vi.fn(async ({ reference }: { reference: string }) => ({
    reference, accessCode: 'r158-access', authorizationUrl: 'https://checkout.example.test/r158',
  })),
}));

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
const CO = randomUUID();
const CUSTOMER = randomUUID();
const USER = randomUUID();
const VIEWER = randomUUID();
let jwt = '';
let viewerJwt = '';
const appUrlBefore = process.env.NEXT_PUBLIC_APP_URL;

type Handler = (req: never, res: never) => Promise<unknown> | unknown;
interface InvoiceOpts { status?: string; deleted?: boolean; paid?: number; legacyCustomerOnly?: boolean }

async function invoice(opts: InvoiceOpts = {}): Promise<string> {
  const id = randomUUID();
  await pool.query(
    `INSERT INTO customer_invoices (id, company_id, invoice_number, customer_id, client_id, invoice_date,
       subtotal, tax_amount, total_amount, amount_paid, status, created_by, deleted_at)
     VALUES ($1, $2, $3, $4, $5, CURRENT_DATE, 100, 15, 115, $6, $7, $8, $9)`,
    [id, CO, `R158-${id.slice(0, 8)}`, CUSTOMER, opts.legacyCustomerOnly ? null : CUSTOMER, opts.paid ?? 0,
      opts.status ?? 'approved', USER, opts.deleted ? new Date() : null]);
  return id;
}

interface As { viewer?: boolean; csrf?: boolean }

async function call(handler: Handler, query: Record<string, unknown>, body: Record<string, unknown>, as: As = {}) {
  const req = request({ 'sb-access-token': as.viewer ? viewerJwt : jwt, active_company_id: CO }, 'POST') as never as {
    body: unknown; query: Record<string, unknown>; headers: Record<string, string>;
  };
  if (as.csrf === false) delete req.headers['x-csrf-token'];
  req.query = query;
  req.body = body;
  const out = response();
  await handler(req as never, out.res as never);
  return out.state as { statusCode: number; body: unknown };
}

const links = async (invoiceId: string) => (await pool.query(
  'SELECT client_id, amount FROM portal_payment_links WHERE invoice_id = $1', [invoiceId])).rows as
  Array<{ client_id: string; amount: string }>;

const ROUTES = [
  // pay-now answers 400 for a paid invoice (its own balance check); enableOnlinePayment folds
  // "no balance" into its one not-eligible result, a 404.
  { name: 'pay-now', paidStatus: 400, send: (id: unknown, as?: As) => call(payNow as Handler, { id }, {}, as) },
  { name: 'payment-gateway enable', paidStatus: 404,
    send: (id: unknown, as?: As) => call(paymentGateway as Handler, {}, { invoiceId: id, action: 'enable' }, as) },
];

beforeAll(async () => {
  process.env.NEXT_PUBLIC_APP_URL = 'https://app.r158.example.test';
  await pool.query('INSERT INTO companies (id, name, is_active) VALUES ($1, $2, true)', [CO, 'R158 payment links']);
  await pool.query('INSERT INTO customers (id, company_id, name) VALUES ($1, $2, $3)', [CUSTOMER, CO, 'R158 customer']);
  await pool.query("INSERT INTO users (id, email, role, is_active) VALUES ($1, $2, 'admin', true)",
    [USER, `r158-${USER}@isaflow.test`]);
  await pool.query("INSERT INTO company_users (company_id, user_id, role, is_default) VALUES ($1, $2, 'admin', true)",
    [CO, USER]);
  await pool.query("INSERT INTO users (id, email, role, is_active) VALUES ($1, $2, 'viewer', true)",
    [VIEWER, `r158-viewer-${VIEWER}@isaflow.test`]);
  await pool.query("INSERT INTO company_users (company_id, user_id, role, is_default) VALUES ($1, $2, 'viewer', true)",
    [CO, VIEWER]);
  viewerJwt = await new SignJWT({ sub: VIEWER, aal: 'aal2' }).setProtectedHeader({ alg: 'HS256' })
    .setExpirationTime('1h').sign(new TextEncoder().encode(process.env.JWT_SECRET));
  jwt = await new SignJWT({ sub: USER, aal: 'aal2' }).setProtectedHeader({ alg: 'HS256' })
    .setExpirationTime('1h').sign(new TextEncoder().encode(process.env.JWT_SECRET));
});

afterAll(async () => {
  process.env.NEXT_PUBLIC_APP_URL = appUrlBefore;
  try {
    await pool.query(
      'DELETE FROM portal_payment_links WHERE invoice_id IN (SELECT id FROM customer_invoices WHERE company_id = $1)', [CO]);
    for (const t of ['paystack_payment_requests', 'customer_invoices', 'company_document_numbers', 'company_users', 'customers']) {
      await pool.query(`DELETE FROM ${t} WHERE company_id = $1`, [CO]);
    }
    await pool.query('DELETE FROM companies WHERE id = $1', [CO]);
    await pool.query('DELETE FROM users WHERE id = ANY($1)', [[USER, VIEWER]]);
  } finally {
    await pool.end();
  }
});

describe.each(ROUTES)('R-158 $name', (route) => {
  it.each([
    ['a viewer', { viewer: true }],
    ['a request without the CSRF header', { csrf: false }],
  ] as const)('refuses %s (403) before any write', async (_label, as) => {
    const id = await invoice();
    const state = await route.send(id, as);
    expect(state.statusCode, JSON.stringify(state.body)).toBe(403);
    expect(await links(id)).toEqual([]);
    const { rows } = await pool.query(
      'SELECT online_payment_enabled, payment_url FROM customer_invoices WHERE id = $1', [id]);
    expect(rows[0]).toEqual({ online_payment_enabled: false, payment_url: null });
  });

  it('creates a link for an open invoice (200)', async () => {
    const id = await invoice();
    const state = await route.send(id);
    expect(state.statusCode, JSON.stringify(state.body)).toBe(200);
    expect(await links(id)).toEqual([{ client_id: CUSTOMER, amount: '115.00' }]);
  });

  it('links the customer held only in the legacy customer_id column', async () => {
    const id = await invoice({ legacyCustomerOnly: true });
    const state = await route.send(id);
    expect(state.statusCode, JSON.stringify(state.body)).toBe(200);
    expect((await links(id)).map((l) => l.client_id)).toEqual([CUSTOMER]);
  });

  it.each(['not-a-uuid', ['00000000-0000-4000-8000-000000000001']])('answers 400, not 500, for id %j', async (bad) => {
    const state = await route.send(bad);
    expect(state.statusCode, JSON.stringify(state.body)).toBe(400);
  });

  it.each([
    ['a cancelled invoice', { status: 'cancelled' }],
    ['a soft-deleted invoice', { deleted: true }],
  ] as const)('refuses %s (404), creating no link', async (_label, opts) => {
    const id = await invoice(opts);
    const state = await route.send(id);
    expect(state.statusCode, JSON.stringify(state.body)).toBe(404);
    expect(await links(id)).toEqual([]);
  });

  it('refuses an unknown invoice (404, not 500)', async () => {
    const state = await route.send(randomUUID());
    expect(state.statusCode, JSON.stringify(state.body)).toBe(404);
  });

  it('refuses a fully paid invoice, creating no link', async () => {
    const id = await invoice({ paid: 115 });
    const state = await route.send(id);
    expect(state.statusCode, JSON.stringify(state.body)).toBe(route.paidStatus);
    expect(await links(id)).toEqual([]);
  });
});
