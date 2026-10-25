// tests/integration/s07e-billing-paths.int.test.ts
//
// S-07e (migration 945): no app role may write the billing tables any more; the
// code makes those writes on the migration_admin pool. This proves each
// legitimate path still works end to end through its real route, on the
// production logins (s07b helpers), and that the Paystack webhook credits a
// purchase or settles a charge only when the payment matches it. Paystack's
// API is stubbed (paystackClient's initialize, verify and charge calls); the
// webhook is signed with a fixture secret, and the revoked mandate has no
// Paystack subscription to disable.
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { Readable } from 'stream';
import { createHmac } from 'crypto';
import type { NextApiRequest } from 'next';
import agingRoute from '../../pages/api/accounting/reports-ar-aging';
import walletRoute from '../../pages/api/billing/flows/wallet';
import autoTopupRoute from '../../pages/api/billing/flows/auto-topup';
import revokeRoute from '../../pages/api/billing/paystack/mandate/revoke';
import resetMonthRoute from '../../pages/api/cron/reset-flow-month';
import chargesCron from '../../pages/api/cron/subscription-charges';
import createMandateRoute from '../../pages/api/billing/paystack/mandate/create';
import verifyMandateRoute from '../../pages/api/billing/paystack/mandate/verify';
import webhookRoute from '../../pages/api/webhooks/paystack';
import { getAuthPool } from '@/lib/auth/authPool';
import { getDbPool } from '@/lib/neon';
import { migrationAdminPool } from '@/lib/auth/migrationAdminPool';
import { getFlowCost } from '@/modules/billing/services/flowOperationCatalog';
import { callRoute } from './s07-users-privilege-columns.helpers';
import { response } from './mfa-impersonation-postgres.helpers';
import { CRON, callCron, fixture, newIds, setup, teardown } from './s07b-app-pool-login-role.helpers';

const paystack = vi.hoisted(() => ({ reference: '', metadata: null as Record<string, unknown> | null,
  charged: [] as Array<{ authorizationCode: string; amountCents: number }> }));
vi.mock('@/modules/billing/services/paystackClient', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  initializeTransaction: vi.fn(async (input: { reference: string; metadata?: Record<string, unknown> }) => {
    paystack.reference = input.reference;
    paystack.metadata = input.metadata ?? null; // what Paystack hands back on verify
    return { authorizationUrl: 'https://checkout.paystack.test/x', accessCode: 'ac_s07e', reference: input.reference };
  }),
  verifyTransaction: vi.fn(async (reference: string) => ({ status: 'success', reference, id: 1, amountCents: 100,
    requestedAmountCents: 100, feesCents: 0, currency: 'ZAR', channel: 'card', paidAt: null, gatewayResponse: 'Approved',
    metadata: paystack.metadata, customer: { email: 'payer@s07e.test.local', customerCode: 'CUS_s07e' },
    authorization: { authorizationCode: 'AUTH_s07e_card', bin: '408408', last4: '4081', expMonth: '12', expYear: '2030',
      cardType: 'visa', bank: 'Test Bank', brand: 'visa', reusable: true } })),
  chargeAuthorization: vi.fn(async (input: { authorizationCode: string; amountCents: number; reference: string }) => {
    paystack.charged.push({ authorizationCode: input.authorizationCode, amountCents: input.amountCents });
    return { status: 'success', reference: input.reference, paystackId: 2, amountCents: input.amountCents, gatewayResponse: 'Approved' };
  }),
}));

const WEBHOOK_KEY = 'fixture-paystack-webhook-key-s07e';
const ids = newIds();
// owner owns `company`, on PAYG.
const { owner, company } = ids;
const payg = crypto.randomUUID();
const bundle = crypto.randomUUID();
const COST = getFlowCost('report.age');

const q = (text: string, params: unknown[] = []) => fixture.query(text, params);
const wallet = async () => (await q(`SELECT balance_flows, month_flows_used, auto_topup_enabled, auto_topup_bundle_id
  FROM flow_wallet WHERE company_id = $1`, [company])).rows[0] as Record<string, unknown>;
// flow_ledger is append-only: each test reads what it added since it began.
let since = '';
const ledger = async () => (await q(`SELECT type, flows FROM flow_ledger WHERE company_id = $1 AND created_at > $2::timestamptz
  ORDER BY created_at, id`, [company, since])).rows;
const setBalance = (n: number) => q('UPDATE flow_wallet SET balance_flows = $2 WHERE company_id = $1', [company, n]);

beforeAll(async () => {
  await setup(ids);
  vi.stubEnv('PAYSTACK_SECRET_KEY', WEBHOOK_KEY);
  vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://app.s07e.test');
  await q(`INSERT INTO company_users (company_id, user_id, role) VALUES ($1, $2, 'owner')
    ON CONFLICT (company_id, user_id) DO UPDATE SET role = 'owner'`, [company, owner]);
  // getCompanyPlan meters exactly the plan coded 'payg'.
  const existing = (await q(`SELECT id FROM plans WHERE code = 'payg'`)).rows[0]?.id as string | undefined;
  if (!existing) await q(`INSERT INTO plans (id, code, name) VALUES ($1, 'payg', 'S07e PAYG')`, [payg]);
  await q(`INSERT INTO subscriptions (company_id, plan_id, status) SELECT $1, id, 'active' FROM plans WHERE code = 'payg'`, [company]);
  await q(`INSERT INTO flow_bundles (id, name, flows, price_cents) VALUES ($1, 'S07e bundle', 500, 25000)`, [bundle]);
}, 60000);

afterAll(async () => {
  await q(`DELETE FROM paystack_webhook_events WHERE reference LIKE 's07e\_%'`);
  for (const t of ['paystack_payment_requests', 'flow_purchases', 'subscription_charges', 'subscription_mandates',
    'subscriptions']) {
    await q(`DELETE FROM ${t} WHERE company_id = $1`, [company]);
  }
  await q('DELETE FROM flow_bundles WHERE id = $1', [bundle]);
  await q('DELETE FROM plans WHERE id = $1', [payg]);
  // flow_ledger refuses DELETE (append-only); the fixture's owner clears this file's rows with triggers off.
  const c = await fixture.connect();
  try {
    await c.query('BEGIN');
    await c.query(`SET LOCAL session_replication_role = replica`);
    await c.query('DELETE FROM flow_ledger WHERE company_id = $1', [company]);
    await c.query('COMMIT');
  } finally {
    c.release();
  }
  await teardown(ids, [getAuthPool(), getDbPool(), migrationAdminPool()]);
});

beforeEach(async () => {
  since = (await q('SELECT clock_timestamp()::text AS t')).rows[0]!.t as string;
  await q(`UPDATE flow_wallet SET balance_flows = 100, month_flows_used = 0, auto_topup_enabled = false, auto_topup_bundle_id = NULL,
    payment_method_token = NULL WHERE company_id = $1`, [company]);
});

describe('S-07e (945): metering, on the production logins', () => {
  it('a metered request debits the wallet and records it', async () => {
    const r = await callRoute(agingRoute, { sub: owner, method: 'GET', companyId: company });
    expect(r.status).toBe(200);
    expect(await wallet()).toMatchObject({ balance_flows: 100 - COST, month_flows_used: COST });
    expect(await ledger()).toEqual([{ type: 'debit', flows: -COST }]);
  });

  it('a metered request that fails is refunded', async () => {
    const r = await callRoute(agingRoute, { sub: owner, method: 'POST', companyId: company });
    expect(r.status).toBe(405);
    expect(await wallet()).toMatchObject({ balance_flows: 100, month_flows_used: 0 });
    expect(await ledger()).toEqual([{ type: 'debit', flows: -COST }, { type: 'refund', flows: COST }]);
  });

  it('an empty wallet answers 402, and auto top-up with a planted payment method credits nothing', async () => {
    await setBalance(0);
    await q(`UPDATE flow_wallet SET auto_topup_enabled = true, auto_topup_bundle_id = $2, payment_method_token = 'planted'
      WHERE company_id = $1`, [company, bundle]);
    const r = await callRoute(agingRoute, { sub: owner, method: 'GET', companyId: company });
    expect(r.status).toBe(402);
    expect((await wallet()).balance_flows).toBe(0);
    expect(await ledger()).toEqual([]);
    expect((await q(`SELECT count(*)::int AS n FROM flow_purchases WHERE company_id = $1 AND payment_method = 'auto_topup'`,
      [company])).rows[0]!.n).toBe(0);
  });

  it('the wallet route answers without the payment method', async () => {
    const r = await callRoute(walletRoute, { sub: owner, method: 'GET', companyId: company });
    expect(r.status).toBe(200);
    const body = JSON.stringify(r.body);
    expect(body).toContain('"balance":100');
    expect(body).not.toMatch(/paymentMethod/i);
  });

  it('auto top-up is switched on and off through its route', async () => {
    const on = await callRoute(autoTopupRoute, { sub: owner, method: 'PATCH', companyId: company, body: { enabled: true, bundleId: bundle } });
    expect(on.status).toBe(200);
    expect(await wallet()).toMatchObject({ auto_topup_enabled: true, auto_topup_bundle_id: bundle });
    const off = await callRoute(autoTopupRoute, { sub: owner, method: 'PATCH', companyId: company, body: { enabled: false } });
    expect(off.status).toBe(200);
    expect(await wallet()).toMatchObject({ auto_topup_enabled: false, auto_topup_bundle_id: null });
  });

  it('the month reset cron zeroes the month\'s usage', async () => {
    await q('UPDATE flow_wallet SET month_flows_used = 42 WHERE company_id = $1', [company]);
    expect((await callCron(resetMonthRoute, CRON)).status).toBe(200);
    expect((await wallet()).month_flows_used).toBe(0);
  });
});

describe('S-07e (945): the Paystack webhook, bound to what was paid', () => {
  let seq = 0;
  async function deliver(data: Record<string, unknown>, event = 'charge.success') {
    const body = JSON.stringify({ event, data: { id: 9000 + (++seq), status: 'success', currency: 'ZAR',
      channel: 'card', customer: { email: 'payer@s07e.test.local', customer_code: 'CUS_s07e' }, ...data } });
    const req = Readable.from([Buffer.from(body)]) as unknown as NextApiRequest;
    (req as { method: string }).method = 'POST';
    (req as { headers: Record<string, string> }).headers = { 'content-type': 'application/json',
      'x-paystack-signature': createHmac('sha512', WEBHOOK_KEY).update(body).digest('hex') };
    const result = response();
    await webhookRoute(req, result.res);
    return result.state.statusCode;
  }
  async function purchaseRequest(priceCents: number) {
    const purchase = (await q(`INSERT INTO flow_purchases (company_id, bundle_id, flows, price_cents, payment_method)
      VALUES ($1, $2, 500, $3, 'paystack') RETURNING id`, [company, bundle, priceCents])).rows[0]!.id as string;
    const reference = `s07e_${crypto.randomUUID().slice(0, 12)}`;
    await q(`INSERT INTO paystack_payment_requests (company_id, purpose, flow_purchase_id, amount_cents, currency, status,
      paystack_reference, payer_email) VALUES ($1, 'flow_bundle', $2, $3, 'ZAR', 'pending', $4, 'payer@s07e.test.local')`,
    [company, purchase, priceCents, reference]);
    return { purchase, reference };
  }
  const purchaseStatus = async (id: string) => (await q('SELECT status FROM flow_purchases WHERE id = $1', [id])).rows[0]!.status;

  // The checkout's own metadata, as purchase.ts starts it: what Paystack signs.
  const meta = (purchase: string, companyId = company) => ({ purpose: 'flow_bundle', company_id: companyId, flow_purchase_id: purchase });
  const review = async (reference: string) => (await q(
    'SELECT failure_reason FROM paystack_payment_requests WHERE paystack_reference = $1', [reference])).rows[0]!.failure_reason;

  it('credits a bundle purchase paid in full', async () => {
    const { purchase, reference } = await purchaseRequest(25000);
    expect(await deliver({ reference, amount: 25000, metadata: meta(purchase) })).toBe(200);
    expect(await purchaseStatus(purchase)).toBe('succeeded');
    expect((await wallet()).balance_flows).toBe(600);
    expect(await ledger()).toEqual([{ type: 'purchase', flows: 500 }]);
  });

  it('credits nothing when a cheap payment is pointed at a dearer purchase', async () => {
    const { purchase, reference } = await purchaseRequest(25000);
    expect(await deliver({ reference, amount: 100, requested_amount: 100, metadata: meta(purchase) })).toBe(200);
    expect(await purchaseStatus(purchase)).toBe('pending');
    expect((await wallet()).balance_flows).toBe(100);
    expect(await ledger()).toEqual([]);
    expect(await review(reference)).toBe('review:flow_purchase_not_credited');
  });

  it('credits a purchase whose payer bore the fee on top of the price', async () => {
    const { purchase, reference } = await purchaseRequest(25000);
    expect(await deliver({ reference, amount: 25750, requested_amount: 25000, metadata: meta(purchase) })).toBe(200);
    expect(await purchaseStatus(purchase)).toBe('succeeded');
    expect((await wallet()).balance_flows).toBe(600);
  });

  it.each([
    ['in another currency', { currency: 'USD' }],
    ['in no stated currency', { currency: undefined }],
  ])('credits nothing for a payment %s', async (_, extra) => {
    const { purchase, reference } = await purchaseRequest(25000);
    expect(await deliver({ reference, amount: 25000, metadata: meta(purchase), ...extra })).toBe(200);
    expect(await purchaseStatus(purchase)).toBe('pending');
    expect((await wallet()).balance_flows).toBe(100);
  });

  it('credits nothing when a victim\'s paid request was re-pointed at the attacker\'s purchase', async () => {
    // The attacker's own pending purchase, and a victim's checkout of the same price. An app role can no
    // longer rewrite the link (945; s07e-billing-temp), so the fixture's owner plays the attacker's rewrite.
    const { purchase: attackers } = await purchaseRequest(25000);
    const victimPurchase = crypto.randomUUID();
    const victimRef = `s07e_${crypto.randomUUID().slice(0, 12)}`;
    await q(`INSERT INTO paystack_payment_requests (company_id, purpose, flow_purchase_id, amount_cents, currency, status,
      paystack_reference) VALUES ($1, 'flow_bundle', $2, 25000, 'ZAR', 'pending', $3)`, [company, attackers, victimRef]);
    expect(await deliver({ reference: victimRef, amount: 25000, metadata: meta(victimPurchase, ids.other) })).toBe(200);
    expect(await purchaseStatus(attackers)).toBe('pending');
    expect((await wallet()).balance_flows).toBe(100);
    expect(await review(victimRef)).toBe('review:checkout_company_mismatch');
  });

  it('a failed payment fails its own purchase, and not one its metadata does not name', async () => {
    const own = await purchaseRequest(25000);
    const other = await purchaseRequest(25000);
    expect(await deliver({ reference: own.reference, metadata: meta(own.purchase) }, 'charge.failed')).toBe(200);
    expect(await deliver({ reference: other.reference, metadata: meta(crypto.randomUUID()) }, 'charge.failed')).toBe(200);
    expect([await purchaseStatus(own.purchase), await purchaseStatus(other.purchase)]).toEqual(['failed', 'pending']);
  });

  it('subscription.disable revokes the mandate holding that Paystack subscription', async () => {
    const code = `SUB_s07e_${crypto.randomUUID().slice(0, 8)}`;
    await q(`UPDATE subscription_mandates SET status = 'revoked' WHERE company_id = $1 AND status = 'active'`, [company]);
    const id = (await q(`INSERT INTO subscription_mandates (company_id, max_amount_cents, status, gateway, paystack_subscription_code)
      VALUES ($1, 100000, 'active', 'paystack', $2) RETURNING id`, [company, code])).rows[0]!.id as string;
    expect(await deliver({ subscription_code: code }, 'subscription.disable')).toBe(200);
    expect((await q('SELECT status, revoked_reason FROM subscription_mandates WHERE id = $1', [id])).rows[0])
      .toEqual({ status: 'revoked', revoked_reason: 'paystack_subscription_disabled' });
  });

  it('settles a subscription charge only for its own amount', async () => {
    const sub = (await q(`SELECT id FROM subscriptions WHERE company_id = $1`, [company])).rows[0]!.id as string;
    const mandate = (await q(`INSERT INTO subscription_mandates (company_id, max_amount_cents, status, gateway)
      VALUES ($1, 100000, 'active', 'paystack') RETURNING id`, [company])).rows[0]!.id as string;
    const charges: string[] = [];
    for (const period of ['2026-08', '2026-09']) {
      charges.push((await q(`INSERT INTO subscription_charges (company_id, mandate_id, subscription_id, period_start, period_end,
        amount_cents, external_reference, status, gateway) VALUES ($1, $2, $3, $4::date, ($4::date + interval '1 month - 1 day')::date,
        49900, $5, 'submitted', 'paystack') RETURNING id`, [company, mandate, sub, `${period}-01`, `s07e-${crypto.randomUUID()}`]))
        .rows[0]!.id as string);
    }
    const refs: string[] = [];
    for (const charge of charges) {
      const reference = `s07e_${crypto.randomUUID().slice(0, 12)}`;
      refs.push(reference);
      await q(`INSERT INTO paystack_payment_requests (company_id, purpose, subscription_charge_id, amount_cents, currency, status,
        paystack_reference, payer_email) VALUES ($1, 'subscription_charge', $2, 49900, 'ZAR', 'pending', $3, 'payer@s07e.test.local')`,
      [company, charge, reference]);
    }
    const chargeMeta = (charge: string) => ({ purpose: 'subscription_charge', company_id: company, subscription_charge_id: charge });
    expect(await deliver({ reference: refs[0], amount: 49900, metadata: chargeMeta(charges[0]!) })).toBe(200);
    expect(await deliver({ reference: refs[1], amount: 100, metadata: chargeMeta(charges[1]!) })).toBe(200);
    const status = async (id: string) => (await q('SELECT status FROM subscription_charges WHERE id = $1', [id])).rows[0]!.status;
    expect([await status(charges[0]!), await status(charges[1]!)]).toEqual(['settled', 'submitted']);
  });
});

describe('S-07e (945): mandates, on the production logins', () => {
  it('an admin revokes the active mandate through its route', async () => {
    await q(`UPDATE subscription_mandates SET status = 'revoked' WHERE company_id = $1`, [company]);
    const id = (await q(`INSERT INTO subscription_mandates (company_id, max_amount_cents, status, gateway, paystack_authorization_code)
      VALUES ($1, 100000, 'active', 'paystack', 'AUTH_s07e') RETURNING id`, [company])).rows[0]!.id as string;
    const r = await callRoute(revokeRoute, { sub: owner, method: 'POST', companyId: company, body: { reason: 's07e' } });
    expect(r.status).toBe(200);
    expect((await q('SELECT status FROM subscription_mandates WHERE id = $1', [id])).rows[0]!.status).toBe('revoked');
  });
});

describe('S-07e (945): a mandate set up and charged, on the production logins', () => {
  const mandate = async () => (await q(`SELECT status, paystack_authorization_code FROM subscription_mandates
    WHERE company_id = $1 AND status IN ('pending', 'active') ORDER BY created_at DESC LIMIT 1`, [company])).rows[0];

  it('an admin creates a mandate, and verify activates it with the card Paystack reports', async () => {
    await q(`UPDATE subscription_mandates SET status = 'revoked' WHERE company_id = $1 AND status IN ('pending', 'active')`, [company]);
    const created = await callRoute(createMandateRoute, { sub: owner, method: 'POST', companyId: company,
      body: { maxAmountCents: 100000 } });
    expect(created).toMatchObject({ status: 200 });
    expect(await mandate()).toEqual({ status: 'pending', paystack_authorization_code: null });
    const verified = await callRoute(verifyMandateRoute, { sub: owner, method: 'POST', companyId: company,
      body: { ref: paystack.reference } });
    expect(verified.status).toBe(200);
    expect(await mandate()).toEqual({ status: 'active', paystack_authorization_code: 'AUTH_s07e_card' });
  });

  it('the charge cron charges a due subscription with its mandate\'s card, settles it and moves the period on', async () => {
    const pro = (await q(`INSERT INTO plans (code, name, monthly_price_cents) VALUES ($1, 'S07e pro', 49900) RETURNING id`,
      [`s07e-pro-${crypto.randomUUID().slice(0, 8)}`])).rows[0]!.id as string;
    try {
      await q(`UPDATE subscriptions SET plan_id = $2, billing_cycle = 'monthly', current_period_start = NOW() - interval '1 month',
        current_period_end = NOW() - interval '1 minute' WHERE company_id = $1`, [company, pro]);
      const before = (await q('SELECT current_period_end FROM subscriptions WHERE company_id = $1', [company])).rows[0]!.current_period_end;
      paystack.charged.length = 0;
      expect((await callCron(chargesCron, CRON)).status).toBe(200);
      // This company's card only: other suites' due subscriptions may share the fixture.
      expect(paystack.charged.filter((c) => c.authorizationCode === 'AUTH_s07e_card'))
        .toEqual([{ authorizationCode: 'AUTH_s07e_card', amountCents: 49900 }]);
      expect((await q(`SELECT status FROM subscription_charges WHERE company_id = $1 ORDER BY created_at DESC LIMIT 1`, [company]))
        .rows[0]!.status).toBe('settled');
      const after = (await q('SELECT current_period_end FROM subscriptions WHERE company_id = $1', [company])).rows[0]!.current_period_end;
      expect(new Date(after as string).getTime()).toBeGreaterThan(new Date(before as string).getTime());
    } finally {
      await q(`DELETE FROM paystack_payment_requests WHERE company_id = $1`, [company]);
      await q(`DELETE FROM subscription_charges WHERE company_id = $1`, [company]);
      await q(`UPDATE subscriptions SET plan_id = (SELECT id FROM plans WHERE code = 'payg') WHERE company_id = $1`, [company]);
      await q('DELETE FROM plans WHERE id = $1', [pro]);
    }
  });
});
