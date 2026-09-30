/**
 * R-167 — an explicit-amount portal payment link charges its own amount, capped at what the
 * invoice still owes, and a successful payment spends it.
 *
 * paystack/create charged the invoice's whole outstanding balance and never read the link's
 * amount, so a R40.50 part-payment link showed R40.50 and charged R115. It also charged a
 * cancelled or soft-deleted invoice, sent NaN cents to the gateway on a NaN amount_paid, and a
 * negative legacy amount_paid raised the charge above the invoice total. Nothing marked a link
 * paid, so a paid link stayed payable. The invoice's standing link is covered in
 * r167-standing-links-and-checkout.int.test.ts.
 *
 * Paystack is mocked: initializeTransaction records the amount it was asked to charge; the
 * webhook is delivered signed; verifyTransaction is stubbed for the return-page route.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'crypto';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import {
  CO, SECRET, addLink, cleanupCompany, create, deliver, getLink, invoiceWithLink, linkRow, pool, requests,
  seedCompany, verify,
} from './r167-portal-links.helpers';
import { spendPaymentLinkOfRequest } from '@/modules/accounting/services/ar/portalLinkCharge';
import { clearSystemAccountCache } from '@/modules/accounting/services/gl/systemAccountResolver';

assertDisposable();

const h = vi.hoisted(() => ({ charged: [] as number[], verifyTransaction: vi.fn() }));
vi.mock('@/modules/billing/services/paystackClient', () => ({
  initializeTransaction: async (input: { amountCents: number; reference: string }) => {
    h.charged.push(input.amountCents);
    return { reference: input.reference, accessCode: 'ac_r167', authorizationUrl: `https://checkout.test/${input.reference}` };
  },
  verifyTransaction: (...a: unknown[]) => h.verifyTransaction(...a),
  chargeAuthorization: vi.fn(async () => { throw new Error('Paystack must not be charged in this test'); }),
}));

beforeAll(async () => {
  vi.stubEnv('PAYSTACK_SECRET_KEY', SECRET);
  vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://app.r167.test');
  await seedCompany();
  clearSystemAccountCache();
});
beforeEach(() => { h.charged.length = 0; h.verifyTransaction.mockReset(); });
afterAll(async () => { vi.unstubAllEnvs(); await cleanupCompany(); });

describe('create charges the link amount, capped at the balance', () => {
  it.each([
    ['a part-payment link on an unpaid invoice', 0, 40.5, 4050],
    ['a link over what is left after a part payment', 85, 40.5, 3000],
    ['a legacy link over a negative amount_paid (never above the total)', -50, 200, 11500],
    ['a NULL amount_paid counts as nothing paid', null, 40.5, 4050],
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

  it('a NaN link amount is refused, not turned into the whole balance', async () => {
    const { invoiceId, linkId, token } = await invoiceWithLink(0, 10);
    await pool.query("UPDATE portal_payment_links SET amount = 'NaN' WHERE id = $1", [linkId]);
    expect((await create(token)).statusCode).toBe(400);
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

  it.each([
    ['an expired link', "expires_at = NOW() - INTERVAL '1 minute'", 'Payment link expired'],
    ['a link with no status', 'status = NULL', 'Payment link not active'],
  ] as const)('%s is refused', async (_n, set, message) => {
    const { linkId, token } = await invoiceWithLink(0, 10);
    await pool.query(`UPDATE portal_payment_links SET ${set} WHERE id = $1`, [linkId]);
    const r = await create(token);
    expect(r.statusCode).toBe(400);
    expect(r.body.error?.message).toBe(message);
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

  it('the verify route marks the link paid when it settles first', async () => {
    const { invoiceId, linkId, token } = await invoiceWithLink(0, 20);
    expect((await create(token)).statusCode).toBe(200);
    const [req] = await requests(invoiceId);
    h.verifyTransaction.mockResolvedValue({ status: 'success', id: 1671, paidAt: new Date().toISOString(), channel: 'card' });
    expect((await verify(req!.ref)).statusCode).toBe(200);
    expect(await linkRow(linkId)).toMatchObject({ status: 'paid', payment_reference: req!.ref });
  });

  it('a link cancelled after checkout started is not turned into a paid one', async () => {
    const { invoiceId, linkId, token } = await invoiceWithLink(0, 20);
    expect((await create(token)).statusCode).toBe(200);
    await pool.query("UPDATE portal_payment_links SET status = 'cancelled' WHERE id = $1", [linkId]);
    const [req] = await requests(invoiceId);
    await deliver(req!.ref, 2000);
    expect((await linkRow(linkId)).status).toBe('cancelled');
  });

  it('a request with no link (made before R-167) settles and touches no link', async () => {
    const { invoiceId, linkId } = await invoiceWithLink(0, 20);
    const ref = `r167_legacy_${randomUUID().slice(0, 8)}`;
    await pool.query(`INSERT INTO paystack_payment_requests (company_id, purpose, customer_invoice_id, paystack_reference,
      amount_cents, status) VALUES ($1, 'customer_invoice', $2, $3, 2000, 'pending')`, [CO, invoiceId, ref]);
    await deliver(ref, 2000);
    expect((await linkRow(linkId)).status).toBe('active');
  });

  it('the spend needs a completed request in the same company', async () => {
    const { invoiceId, linkId, token } = await invoiceWithLink(0, 20);
    expect((await create(token)).statusCode).toBe(200);
    const [req] = await requests(invoiceId);
    await spendPaymentLinkOfRequest(CO, req!.ref); // still pending
    expect((await linkRow(linkId)).status).toBe('active');
    await pool.query("UPDATE paystack_payment_requests SET status = 'completed' WHERE paystack_reference = $1", [req!.ref]);
    await spendPaymentLinkOfRequest(randomUUID(), req!.ref); // another company
    expect((await linkRow(linkId)).status).toBe('active');
    await spendPaymentLinkOfRequest(CO, req!.ref);
    expect((await linkRow(linkId)).status).toBe('paid');
  });
});

describe('the pay page shows what will be charged', () => {
  it('the public GET gives the link amount capped at the balance', async () => {
    const { token } = await invoiceWithLink(85, 40.5);
    const r = await getLink(token);
    expect(r.statusCode).toBe(200);
    expect(r.body.data?.amount).toBe(30);
  });

  it('a link on a paid invoice says there is nothing to pay', async () => {
    const { token } = await invoiceWithLink(115, 10);
    const r = await getLink(token);
    expect(r.statusCode).toBe(400);
    expect(r.body.error?.message).toBe('This invoice has no outstanding balance');
  });

  it('a link on a cancelled invoice is not found', async () => {
    const { token } = await invoiceWithLink(0, 10, "status = 'cancelled'");
    expect((await getLink(token)).statusCode).toBe(404);
  });
});
