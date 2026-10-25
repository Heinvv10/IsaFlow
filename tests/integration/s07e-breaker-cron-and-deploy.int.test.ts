// tests/integration/s07e-breaker-cron-and-deploy.int.test.ts
//
// brk945 round-3 breaker, EXECUTED against the real PG16 fixture.
// (4) The subscription-charge cron's reference pre-claim: an attacker inserts a
//     payment request under the reference the cron will use for a victim's
//     charge. recordChargePaymentRequest (the real service fn) must refuse to
//     adopt that row, and the webhook must settle nothing for the victim or the
//     attacker through the hijacked reference.
// (6) The deploy check, app_pool_reach_violations(), must flag each 945 rule
//     when its grant is put back (every grant is rolled back after the assert).
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { Readable } from 'stream';
import { createHmac } from 'crypto';
import type { NextApiRequest } from 'next';
import type { PoolClient } from 'pg';
import webhookRoute from '../../pages/api/webhooks/paystack';
import { als } from '@/lib/als';
import { getAuthPool } from '@/lib/auth/authPool';
import { getDbPool } from '@/lib/neon';
import { migrationAdminPool } from '@/lib/auth/migrationAdminPool';
import { recordChargePaymentRequest } from '@/modules/billing/services/subscriptionChargeRequest';
import { response } from './mfa-impersonation-postgres.helpers';
import { fixture, newIds, setup, teardown } from './s07b-app-pool-login-role.helpers';

vi.mock('@/modules/billing/services/paystackClient', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
}));

const WEBHOOK_KEY = 'fixture-paystack-webhook-key-brk945c';
const ids = newIds();
const { owner, company, other } = ids; // company = attacker, other = victim
const victimOwner = crypto.randomUUID();
const payg = crypto.randomUUID();
const q = (text: string, params: unknown[] = []) => fixture.query(text, params);

let attackerSub = '';
let victimSub = '';
let attackerMandate = '';
let victimMandate = '';

beforeAll(async () => {
  await setup(ids);
  vi.stubEnv('PAYSTACK_SECRET_KEY', WEBHOOK_KEY);
  await q(`INSERT INTO users (id, email, role, is_active, status) VALUES ($1, $2, 'viewer', true, 'active')`, [victimOwner, `${victimOwner}@test.local`]);
  await q(`INSERT INTO company_users (company_id, user_id, role, is_default) VALUES ($1, $2, 'owner', true)`, [other, victimOwner]);
  if (!(await q(`SELECT id FROM plans WHERE code = 'payg'`)).rows[0]) await q(`INSERT INTO plans (id, code, name) VALUES ($1, 'payg', 'brk945c PAYG')`, [payg]);
  attackerSub = (await q(`INSERT INTO subscriptions (company_id, plan_id, status) SELECT $1, id, 'active' FROM plans WHERE code='payg' RETURNING id`, [company])).rows[0]!.id;
  victimSub = (await q(`INSERT INTO subscriptions (company_id, plan_id, status) SELECT $1, id, 'active' FROM plans WHERE code='payg' RETURNING id`, [other])).rows[0]!.id;
  attackerMandate = (await q(`INSERT INTO subscription_mandates (company_id, max_amount_cents, status, gateway) VALUES ($1,100000,'active','paystack') RETURNING id`, [company])).rows[0]!.id;
  victimMandate = (await q(`INSERT INTO subscription_mandates (company_id, max_amount_cents, status, gateway) VALUES ($1,100000,'active','paystack') RETURNING id`, [other])).rows[0]!.id;
}, 60000);

afterAll(async () => {
  await q(`DELETE FROM paystack_webhook_events WHERE reference LIKE 'brk945c\\_%'`);
  for (const t of ['paystack_payment_requests', 'subscription_charges', 'subscription_mandates', 'subscriptions']) {
    await q(`DELETE FROM ${t} WHERE company_id = ANY($1)`, [[company, other]]).catch(() => undefined);
  }
  await q('DELETE FROM company_users WHERE user_id = $1', [victimOwner]);
  await q('DELETE FROM users WHERE id = $1', [victimOwner]);
  await q('DELETE FROM plans WHERE id = $1', [payg]).catch(() => undefined);
  await teardown(ids, [getAuthPool(), getDbPool(), migrationAdminPool()]);
});

let seq = 0;
async function deliver(data: Record<string, unknown>, event = 'charge.success') {
  const body = JSON.stringify({ event, data: { id: 80000 + (++seq), status: 'success', currency: 'ZAR', channel: 'card',
    customer: { email: 'x@brk945c.test', customer_code: 'CUS_x' }, ...data } });
  const req = Readable.from([Buffer.from(body)]) as unknown as NextApiRequest;
  (req as { method: string }).method = 'POST';
  (req as { headers: Record<string, string> }).headers = { 'content-type': 'application/json',
    'x-paystack-signature': createHmac('sha512', WEBHOOK_KEY).update(body).digest('hex') };
  const result = response();
  await webhookRoute(req, result.res);
  return result.state.statusCode;
}

const mkCharge = async (companyId: string, mandate: string, sub: string, ref: string) =>
  (await q(`INSERT INTO subscription_charges (company_id, mandate_id, subscription_id, period_start, period_end,
    amount_cents, external_reference, status, gateway) VALUES ($1,$2,$3,'2026-09-01','2026-09-30',49900,$4,'submitted','paystack') RETURNING id`,
  [companyId, mandate, sub, ref])).rows[0]!.id as string;
const chargeStatus = async (id: string) => (await q('SELECT status FROM subscription_charges WHERE id = $1', [id])).rows[0]!.status;

describe('brk945 (4): the subscription-charge cron reference pre-claim', () => {
  it('the cron does not adopt an attacker row under the reference, and the webhook settles nothing through it', async () => {
    const reference = `brk945c_${crypto.randomUUID().slice(0, 12)}`;
    const victimCharge = await mkCharge(other, victimMandate, victimSub, reference); // the cron will use this reference
    const attackerCharge = await mkCharge(company, attackerMandate, attackerSub, `brk945c_other_${crypto.randomUUID().slice(0, 8)}`);
    // Attacker pre-claims the reference, pointing it at its OWN charge (the FK forbids a cross-company link).
    await q(`INSERT INTO paystack_payment_requests (company_id, purpose, subscription_charge_id, paystack_reference, amount_cents, currency, status)
      VALUES ($1, 'subscription_charge', $2, $3, 49900, 'ZAR', 'pending')`, [company, attackerCharge, reference]);

    // Run the REAL cron recorder for the victim's charge under that reference, inside a service-pool request context.
    const client: PoolClient = await getDbPool().connect();
    try {
      await client.query('BEGIN');
      await als.run({ client, userId: 'cron', claims: {} }, () =>
        recordChargePaymentRequest(other, victimCharge, reference, 49900, false));
      await client.query('ROLLBACK');
    } finally { client.release(); }

    // The reference is still the attacker's row — the cron refused to overwrite the link (ON CONFLICT DO NOTHING + ownership check).
    const held = (await q('SELECT company_id, subscription_charge_id FROM paystack_payment_requests WHERE paystack_reference = $1', [reference])).rows[0];
    expect(held).toEqual({ company_id: company, subscription_charge_id: attackerCharge });

    // Paystack's genuine event for this reference carries the VICTIM's metadata; it binds to the attacker's row and is refused.
    expect(await deliver({ reference, amount: 49900, requested_amount: 49900,
      metadata: { purpose: 'subscription_charge', company_id: other, subscription_charge_id: victimCharge } })).toBe(200);
    expect(await chargeStatus(victimCharge)).toBe('submitted'); // victim not settled through the hijacked reference
    expect(await chargeStatus(attackerCharge)).toBe('submitted'); // attacker not settled either (metadata names the victim)
    expect((await q('SELECT failure_reason FROM paystack_payment_requests WHERE paystack_reference = $1', [reference])).rows[0]!.failure_reason)
      .toBe('review:checkout_company_mismatch');
  });
});

// (6) Each 945 rule, put back one grant at a time, must be flagged — and rolled back.
const violations = async (client: PoolClient): Promise<string[]> =>
  (await client.query('SELECT v FROM public.app_pool_reach_violations() v')).rows.map((r: { v: string }) => r.v);

type Rule = [desc: string, grant: string, expect: RegExp];
// The deploy check prints the relation via regclass (unqualified when on search_path), and
// INSERT/UPDATE per column; the hidden-column SELECT branch prints the literal 'public.<tbl>'.
const RULES: Rule[] = [
  ['app_user INSERT on flow_wallet', 'GRANT INSERT ON public.flow_wallet TO app_user', /can INSERT flow_wallet\./],
  ['app_user UPDATE on flow_wallet', 'GRANT UPDATE ON public.flow_wallet TO app_user', /can UPDATE flow_wallet\./],
  ['app_user read flow_wallet.payment_method_token', 'GRANT SELECT (payment_method_token) ON public.flow_wallet TO app_user', /can SELECT public\.flow_wallet\.payment_method_token/],
  ['app_user UPDATE on plans', 'GRANT UPDATE ON public.plans TO app_user', /can UPDATE plans\./],
  ['app_user UPDATE on subscriptions', 'GRANT UPDATE ON public.subscriptions TO app_user', /can UPDATE subscriptions\./],
  ['app_user INSERT on subscription_charges', 'GRANT INSERT ON public.subscription_charges TO app_user', /can INSERT subscription_charges\./],
  ['app_user UPDATE on subscription_mandates', 'GRANT UPDATE ON public.subscription_mandates TO app_user', /can UPDATE subscription_mandates\./],
  ['app_user read subscription_mandates.paystack_authorization_code', 'GRANT SELECT (paystack_authorization_code) ON public.subscription_mandates TO app_user', /can SELECT public\.subscription_mandates\.paystack_authorization_code/],
  ['app_user read subscription_charges.paystack_authorization_code', 'GRANT SELECT (paystack_authorization_code) ON public.subscription_charges TO app_user', /can SELECT public\.subscription_charges\.paystack_authorization_code/],
  ['app_user UPDATE on flow_purchases', 'GRANT UPDATE ON public.flow_purchases TO app_user', /can UPDATE flow_purchases\./],
  ['app_user INSERT on flow_ledger', 'GRANT INSERT ON public.flow_ledger TO app_user', /can INSERT flow_ledger\./],
  ['app_user UPDATE on flow_bundles', 'GRANT UPDATE ON public.flow_bundles TO app_user', /can UPDATE flow_bundles\./],
  ['app_user INSERT on plan_features', 'GRANT INSERT ON public.plan_features TO app_user', /can INSERT plan_features\./],
  ['app_user UPDATE on feature_flags', 'GRANT UPDATE ON public.feature_flags TO app_user', /can UPDATE feature_flags\./],
  ['app_user INSERT on company_feature_overrides', 'GRANT INSERT ON public.company_feature_overrides TO app_user', /can INSERT company_feature_overrides\./],
  ['app_user UPDATE paystack_payment_requests.company_id (link column)', 'GRANT UPDATE (company_id) ON public.paystack_payment_requests TO app_user', /can UPDATE paystack_payment_requests\.company_id/],
  ['app_user DELETE on paystack_payment_requests', 'GRANT DELETE ON public.paystack_payment_requests TO app_user', /can DELETE paystack_payment_requests/],
  ['app_user read paystack_payment_requests.paystack_authorization_code', 'GRANT SELECT (paystack_authorization_code) ON public.paystack_payment_requests TO app_user', /can SELECT public\.paystack_payment_requests\.paystack_authorization_code/],
  ['TEMPORARY back to PUBLIC', 'GRANT TEMPORARY ON DATABASE isaflow_schema_fixture TO PUBLIC', /can create temporary objects/],
];

describe('brk945 (6): the deploy check flags each 945 rule when its grant is put back', () => {
  it('baseline: no violations', async () => {
    const client = await fixture.connect();
    try { expect(await violations(client)).toEqual([]); } finally { client.release(); }
  });
  it.each(RULES)('%s is flagged (then rolled back)', async (_desc, grant, re) => {
    const client = await fixture.connect();
    try {
      await client.query('BEGIN');
      await client.query(grant);
      const v = await violations(client);
      expect(v.some((s) => re.test(s))).toBe(true);
      await client.query('ROLLBACK');
      // and gone again after rollback
      expect(await violations(client)).toEqual([]);
    } finally { await client.query('ROLLBACK').catch(() => undefined); client.release(); }
  });
});
