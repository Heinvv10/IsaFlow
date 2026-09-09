/**
 * K-034 RED — cancelSubscription(id, atPeriodEnd=true) only sets
 * subscriptions.cancel_at_period_end (src/modules/admin/services/billingService.ts:266-272),
 * leaving status='active'. generateDueCharges() selects on
 * `status IN ('active','past_due')` alone
 * (src/modules/billing/services/subscriptionBillingService.ts:50-52), so the
 * cancelled customer is charged for another period. Paystack is mocked.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import type { PoolClient } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { acquireCronLock, releaseCronLock } from './subscription-cron.lock';

assertDisposable();

const chargeAuthorization = vi.fn(async () => {
  throw new Error('Paystack must not be reached in this test');
});
vi.mock('@/modules/billing/services/paystackClient', () => ({
  chargeAuthorization: (...args: unknown[]) => chargeAuthorization(...args),
}));

const { generateDueCharges, runQueuedCharges } = await import(
  '@/modules/billing/services/subscriptionBillingService'
);
const { cancelSubscription, updateSubscription } = await import(
  '@/modules/admin/services/billingService'
);

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const companyId = crypto.randomUUID();
const planId = crypto.randomUUID();
const subscriptionId = crypto.randomUUID();
const mandateId = crypto.randomUUID();
const userId = crypto.randomUUID();

/** A second tenant with no scheduled cancellation — must still be billed. */
const otherCompanyId = crypto.randomUUID();
const otherSubscriptionId = crypto.randomUUID();
const otherMandateId = crypto.randomUUID();

const cronNow = new Date();
const originalPeriodEnd = new Date(cronNow.getTime() - 24 * 3600_000);
const notDueEnd = new Date(cronNow.getTime() + 5 * 24 * 3600_000);
const periodStart = new Date(originalPeriodEnd.getTime() - 30 * 24 * 3600_000);

let cronLock: PoolClient;

beforeAll(async () => {
  cronLock = await acquireCronLock(pool);
  await pool.query('INSERT INTO companies(id,name) VALUES($1,$2)', [companyId, 'K-034 fixture']);
  await pool.query(
    "INSERT INTO users(id,email,role,is_active,account_type) VALUES($1,$2,'admin',true,'direct')",
    [userId, `${userId}@k034.test.local`],
  );
  await pool.query(
    'INSERT INTO plans(id,code,name,monthly_price_cents,annual_price_cents) VALUES($1,$2,$3,$4,$5)',
    [planId, `k034-${planId.slice(0, 8)}`, 'K-034 plan', 49900, 499000],
  );
  await pool.query(
    `INSERT INTO subscription_mandates(id,company_id,max_amount_cents,authorised_by,status,gateway,
       paystack_authorization_code,paystack_customer_code,authorised_at)
     VALUES($1,$2,$3,$4,'active','paystack','AUTH_k034','CUS_k034',now())`,
    [mandateId, companyId, 10_000_00, userId],
  );
  await pool.query('INSERT INTO companies(id,name) VALUES($1,$2)', [otherCompanyId, 'K-034 other tenant']);
  await pool.query(
    `INSERT INTO subscription_mandates(id,company_id,max_amount_cents,authorised_by,status,gateway,
       paystack_authorization_code,paystack_customer_code,authorised_at)
     VALUES($1,$2,$3,$4,'active','paystack','AUTH_k034b','CUS_k034b',now())`,
    [otherMandateId, otherCompanyId, 10_000_00, userId],
  );
});

beforeEach(async () => {
  await pool.query('DELETE FROM subscription_charges WHERE company_id=$1', [companyId]);
  await pool.query('DELETE FROM subscriptions WHERE company_id=$1', [companyId]);
  await pool.query(
    `INSERT INTO subscriptions(id,company_id,plan_id,status,billing_cycle,
       current_period_start,current_period_end,cancel_at_period_end,discount_percent)
     VALUES($1,$2,$3,'active','monthly',$4,$5,false,0)`,
    [subscriptionId, companyId, planId, periodStart, originalPeriodEnd],
  );
  await pool.query('DELETE FROM subscription_charges WHERE company_id=$1', [otherCompanyId]);
  await pool.query('DELETE FROM subscriptions WHERE company_id=$1', [otherCompanyId]);
  await pool.query(
    `INSERT INTO subscriptions(id,company_id,plan_id,status,billing_cycle,
       current_period_start,current_period_end,cancel_at_period_end,discount_percent)
     VALUES($1,$2,$3,'active','monthly',$4,$5,false,0)`,
    [otherSubscriptionId, otherCompanyId, planId, periodStart, notDueEnd],
  );
});

afterAll(async () => {
  try {
    await pool.query('DELETE FROM subscription_charges WHERE company_id=$1', [companyId]);
    await pool.query('DELETE FROM subscriptions WHERE company_id=$1', [companyId]);
    await pool.query('DELETE FROM subscription_charges WHERE company_id=$1', [otherCompanyId]);
    await pool.query('DELETE FROM subscriptions WHERE company_id=$1', [otherCompanyId]);
    await pool.query('DELETE FROM subscription_mandates WHERE company_id IN ($1,$2)', [companyId, otherCompanyId]);
    await pool.query('DELETE FROM companies WHERE id IN ($1,$2)', [companyId, otherCompanyId]);
    await pool.query('DELETE FROM plans WHERE id=$1', [planId]);
    await pool.query('DELETE FROM users WHERE id=$1', [userId]);
  } finally {
    await releaseCronLock(cronLock);
    await pool.end();
  }
});

describe('K-034 scheduled cancellation ignored at renewal', () => {
  it('leaves the subscription active so the renewal query still selects it', async () => {
    await cancelSubscription(subscriptionId, true);
    const { rows } = await pool.query(
      'SELECT status, cancel_at_period_end, cancelled_at FROM subscriptions WHERE id=$1',
      [subscriptionId],
    );
    expect(rows[0]).toMatchObject({ cancel_at_period_end: true, status: 'active' });
  });

  it('must not raise a new charge for a subscription cancelled at period end', async () => {
    await cancelSubscription(subscriptionId, true);

    await generateDueCharges(cronNow);

    const charges = await pool.query(
      'SELECT status, amount_cents, period_start, period_end FROM subscription_charges WHERE company_id=$1',
      [companyId],
    );
    expect(charges.rows).toHaveLength(0);
  });

  it('must not roll a cancelled subscription into a new billing period', async () => {
    await cancelSubscription(subscriptionId, true);
    await generateDueCharges(cronNow);

    const { rows } = await pool.query(
      'SELECT current_period_end FROM subscriptions WHERE id=$1',
      [subscriptionId],
    );
    expect(new Date(rows[0].current_period_end).toISOString()).toBe(
      originalPeriodEnd.toISOString(),
    );
  });

  it('closes the cancelled subscription out once its period has ended', async () => {
    await cancelSubscription(subscriptionId, true);

    await generateDueCharges(cronNow);

    const { rows } = await pool.query(
      'SELECT status, cancelled_at FROM subscriptions WHERE id=$1',
      [subscriptionId],
    );
    expect(rows[0].status).toBe('cancelled');
    expect(rows[0].cancelled_at).not.toBeNull();
  });

  it('leaves a cancelled subscription alone while its paid period is still running', async () => {
    const futureEnd = new Date(cronNow.getTime() + 5 * 24 * 3600_000);
    await pool.query('UPDATE subscriptions SET current_period_end=$2 WHERE id=$1', [
      subscriptionId,
      futureEnd,
    ]);
    await cancelSubscription(subscriptionId, true);

    await generateDueCharges(cronNow);

    const { rows } = await pool.query(
      'SELECT status, cancelled_at, current_period_end FROM subscriptions WHERE id=$1',
      [subscriptionId],
    );
    expect(rows[0].status).toBe('active');
    expect(rows[0].cancelled_at).toBeNull();
    expect(new Date(rows[0].current_period_end).toISOString()).toBe(futureEnd.toISOString());
  });

  it('still bills a due subscription that has no scheduled cancellation', async () => {
    await cancelSubscription(subscriptionId, true);
    await pool.query('UPDATE subscriptions SET current_period_end=$2 WHERE id=$1', [
      otherSubscriptionId,
      originalPeriodEnd,
    ]);

    await generateDueCharges(cronNow);

    const charges = await pool.query(
      'SELECT company_id FROM subscription_charges WHERE company_id=$1',
      [otherCompanyId],
    );
    expect(charges.rows).toHaveLength(1);
    const { rows } = await pool.query('SELECT status FROM subscriptions WHERE id=$1', [
      otherSubscriptionId,
    ]);
    expect(rows[0].status).toBe('active');
  });

  it('clears the scheduled cancellation when the subscription is reactivated', async () => {
    await cancelSubscription(subscriptionId, true);
    // A reactivation is a real transition — the subscription was not active.
    await pool.query("UPDATE subscriptions SET status='paused' WHERE id=$1", [subscriptionId]);
    await updateSubscription(subscriptionId, { status: 'active' });

    const { rows } = await pool.query(
      'SELECT cancel_at_period_end FROM subscriptions WHERE id=$1',
      [subscriptionId],
    );
    expect(rows[0].cancel_at_period_end).toBe(false);

    await generateDueCharges(cronNow);
    const charges = await pool.query(
      'SELECT status FROM subscription_charges WHERE company_id=$1',
      [companyId],
    );
    expect(charges.rows).toHaveLength(1);
  });

  it('keeps the scheduled cancellation when an unrelated field is edited', async () => {
    await cancelSubscription(subscriptionId, true);
    await updateSubscription(subscriptionId, { notes: 'called to confirm the cancellation' });

    const { rows } = await pool.query(
      'SELECT cancel_at_period_end, status FROM subscriptions WHERE id=$1',
      [subscriptionId],
    );
    expect(rows[0]).toMatchObject({ cancel_at_period_end: true, status: 'active' });
  });

  it('voids the queued charge instead of debiting a subscription cancelled mid-flight', async () => {
    // The renewal charge is raised first; the customer cancels before it runs.
    await generateDueCharges(cronNow);
    const queued = await pool.query(
      'SELECT id, status FROM subscription_charges WHERE company_id=$1',
      [companyId],
    );
    expect(queued.rows[0].status).toBe('queued');

    await cancelSubscription(subscriptionId, true);
    await generateDueCharges(cronNow);

    const charges = await pool.query(
      'SELECT status FROM subscription_charges WHERE company_id=$1',
      [companyId],
    );
    expect(charges.rows[0].status).toBe('cancelled');

    const sub = await pool.query('SELECT status FROM subscriptions WHERE id=$1', [subscriptionId]);
    expect(sub.rows[0].status).toBe('cancelled');

    // The voided charge is invisible to the debit pass, so no money moves.
    chargeAuthorization.mockClear();
    const ran = await runQueuedCharges(new Date());
    expect(ran.submitted).toBe(0);
    expect(chargeAuthorization).not.toHaveBeenCalled();
  });

  it('defers the close-out while a charge is still in flight at Paystack', async () => {
    await generateDueCharges(cronNow);
    await pool.query(
      "UPDATE subscription_charges SET status='submitted' WHERE company_id=$1",
      [companyId],
    );
    await cancelSubscription(subscriptionId, true);

    await generateDueCharges(cronNow);

    const charges = await pool.query(
      'SELECT status FROM subscription_charges WHERE company_id=$1',
      [companyId],
    );
    // Paystack already has the request — voiding it locally would lose the money.
    expect(charges.rows[0].status).toBe('submitted');
    const sub = await pool.query('SELECT status FROM subscriptions WHERE id=$1', [subscriptionId]);
    expect(sub.rows[0].status).toBe('active');
  });

  it('does not un-cancel when an edit merely restates the current status', async () => {
    await cancelSubscription(subscriptionId, true);
    await updateSubscription(subscriptionId, { status: 'active', notes: 'customer called' });

    const { rows } = await pool.query(
      'SELECT cancel_at_period_end, notes FROM subscriptions WHERE id=$1',
      [subscriptionId],
    );
    expect(rows[0].cancel_at_period_end).toBe(true);
    expect(rows[0].notes).toBe('customer called');
  });

  it('clears the flag when the subscription really transitions back from cancelled', async () => {
    await cancelSubscription(subscriptionId, true);
    await pool.query("UPDATE subscriptions SET status='paused' WHERE id=$1", [subscriptionId]);
    await updateSubscription(subscriptionId, { status: 'active' });

    const { rows } = await pool.query(
      'SELECT cancel_at_period_end, status FROM subscriptions WHERE id=$1',
      [subscriptionId],
    );
    expect(rows[0]).toMatchObject({ cancel_at_period_end: false, status: 'active' });
  });
});
