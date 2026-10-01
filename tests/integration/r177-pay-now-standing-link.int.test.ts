/**
 * R-177: "Pay Now" no longer calls the gateway inside its request transaction. It makes sure the
 * invoice has its one standing link and answers with it; the page then starts the checkout through
 * the public create route (one checkout per click, bounded gateway call, numeric balance).
 *
 * Real Postgres, real routes and wrappers; only the Paystack client is stubbed.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'crypto';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { CO, CUSTOMER, SECRET, USER, addLink, cleanupCompany, create, pool, requests, seedCompany } from './r167-portal-links.helpers';
import { enableOnlinePayment, enableRoute, invoice, links, payNow, signIn, tokenOf } from './r177-portal-followups.helpers';
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
    await pool.query('UPDATE customer_invoices SET online_payment_enabled = false WHERE id = $1', [id]); // a legacy row
    expect(tokenOf(await payNow(id))).toBe(tokenOf(a!));
    expect((await pool.query('SELECT online_payment_enabled AS on FROM customer_invoices WHERE id = $1', [id])).rows).toEqual([{ on: true }]);
    // a row whose link was stored on another origin (the old localhost fallback): same link, stored URL corrected
    await pool.query('UPDATE customer_invoices SET payment_url = $2 WHERE id = $1', [id, `http://localhost:3101/portal/pay/${tokenOf(a!)}`]);
    expect(tokenOf(await payNow(id))).toBe(tokenOf(a!));
    expect((await pool.query('SELECT payment_url FROM customer_invoices WHERE id = $1', [id])).rows)
      .toEqual([{ payment_url: `https://app.r177.test/portal/pay/${tokenOf(a!)}` }]);
    expect(await links(id)).toHaveLength(1);
  });

  it('takes only a NO KEY lock on the invoice: it does not wait behind a row that references the invoice being written', async () => {
    const id = await invoice();
    const holder = await pool.connect();
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT 1 FROM customer_invoices WHERE id = $1 FOR KEY SHARE', [id]); // what an FK insert holds
      const started = Date.now();
      expect((await payNow(id)).statusCode).toBe(200);
      expect(Date.now() - started).toBeLessThan(3000);
    } finally { await holder.query('ROLLBACK'); holder.release(); }
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
      await pool.query("UPDATE customer_invoices SET status = 'draft' WHERE id = $1", [id]);
      expect((await payNow(id)).statusCode).toBe(404); // not "not approved": that would confirm the invoice exists
      expect((await enableRoute(id)).statusCode).toBe(404);
      // Row security hides the row from both routes. This call has none: the predicate alone must
      // answer "not found" (null), never "not approved" (a throw), for another company's draft.
      await expect(enableOnlinePayment(CO, id, true)).resolves.toBeNull();
      await pool.query("UPDATE customer_invoices SET status = 'sent' WHERE id = $1", [id]);
      expect(await enableOnlinePayment(CO, id)).toBeNull(); // no RLS on this call: the predicate alone
      expect(await links(id)).toEqual([]);
    } finally {
      await pool.query('DELETE FROM customer_invoices WHERE id = $1', [id]);
      await pool.query('DELETE FROM companies WHERE id = $1', [other]);
    }
  });
});
