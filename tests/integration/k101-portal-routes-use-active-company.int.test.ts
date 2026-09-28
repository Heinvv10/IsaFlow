/**
 * K-101 — the three authenticated portal actions must act in the ACTIVE company.
 *
 * POST /api/portal/invoice/generate, POST /api/portal/invoice/[token] (the
 * internal generate action) and POST /api/portal/payment-link re-derived the
 * company from `company_users ORDER BY is_default DESC` instead of taking
 * withAuth's active company. A user in two companies whose active company is
 * not their default got a 404 for an invoice on the screen in front of them,
 * and no token or link was written.
 *
 * Driven through the real handlers: withAuth (app_user, RLS, the membership
 * check) and withErrorHandler. Each route is asserted in both directions — the
 * active company's invoice is served and written, and an invoice in the user's
 * OTHER company (default or not) is a 404 with nothing written, because
 * withAuth COMMITs a 4xx.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { randomUUID } from 'crypto';
import { SignJWT } from 'jose';
import generate from '../../pages/api/portal/invoice/generate';
import tokenRoute from '../../pages/api/portal/invoice/[token]';
import paymentLink from '../../pages/api/portal/payment-link';
import { assertDisposable, request, response } from './mfa-impersonation-postgres.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });

/** The user's DEFAULT company. */
const DEF = randomUUID();
/** The user's other company, the one they have switched to. */
const OTHER = randomUUID();
/** A company the user does not belong to. */
const FOREIGN = randomUUID();
const USER = randomUUID();
const COMPANIES = [DEF, OTHER, FOREIGN];
const customerOf: Record<string, string> = {};
let token = '';

type Handler = (req: never, res: never) => Promise<unknown> | unknown;

interface Route {
  name: string;
  handler: Handler;
  url: string;
  query: Record<string, string>;
  body: (company: string, invoiceId: string) => Record<string, unknown>;
  /** What the route persisted for this invoice: a token or a link count. */
  written: (invoiceId: string) => Promise<number>;
}

const portalTokenSet = async (invoiceId: string) => Number((await pool.query(
  'SELECT count(*) AS n FROM customer_invoices WHERE id = $1 AND portal_token IS NOT NULL', [invoiceId])).rows[0].n);

const ROUTES: Route[] = [
  { name: 'POST /api/portal/invoice/generate', handler: generate as Handler,
    url: '/api/portal/invoice/generate', query: {},
    body: (_c, invoiceId) => ({ invoiceId }), written: portalTokenSet },
  { name: 'POST /api/portal/invoice/[token] (generate action)', handler: tokenRoute as Handler,
    url: '/api/portal/invoice/generate?action=generate', query: { token: 'generate', action: 'generate' },
    body: (_c, invoiceId) => ({ invoiceId }), written: portalTokenSet },
  { name: 'POST /api/portal/payment-link', handler: paymentLink as Handler,
    url: '/api/portal/payment-link', query: {},
    body: (c, invoiceId) => ({ invoiceId, clientId: customerOf[c], amount: 115 }),
    written: async (invoiceId) => Number((await pool.query(
      'SELECT count(*) AS n FROM portal_payment_links WHERE invoice_id = $1', [invoiceId])).rows[0].n) },
];

async function invoice(company: string): Promise<string> {
  const id = randomUUID();
  await pool.query(
    `INSERT INTO customer_invoices (id, company_id, invoice_number, customer_id, client_id, invoice_date,
       subtotal, tax_amount, total_amount, amount_paid, status, created_by)
     VALUES ($1, $2, $3, $4, $4, CURRENT_DATE, 100, 15, 115, 0, 'approved', $5)`,
    [id, company, `K101-${id.slice(0, 8)}`, customerOf[company], USER]);
  return id;
}

async function call(route: Route, activeCompany: string, body: Record<string, unknown>) {
  const req = request({ 'sb-access-token': token, active_company_id: activeCompany }, 'POST') as never as {
    body: unknown; query: Record<string, string>; url: string;
  };
  req.body = body;
  req.query = route.query;
  req.url = route.url;
  const out = response();
  await route.handler(req as never, out.res as never);
  return out.state;
}

beforeAll(async () => {
  for (const [id, name] of [[DEF, 'K101 Default'], [OTHER, 'K101 Other'], [FOREIGN, 'K101 Foreign']] as const) {
    await pool.query('INSERT INTO companies (id, name, is_active) VALUES ($1, $2, true)', [id, name]);
    customerOf[id] = randomUUID();
    await pool.query('INSERT INTO customers (id, company_id, name) VALUES ($1, $2, $3)',
      [customerOf[id], id, `${name} customer`]);
  }
  await pool.query("INSERT INTO users (id, email, role, is_active) VALUES ($1, $2, 'admin', true)",
    [USER, `k101-${USER}@isaflow.test`]);
  // Default first and oldest, so `ORDER BY is_default DESC, created_at ASC` picks it either way.
  await pool.query(
    `INSERT INTO company_users (company_id, user_id, role, is_default, created_at)
     VALUES ($1, $3, 'admin', true, now() - interval '1 day'), ($2, $3, 'admin', false, now())`,
    [DEF, OTHER, USER]);
  token = await new SignJWT({ sub: USER, aal: 'aal2' }).setProtectedHeader({ alg: 'HS256' })
    .setExpirationTime('1h').sign(new TextEncoder().encode(process.env.JWT_SECRET));
});

afterAll(async () => {
  try {
    await pool.query(
      'DELETE FROM portal_payment_links WHERE invoice_id IN (SELECT id FROM customer_invoices WHERE company_id = ANY($1))',
      [COMPANIES]);
    for (const t of ['customer_invoices', 'company_document_numbers', 'company_users', 'customers']) {
      await pool.query(`DELETE FROM ${t} WHERE company_id = ANY($1)`, [COMPANIES]);
    }
    await pool.query('DELETE FROM companies WHERE id = ANY($1)', [COMPANIES]);
    await pool.query('DELETE FROM users WHERE id = $1', [USER]);
  } finally {
    await pool.end();
  }
});

describe.each(ROUTES)('K-101 $name follows the active company', (route) => {
  it('serves and writes an invoice in the active company when it is not the default', async () => {
    const id = await invoice(OTHER);
    const state = await call(route, OTHER, route.body(OTHER, id));
    expect(state.statusCode, JSON.stringify(state.body)).toBe(200);
    expect(await route.written(id)).toBe(1);
  });

  it('still serves the default company when it is the active one', async () => {
    const id = await invoice(DEF);
    const state = await call(route, DEF, route.body(DEF, id));
    expect(state.statusCode, JSON.stringify(state.body)).toBe(200);
    expect(await route.written(id)).toBe(1);
  });

  it('refuses an invoice in the default company while another company is active, writing nothing', async () => {
    const id = await invoice(DEF);
    const state = await call(route, OTHER, route.body(DEF, id));
    expect(state.statusCode).toBe(404);
    expect(await route.written(id)).toBe(0);
  });

  it('refuses an invoice in the non-default company while the default is active, writing nothing', async () => {
    const id = await invoice(OTHER);
    const state = await call(route, DEF, route.body(OTHER, id));
    expect(state.statusCode).toBe(404);
    expect(await route.written(id)).toBe(0);
  });

  it('answers 400, not 500, for an invoiceId that is not a UUID', async () => {
    const state = await call(route, OTHER, route.body(OTHER, 'not-a-uuid'));
    expect(state.statusCode, JSON.stringify(state.body)).toBe(400);
  });

  it('refuses a company the user does not belong to, writing nothing', async () => {
    const id = await invoice(FOREIGN);
    const state = await call(route, FOREIGN, route.body(FOREIGN, id));
    expect(state.statusCode).toBe(403);
    expect(await route.written(id)).toBe(0);
  });
});

// customer_invoices' RLS USING clause admits every company the user belongs to
// (only WITH CHECK is the active company), so it is the handler's company_id
// predicate, not RLS, that keeps an existing token in the other company unread.
it('the generate routes do not hand out the token of an invoice in the user\'s other company', async () => {
  for (const route of ROUTES.slice(0, 2)) {
    const id = await invoice(DEF);
    const existing = 'b'.repeat(64);
    await pool.query('UPDATE customer_invoices SET portal_token = NULL WHERE portal_token = $1', [existing]);
    await pool.query('UPDATE customer_invoices SET portal_token = $2 WHERE id = $1', [id, existing]);
    const state = await call(route, OTHER, route.body(DEF, id));
    expect(state.statusCode).toBe(404);
    expect(JSON.stringify(state.body)).not.toContain(existing);
  }
});

const paymentLinkRoute = ROUTES[2]!;
const linkCount = paymentLinkRoute.written;

it('payment-link refuses a customer of the same company who is not the invoice\'s customer', async () => {
  const id = await invoice(OTHER);
  const stranger = randomUUID();
  await pool.query('INSERT INTO customers (id, company_id, name) VALUES ($1, $2, $3)',
    [stranger, OTHER, 'K101 Other second customer']);
  const state = await call(paymentLinkRoute, OTHER, { invoiceId: id, clientId: stranger, amount: 115 });
  expect(state.statusCode, JSON.stringify(state.body)).toBe(400);
  expect(await linkCount(id)).toBe(0);
});

it('payment-link refuses a cancelled invoice, writing nothing', async () => {
  const id = await invoice(OTHER);
  await pool.query("UPDATE customer_invoices SET status = 'cancelled' WHERE id = $1", [id]);
  const state = await call(paymentLinkRoute, OTHER, paymentLinkRoute.body(OTHER, id));
  expect(state.statusCode).toBe(404);
  expect(await linkCount(id)).toBe(0);
});

it('payment-link accepts the invoice\'s customer held only in the legacy customer_id column', async () => {
  const id = await invoice(OTHER);
  await pool.query('UPDATE customer_invoices SET client_id = NULL WHERE id = $1', [id]);
  const state = await call(paymentLinkRoute, OTHER, paymentLinkRoute.body(OTHER, id));
  expect(state.statusCode, JSON.stringify(state.body)).toBe(200);
  expect(await linkCount(id)).toBe(1);
});

it('the generate routes return the token they stored', async () => {
  for (const route of ROUTES.slice(0, 2)) {
    const id = await invoice(OTHER);
    const state = await call(route, OTHER, route.body(OTHER, id));
    const stored = (await pool.query('SELECT portal_token FROM customer_invoices WHERE id = $1', [id])).rows[0];
    expect((state.body as { data: { token: string } }).data.token).toBe(stored.portal_token);
  }
});
