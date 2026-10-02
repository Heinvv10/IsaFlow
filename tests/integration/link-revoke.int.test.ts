/**
 * LINK-REVOKE: POST /customer-invoices/[id]/payment-link/revoke cancels every active standing link on
 * the invoice and clears payment_url / online_payment_enabled, so the next Pay Now mints a new one.
 * The concurrency and lock-timeout cases are in link-revoke-locking.int.test.ts.
 *
 * Real Postgres, real route and wrappers; only the Paystack client is stubbed.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'crypto';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { CO, USER, addLink, create, deliver, getLink, pool, requests } from './r167-portal-links.helpers';
import { invoice, links, payNow, tokenOf } from './r177-portal-followups.helpers';
import { log } from '@/lib/logger';
import { getCustomerInvoiceDetail } from '@/modules/accounting/services/ar/customerInvoiceReadService';
import { als } from '@/lib/als';
import { revoke, revokeInTx, row, setupRevokeFixture, status, teardownRevokeFixture, viewerToken } from './link-revoke.helpers';

assertDisposable();

vi.mock('@/modules/billing/services/paystackClient', () => ({
  initializeTransaction: async (input: { reference: string }) =>
    ({ reference: input.reference, accessCode: 'ac_revoke', authorizationUrl: `https://checkout.test/${input.reference}` }),
  verifyTransaction: vi.fn(),
  chargeAuthorization: vi.fn(async () => { throw new Error('Paystack must not be charged in this test'); }),
}));

beforeAll(setupRevokeFixture);
afterAll(teardownRevokeFixture);

describe('LINK-REVOKE: revoke the standing payment link', () => {
  it('cancels the named standing link and clears payment_url and online_payment_enabled', async () => {
    const id = await invoice();
    const token = tokenOf(await payNow(id));
    expect(await row(id)).toMatchObject({ on: true });
    const r = await revoke(id);
    expect(r.statusCode, JSON.stringify(r.body)).toBe(200);
    expect(r.body.data).toEqual({ revoked: true, cancelled: 1 });
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
    expect(pay.statusCode).toBe(400);
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

  it('leaves an explicit-amount link untouched; cancels the unnamed standing link', async () => {
    const id = await invoice();
    const explicit = await addLink(id, 10, false);
    const unnamed = await addLink(id, 115, true);
    const named = tokenOf(await payNow(id));
    expect((await revoke(id)).statusCode).toBe(200);
    expect(await status(explicit.token)).toBe('active');
    expect(await status(unnamed.token)).toBe('cancelled');
    expect(await status(named)).toBe('cancelled');
  });

  it('cancels every active standing link on the invoice, named or not, and only on that invoice', async () => {
    const id = await invoice();
    const other = await invoice();
    const old = await addLink(id, 115, true); // a pre-R-177 Pay Now click
    await pool.query("UPDATE portal_payment_links SET expires_at = NOW() + interval '30 days' WHERE id = $1", [old.linkId]);
    const named = tokenOf(await payNow(id));
    const elsewhere = await addLink(other, 115, true);
    const r = await revoke(id);
    expect(r.body.data).toEqual({ revoked: true, cancelled: 2 });
    expect(await status(old.token)).toBe('cancelled');
    expect(await status(named)).toBe('cancelled');
    expect(await status(elsewhere.token)).toBe('active');
    expect((await getLink(old.token)).statusCode).toBe(404);
  });

  it('a pre-717 fixed-amount link (charges_balance true by default) is cancelled; cancelled equals the active standing links found', async () => {
    const id = await invoice();
    const pre717 = await addLink(id, 10, true);
    const modern = await addLink(id, 20, false);
    const named = tokenOf(await payNow(id));
    const found = Number((await pool.query(
      "SELECT count(*) FROM portal_payment_links WHERE invoice_id = $1 AND status = 'active' AND charges_balance", [id])).rows[0].count);
    expect(found).toBe(2);
    const r = await revoke(id);
    expect(r.body.data).toEqual({ revoked: true, cancelled: found });
    expect(await status(pre717.token)).toBe('cancelled');
    expect(await status(named)).toBe('cancelled');
    expect(await status(modern.token)).toBe('active');
  });

  it('stuck button: a payment_url naming an explicit-amount link is cleared, the link left active', async () => {
    const id = await invoice();
    const explicit = await addLink(id, 10, false);
    await pool.query('UPDATE customer_invoices SET payment_url = $2, online_payment_enabled = true WHERE id = $1',
      [id, `https://app.revoke.test/portal/pay/${explicit.token}`]);
    const r = await revoke(id);
    expect(r.body.data).toEqual({ revoked: true, cancelled: 0 });
    expect(await status(explicit.token)).toBe('active');
    expect(await row(id)).toEqual({ payment_url: null, on: false });
  });

  it.each(['paid', 'cancelled'])('stuck button: a payment_url naming a %s link is cleared, the link status kept', async (st) => {
    const id = await invoice();
    const token = tokenOf(await payNow(id));
    await pool.query('UPDATE portal_payment_links SET status = $2 WHERE token = $1', [token, st]);
    const r = await revoke(id);
    expect(r.body.data).toEqual({ revoked: true, cancelled: 0 });
    expect(await status(token)).toBe(st);
    expect(await row(id)).toEqual({ payment_url: null, on: false });
  });

  it('stuck button: a payment_url naming no link at all is cleared', async () => {
    const id = await invoice();
    await pool.query("UPDATE customer_invoices SET payment_url = 'https://app.revoke.test/portal/pay/gone', online_payment_enabled = true WHERE id = $1", [id]);
    expect((await revoke(id)).body.data).toEqual({ revoked: true, cancelled: 0 });
    expect(await row(id)).toEqual({ payment_url: null, on: false });
  });

  it('an active standing link the invoice does not name is cancelled even with no payment_url', async () => {
    const id = await invoice();
    const old = await addLink(id, 115, true);
    expect((await revoke(id)).body.data).toEqual({ revoked: true, cancelled: 1 });
    expect(await status(old.token)).toBe('cancelled');
  });

  it('an expired active standing link with no payment_url is still cancelled (200, cancelled 1); a second revoke is 404', async () => {
    const id = await invoice();
    const old = await addLink(id, 115, true);
    await pool.query("UPDATE portal_payment_links SET expires_at = NOW() - interval '1 day' WHERE id = $1", [old.linkId]);
    expect((await row(id)).payment_url).toBeNull();
    const r = await revoke(id);
    expect(r.statusCode).toBe(200);
    expect(r.body.data).toEqual({ revoked: true, cancelled: 1 });
    expect(await status(old.token)).toBe('cancelled');
    expect((await revoke(id)).statusCode).toBe(404);
  });

  it('only an explicit-amount link and no payment_url: nothing to do, 404, link untouched', async () => {
    const id = await invoice();
    const explicit = await addLink(id, 10, false);
    expect((await revoke(id)).statusCode).toBe(404);
    expect(await status(explicit.token)).toBe('active');
  });

  it('leaves a checkout already open at Paystack in place, and it still settles after the revoke', async () => {
    const id = await invoice();
    const token = tokenOf(await payNow(id));
    expect((await create(token)).statusCode).toBe(200);
    const before = await requests(id);
    expect(before).toHaveLength(1);
    expect((await revoke(id)).statusCode).toBe(200);
    expect(await requests(id)).toEqual(before);
    expect(await status(token)).toBe('cancelled');
    await deliver(before[0]!.ref, 11500);
    const banked = await pool.query('SELECT total_amount::text AS t FROM customer_payments WHERE bank_reference = $1', [before[0]!.ref]);
    expect(banked.rows).toEqual([{ t: '115.00' }]);
    expect((await pool.query('SELECT amount_paid::text AS p FROM customer_invoices WHERE id = $1', [id])).rows).toEqual([{ p: '115.00' }]);
  });

  it('logs who revoked which invoice and how many links were cancelled', async () => {
    const id = await invoice();
    await payNow(id);
    const spy = vi.spyOn(log, 'info');
    try {
      expect((await revoke(id)).statusCode).toBe(200);
      expect(spy).toHaveBeenCalledWith('Standing payment link revoked',
        { companyId: CO, invoiceId: id, userId: USER, cancelled: 1 }, 'PaymentLink');
    } finally { spy.mockRestore(); }
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

  it('only a paid standing link and no payment_url: nothing to do, 404, status kept', async () => {
    const id = await invoice();
    const paid = await addLink(id, 115, true);
    await pool.query("UPDATE portal_payment_links SET status = 'paid' WHERE id = $1", [paid.linkId]);
    expect((await revoke(id)).statusCode).toBe(404);
    expect(await status(paid.token)).toBe('paid');
  });

  it('a malformed id is 400', async () => {
    expect((await revoke('not-a-uuid')).statusCode).toBe(400);
  });

  it('a viewer is refused and nothing changes', async () => {
    const id = await invoice();
    const token = tokenOf(await payNow(id));
    const r = await revoke(id, { jwt: viewerToken() });
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

  it('the invoice detail read says whether an active standing link exists, scoped to the company', async () => {
    const detail = async (id: string, co = CO) => {
      const client = await pool.connect();
      try {
        return await als.run({ client, userId: USER, companyId: co, claims: {} } as never, () => getCustomerInvoiceDetail(co, id));
      } finally { client.release(); }
    };
    const none = await invoice();
    expect((await detail(none))?.has_standing_link).toBe(false);
    const pre717 = await invoice();
    await addLink(pre717, 10, true); // charges_balance true by default, no payment_url
    expect((await detail(pre717))?.has_standing_link).toBe(true);
    const fixed = await invoice();
    await addLink(fixed, 10, false);
    expect((await detail(fixed))?.has_standing_link).toBe(false);
    const paid = await invoice();
    const l = await addLink(paid, 10, true);
    await pool.query("UPDATE portal_payment_links SET status = 'paid' WHERE id = $1", [l.linkId]);
    expect((await detail(paid))?.has_standing_link).toBe(false);
    const expired = await invoice();
    const e = await addLink(expired, 10, true);
    await pool.query("UPDATE portal_payment_links SET expires_at = NOW() - interval '1 day' WHERE id = $1", [e.linkId]);
    expect((await detail(expired))?.has_standing_link).toBe(false);
    const live = await invoice();
    const lv = await addLink(live, 10, true);
    await pool.query("UPDATE portal_payment_links SET expires_at = NOW() + interval '10 days' WHERE id = $1", [lv.linkId]);
    expect((await detail(live))?.has_standing_link).toBe(true);
    expect(await detail(pre717, randomUUID())).toBeNull();
  });
});
