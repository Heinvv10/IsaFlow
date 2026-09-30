/**
 * R-167 — the invoice's standing "Pay now" link, and one checkout per click.
 *
 * Two kinds of link (Hein, 2026-09-30). The link customer_invoices.payment_url names, minted by
 * pay-now and enableOnlinePayment, charges the LIVE balance and a payment never spends it: its
 * `amount` is only the balance when it was minted, so a draft edited upward, or a receipt voided
 * later, must not leave the invoice with a pay URL that undercharges or 404s. An explicit-amount
 * link (the other suite) charges its own amount and is spent.
 *
 * Clicking Pay twice from one link used to start two checkouts for the full amount, and both
 * could be paid. A checkout started from the same link for the same amount within the reuse
 * window is now handed out again instead.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'fs';
import { SignJWT } from 'jose';
import { assertDisposable, request } from './mfa-impersonation-postgres.helpers';
import {
  CO, SECRET, USER, call, cleanupCompany, create, deliver, getLink, invoiceWithLink, linkRow, pool, requests, seedCompany,
} from './r167-portal-links.helpers';
import { enableOnlinePayment } from '@/modules/accounting/services/core/paymentGatewayPortalService';
import { clearSystemAccountCache } from '@/modules/accounting/services/gl/systemAccountResolver';

assertDisposable();

const h = vi.hoisted(() => ({ charged: [] as number[] }));
vi.mock('@/modules/billing/services/paystackClient', () => ({
  initializeTransaction: async (input: { amountCents: number; reference: string }) => {
    h.charged.push(input.amountCents);
    return { reference: input.reference, accessCode: 'ac_r167', authorizationUrl: `https://checkout.test/${input.reference}` };
  },
  verifyTransaction: vi.fn(),
  chargeAuthorization: vi.fn(async () => { throw new Error('Paystack must not be charged in this test'); }),
}));

beforeAll(async () => {
  vi.stubEnv('PAYSTACK_SECRET_KEY', SECRET);
  vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://app.r167.test');
  await seedCompany();
  clearSystemAccountCache();
});
beforeEach(() => { h.charged.length = 0; });
afterAll(async () => { vi.unstubAllEnvs(); await cleanupCompany(); });

describe("the invoice's standing link charges the live balance and is never spent", () => {
  it('charges what is owed now, not the balance it was minted at', async () => {
    const { token } = await invoiceWithLink(85, 115, '', true); // minted at R115, R30 owed now
    expect((await create(token)).statusCode).toBe(200);
    expect(h.charged).toEqual([3000]);
    expect((await getLink(token)).body.data?.amount).toBe(30);
  });

  it('charges more than it was minted at when the invoice grew', async () => {
    const { token } = await invoiceWithLink(0, 100, 'subtotal = 135, total_amount = 150', true);
    expect((await create(token)).statusCode).toBe(200);
    expect(h.charged).toEqual([15000]);
  });

  it('stays active after a payment, and charges the rest next time', async () => {
    const { invoiceId, linkId, token } = await invoiceWithLink(0, 115, '', true);
    expect((await create(token)).statusCode).toBe(200);
    const [req] = await requests(invoiceId);
    await pool.query('UPDATE customer_invoices SET amount_paid = 100 WHERE id = $1', [invoiceId]); // e.g. an EFT lands
    await deliver(req!.ref, 11500);
    expect((await linkRow(linkId)).status).toBe('active');
    await pool.query('UPDATE customer_invoices SET amount_paid = 90 WHERE id = $1', [invoiceId]); // a receipt reversed
    h.charged.length = 0;
    expect((await create(token)).statusCode).toBe(200);
    expect(h.charged).toEqual([2500]);
  });

  it('enableOnlinePayment and pay-now mint standing links', async () => {
    const a = await invoiceWithLink(0, 1);
    const url = await enableOnlinePayment(CO, a.invoiceId);
    const token = url!.split('/portal/pay/')[1]!;
    expect((await pool.query('SELECT charges_balance FROM portal_payment_links WHERE token = $1', [token])).rows)
      .toEqual([{ charges_balance: true }]);

    const b = await invoiceWithLink(0, 1);
    const jwt = await new SignJWT({ sub: USER, aal: 'aal2' }).setProtectedHeader({ alg: 'HS256' })
      .setExpirationTime('1h').sign(new TextEncoder().encode(process.env.JWT_SECRET));
    const payNow = (await import('../../pages/api/accounting/customer-invoices/[id]/pay-now')).default;
    const req = { ...(request({ 'sb-access-token': jwt, active_company_id: CO }, 'POST') as object), query: { id: b.invoiceId } };
    const r = await call(payNow as never, req);
    expect(r.statusCode, JSON.stringify(r.body)).toBe(200);
    const minted = await pool.query(
      `SELECT l.charges_balance FROM portal_payment_links l JOIN customer_invoices ci ON ci.id = l.invoice_id
       WHERE ci.id = $1 AND ci.payment_url LIKE ('%/portal/pay/' || l.token)`, [b.invoiceId]);
    expect(minted.rows).toEqual([{ charges_balance: true }]);
  });

  it('migration 717 marks the link an invoice payment_url names as standing, and nothing else', async () => {
    const named = await invoiceWithLink(0, 115);
    const other = await invoiceWithLink(0, 20);
    await pool.query("UPDATE customer_invoices SET payment_url = 'https://app.r167.test/portal/pay/' || $2 WHERE id = $1",
      [named.invoiceId, named.token]);
    await pool.query(readFileSync('scripts/migrations/sql/717_paystack_request_portal_link.sql', 'utf8'));
    expect((await linkRow(named.linkId)).charges_balance).toBe(true);
    expect((await linkRow(other.linkId)).charges_balance).toBe(false);
  });
});

describe('one checkout per click', () => {
  it('a second click on the same link gets the same checkout, and is charged once', async () => {
    const { invoiceId, token } = await invoiceWithLink(0, 40.5);
    const first = await create(token);
    const second = await create(token);
    expect(second.body.data).toEqual(first.body.data);
    expect(h.charged).toEqual([4050]);
    expect(await requests(invoiceId)).toHaveLength(1);
  });

  it('a new checkout once the old one is past the reuse window, or the amount changed', async () => {
    const { invoiceId, token } = await invoiceWithLink(0, 115, '', true);
    expect((await create(token)).statusCode).toBe(200);
    await pool.query("UPDATE paystack_payment_requests SET created_at = NOW() - INTERVAL '31 minutes' WHERE customer_invoice_id = $1", [invoiceId]);
    expect((await create(token)).statusCode).toBe(200);
    await pool.query('UPDATE customer_invoices SET amount_paid = 15 WHERE id = $1', [invoiceId]);
    expect((await create(token)).statusCode).toBe(200);
    expect(h.charged).toEqual([11500, 11500, 10000]);
    expect(await requests(invoiceId)).toHaveLength(3);
  });

  it('a completed checkout is never handed out again', async () => {
    const { invoiceId, token } = await invoiceWithLink(0, 115, '', true);
    expect((await create(token)).statusCode).toBe(200);
    await pool.query("UPDATE paystack_payment_requests SET status = 'completed' WHERE customer_invoice_id = $1", [invoiceId]);
    expect((await create(token)).statusCode).toBe(200);
    expect(h.charged).toHaveLength(2);
  });
});
