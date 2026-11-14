/**
 * Admin audit 3.1 (F1) — charge after cancel. An admin who cancels a subscription
 * immediately (POST .../cancel, or PATCH status) used to update the subscription
 * row only. A charge already queued, or failed and past its 24h backoff, was
 * still picked up by runQueuedCharges(), which had no join to subscriptions, so
 * the cancelled customer's card was debited for a period advancePeriod refuses
 * to grant. Paystack is stubbed at the client boundary and records every call.
 * The admin routes run for real (withAdmin / withPlatformAdmin).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import type { PoolClient } from 'pg';
import cancelRoute from '../../pages/api/admin/billing/subscriptions/[id]/cancel';
import patchRoute from '../../pages/api/admin/billing/subscriptions/[id]';
import { assertDisposable, request, response } from './mfa-impersonation-postgres.helpers';
import { signSession } from './r-032-fake-gotrue.helpers';
import { acquireCronLock, releaseCronLock } from './subscription-cron.lock';

assertDisposable();

const chargeAuthorization = vi.fn();
vi.mock('@/modules/billing/services/paystackClient', () => ({
  chargeAuthorization: (...args: unknown[]) => chargeAuthorization(...args),
  verifyTransaction: vi.fn(),
}));

const { runQueuedCharges } = await import('@/modules/billing/services/subscriptionBillingService');
const { claimChargeAttempt } = await import('@/modules/billing/services/subscriptionPeriod');

const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
const adminId = crypto.randomUUID();
const companyId = crypto.randomUUID();
const otherCompanyId = crypto.randomUUID();
const planId = crypto.randomUUID();
const mandateId = crypto.randomUUID();
const otherMandateId = crypto.randomUUID();
const subscriptionId = crypto.randomUUID();
const otherSubscriptionId = crypto.randomUUID();
const planCode = `adm-cancel-${planId.slice(0, 8)}`;

const day = (offset: number) => new Date(Date.now() + offset * 24 * 3600_000).toISOString().slice(0, 10);
let cronLock: PoolClient;
let queuedId = '';
let failedId = '';
let otherChargeId = '';

async function insertMandate(id: string, company: string, tag: string) {
  await pool.query(
    `INSERT INTO subscription_mandates(id,company_id,max_amount_cents,authorised_by,status,gateway,
       paystack_authorization_code,paystack_customer_code,authorised_at)
     VALUES($1,$2,1000000,$3,'active','paystack',$4,$5,now())`,
    [id, company, adminId, `AUTH_${tag}`, `CUS_${tag}`],
  );
}

async function insertSubscription(id: string, company: string) {
  await pool.query(
    `INSERT INTO subscriptions(id,company_id,plan_id,status,billing_cycle,
       current_period_start,current_period_end,cancel_at_period_end,discount_percent)
     VALUES($1,$2,$3,'active','monthly',now() - interval '31 days', now() - interval '1 day',false,0)`,
    [id, company, planId],
  );
}

async function insertCharge(opts: {
  company: string; subscription: string; mandate: string; start: number; end: number;
  status: string; attempts?: number; lastAttemptHoursAgo?: number;
}): Promise<string> {
  const ref = `adm_cancel_${crypto.randomUUID()}`;
  const { rows } = await pool.query(
    `INSERT INTO subscription_charges(company_id,subscription_id,mandate_id,period_start,period_end,
       amount_cents,currency,gateway,external_reference,paystack_reference,status,attempt_count,last_attempt_at)
     VALUES($1,$2,$3,$4,$5,29900,'ZAR','paystack',$6,$6,$7,$8,
       CASE WHEN $9::int IS NULL THEN NULL ELSE now() - ($9::int * interval '1 hour') END)
     RETURNING id`,
    [opts.company, opts.subscription, opts.mandate, day(opts.start), day(opts.end), ref, opts.status,
      opts.attempts ?? 0, opts.lastAttemptHoursAgo ?? null],
  );
  return rows[0].id as string;
}

async function chargeStatus(id: string): Promise<{ status: string; attempt_count: number }> {
  const { rows } = await pool.query('SELECT status, attempt_count FROM subscription_charges WHERE id=$1', [id]);
  return rows[0] as { status: string; attempt_count: number };
}

async function subscriptionStatus(): Promise<string> {
  const { rows } = await pool.query('SELECT status FROM subscriptions WHERE id=$1', [subscriptionId]);
  return rows[0].status as string;
}

/** Calls the real admin route handler exactly as the console does. */
async function callRoute(
  route: typeof cancelRoute | typeof patchRoute, method: string, body: unknown,
): Promise<{ status: number; body: unknown }> {
  const jar = { 'sb-access-token': await signSession(adminId, crypto.randomUUID(), 'aal2') };
  const req = request(jar, method, subscriptionId) as unknown as { body: unknown; url: string };
  req.body = body;
  const result = response();
  await route(req as never, result.res);
  return { status: result.state.statusCode, body: result.state.body };
}

beforeAll(async () => {
  cronLock = await acquireCronLock(pool);
  await pool.query('INSERT INTO companies(id,name) VALUES($1,$2),($3,$4)',
    [companyId, 'Admin cancel fixture', otherCompanyId, 'Admin cancel other tenant']);
  await pool.query("INSERT INTO users(id,email,role,is_active) VALUES($1,$2,'super_admin',true)",
    [adminId, `${adminId}@test.local`]);
  await pool.query(
    'INSERT INTO plans(id,code,name,monthly_price_cents,annual_price_cents) VALUES($1,$2,$3,29900,299000)',
    [planId, planCode, 'Admin cancel plan'],
  );
  await insertMandate(mandateId, companyId, 'adm1');
  await insertMandate(otherMandateId, otherCompanyId, 'adm2');
}, 60000);

beforeEach(async () => {
  chargeAuthorization.mockReset();
  chargeAuthorization.mockImplementation(async () => ({ status: 'pending', reference: `ref_${crypto.randomUUID()}` }));
  for (const c of [companyId, otherCompanyId]) {
    await pool.query('DELETE FROM paystack_payment_requests WHERE company_id=$1', [c]);
    await pool.query('DELETE FROM subscription_charges WHERE company_id=$1', [c]);
    await pool.query('DELETE FROM subscriptions WHERE company_id=$1', [c]);
  }
  await insertSubscription(subscriptionId, companyId);
  await insertSubscription(otherSubscriptionId, otherCompanyId);
  // One queued, one failed and past its 24h backoff: both are due to the runner.
  queuedId = await insertCharge({ company: companyId, subscription: subscriptionId, mandate: mandateId,
    start: -1, end: 29, status: 'queued' });
  failedId = await insertCharge({ company: companyId, subscription: subscriptionId, mandate: mandateId,
    start: -32, end: -2, status: 'failed', attempts: 1, lastAttemptHoursAgo: 25 });
  otherChargeId = await insertCharge({ company: otherCompanyId, subscription: otherSubscriptionId,
    mandate: otherMandateId, start: -1, end: 29, status: 'queued' });
});

afterAll(async () => {
  try {
    for (const c of [companyId, otherCompanyId]) {
      await pool.query('DELETE FROM paystack_payment_requests WHERE company_id=$1', [c]);
      await pool.query('DELETE FROM subscription_charges WHERE company_id=$1', [c]);
      await pool.query('DELETE FROM subscriptions WHERE company_id=$1', [c]);
      await pool.query('DELETE FROM subscription_mandates WHERE company_id=$1', [c]);
    }
    await pool.query('DELETE FROM admin_audit_log WHERE admin_user_id=$1', [adminId]);
    await pool.query('DELETE FROM companies WHERE id IN ($1,$2)', [companyId, otherCompanyId]);
    await pool.query('DELETE FROM plans WHERE id=$1', [planId]);
    await pool.query('DELETE FROM users WHERE id=$1', [adminId]);
    await pool.query("DELETE FROM rate_limit_counters WHERE key='admin:127.0.0.79'");
  } finally {
    await releaseCronLock(cronLock);
    await pool.end();
  }
}, 60000);

/** The calls the runner made for the company under test (others' fixtures may share the schema). */
function callsFor(company: string): unknown[] {
  return chargeAuthorization.mock.calls.filter(
    (c) => (c[0] as { metadata: { company_id: string } }).metadata.company_id === company,
  );
}

describe('admin cancel / status change must not leave a debit live', () => {
  it('control: an active subscription with a queued and a due-failed charge is debited', async () => {
    await runQueuedCharges(new Date());
    expect(callsFor(companyId)).toHaveLength(2);
  });

  it('immediate cancel (POST cancel, at_period_end false) voids both charges; the runner debits nothing', async () => {
    const answer = await callRoute(cancelRoute, 'POST', { at_period_end: false });
    expect(answer.status, JSON.stringify(answer.body)).toBe(200);
    expect(await subscriptionStatus()).toBe('cancelled');

    await runQueuedCharges(new Date());

    expect(callsFor(companyId)).toHaveLength(0);
    expect((await chargeStatus(queuedId)).status).toBe('cancelled');
    expect((await chargeStatus(failedId)).status).toBe('cancelled');
  });

  it('PATCH status cancelled voids both charges; the runner debits nothing', async () => {
    const answer = await callRoute(patchRoute, 'PATCH', { status: 'cancelled' });
    expect(answer.status, JSON.stringify(answer.body)).toBe(200);
    expect(await subscriptionStatus()).toBe('cancelled');

    await runQueuedCharges(new Date());

    expect(callsFor(companyId)).toHaveLength(0);
    expect((await chargeStatus(queuedId)).status).toBe('cancelled');
    expect((await chargeStatus(failedId)).status).toBe('cancelled');
  });

  it('cancelling one tenant leaves another tenant\'s queued charge to be debited', async () => {
    await callRoute(cancelRoute, 'POST', { at_period_end: false });

    await runQueuedCharges(new Date());

    expect(callsFor(companyId)).toHaveLength(0);
    expect(callsFor(otherCompanyId)).toHaveLength(1);
    expect((await chargeStatus(otherChargeId)).status).not.toBe('cancelled');
  });

  it('a charge already in flight at Paystack (submitted) is not voided by the cancel', async () => {
    await pool.query("UPDATE subscription_charges SET status='submitted' WHERE id=$1", [queuedId]);

    await callRoute(cancelRoute, 'POST', { at_period_end: false });

    expect((await chargeStatus(queuedId)).status).toBe('submitted');
    expect((await chargeStatus(failedId)).status).toBe('cancelled');
  });

  it('the runner alone refuses a cancelled subscription (a charge that slipped past the void)', async () => {
    await pool.query("UPDATE subscriptions SET status='cancelled', cancelled_at=now() WHERE id=$1", [subscriptionId]);

    const ran = await runQueuedCharges(new Date());

    expect(callsFor(companyId)).toHaveLength(0);
    // Not even selected: the SELECT excludes it, the claim is not the only guard.
    expect(ran.skipped).toBe(0);
    expect(await chargeStatus(queuedId)).toMatchObject({ status: 'queued', attempt_count: 0 });
    expect(await chargeStatus(failedId)).toMatchObject({ status: 'failed', attempt_count: 1 });
  });

  it('the runner refuses a paused subscription, and debits it again once it is reactivated', async () => {
    await pool.query("UPDATE subscriptions SET status='paused' WHERE id=$1", [subscriptionId]);

    const ran = await runQueuedCharges(new Date());
    expect(callsFor(companyId)).toHaveLength(0);
    expect(ran.skipped).toBe(0);
    expect(await chargeStatus(queuedId)).toMatchObject({ status: 'queued', attempt_count: 0 });

    await pool.query("UPDATE subscriptions SET status='active' WHERE id=$1", [subscriptionId]);
    await runQueuedCharges(new Date());
    expect(callsFor(companyId)).toHaveLength(2);
  });

  it('the attempt claim itself refuses a subscription cancelled after the runner read the charge', async () => {
    await pool.query("UPDATE subscriptions SET status='cancelled', cancelled_at=now() WHERE id=$1", [subscriptionId]);

    const claimed = await claimChargeAttempt(queuedId, companyId, 'queued', 0);

    expect(claimed).toBeNull();
    expect(await chargeStatus(queuedId)).toMatchObject({ status: 'queued', attempt_count: 0 });
  });

  it('PATCH to past_due keeps the charges chargeable (dunning: generateDueCharges bills past_due and settling lifts it)', async () => {
    const answer = await callRoute(patchRoute, 'PATCH', { status: 'past_due' });
    expect(answer.status, JSON.stringify(answer.body)).toBe(200);

    await runQueuedCharges(new Date());

    expect(callsFor(companyId)).toHaveLength(2);
    expect((await chargeStatus(queuedId)).status).not.toBe('cancelled');
  });
});
