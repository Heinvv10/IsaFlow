/**
 * R-178..R-180: follow-ups of R-167 on portal payment links.
 *
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
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { CO, SECRET, addLink, cleanupCompany, create, getLink, pool, requests, seedCompany, verify } from './r167-portal-links.helpers';
import { enableOnlinePayment, enableRoute, invoice, links, mintExplicit, payNow, signIn, tokenOf } from './r177-portal-followups.helpers';
import { enableOnlinePayment as enableOnlinePaymentBare } from '@/modules/accounting/services/core/paymentGatewayPortalService';
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

beforeAll(async () => {
  vi.stubEnv('PAYSTACK_SECRET_KEY', SECRET);
  vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://app.r177.test');
  await seedCompany();
  clearSystemAccountCache();
  await signIn();
});
beforeEach(() => { h.charged.length = 0; h.verifyTransaction.mockReset(); });
afterAll(async () => { vi.unstubAllEnvs(); await cleanupCompany(); });

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

describe('the enable-online-payment route shares the standing link and its lock', () => {
  it('returns the standing link, and 404 for a paid invoice as before', async () => {
    const id = await invoice();
    const r = await enableRoute(id);
    expect(r.statusCode, JSON.stringify(r.body)).toBe(200);
    expect(r.body.data?.paymentUrl).toBe(`https://app.r177.test/portal/pay/${tokenOf(await payNow(id))}`);
    expect((await enableRoute(await invoice('paid', 115))).statusCode).toBe(404);
  });

  it('waits at most 5s for an invoice another request holds, then answers a retryable 400', async () => {
    const id = await invoice();
    const holder = await pool.connect();
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT 1 FROM customer_invoices WHERE id = $1 FOR UPDATE', [id]);
      const r = await enableRoute(id);
      expect(r.statusCode).toBe(503);
      expect(JSON.stringify(r.body)).toContain('CUSTOMER_INVOICE_LOCK_TIMEOUT');
    } finally { await holder.query('ROLLBACK'); holder.release(); }
    expect(await links(id)).toEqual([]);
  }, 20_000);

  it.each(['', 'http://localhost:3200'])('with the public origin set to "%s" it mints nothing and answers 500, on both routes', async (origin) => {
    const id = await invoice();
    vi.stubEnv('NEXT_PUBLIC_APP_URL', origin);
    try {
      expect((await enableRoute(id)).statusCode).toBe(500);
      expect((await payNow(id)).statusCode).toBe(500);
    } finally { vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://app.r177.test'); }
    expect(await links(id)).toEqual([]);
    expect((await pool.query('SELECT payment_url FROM customer_invoices WHERE id = $1', [id])).rows).toEqual([{ payment_url: null }]);
  });

  it('a token is matched exactly, not as a pattern: a link whose token is the named one with a "_" in it names nothing', async () => {
    const id = await invoice();
    const real = tokenOf(await payNow(id));
    const wild = `${real.slice(0, -1)}_`; // as a LIKE pattern this would match the invoice's payment_url
    await pool.query(
      `INSERT INTO portal_payment_links (invoice_id, client_id, amount, charges_balance, token, expires_at)
       SELECT invoice_id, client_id, amount, true, $2, NOW() - interval '1 day' FROM portal_payment_links WHERE token = $1`, [real, wild]);
    const c = await create(wild);
    expect(c.statusCode).toBe(400);
    expect(c.body.error?.message).toMatch(/expired/i); // the invoice does not name it
    await pool.query("UPDATE portal_payment_links SET status = 'cancelled' WHERE token = $1", [real]);
    expect(tokenOf(await payNow(id))).not.toBe(wild); // and Pay Now does not adopt it
  });

  it('the service refuses to run outside a request transaction, where its lock would hold nothing', async () => {
    const id = await invoice();
    await expect(enableOnlinePaymentBare(CO, id)).rejects.toThrow(/requires a request transaction/);
    expect(await links(id)).toEqual([]);
  });
});

describe('R-180: an invoice that is not approved is not payable through a link', () => {
  it.each(['draft', 'pending_approval'])('no link is minted for a %s invoice by Pay Now, enableOnlinePayment or the payment-link POST', async (status) => {
    const id = await invoice(status);
    const r = await payNow(id);
    expect(r.statusCode).toBe(400);
    expect(r.body.error?.message).toMatch(/not approved/i);
    expect(await enableOnlinePayment(CO, id)).toBeNull();
    const e = await enableRoute(id);
    expect(e.statusCode).toBe(400);
    expect(e.body.error?.message).toMatch(/not approved/i);
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
