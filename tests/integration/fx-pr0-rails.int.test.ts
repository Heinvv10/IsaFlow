/**
 * FX PR0, the payment rails: Paystack and the portal links charge RANDS. A
 * link on a USD invoice charged the USD balance as rands (portalLinkCharge
 * built `charge_cents` from total_amount - amount_paid and recorded the
 * checkout as 'ZAR'), and the settlement would then have been refused by the
 * database — the customer charged, the invoice still open. So a foreign
 * invoice gets no link from any route, a link that already exists charges
 * nothing, and a gateway receipt that still arrives is banked unapplied and
 * flagged, never allocated. Permanent: the programme does not lift these.
 *
 * Real Postgres, real routes; only the Paystack client is stubbed.
 */
import { randomUUID } from 'crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { CO, CUSTOMER, SECRET, USER, addLink, cleanupCompany, create, deliver, getLink, pool, requests, seedCompany } from './r167-portal-links.helpers';
import { enableOnlinePayment, enableRoute, links, mintExplicit, payNow, signIn } from './r177-portal-followups.helpers';
import { clearSystemAccountCache } from '@/modules/accounting/services/gl/systemAccountResolver';
import { sql } from '@/lib/neon';
import { invoiceForeignCurrencySql } from '@/modules/accounting/services/shared/documentCurrency';

assertDisposable();

const h = vi.hoisted(() => ({ charged: [] as number[] }));
vi.mock('@/modules/billing/services/paystackClient', () => ({
  initializeTransaction: async (input: { amountCents: number; reference: string }) => {
    h.charged.push(input.amountCents);
    return { reference: input.reference, accessCode: 'ac_fx', authorizationUrl: `https://checkout.test/${input.reference}` };
  },
  verifyTransaction: vi.fn(async () => { throw new Error('verify is not exercised here'); }),
  chargeAuthorization: vi.fn(async () => { throw new Error('Paystack must not be charged in this test'); }),
}));

beforeAll(async () => {
  vi.stubEnv('PAYSTACK_SECRET_KEY', SECRET);
  vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://app.fxpr0.test');
  await seedCompany();
  // Enabled only so a USD invoice can be planted; the rails refuse it regardless.
  await pool.query('UPDATE companies SET fx_documents_enabled = true WHERE id = $1', [CO]);
  clearSystemAccountCache();
  await signIn();
});
beforeEach(() => { h.charged.length = 0; });
afterAll(async () => { vi.unstubAllEnvs(); await cleanupCompany(); });

/** An approved ('sent') invoice for 115.00 in `currency`. */
async function invoice(currency: string): Promise<string> {
  const id = randomUUID();
  await pool.query(
    `INSERT INTO customer_invoices (id, company_id, customer_id, client_id, invoice_number, invoice_date,
       subtotal, tax_amount, total_amount, amount_paid, status, created_by, currency_code, exchange_rate)
     VALUES ($1, $2, $3, $3, $4, CURRENT_DATE, 100, 15, 115, 0, 'sent', $5, $6, $7)`,
    [id, CO, CUSTOMER, `FX0-${id.slice(0, 8)}`, USER, currency, currency.toUpperCase() === 'ZAR' ? 1 : 18.5]);
  return id;
}
const FOREIGN = /USD.*cannot be paid online|charges rands/i;
const messageOf = (r: { body: { error?: { message?: string } } }) => String(r.body.error?.message);

describe('no route mints a payment link for a foreign-currency invoice', () => {
  it('Pay Now: 400, no link, nothing stored on the invoice', async () => {
    const id = await invoice('USD');
    const res = await payNow(id);
    expect(res.statusCode).toBe(400);
    expect(messageOf(res)).toMatch(FOREIGN);
    expect(await links(id)).toEqual([]);
    expect((await pool.query('SELECT payment_url, online_payment_enabled FROM customer_invoices WHERE id = $1', [id])).rows)
      .toEqual([{ payment_url: null, online_payment_enabled: false }]);
  });

  it('enable online payment (route and service): refused, no link', async () => {
    const id = await invoice('USD');
    const res = await enableRoute(id);
    expect(res.statusCode).toBe(400);
    expect(messageOf(res)).toMatch(FOREIGN);
    await expect(enableOnlinePayment(CO, id, true)).rejects.toThrow(FOREIGN);
    expect(await links(id)).toEqual([]);
  });

  it('an explicit-amount link: 400, no link', async () => {
    const id = await invoice('USD');
    const res = await mintExplicit(id);
    expect(res.statusCode).toBe(400);
    expect(messageOf(res)).toMatch(FOREIGN);
    expect(await links(id)).toEqual([]);
  });

  it('the currency is compared case-folded: lower-case `usd` is refused, lower-case `zar` is rands', async () => {
    const usd = await invoice('usd');
    expect((await payNow(usd)).statusCode).toBe(400);
    expect(await links(usd)).toEqual([]);
    const zar = await invoice('zar');
    expect((await payNow(zar)).statusCode).toBe(200);
  });

  it('the test fails closed: a company it cannot read makes the invoice foreign; NULL is the functional currency', async () => {
    const foreign = async (companyId: string, code: string | null) => ((await sql`
      SELECT ${invoiceForeignCurrencySql()} AS f
      FROM (SELECT ${companyId}::UUID AS company_id, ${code}::TEXT AS currency_code) ci`) as { f: boolean }[])[0]!.f;
    expect(await foreign(randomUUID(), 'ZAR')).toBe(true);
    expect(await foreign(CO, 'ZAR')).toBe(false);
    expect(await foreign(CO, null)).toBe(false);
    expect(await foreign(CO, ' ')).toBe(false);
    expect(await foreign(CO, 'EUR')).toBe(true);
  });

  it('a ZAR invoice still gets its link', async () => {
    const id = await invoice('ZAR');
    expect((await payNow(id)).statusCode).toBe(200);
    expect(await links(id)).toHaveLength(1);
  });
});

describe('a link that already exists on a foreign-currency invoice charges nothing', () => {
  it('checkout is refused before Paystack is called, and records no request; the link page refuses too', async () => {
    const id = await invoice('USD');
    for (const standing of [true, false]) {
      const { token } = await addLink(id, 115, standing);
      const res = await create(token);
      expect(res.statusCode).toBe(400);
      expect(messageOf(res)).toMatch(FOREIGN);
      const page = await getLink(token);
      expect(page.statusCode).toBe(400);
      expect(messageOf(page)).toMatch(FOREIGN);
    }
    expect(h.charged).toEqual([]);
    expect(await requests(id)).toEqual([]);
  });
});

describe('a gateway receipt that still arrives for a foreign-currency invoice', () => {
  it('is banked in full, unapplied, and flagged; the invoice is not settled', async () => {
    const id = await invoice('USD');
    const ref = `fx0_${randomUUID().slice(0, 12)}`;
    await pool.query(
      `INSERT INTO paystack_payment_requests (company_id, purpose, customer_invoice_id, paystack_reference, amount_cents, status)
       VALUES ($1, 'customer_invoice', $2, $3, 11500, 'pending')`, [CO, id, ref]);
    expect((await deliver(ref, 11500)).statusCode).toBe(200);
    const paid = await pool.query('SELECT amount_paid::text AS p FROM customer_invoices WHERE id = $1', [id]);
    expect(paid.rows).toEqual([{ p: '0.00' }]);
    const payments = await pool.query(
      `SELECT cp.total_amount::text AS total, (SELECT count(*)::INT FROM customer_payment_allocations a WHERE a.payment_id = cp.id) AS allocations
       FROM customer_payments cp WHERE cp.company_id = $1 AND cp.bank_reference = $2`, [CO, ref]);
    expect(payments.rows).toEqual([{ total: '115.00', allocations: 0 }]);
    const review = await pool.query('SELECT failure_reason FROM paystack_payment_requests WHERE paystack_reference = $1', [ref]);
    expect(String(review.rows[0]?.failure_reason)).toMatch(/invoice_foreign_currency/);
  });
});
