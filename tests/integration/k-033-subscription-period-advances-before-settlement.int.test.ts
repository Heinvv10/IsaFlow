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
const verifyTransaction = vi.fn();
vi.mock('@/modules/billing/services/paystackClient', () => ({
  chargeAuthorization: (...args: unknown[]) => chargeAuthorization(...args),
  verifyTransaction: (...args: unknown[]) => verifyTransaction(...args),
}));

const { generateDueCharges, runQueuedCharges } = await import(
  '@/modules/billing/services/subscriptionBillingService'
);
const { advancePeriodForSettledCharge, claimChargeAttempt } = await import(
  '@/modules/billing/services/subscriptionPeriod'
);
const { resolveStaleSubmittedCharges, warnUnattributedLiveCharges } = await import(
  '@/modules/billing/services/subscriptionChargeVerify'
);
const { settleSubscriptionCharge } = await import(
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
  verifyTransaction.mockReset();
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
  it('bills both subscriptions of a company that shares one mandate, and settles both', async () => {
    // The mandate is per company and the settled-charge uniqueness used to be
    // per mandate, so two due subscriptions produced two debits of which the
    // second could not be recorded as settled.
    await pool.query(
      `INSERT INTO subscriptions(id,company_id,plan_id,status,billing_cycle,
         current_period_start,current_period_end,cancel_at_period_end,discount_percent)
       VALUES($1,$2,$3,'active','monthly',$4,$5,false,0)`,
      [siblingSubscriptionId, companyId, planId, periodStart, originalPeriodEnd],
    );

    const generated = await generateDueCharges(cronNow);
    expect(generated.created).toBe(2);

    chargeAuthorization.mockImplementation(async () => ({
      status: 'success',
      reference: `ref_${crypto.randomUUID()}`,
    }));
    const ran = await runQueuedCharges(new Date());
    expect(ran).toMatchObject({ submitted: 2, failed: 0 });

    const { rows: charges } = await pool.query(
      'SELECT subscription_id, status, failure_reason FROM subscription_charges WHERE company_id=$1 ORDER BY subscription_id',
      [companyId],
    );
    expect(charges.map((r) => r.status)).toEqual(['settled', 'settled']);
    expect(charges.every((r) => r.failure_reason === null)).toBe(true);
    expect(new Set(charges.map((r) => r.subscription_id)).size).toBe(2);

    // Each subscription got the period its own charge paid for.
    for (const id of [subscriptionId, siblingSubscriptionId]) {
      const { rows } = await pool.query(
        'SELECT status, current_period_end FROM subscriptions WHERE id=$1',
        [id],
      );
      expect(rows[0].status).toBe('active');
      expect(new Date(rows[0].current_period_end).getTime()).toBeGreaterThan(
        originalPeriodEnd.getTime(),
      );
    }
  });

  it('settles a submitted charge whose webhook never arrived', async () => {
    await generateDueCharges(cronNow);
    chargeAuthorization.mockResolvedValue({ status: 'pending', reference: 'ref_k033_stale' });
    await runQueuedCharges(new Date());
    expect((await readCharge())?.status).toBe('submitted');

    // Nothing has moved it for longer than STALE_SUBMITTED_HOURS.
    await pool.query(
      "UPDATE subscription_charges SET last_attempt_at = now() - INTERVAL '30 hours' WHERE company_id=$1",
      [companyId],
    );
    verifyTransaction.mockResolvedValue({ status: 'success', reference: 'ref_k033_stale' });

    const resolved = await resolveStaleSubmittedCharges(new Date());

    expect(resolved).toMatchObject({ settled: 1, failed: 0, pending: 0, contended: 0, errored: 0 });
    expect((await readCharge())?.status).toBe('settled');
    const sub = await readSubscription();
    expect(new Date(sub.current_period_end).toISOString()).toBe(await expectedPeriodEndIso());
  });

  it('fails a submitted charge Paystack says never succeeded, and leaves a fresh one alone', async () => {
    await generateDueCharges(cronNow);
    chargeAuthorization.mockResolvedValue({ status: 'pending', reference: 'ref_k033_stale2' });
    await runQueuedCharges(new Date());

    // Still inside the wait window — the resolver must not touch it yet.
    verifyTransaction.mockResolvedValue({ status: 'failed', reference: 'ref_k033_stale2' });
    expect(await resolveStaleSubmittedCharges(new Date())).toMatchObject({ settled: 0, failed: 0 });
    expect((await readCharge())?.status).toBe('submitted');
    expect(verifyTransaction).not.toHaveBeenCalled();

    await pool.query(
      "UPDATE subscription_charges SET last_attempt_at = now() - INTERVAL '30 hours' WHERE company_id=$1",
      [companyId],
    );
    const resolved = await resolveStaleSubmittedCharges(new Date());

    expect(resolved).toMatchObject({ settled: 0, failed: 1, pending: 0, contended: 0, errored: 0 });
    const charge = await readCharge();
    expect(charge?.status).toBe('failed');
    const sub = await readSubscription();
    expect(new Date(sub.current_period_end).toISOString()).toBe(originalPeriodEnd.toISOString());
  });
  it('flags a trial subscription past_due when its debit exhausts every attempt', async () => {
    // The due query never bills a trial, so the only way one holds a charge is
    // an admin moving it to trial after the charge was raised. It is still an
    // unpaid period, so it is still past_due.
    await generateDueCharges(cronNow);
    await pool.query("UPDATE subscriptions SET status='trial' WHERE id=$1", [subscriptionId]);
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

    // A trial that never converts is as unpaid as an active one.
    expect((await readSubscription()).status).toBe('past_due');
  });
  it('does not queue a replacement for a charge that predates migration 624', async () => {
    // A row the migration could not attribute names no subscription. If the
    // duplicate guard cannot see it, the cron queues a second charge for the
    // same period and — the buckets being different — both settle silently.
    const periodStartDay = new Date(originalPeriodEnd).toISOString().slice(0, 10);
    const nextEnd = new Date(originalPeriodEnd);
    nextEnd.setMonth(nextEnd.getMonth() + 1);
    await pool.query(
      `INSERT INTO subscription_charges
         (company_id, subscription_id, mandate_id, period_start, period_end,
          amount_cents, currency, gateway, external_reference, paystack_reference, status)
       VALUES ($1, NULL, $2, $3, $4, 49900, 'ZAR', 'paystack', $5, $5, 'queued')`,
      [companyId, mandateId, periodStartDay, nextEnd.toISOString().slice(0, 10), 'legacy_k033'],
    );

    const generated = await generateDueCharges(cronNow);

    const { rows } = await pool.query(
      'SELECT external_reference FROM subscription_charges WHERE company_id=$1',
      [companyId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].external_reference).toBe('legacy_k033');
    expect(generated.created).toBe(0);
  });

  it('does not overwrite a settlement that lands while the resolver is verifying', async () => {
    await generateDueCharges(cronNow);
    chargeAuthorization.mockResolvedValue({ status: 'pending', reference: 'ref_k033_race' });
    await runQueuedCharges(new Date());
    await pool.query(
      "UPDATE subscription_charges SET last_attempt_at = now() - INTERVAL '30 hours' WHERE company_id=$1",
      [companyId],
    );

    // The missing webhook arrives mid-verify, then Paystack answers 'failed'.
    verifyTransaction.mockImplementation(async () => {
      const charge = await readCharge();
      await settleSubscriptionCharge(charge!.id, companyId);
      return { status: 'failed', reference: 'ref_k033_race' };
    });

    const resolved = await resolveStaleSubmittedCharges(new Date());

    // The settlement landed mid-verify, so this is 'pending', not a lost claim.
    expect(resolved).toMatchObject({ settled: 0, failed: 0, pending: 1, contended: 0 });
    const charge = await readCharge();
    expect(charge?.status).toBe('settled');
    const sub = await readSubscription();
    expect(new Date(sub.current_period_end).toISOString()).toBe(await expectedPeriodEndIso());
  });

  it('lets only one of two resolver runs verify the same submitted charge', async () => {
    await generateDueCharges(cronNow);
    chargeAuthorization.mockResolvedValue({ status: 'pending', reference: 'ref_k033_two' });
    await runQueuedCharges(new Date());
    await pool.query(
      "UPDATE subscription_charges SET last_attempt_at = now() - INTERVAL '30 hours' WHERE company_id=$1",
      [companyId],
    );
    // The verify call takes time, so the second run starts after the first has
    // already claimed — the case a row-version CAS does not cover.
    verifyTransaction.mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 40));
      return { status: 'success', reference: 'ref_k033_two' };
    });

    const first = resolveStaleSubmittedCharges(new Date());
    await new Promise((resolve) => setTimeout(resolve, 10));
    const [a, b] = await Promise.all([first, resolveStaleSubmittedCharges(new Date())]);

    expect(a.settled + b.settled).toBe(1);
    expect(a.errored + b.errored).toBe(0);
    // The later run must not have seen the charge at all, let alone verified it.
    expect(verifyTransaction).toHaveBeenCalledTimes(1);
  });

  it('does not resurrect a charge that was voided when the customer cancelled', async () => {
    await generateDueCharges(cronNow);
    const charge = await readCharge();
    await pool.query("UPDATE subscription_charges SET status='cancelled' WHERE id=$1", [charge!.id]);

    // A late webhook for the voided debit.
    await settleSubscriptionCharge(charge!.id, companyId);

    const after = await readCharge();
    expect(after?.status).toBe('cancelled');
    const sub = await readSubscription();
    expect(new Date(sub.current_period_end).toISOString()).toBe(originalPeriodEnd.toISOString());
  });
  it('never debits a charge that names no subscription', async () => {
    // Migration 624's CHECK rejects the settlement of such a row, and that
    // rejection lands after the money has moved — so the debit pass must not
    // pick it up at all.
    const periodStartDay = new Date(originalPeriodEnd).toISOString().slice(0, 10);
    const nextEnd = new Date(originalPeriodEnd);
    nextEnd.setMonth(nextEnd.getMonth() + 1);
    await pool.query(
      `INSERT INTO subscription_charges
         (company_id, subscription_id, mandate_id, period_start, period_end,
          amount_cents, currency, gateway, external_reference, paystack_reference, status)
       VALUES ($1, NULL, $2, $3, $4, 49900, 'ZAR', 'paystack', $5, $5, 'queued')`,
      [companyId, mandateId, periodStartDay, nextEnd.toISOString().slice(0, 10), 'orphan_k033'],
    );
    chargeAuthorization.mockResolvedValue({ status: 'success', reference: 'orphan_k033' });

    const ran = await runQueuedCharges(new Date());

    expect(chargeAuthorization).not.toHaveBeenCalled();
    expect(ran).toMatchObject({ submitted: 0, failed: 0, skipped: 0 });
    const { rows } = await pool.query(
      'SELECT status, attempt_count FROM subscription_charges WHERE external_reference=$1',
      ['orphan_k033'],
    );
    expect(rows[0]).toMatchObject({ status: 'queued', attempt_count: 0 });
  });
  it('counts and skips a submitted charge that names no subscription', async () => {
    // Paystack already has this money and 624's CHECK will reject the
    // settlement, so the resolver must leave it alone and the warning must see
    // it — this is the one unattributed state that has already cost the
    // customer something.
    const periodStartDay = new Date(originalPeriodEnd).toISOString().slice(0, 10);
    const nextEnd = new Date(originalPeriodEnd);
    nextEnd.setMonth(nextEnd.getMonth() + 1);
    await pool.query(
      `INSERT INTO subscription_charges
         (company_id, subscription_id, mandate_id, period_start, period_end,
          amount_cents, currency, gateway, external_reference, paystack_reference,
          status, last_attempt_at)
       VALUES ($1, NULL, $2, $3, $4, 49900, 'ZAR', 'paystack', $5, $5,
               'submitted', now() - INTERVAL '30 hours')`,
      [companyId, mandateId, periodStartDay, nextEnd.toISOString().slice(0, 10), 'orphan_sub_k033'],
    );

    expect(await warnUnattributedLiveCharges()).toBeGreaterThanOrEqual(1);

    const resolved = await resolveStaleSubmittedCharges(new Date());

    expect(verifyTransaction).not.toHaveBeenCalled();
    expect(resolved).toMatchObject({ settled: 0, failed: 0, errored: 0 });
    const { rows } = await pool.query(
      'SELECT status FROM subscription_charges WHERE external_reference=$1',
      ['orphan_sub_k033'],
    );
    expect(rows[0].status).toBe('submitted');
  });
});
