/**
 * R-157 review round 4 — a payment-link POST that throws after its write must
 * roll back AND answer the client.
 *
 * withAuth buffers res.end until COMMIT/ROLLBACK and replays it only on a normal
 * return; on a throw it rolls back and rethrows without replaying. With
 * withErrorHandler only OUTSIDE withAuth (the public GET shares the router), the
 * outer 500 lands in that dead buffer and the client hangs. generate.ts, whose
 * withErrorHandler sits inside withAuth, is the control.
 *
 * The link write is forced to throw after its INSERT through the real route
 * (withAuth as app_user, withCsrf, withWriteAccess). The real res.end is counted.
 */
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import { randomUUID } from 'crypto';
import { SignJWT } from 'jose';
import { assertDisposable, request, response } from './mfa-impersonation-postgres.helpers';

vi.mock('@/modules/accounting/services/ar/portalService', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/modules/accounting/services/ar/portalService')>();
  const { sql } = await import('@/lib/neon');
  return {
    ...original,
    createPaymentLink: async (invoiceId: string, clientId: string, amount: number) => {
      await sql`INSERT INTO portal_payment_links (invoice_id, client_id, amount)
                VALUES (${invoiceId}::uuid, ${clientId}::uuid, ${amount})`;
      throw new Error('R-157 forced failure after the link INSERT');
    },
  };
});
vi.mock('@/modules/accounting/services/ar/portalTokenService', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/modules/accounting/services/ar/portalTokenService')>();
  return {
    ...original,
    findOrMintInvoicePortalToken: async (invoiceId: string, companyId: string) => {
      await original.findOrMintInvoicePortalToken(invoiceId, companyId);
      throw new Error('R-157 forced failure after the token mint');
    },
  };
});

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
const CO = randomUUID();
const CUSTOMER = randomUUID();
const USER = randomUUID();
let jwt = '';

async function invoice(): Promise<string> {
  const id = randomUUID();
  await pool.query(
    `INSERT INTO customer_invoices (id, company_id, invoice_number, customer_id, client_id, invoice_date,
       subtotal, tax_amount, total_amount, amount_paid, status, created_by)
     VALUES ($1, $2, $3, $4, $4, CURRENT_DATE, 100, 15, 115, 0, 'approved', $5)`,
    [id, CO, `R157T-${id.slice(0, 8)}`, CUSTOMER, USER]);
  return id;
}

/**
 * Calls the real route; counts calls of the response's own end(), which withAuth defers, and of
 * withErrorHandler's X-Request-Id header (one per withErrorHandler the request passes through).
 */
async function post(path: string, body: Record<string, unknown>, method = 'POST') {
  const req = request({ 'sb-access-token': jwt, active_company_id: CO }, method) as never as { body: unknown; url: string };
  req.body = body;
  const out = response();
  let requestIds = 0;
  const setHeader = out.res.setHeader.bind(out.res);
  (out.res as unknown as { setHeader: (n: string, v: unknown) => unknown }).setHeader = (n: string, v: unknown) => {
    if (n.toLowerCase() === 'x-request-id') requestIds += 1;
    return setHeader(n, v as never);
  };
  let ends = 0;
  const end = out.res.end.bind(out.res) as (...a: unknown[]) => unknown;
  (out.res as unknown as { end: (...a: unknown[]) => unknown }).end = (...a: unknown[]) => { ends += 1; return end(...a); };
  const handler = (await import(path)).default as (req: never, res: never) => Promise<unknown>;
  let threw: unknown = null;
  try {
    await handler(req as never, out.res as never);
  } catch (err) {
    threw = err;
  }
  return { status: out.state.statusCode, ends, threw, requestIds };
}

beforeAll(async () => {
  await pool.query('INSERT INTO companies (id, name, is_active) VALUES ($1, $2, true)', [CO, 'R157 throw responds']);
  await pool.query('INSERT INTO customers (id, company_id, name) VALUES ($1, $2, $3)', [CUSTOMER, CO, 'R157 customer']);
  await pool.query("INSERT INTO users (id, email, role, is_active) VALUES ($1, $2, 'admin', true)",
    [USER, `r157-throw-${USER}@isaflow.test`]);
  await pool.query("INSERT INTO company_users (company_id, user_id, role, is_default) VALUES ($1, $2, 'admin', true)",
    [CO, USER]);
  jwt = await new SignJWT({ sub: USER, aal: 'aal2' }).setProtectedHeader({ alg: 'HS256' })
    .setExpirationTime('1h').sign(new TextEncoder().encode(process.env.JWT_SECRET));
});

afterAll(async () => {
  try {
    await pool.query(
      'DELETE FROM portal_payment_links WHERE invoice_id IN (SELECT id FROM customer_invoices WHERE company_id = $1)', [CO]);
    for (const t of ['customer_invoices', 'company_document_numbers', 'company_users', 'customers']) {
      await pool.query(`DELETE FROM ${t} WHERE company_id = $1`, [CO]);
    }
    await pool.query('DELETE FROM companies WHERE id = $1', [CO]);
    await pool.query('DELETE FROM users WHERE id = $1', [USER]);
  } finally {
    await pool.end();
  }
});

it('payment-link POST rolls back the link and still sends its 500 exactly once', async () => {
  const id = await invoice();
  const r = await post('../../pages/api/portal/payment-link', { invoiceId: id, clientId: CUSTOMER, amount: 10 });
  const links = Number((await pool.query(
    'SELECT count(*) AS n FROM portal_payment_links WHERE invoice_id = $1', [id])).rows[0].n);
  expect(links).toBe(0);
  expect(r.threw).toBeNull();
  expect(r.status).toBe(500);
  expect(r.ends).toBe(1);
});

it('generate (control) rolls back the token and sends its 500 exactly once', async () => {
  const id = await invoice();
  const r = await post('../../pages/api/portal/invoice/generate', { invoiceId: id });
  const { rows } = await pool.query('SELECT portal_token FROM customer_invoices WHERE id = $1', [id]);
  expect(rows[0].portal_token).toBeNull();
  expect(r.threw).toBeNull();
  expect(r.status).toBe(500);
  expect(r.ends).toBe(1);
});

// Review round 5: withErrorHandler wrapped the whole router AND the POST inside withAuth, so every
// authenticated POST was logged twice under two request ids. Only the public side is wrapped now.
it('payment-link POST passes through withErrorHandler once (one X-Request-Id)', async () => {
  const id = await invoice();
  const r = await post('../../pages/api/portal/payment-link', { invoiceId: id, clientId: CUSTOMER, amount: 10 });
  expect(r.status).toBe(500);
  expect(r.requestIds).toBe(1);
});

it.each([['GET', 400], ['OPTIONS', 200], ['PUT', 405]] as const)(
  'payment-link still answers %s (%i) through withErrorHandler (GET: public, no token given)', async (method, status) => {
    const r = await post('../../pages/api/portal/payment-link', {}, method);
    expect(r.status).toBe(status);
    expect(r.ends).toBe(1);
    expect(r.requestIds).toBe(1);
  });
