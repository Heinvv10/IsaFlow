/**
 * R-177..R-180: follow-ups of R-167 on portal payments.
 *
 * - R-177: "Pay Now" no longer calls the gateway inside its request transaction. It makes sure the
 *   invoice has its standing link and answers with it; the page then starts the checkout through
 *   the public create route (one checkout per click, bounded gateway call, numeric balance).
 * - R-178: Paystack's `abandoned` is not terminal. verify reports it as cancelled and leaves the
 *   checkout pending, so the next click gets the same checkout instead of a second payable one.
 * - R-179: the standing link an invoice names does not expire, whatever its stored expiry says;
 *   every other link keeps its 30 days.
 * - R-180: an invoice that is a draft or awaiting approval gets no payment link, and a link on one
 *   cannot be paid.
 *
 * Real Postgres, real routes and wrappers; only the Paystack client is stubbed.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'crypto';
import { SignJWT } from 'jose';
import { assertDisposable, request } from './mfa-impersonation-postgres.helpers';
import {
  CO, CUSTOMER, SECRET, USER, addLink, call, cleanupCompany, create, getLink, pool, requests, seedCompany, verify,
} from './r167-portal-links.helpers';
import { als } from '@/lib/als';
import { enableOnlinePayment as enableOnlinePaymentInTx } from '@/modules/accounting/services/core/paymentGatewayPortalService';
import { clearSystemAccountCache } from '@/modules/accounting/services/gl/systemAccountResolver';

assertDisposable();

const h = vi.hoisted(() => ({ charged: [] as number[], verifyTransaction: vi.fn() }));
vi.mock('@/modules/billing/services/paystackClient', () => ({
  initializeTransaction: async (input: { amountCents: number; reference: string }) => {
    h.charged.push(input.amountCents);
    return { reference: input.reference, accessCode: 'ac_r177', authorizationUrl: `https://checkout.test/${input.reference}` };
  },
  verifyTransaction: (...a: unknown[]) => h.verifyTransaction(...a),
  chargeAuthorization: vi.fn(async () => { throw new Error('Paystack must not be charged in this test'); }),
}));

let jwt = '';
beforeAll(async () => {
  vi.stubEnv('PAYSTACK_SECRET_KEY', SECRET);
  vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://app.r177.test');
  await seedCompany();
  clearSystemAccountCache();
  jwt = await new SignJWT({ sub: USER, aal: 'aal2' }).setProtectedHeader({ alg: 'HS256' })
    .setExpirationTime('1h').sign(new TextEncoder().encode(process.env.JWT_SECRET));
});
beforeEach(() => { h.charged.length = 0; h.verifyTransaction.mockReset(); });
afterAll(async () => { vi.unstubAllEnvs(); await cleanupCompany(); });

/** An invoice for R115.00 with no link yet. `paid` may be a string for NaN. */
async function invoice(status = 'sent', paid: number | string = 0): Promise<string> {
  const id = randomUUID();
  await pool.query(
    `INSERT INTO customer_invoices (id, company_id, customer_id, client_id, invoice_number, invoice_date,
       subtotal, tax_amount, total_amount, amount_paid, status, created_by)
     VALUES ($1, $2, $3, $3, $4, CURRENT_DATE, 100, 15, 115, $5, $6, $7)`,
    [id, CO, CUSTOMER, `R177-${id.slice(0, 8)}`, paid, status, USER]);
  return id;
}
const authed = (extra: Record<string, unknown>) =>
  ({ ...(request({ 'sb-access-token': jwt, active_company_id: CO }, 'POST') as object), ...extra });
const payNow = async (invoiceId: string) => call(
  (await import('../../pages/api/accounting/customer-invoices/[id]/pay-now')).default as never, authed({ query: { id: invoiceId } }));
const mintExplicit = async (invoiceId: string, amount = 10) => call(
  (await import('../../pages/api/portal/payment-link')).default as never,
  authed({ query: {}, body: { invoiceId, clientId: CUSTOMER, amount } }));
/** The service in a transaction of its own, as the fixture's owner: no row security, so only its predicates isolate. */
async function enableOnlinePayment(companyId: string, invoiceId: string): Promise<string | null> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const url = await als.run({ client, userId: USER, companyId, claims: {} } as never, () => enableOnlinePaymentInTx(companyId, invoiceId));
    await client.query('COMMIT');
    return url;
  } catch (err) { await client.query('ROLLBACK'); throw err; } finally { client.release(); }
}
const links = async (invoiceId: string) => (await pool.query<{ token: string; expires_at: Date | null; charges_balance: boolean }>(
  'SELECT token, expires_at, charges_balance FROM portal_payment_links WHERE invoice_id = $1 ORDER BY created_at', [invoiceId])).rows;
const tokenOf = (r: { body: { data?: Record<string, unknown> } }) => String(r.body.data?.token);

describe('R-177: Pay Now hands out the standing link and never calls the gateway itself', () => {
  it('answers with the link and its token; no gateway call and no payment request in its transaction', async () => {
    const id = await invoice();
    const r = await payNow(id);
    expect(r.statusCode, JSON.stringify(r.body)).toBe(200);
    const [link] = await links(id);
    expect(r.body.data).toEqual({ token: link!.token, paymentUrl: `https://app.r177.test/portal/pay/${link!.token}` });
    expect(h.charged).toEqual([]);
    expect(await requests(id)).toEqual([]);
  });

  it('the token starts one checkout for the live balance through the public route, and a second click reuses it', async () => {
    const id = await invoice('partially_paid', 15);
    const token = tokenOf(await payNow(id));
    const first = await create(token);
    expect(first.statusCode, JSON.stringify(first.body)).toBe(200);
    expect((await create(tokenOf(await payNow(id)))).body.data).toEqual(first.body.data);
    expect(h.charged).toEqual([10000]);
    expect(await requests(id)).toHaveLength(1);
  });

  it('a second Pay Now, even at the same moment, keeps the one standing link', async () => {
    const id = await invoice();
    const [a, b] = await Promise.all([payNow(id), payNow(id)]);
    expect([a!.statusCode, b!.statusCode]).toEqual([200, 200]);
    expect(tokenOf(a!)).toBe(tokenOf(b!));
    expect(tokenOf(await payNow(id))).toBe(tokenOf(a!));
    expect(await links(id)).toHaveLength(1);
  });

  it('mints a fresh standing link when the one the invoice names is cancelled', async () => {
    const id = await invoice();
    const first = tokenOf(await payNow(id));
    await pool.query("UPDATE portal_payment_links SET status = 'cancelled' WHERE token = $1", [first]);
    const second = tokenOf(await payNow(id));
    expect(second).not.toBe(first);
    expect((await pool.query('SELECT payment_url FROM customer_invoices WHERE id = $1', [id])).rows)
      .toEqual([{ payment_url: `https://app.r177.test/portal/pay/${second}` }]);
  });

  it('never adopts a link the invoice does not name, nor an explicit-amount link it does', async () => {
    const id = await invoice();
    const unnamed = await addLink(id, 115, true); // e.g. an explicit-amount link from before 717
    const first = tokenOf(await payNow(id));
    expect(first).not.toBe(unnamed.token);
    const explicit = await addLink(id, 10, false);
    await pool.query('UPDATE customer_invoices SET payment_url = $2 WHERE id = $1', [id, `https://app.r177.test/portal/pay/${explicit.token}`]);
    const second = tokenOf(await payNow(id));
    expect([first, explicit.token]).not.toContain(second);
    expect((await links(id)).find((l) => l.token === second)).toMatchObject({ charges_balance: true, expires_at: null });
  });

  it('reads the balance in numeric: a NaN balance or a paid invoice gets no link, a negative amount_paid counts as nothing paid', async () => {
    const nan = await invoice('sent', 'NaN');
    expect((await payNow(nan)).statusCode).toBe(400);
    const paid = await invoice('paid', 115);
    expect((await payNow(paid)).statusCode).toBe(400);
    expect([...(await links(nan)), ...(await links(paid))]).toEqual([]);
    const negative = await invoice('sent', -50);
    expect((await create(tokenOf(await payNow(negative)))).statusCode).toBe(200);
    expect(h.charged).toEqual([11500]);
  });

  it('waits at most 5s for an invoice another request holds, then answers a retryable 400 and mints nothing', async () => {
    const id = await invoice();
    const holder = await pool.connect();
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT 1 FROM customer_invoices WHERE id = $1 FOR UPDATE', [id]);
      const started = Date.now();
      const r = await payNow(id);
      expect(Date.now() - started).toBeGreaterThan(4000);
      expect(r.statusCode).toBe(400);
      expect(JSON.stringify(r.body)).toContain('CUSTOMER_INVOICE_LOCK_TIMEOUT');
    } finally { await holder.query('ROLLBACK'); holder.release(); }
    expect(await links(id)).toEqual([]);
  }, 20_000);

  it('an invoice of another company is not found', async () => {
    const other = randomUUID();
    await pool.query('INSERT INTO companies (id, name, is_active) VALUES ($1, $2, true)', [other, 'R177 other']);
    const id = randomUUID();
    try {
      await pool.query(
        `INSERT INTO customer_invoices (id, company_id, customer_id, client_id, invoice_number, invoice_date,
           subtotal, tax_amount, total_amount, amount_paid, status, created_by)
         VALUES ($1, $2, $3, $3, 'R177-OTHER', CURRENT_DATE, 100, 15, 115, 0, 'sent', $4)`, [id, other, CUSTOMER, USER]);
      expect((await payNow(id)).statusCode).toBe(404);
      expect(await enableOnlinePayment(CO, id)).toBeNull(); // no RLS on this call: the predicate alone
      expect(await links(id)).toEqual([]);
    } finally {
      await pool.query('DELETE FROM customer_invoices WHERE id = $1', [id]);
      await pool.query('DELETE FROM companies WHERE id = $1', [other]);
    }
  });
});

describe('R-178: an abandoned checkout stays payable and reusable', () => {
  it('verify reports cancelled, leaves the request pending, and the next click gets the same checkout', async () => {
    const id = await invoice();
    const token = tokenOf(await payNow(id));
    const first = await create(token);
    const [req] = await requests(id);
    h.verifyTransaction.mockResolvedValue({ status: 'abandoned', id: 1781 });
    expect((await verify(req!.ref)).body.data?.status).toBe('cancelled');
    expect((await pool.query('SELECT status FROM paystack_payment_requests WHERE paystack_reference = $1', [req!.ref])).rows)
      .toEqual([{ status: 'pending' }]);
    expect((await create(token)).body.data).toEqual(first.body.data);
    expect(h.charged).toEqual([11500]);
  });

  it('a failed checkout is still marked failed', async () => {
    const id = await invoice();
    await create(tokenOf(await payNow(id)));
    const [req] = await requests(id);
    h.verifyTransaction.mockResolvedValue({ status: 'failed', id: 1782 });
    expect((await verify(req!.ref)).body.data?.status).toBe('failed');
    expect((await pool.query('SELECT status FROM paystack_payment_requests WHERE paystack_reference = $1', [req!.ref])).rows)
      .toEqual([{ status: 'failed' }]);
  });
});

describe('R-179: a standing link does not expire', () => {
  it('Pay Now and enableOnlinePayment mint links with no expiry; an explicit-amount link keeps its 30 days', async () => {
    const a = await invoice();
    await payNow(a);
    const b = await invoice();
    expect(await enableOnlinePayment(CO, b)).toMatch(/\/portal\/pay\/[0-9a-f]{64}$/);
    expect([...(await links(a)), ...(await links(b))].map((l) => [l.charges_balance, l.expires_at])).toEqual([[true, null], [true, null]]);
    const c = await invoice();
    expect((await mintExplicit(c)).statusCode).toBe(200);
    const [explicit] = await links(c);
    expect(explicit!.charges_balance).toBe(false);
    expect(explicit!.expires_at!.getTime()).toBeGreaterThan(Date.now() + 29 * 86_400_000);
  });

  it('enableOnlinePayment returns the standing link the invoice already has', async () => {
    const id = await invoice();
    const url = await enableOnlinePayment(CO, id);
    expect(await enableOnlinePayment(CO, id)).toBe(url);
    expect(`https://app.r177.test/portal/pay/${tokenOf(await payNow(id))}`).toBe(url);
    expect(await links(id)).toHaveLength(1);
  });

  it('the standing link an invoice names is payable past its stored expiry, and Pay Now still hands it out', async () => {
    const id = await invoice();
    const token = tokenOf(await payNow(id));
    await pool.query("UPDATE portal_payment_links SET expires_at = NOW() - interval '1 day' WHERE token = $1", [token]); // minted by the old code
    expect((await getLink(token)).statusCode).toBe(200);
    expect((await create(token)).statusCode).toBe(200);
    expect(tokenOf(await payNow(id))).toBe(token);
    expect(await links(id)).toHaveLength(1);
  });

  it('every other link still expires: one the invoice does not name, an explicit one it does, and a standing one on another invoice', async () => {
    const id = await invoice();
    const unnamed = await addLink(id, 115, true); // e.g. an explicit-amount link from before 717
    const other = await invoice();
    const namedExplicit = await addLink(other, 10, false);
    await pool.query('UPDATE customer_invoices SET payment_url = $2 WHERE id = $1', [other, `https://app.r177.test/portal/pay/${namedExplicit.token}`]);
    const third = await invoice();
    await pool.query('UPDATE customer_invoices SET payment_url = $2 WHERE id = $1', [third, `https://app.r177.test/portal/pay/${unnamed.token}`]);
    await pool.query("UPDATE portal_payment_links SET expires_at = NOW() - interval '1 day' WHERE invoice_id = ANY($1)", [[id, other]]);
    for (const t of [unnamed.token, namedExplicit.token]) {
      const c = await create(t);
      expect(c.statusCode).toBe(400);
      expect(c.body.error?.message).toMatch(/expired/i);
      expect((await getLink(t)).statusCode).toBe(404);
    }
    expect(h.charged).toEqual([]);
  });

  it('a cancelled or paid link is not shown, even one the invoice names', async () => {
    const id = await invoice();
    const token = tokenOf(await payNow(id));
    for (const status of ['cancelled', 'paid']) {
      await pool.query('UPDATE portal_payment_links SET status = $2 WHERE token = $1', [token, status]);
      expect((await getLink(token)).statusCode).toBe(404);
      expect((await create(token)).statusCode).toBe(400);
    }
  });
});

describe('R-180: an invoice that is not approved is not payable through a link', () => {
  it.each(['draft', 'pending_approval'])('no link is minted for a %s invoice by Pay Now, enableOnlinePayment or the payment-link POST', async (status) => {
    const id = await invoice(status);
    const r = await payNow(id);
    expect(r.statusCode).toBe(400);
    expect(r.body.error?.message).toMatch(/not approved/i);
    expect(await enableOnlinePayment(CO, id)).toBeNull();
    const m = await mintExplicit(id);
    expect(m.statusCode).toBe(400);
    expect(m.body.error?.message).toMatch(/not approved/i);
    expect(await links(id)).toEqual([]);
  });

  it.each(['draft', 'pending_approval'])('a link already on a %s invoice cannot be shown or paid, and works once the invoice is approved', async (status) => {
    const id = await invoice(status);
    const standing = await addLink(id, 115, true);
    const explicit = await addLink(id, 10, false);
    for (const t of [standing.token, explicit.token]) {
      const c = await create(t);
      expect(c.statusCode).toBe(400);
      expect(c.body.error?.message).toMatch(/not been issued/i);
      expect((await getLink(t)).statusCode).toBe(404);
    }
    expect(h.charged).toEqual([]);
    await pool.query("UPDATE customer_invoices SET status = 'approved' WHERE id = $1", [id]);
    expect((await getLink(standing.token)).statusCode).toBe(200);
    expect((await create(explicit.token)).statusCode).toBe(200);
    expect(h.charged).toEqual([1000]);
  });
});
