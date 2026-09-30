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
import { createHash } from 'crypto';
import { SignJWT } from 'jose';
import { assertDisposable, request } from './mfa-impersonation-postgres.helpers';
import {
  CO, SECRET, USER, addLink, call, cleanupCompany, create, deliver, getLink, invoiceWithLink, linkRow, pool, requests, seedCompany,
} from './r167-portal-links.helpers';
import { enableOnlinePayment } from '@/modules/accounting/services/core/paymentGatewayPortalService';
import { clearSystemAccountCache } from '@/modules/accounting/services/gl/systemAccountResolver';

assertDisposable();

const h = vi.hoisted(() => ({
  charged: [] as number[],
  timeouts: [] as (number | undefined)[],
  /** Runs inside the gateway call, before it answers; a test can hold it open or make it fail. */
  during: null as null | (() => Promise<void>),
}));
vi.mock('@/modules/billing/services/paystackClient', () => ({
  initializeTransaction: async (input: { amountCents: number; reference: string; timeoutMs?: number }) => {
    h.charged.push(input.amountCents);
    h.timeouts.push(input.timeoutMs);
    if (h.during) await h.during();
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
beforeEach(() => { h.charged.length = 0; h.timeouts.length = 0; h.during = null; });
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
    expect((await deliver(req!.ref, 11500)).statusCode).toBe(200);
    expect((await pool.query('SELECT 1 FROM customer_payments WHERE bank_reference = $1', [req!.ref])).rowCount).toBe(1);
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
    const explicitOnNamed = await addLink(named.invoiceId, 10); // same invoice, not the one payment_url names
    await pool.query("UPDATE customer_invoices SET payment_url = 'https://app.r167.test/portal/pay/' || $2 WHERE id = $1",
      [named.invoiceId, named.token]);
    await pool.query(readFileSync('scripts/migrations/sql/717_paystack_request_portal_link.sql', 'utf8'));
    expect((await linkRow(named.linkId)).charges_balance).toBe(true);
    expect((await linkRow(other.linkId)).charges_balance).toBe(false);
    expect((await linkRow(explicitOnNamed.linkId)).charges_balance).toBe(false);
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

describe('create holds nothing across the gateway call', () => {
  it('a click waits for the link lock another checkout holds, then starts exactly one', async () => {
    const { token } = await invoiceWithLink(0, 40.5);
    const holder = await pool.connect();
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT 1 FROM portal_payment_links WHERE token = $1 FOR UPDATE', [token]);
      const pending = create(token);
      await new Promise((done) => setTimeout(done, 300));
      expect(h.charged).toEqual([]); // blocked on the lock
      await holder.query('COMMIT');
      expect((await pending).statusCode).toBe(200);
    } finally {
      holder.release();
    }
    expect((await create(token)).statusCode).toBe(200);
    expect(h.charged).toEqual([4050]);
  });

  it('while the gateway is answering, the link is not locked and the checkout is already recorded', async () => {
    const { invoiceId, token } = await invoiceWithLink(0, 40.5);
    const seen: { locked: boolean; rows: number }[] = [];
    h.during = async () => {
      const probe = await pool.connect();
      try {
        await probe.query('BEGIN');
        const locked = await probe.query('SELECT 1 FROM portal_payment_links WHERE token = $1 FOR UPDATE NOWAIT', [token])
          .then(() => false, () => true);
        await probe.query('ROLLBACK');
        seen.push({ locked, rows: (await requests(invoiceId)).length });
      } finally {
        probe.release();
      }
    };
    expect((await create(token)).statusCode).toBe(200);
    expect(seen).toEqual([{ locked: false, rows: 1 }]);
    expect(h.timeouts).toEqual([10_000]);
  });

  it('a checkout still being set up answers 409 instead of starting another', async () => {
    const { invoiceId, linkId, token } = await invoiceWithLink(0, 40.5);
    await pool.query(`INSERT INTO paystack_payment_requests (company_id, purpose, customer_invoice_id, paystack_reference,
      amount_cents, status, portal_payment_link_id) VALUES ($1, 'customer_invoice', $2, $3, 4050, 'pending', $4)`,
      [CO, invoiceId, `r167_starting_${linkId.slice(0, 8)}`, linkId]);
    const r = await create(token);
    expect(r.statusCode).toBe(409);
    expect(h.charged).toEqual([]);
    await pool.query("UPDATE paystack_payment_requests SET created_at = NOW() - INTERVAL '61 seconds' WHERE customer_invoice_id = $1", [invoiceId]);
    expect((await create(token)).statusCode).toBe(200); // abandoned while starting: a fresh one
    expect(h.charged).toEqual([4050]);
  });

  it('a gateway failure marks the recorded checkout failed, and the next click starts afresh', async () => {
    const { invoiceId, token } = await invoiceWithLink(0, 40.5);
    h.during = async () => { throw new Error('gateway timed out'); };
    expect((await create(token)).statusCode).toBe(500);
    expect((await pool.query('SELECT status, authorization_url FROM paystack_payment_requests WHERE customer_invoice_id = $1', [invoiceId])).rows)
      .toEqual([{ status: 'failed', authorization_url: null }]);
    h.during = null;
    expect((await create(token)).statusCode).toBe(200);
    expect(h.charged).toEqual([4050, 4050]);
  });

  it('a link that has used its 20 checkouts for the window is refused 429 before anything else', async () => {
    const { invoiceId, token } = await invoiceWithLink(0, 40.5);
    // The limiter's shared counter for this link, already at its maximum of 20.
    const key = `paystack-create-link:${createHash('sha256').update(token).digest('hex').slice(0, 32)}`;
    await pool.query(`INSERT INTO rate_limit_counters (key, count, window_start) VALUES ($1, 20, NOW())
      ON CONFLICT (key) DO UPDATE SET count = 20, window_start = NOW()`, [key]);
    try {
      expect((await create(token)).statusCode).toBe(429);
      expect(h.charged).toEqual([]);
      expect(await requests(invoiceId)).toEqual([]);
    } finally {
      await pool.query('DELETE FROM rate_limit_counters WHERE key = $1', [key]);
    }
  });
});

