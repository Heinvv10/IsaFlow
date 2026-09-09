/**
 * K-033 RED — subscriptionBillingService.generateDueCharges() rolls the
 * subscription period forward at queue time (line 125-131 of
 * src/modules/billing/services/subscriptionBillingService.ts) and nothing
 * rolls it back or flags the subscription once the debit has burned all
 * MAX_ATTEMPTS attempts. Paystack is mocked — no network call is made.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import type { PoolClient } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { acquireCronLock, releaseCronLock } from './subscription-cron.lock';

assertDisposable();

const chargeAuthorization = vi.fn();
vi.mock('@/modules/billing/services/paystackClient', () => ({
  chargeAuthorization: (...args: unknown[]) => chargeAuthorization(...args),
}));

const { generateDueCharges, runQueuedCharges } = await import(
  '@/modules/billing/services/subscriptionBillingService'
);
const { advancePeriodForSettledCharge } = await import(
  '@/modules/billing/services/subscriptionPeriod'
);

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const companyId = crypto.randomUUID();
const planId = crypto.randomUUID();
const subscriptionId = crypto.randomUUID();
const mandateId = crypto.randomUUID();
const userId = crypto.randomUUID();
const planCode = `k033-${planId.slice(0, 8)}`;
/** A second tenant on the same plan, equally due — nothing this test does may touch it. */
const otherCompanyId = crypto.randomUUID();
const otherSubscriptionId = crypto.randomUUID();

/** Period ended yesterday, so the cron considers the subscription due. Anchored
 *  to the real clock because the service stamps last_attempt_at with the DB's now(). */
const cronNow = new Date();
const originalPeriodEnd = new Date(cronNow.getTime() - 24 * 3600_000);
const periodStart = new Date(originalPeriodEnd.getTime() - 30 * 24 * 3600_000);

const otherPeriodEnd = new Date(Date.now() - 24 * 3600_000);

let cronLock: PoolClient;

beforeAll(async () => {
  cronLock = await acquireCronLock(pool);
  await pool.query('INSERT INTO companies(id,name) VALUES($1,$2)', [companyId, 'K-033 fixture']);
  await pool.query('INSERT INTO companies(id,name) VALUES($1,$2)', [otherCompanyId, 'K-033 other tenant']);
  await pool.query(
    "INSERT INTO users(id,email,role,is_active,account_type) VALUES($1,$2,'admin',true,'direct')",
    [userId, `${userId}@k033.test.local`],
  );
  await pool.query(
    'INSERT INTO plans(id,code,name,monthly_price_cents,annual_price_cents) VALUES($1,$2,$3,$4,$5)',
    [planId, planCode, 'K-033 plan', 49900, 499000],
  );
  await pool.query(
    `INSERT INTO subscription_mandates(id,company_id,max_amount_cents,authorised_by,status,gateway,
       paystack_authorization_code,paystack_customer_code,authorised_at)
     VALUES($1,$2,$3,$4,'active','paystack','AUTH_k033','CUS_k033',now())`,
    [mandateId, companyId, 10_000_00, userId],
  );
  await pool.query(
    `INSERT INTO subscriptions(id,company_id,plan_id,status,billing_cycle,
       current_period_start,current_period_end,cancel_at_period_end,discount_percent)
     VALUES($1,$2,$3,'active','monthly',$4,$5,false,0)`,
    [otherSubscriptionId, otherCompanyId, planId, periodStart, otherPeriodEnd],
  );
});

beforeEach(async () => {
  chargeAuthorization.mockReset();
  await pool.query('DELETE FROM paystack_payment_requests WHERE company_id=$1', [companyId]);
  await pool.query('DELETE FROM subscription_charges WHERE company_id=$1', [companyId]);
  await pool.query('DELETE FROM subscriptions WHERE company_id=$1', [companyId]);
  await pool.query(
    `INSERT INTO subscriptions(id,company_id,plan_id,status,billing_cycle,
       current_period_start,current_period_end,cancel_at_period_end,discount_percent)
     VALUES($1,$2,$3,'active','monthly',$4,$5,false,0)`,
    [subscriptionId, companyId, planId, periodStart, originalPeriodEnd],
  );
});

afterAll(async () => {
  try {
    await pool.query('DELETE FROM paystack_payment_requests WHERE company_id=$1', [companyId]);
    await pool.query('DELETE FROM subscription_charges WHERE company_id=$1', [companyId]);
    await pool.query('DELETE FROM subscriptions WHERE company_id=$1', [companyId]);
    await pool.query('DELETE FROM subscription_mandates WHERE company_id=$1', [companyId]);
    await pool.query('DELETE FROM subscriptions WHERE company_id=$1', [otherCompanyId]);
    await pool.query('DELETE FROM companies WHERE id IN ($1,$2)', [companyId, otherCompanyId]);
    await pool.query('DELETE FROM plans WHERE id=$1', [planId]);
    await pool.query('DELETE FROM users WHERE id=$1', [userId]);
  } finally {
    await releaseCronLock(cronLock);
    await pool.end();
  }
});

async function readSubscription() {
  const { rows } = await pool.query(
    'SELECT status, current_period_start, current_period_end FROM subscriptions WHERE id=$1',
    [subscriptionId],
  );
  return rows[0] as { status: string; current_period_start: Date; current_period_end: Date };
}

async function readCharge() {
  const { rows } = await pool.query(
    'SELECT id, status, attempt_count, period_start, period_end FROM subscription_charges WHERE company_id=$1',
    [companyId],
  );
  return rows[0] as
    | { id: string; status: string; attempt_count: number; period_start: Date; period_end: Date }
    | undefined;
}

/** The period a settled charge buys — the charge's own period_end at midnight. */
async function expectedPeriodEndIso() {
  const charge = await readCharge();
  const { rows } = await pool.query('SELECT $1::date::timestamptz AS ts', [charge!.period_end]);
  return new Date(rows[0].ts).toISOString();
}

describe('K-033 subscription period advances before Paystack settles', () => {
  it('must not roll the period forward while the debit is still unsettled', async () => {
    await generateDueCharges(cronNow);

    const charge = await readCharge();
    expect(charge?.status).toBe('queued');

    const sub = await readSubscription();
    // The charge has not been submitted to Paystack, let alone settled, so the
    // paid-up period must still end where it did.
    expect(new Date(sub.current_period_end).toISOString()).toBe(
      originalPeriodEnd.toISOString(),
    );
  });

  it('must stop granting the advanced period once every attempt has failed', async () => {
    await generateDueCharges(cronNow);
    chargeAuthorization.mockRejectedValue(new Error('Paystack declined: insufficient funds'));

    // Three cron passes. Between passes the previous attempt is aged past the
    // 24h RETRY_BACKOFF_HOURS window so the next pass re-selects the charge.
    for (let pass = 0; pass < 3; pass++) {
      if (pass > 0) {
        await pool.query(
          "UPDATE subscription_charges SET last_attempt_at = last_attempt_at - INTERVAL '25 hours' WHERE company_id=$1",
          [companyId],
        );
      }
      await runQueuedCharges(new Date());
    }

    const charge = await readCharge();
    expect(charge).toMatchObject({ status: 'failed', attempt_count: 3 });
    expect(chargeAuthorization).toHaveBeenCalledTimes(3);

    const sub = await readSubscription();
    // MAX_ATTEMPTS is spent and the charge will never be retried, yet the
    // subscription is still 'active' on a period nobody paid for.
    expect(sub.status).toBe('past_due');
  });

  it('advances the period onto the charge it settled', async () => {
    await generateDueCharges(cronNow);
    chargeAuthorization.mockResolvedValue({ status: 'success', reference: 'ref_k033_ok' });

    await runQueuedCharges(new Date());

    const charge = await readCharge();
    expect(charge?.status).toBe('settled');

    const sub = await readSubscription();
    expect(sub.status).toBe('active');
    expect(new Date(sub.current_period_end).toISOString()).toBe(await expectedPeriodEndIso());
  });

  it('does not advance twice when the webhook settles a charge the cron already settled', async () => {
    await generateDueCharges(cronNow);
    chargeAuthorization.mockResolvedValue({ status: 'success', reference: 'ref_k033_dup' });
    await runQueuedCharges(new Date());

    const afterCron = await readSubscription();
    const charge = await readCharge();
    // Same call the Paystack webhook makes once charge.success arrives.
    await advancePeriodForSettledCharge(charge!.id, companyId);

    const afterWebhook = await readSubscription();
    expect(new Date(afterWebhook.current_period_end).toISOString()).toBe(
      new Date(afterCron.current_period_end).toISOString(),
    );
  });

  it('settlement lifts the past_due raised by the earlier failed attempts', async () => {
    await generateDueCharges(cronNow);
    chargeAuthorization.mockRejectedValue(new Error('declined'));
    for (let pass = 0; pass < 3; pass++) {
      if (pass > 0) {
        await pool.query(
          "UPDATE subscription_charges SET last_attempt_at = last_attempt_at - INTERVAL '25 hours' WHERE company_id=$1",
          [companyId],
        );
      }
      await runQueuedCharges(new Date());
    }
    expect((await readSubscription()).status).toBe('past_due');

    // The customer pays the outstanding charge out of band; Paystack settles it.
    const charge = await readCharge();
    await pool.query("UPDATE subscription_charges SET status='settled', settled_at=now() WHERE id=$1", [charge!.id]);
    await advancePeriodForSettledCharge(charge!.id, companyId);

    const sub = await readSubscription();
    expect(sub.status).toBe('active');
    expect(new Date(sub.current_period_end).toISOString()).toBe(await expectedPeriodEndIso());
  });

  it('leaves another tenant\'s subscription untouched when this one exhausts its attempts', async () => {
    await generateDueCharges(cronNow);
    chargeAuthorization.mockRejectedValue(new Error('declined'));
    for (let pass = 0; pass < 3; pass++) {
      if (pass > 0) {
        await pool.query(
          "UPDATE subscription_charges SET last_attempt_at = last_attempt_at - INTERVAL '25 hours' WHERE company_id=$1",
          [companyId],
        );
      }
      await runQueuedCharges(new Date());
    }

    const { rows } = await pool.query(
      'SELECT status, current_period_end FROM subscriptions WHERE id=$1',
      [otherSubscriptionId],
    );
    expect(rows[0].status).toBe('active');
    expect(new Date(rows[0].current_period_end).toISOString()).toBe(
      otherPeriodEnd.toISOString(),
    );
  });
});
