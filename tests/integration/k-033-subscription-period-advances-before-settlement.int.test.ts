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
const { advancePeriodForSettledCharge, claimChargeAttempt } = await import(
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
/** A SECOND SUBSCRIPTION IN THE SAME COMPANY: one charge must move only its own. */
const siblingSubscriptionId = crypto.randomUUID();

/** Period ended yesterday, so the cron considers the subscription due. Anchored
 *  to the real clock because the service stamps last_attempt_at with the DB's now(). */
const cronNow = new Date();
const originalPeriodEnd = new Date(cronNow.getTime() - 24 * 3600_000);
const periodStart = new Date(originalPeriodEnd.getTime() - 30 * 24 * 3600_000);

const otherPeriodEnd = new Date(Date.now() - 24 * 3600_000);
/** Not yet due, so the cron never raises a charge of its own for it. */
const siblingPeriodEnd = new Date(Date.now() + 20 * 24 * 3600_000);

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

/** Adds a second, not-yet-due subscription to the company under test. */
async function addSiblingSubscription() {
  await pool.query(
    `INSERT INTO subscriptions(id,company_id,plan_id,status,billing_cycle,
       current_period_start,current_period_end,cancel_at_period_end,discount_percent)
     VALUES($1,$2,$3,'active','monthly',$4,$5,false,0)`,
    [siblingSubscriptionId, companyId, planId, periodStart, siblingPeriodEnd],
  );
}

async function readSibling() {
  const { rows } = await pool.query(
    'SELECT status, current_period_end FROM subscriptions WHERE id=$1',
    [siblingSubscriptionId],
  );
  return rows[0] as { status: string; current_period_end: Date };
}

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

  it('advances only the subscription the settled charge belongs to', async () => {
    await addSiblingSubscription();
    await generateDueCharges(cronNow);
    chargeAuthorization.mockResolvedValue({ status: 'success', reference: 'ref_k033_sib' });

    await runQueuedCharges(new Date());

    expect((await readCharge())?.status).toBe('settled');
    const sibling = await readSibling();
    expect(new Date(sibling.current_period_end).toISOString()).toBe(
      siblingPeriodEnd.toISOString(),
    );
    expect(sibling.status).toBe('active');
  });

  it('past-dues only the subscription whose charge exhausted its attempts', async () => {
    await addSiblingSubscription();
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
    expect((await readSibling()).status).toBe('active');
  });

  it('lets only one of two cron runs holding the same snapshot spend the attempt', async () => {
    await generateDueCharges(cronNow);
    const charge = await readCharge();

    // Both runs selected the row before either wrote to it: same id, same
    // status, same attempt_count. Only one may claim the attempt.
    const [runA, runB] = await Promise.all([
      claimChargeAttempt(charge!.id, charge!.status, charge!.attempt_count),
      claimChargeAttempt(charge!.id, charge!.status, charge!.attempt_count),
    ]);

    expect([runA, runB].filter((v) => v !== null)).toEqual([1]);
    expect((await readCharge())!.attempt_count).toBe(1);
  });

  it('never exceeds MAX_ATTEMPTS across overlapping cron runs', async () => {
    await generateDueCharges(cronNow);
    chargeAuthorization.mockRejectedValue(new Error('declined'));

    for (let round = 0; round < 4; round++) {
      await Promise.all([
        runQueuedCharges(new Date()),
        runQueuedCharges(new Date()),
        runQueuedCharges(new Date()),
      ]);
      await pool.query(
        "UPDATE subscription_charges SET last_attempt_at = last_attempt_at - INTERVAL '25 hours' WHERE company_id=$1",
        [companyId],
      );
    }

    const after = await readCharge();
    expect(after!.attempt_count).toBe(3);
    expect(chargeAuthorization.mock.calls.length).toBe(3);
    expect((await readSubscription()).status).toBe('past_due');
  });
});
