/**
 * LINK-REVOKE: POST /customer-invoices/[id]/payment-link/revoke cancels the standing link the
 * invoice names and clears payment_url / online_payment_enabled, so the next Pay Now mints a new one.
 *
 * Real Postgres, real route and wrappers; only the Paystack client is stubbed.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'crypto';
import { SignJWT } from 'jose';
import { request } from './mfa-impersonation-postgres.helpers';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { CO, SECRET, USER, addLink, call, cleanupCompany, create, getLink, pool, requests, seedCompany } from './r167-portal-links.helpers';
import { invoice, links, payNow, signIn, tokenOf } from './r177-portal-followups.helpers';
import { als } from '@/lib/als';
import { revokeStandingLink } from '@/modules/accounting/services/ar/standingPaymentLink';
import { clearSystemAccountCache } from '@/modules/accounting/services/gl/systemAccountResolver';

assertDisposable();

vi.mock('@/modules/billing/services/paystackClient', () => ({
  initializeTransaction: async (input: { reference: string }) =>
    ({ reference: input.reference, accessCode: 'ac_revoke', authorizationUrl: `https://checkout.test/${input.reference}` }),
  verifyTransaction: vi.fn(),
  chargeAuthorization: vi.fn(async () => { throw new Error('Paystack must not be charged in this test'); }),
}));

const VIEWER = randomUUID();
let adminJwt = '';
let viewerJwt = '';
const sign = (sub: string) => new SignJWT({ sub, aal: 'aal2' }).setProtectedHeader({ alg: 'HS256' })
  .setExpirationTime('1h').sign(new TextEncoder().encode(process.env.JWT_SECRET));

async function revoke(invoiceId: string, opts: { jwt?: string; csrf?: boolean } = {}) {
  const req = request({ 'sb-access-token': opts.jwt ?? adminJwt, active_company_id: CO }, 'POST') as unknown as Record<string, unknown>;
  if (opts.csrf === false) {
    delete (req.headers as Record<string, unknown>)['x-csrf-token'];
    req.cookies = { ...(req.cookies as Record<string, string>), isaflow_csrf: undefined };
  }
  return call((await import('../../pages/api/accounting/customer-invoices/[id]/payment-link/revoke')).default as never,
    { ...req, query: { id: invoiceId } });
}
/** The service in a transaction of its own as the fixture owner: no row security, so only its predicates isolate. */
async function revokeInTx(companyId: string, invoiceId: string) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const out = await als.run({ client, userId: USER, companyId, claims: {} } as never, () => revokeStandingLink(companyId, invoiceId));
    await client.query('COMMIT');
    return out;
  } catch (err) { await client.query('ROLLBACK'); throw err; } finally { client.release(); }
}
const row = async (id: string) => (await pool.query<{ payment_url: string | null; on: boolean | null }>(
  'SELECT payment_url, online_payment_enabled AS on FROM customer_invoices WHERE id = $1', [id])).rows[0]!;
const status = async (token: string) => (await pool.query<{ status: string }>(
  'SELECT status FROM portal_payment_links WHERE token = $1', [token])).rows[0]!.status;

beforeAll(async () => {
  vi.stubEnv('PAYSTACK_SECRET_KEY', SECRET);
  vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://app.revoke.test');
  await seedCompany();
  await pool.query("INSERT INTO users (id, email, role, is_active, account_type) VALUES ($1, $2, 'viewer', true, 'direct')",
    [VIEWER, `revoke-viewer-${VIEWER}@isaflow.test`]);
  await pool.query("INSERT INTO company_users (company_id, user_id, role, is_default) VALUES ($1, $2, 'viewer', true)", [CO, VIEWER]);
  clearSystemAccountCache();
  await signIn();
  adminJwt = await sign(USER);
  viewerJwt = await sign(VIEWER);
});
afterAll(async () => {
  vi.unstubAllEnvs();
  await pool.query('DELETE FROM company_users WHERE user_id = $1', [VIEWER]);
  await pool.query('DELETE FROM users WHERE id = $1', [VIEWER]);
  await cleanupCompany();
});

describe('LINK-REVOKE: revoke the standing payment link', () => {
  it('cancels the named standing link and clears payment_url and online_payment_enabled', async () => {
    const id = await invoice();
    const token = tokenOf(await payNow(id));
    expect(await row(id)).toMatchObject({ on: true });
    const r = await revoke(id);
    expect(r.statusCode, JSON.stringify(r.body)).toBe(200);
    expect(await status(token)).toBe('cancelled');
    expect(await row(id)).toEqual({ payment_url: null, on: false });
  });

  it('the revoked token is neither shown nor payable', async () => {
    const id = await invoice();
    const token = tokenOf(await payNow(id));
    expect((await getLink(token)).statusCode).toBe(200);
    expect((await revoke(id)).statusCode).toBe(200);
    expect((await getLink(token)).statusCode).toBe(404);
    const pay = await create(token);
    expect(pay.statusCode).not.toBe(200);
    expect(await requests(id)).toEqual([]);
  });

  it('the next Pay Now mints a different token and stores it', async () => {
    const id = await invoice();
    const first = tokenOf(await payNow(id));
    await revoke(id);
    const second = tokenOf(await payNow(id));
    expect(second).not.toBe(first);
    expect(await row(id)).toEqual({ payment_url: `https://app.revoke.test/portal/pay/${second}`, on: true });
    expect((await getLink(second)).statusCode).toBe(200);
  });

  it('leaves an explicit-amount link, and an unnamed standing link, untouched', async () => {
    const id = await invoice();
    const explicit = await addLink(id, 10, false);
    const unnamed = await addLink(id, 115, true);
    const named = tokenOf(await payNow(id));
    expect((await revoke(id)).statusCode).toBe(200);
    expect(await status(explicit.token)).toBe('active');
    expect(await status(unnamed.token)).toBe('active');
    expect(await status(named)).toBe('cancelled');
  });

  it('does not cancel an explicit-amount link the invoice names: 404 and nothing written', async () => {
    const id = await invoice();
    const explicit = await addLink(id, 10, false);
    const url = `https://app.revoke.test/portal/pay/${explicit.token}`;
    await pool.query('UPDATE customer_invoices SET payment_url = $2, online_payment_enabled = true WHERE id = $1', [id, url]);
    const r = await revoke(id);
    expect(r.statusCode).toBe(404);
    expect(await status(explicit.token)).toBe('active');
    expect(await row(id)).toEqual({ payment_url: url, on: true });
  });

  it('leaves a checkout already open at Paystack in place', async () => {
    const id = await invoice();
    const token = tokenOf(await payNow(id));
    expect((await create(token)).statusCode).toBe(200);
    const before = await requests(id);
    expect(before).toHaveLength(1);
    expect((await revoke(id)).statusCode).toBe(200);
    expect(await requests(id)).toEqual(before);
  });

  it('another company\'s invoice is 404 and untouched', async () => {
    const other = randomUUID();
    await pool.query('INSERT INTO companies (id, name, is_active) VALUES ($1, $2, true)', [other, 'Revoke other']);
    const id = randomUUID();
    try {
      await pool.query(
        `INSERT INTO customer_invoices (id, company_id, customer_id, client_id, invoice_number, invoice_date,
           subtotal, tax_amount, total_amount, amount_paid, status, created_by, online_payment_enabled, payment_url)
         VALUES ($1, $2, $3, $3, 'REVOKE-OTHER', CURRENT_DATE, 100, 15, 115, 0, 'sent', $4, true, 'https://app.revoke.test/portal/pay/x')`,
        [id, other, (await pool.query('SELECT id FROM customers WHERE company_id = $1', [CO])).rows[0]!.id, USER]);
      const { rows } = await pool.query<{ token: string }>(
        'INSERT INTO portal_payment_links (invoice_id, client_id, amount, charges_balance) SELECT $1, customer_id, 115, true FROM customer_invoices WHERE id = $1 RETURNING token', [id]);
      await pool.query('UPDATE customer_invoices SET payment_url = $2 WHERE id = $1', [id, `https://app.revoke.test/portal/pay/${rows[0]!.token}`]);
      const r = await revoke(id);
      expect(r.statusCode).toBe(404);
      expect(r.body.error?.message).toBe('Invoice not found');
      expect(await status(rows[0]!.token)).toBe('active');
      expect((await row(id)).on).toBe(true);
      // Row security hides the row above; with none (the call below) the predicates alone must answer.
      expect(await revokeInTx(CO, id)).toEqual({ ok: false, reason: 'invoice_not_found' });
      expect(await status(rows[0]!.token)).toBe('active');
      expect((await row(id)).on).toBe(true);
    } finally {
      await pool.query('DELETE FROM portal_payment_links WHERE invoice_id = $1', [id]);
      await pool.query('DELETE FROM customer_invoices WHERE id = $1', [id]);
      await pool.query('DELETE FROM companies WHERE id = $1', [other]);
    }
  });

  it('no link: 404 "No active payment link"; a second revoke is the same 404', async () => {
    const none = await invoice();
    const r = await revoke(none);
    expect(r.statusCode).toBe(404);
    expect(r.body.error?.message).toBe('No active payment link');
    const id = await invoice();
    await payNow(id);
    expect((await revoke(id)).statusCode).toBe(200);
    const again = await revoke(id);
    expect(again.statusCode).toBe(404);
    expect(again.body.error?.message).toBe('No active payment link');
    expect((await links(id)).map((l) => l.charges_balance)).toEqual([true]);
  });

  it('a named link that is no longer active (paid) is not touched: 404', async () => {
    const id = await invoice();
    const token = tokenOf(await payNow(id));
    await pool.query("UPDATE portal_payment_links SET status = 'paid' WHERE token = $1", [token]);
    expect((await revoke(id)).statusCode).toBe(404);
    expect(await status(token)).toBe('paid');
    expect((await row(id)).on).toBe(true);
  });

  it('a malformed id is 400', async () => {
    expect((await revoke('not-a-uuid')).statusCode).toBe(400);
  });

  it('a viewer is refused and nothing changes', async () => {
    const id = await invoice();
    const token = tokenOf(await payNow(id));
    const r = await revoke(id, { jwt: viewerJwt });
    expect(r.statusCode).toBe(403);
    expect(await status(token)).toBe('active');
    expect((await row(id)).on).toBe(true);
  });

  it('a request without the CSRF token is refused and nothing changes', async () => {
    const id = await invoice();
    const token = tokenOf(await payNow(id));
    const r = await revoke(id, { csrf: false });
    expect(r.statusCode).toBe(403);
    expect(await status(token)).toBe('active');
  });

  it('waits at most 5s for an invoice another request holds, then answers a retryable 400 and writes nothing', async () => {
    const id = await invoice();
    const token = tokenOf(await payNow(id));
    const holder = await pool.connect();
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT 1 FROM customer_invoices WHERE id = $1 FOR UPDATE', [id]);
      const started = Date.now();
      const r = await revoke(id);
      expect(Date.now() - started).toBeGreaterThan(4000);
      expect(r.statusCode).toBe(400);
      expect(JSON.stringify(r.body)).toContain('CUSTOMER_INVOICE_LOCK_TIMEOUT');
    } finally { await holder.query('ROLLBACK'); holder.release(); }
    expect(await status(token)).toBe('active');
  }, 20_000);
});
