/**
 * Admin audit 3.1 (F1) — charge after cancel. An admin who cancels a subscription
 * immediately (POST .../cancel, or PATCH status) used to update the subscription
 * row only. A charge already queued, or failed and past its 24h backoff, was
 * still picked up by runQueuedCharges(), which had no join to subscriptions, so
 * the cancelled customer's card was debited for a period advancePeriod refuses
 * to grant. Paystack is stubbed at the client boundary and records every call.
 * The admin routes run for real (withAdmin / withPlatformAdmin). Policy: a charge
 * for a period NOT yet granted is never debited once cancelled; a debt for a
 * period already granted stays collectible (admin-cancel-charges-policy suite).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import type { PoolClient } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { acquireCronLock, releaseCronLock } from './subscription-cron.lock';
import { adminCancelFixture, cancelRoute, patchRoute } from './helpers/adminCancelCharges';

assertDisposable();

const chargeAuthorization = vi.fn();
vi.mock('@/modules/billing/services/paystackClient', () => ({
  chargeAuthorization: (...args: unknown[]) => chargeAuthorization(...args),
  verifyTransaction: vi.fn(),
}));

const { runQueuedCharges } = await import('@/modules/billing/services/subscriptionBillingService');
const { claimChargeAttempt } = await import('@/modules/billing/services/subscriptionPeriod');

const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
const fx = adminCancelFixture(pool);
const { ids, charges, chargeStatus, subscriptionRow, callRoute } = fx;
let cronLock: PoolClient;

beforeAll(async () => {
  cronLock = await acquireCronLock(pool);
  await fx.setup();
}, 60000);

beforeEach(async () => {
  chargeAuthorization.mockReset();
  chargeAuthorization.mockImplementation(async () => ({ status: 'pending', reference: `ref_${crypto.randomUUID()}` }));
  await fx.reset();
});

afterAll(async () => {
  try {
    await fx.teardown();
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
    expect(callsFor(ids.company)).toHaveLength(2);
  });

  it('immediate cancel (POST cancel, at_period_end false) voids both charges; the runner debits nothing', async () => {
    const answer = await callRoute(cancelRoute, 'POST', { at_period_end: false });
    expect(answer.status, JSON.stringify(answer.body)).toBe(200);
    expect((await subscriptionRow()).status).toBe('cancelled');

    await runQueuedCharges(new Date());

    expect(callsFor(ids.company)).toHaveLength(0);
    expect((await chargeStatus(charges.queued)).status).toBe('cancelled');
    expect((await chargeStatus(charges.failed)).status).toBe('cancelled');
  });

  it('PATCH status cancelled voids both charges; the runner debits nothing', async () => {
    const answer = await callRoute(patchRoute, 'PATCH', { status: 'cancelled' });
    expect(answer.status, JSON.stringify(answer.body)).toBe(200);
    expect((await subscriptionRow()).status).toBe('cancelled');

    await runQueuedCharges(new Date());

    expect(callsFor(ids.company)).toHaveLength(0);
    expect((await chargeStatus(charges.queued)).status).toBe('cancelled');
    expect((await chargeStatus(charges.failed)).status).toBe('cancelled');
  });

  it('cancelling one tenant leaves another tenant\'s queued charge to be debited', async () => {
    await callRoute(cancelRoute, 'POST', { at_period_end: false });

    await runQueuedCharges(new Date());

    expect(callsFor(ids.company)).toHaveLength(0);
    expect(callsFor(ids.other)).toHaveLength(1);
    expect((await chargeStatus(charges.other)).status).not.toBe('cancelled');
  });

  it('a charge already in flight at Paystack (submitted) is not voided by the cancel', async () => {
    await pool.query("UPDATE subscription_charges SET status='submitted' WHERE id=$1", [charges.queued]);

    await callRoute(cancelRoute, 'POST', { at_period_end: false });

    expect((await chargeStatus(charges.queued)).status).toBe('submitted');
    expect((await chargeStatus(charges.failed)).status).toBe('cancelled');
  });

  it('the runner alone refuses a cancelled subscription (a charge that slipped past the void)', async () => {
    await pool.query("UPDATE subscriptions SET status='cancelled', cancelled_at=now() WHERE id=$1", [ids.sub]);

    const ran = await runQueuedCharges(new Date());

    expect(callsFor(ids.company)).toHaveLength(0);
    // Not even selected: the SELECT excludes it, the claim is not the only guard.
    expect(ran.skipped).toBe(0);
    expect(await chargeStatus(charges.queued)).toMatchObject({ status: 'queued', attempt_count: 0 });
    expect(await chargeStatus(charges.failed)).toMatchObject({ status: 'failed', attempt_count: 1 });
  });

  it('the runner refuses a paused subscription, and debits it again once it is reactivated', async () => {
    await pool.query("UPDATE subscriptions SET status='paused' WHERE id=$1", [ids.sub]);

    const ran = await runQueuedCharges(new Date());
    expect(callsFor(ids.company)).toHaveLength(0);
    expect(ran.skipped).toBe(0);
    expect(await chargeStatus(charges.queued)).toMatchObject({ status: 'queued', attempt_count: 0 });

    await pool.query("UPDATE subscriptions SET status='active' WHERE id=$1", [ids.sub]);
    await runQueuedCharges(new Date());
    expect(callsFor(ids.company)).toHaveLength(2);
  });

  it('the attempt claim itself refuses a subscription cancelled after the runner read the charge', async () => {
    await pool.query("UPDATE subscriptions SET status='cancelled', cancelled_at=now() WHERE id=$1", [ids.sub]);

    const claimed = await claimChargeAttempt(charges.queued, ids.company, 'queued', 0);

    expect(claimed).toBeNull();
    expect(await chargeStatus(charges.queued)).toMatchObject({ status: 'queued', attempt_count: 0 });
  });

  it('PATCH to past_due keeps the charges chargeable (dunning: generateDueCharges bills past_due and settling lifts it)', async () => {
    const answer = await callRoute(patchRoute, 'PATCH', { status: 'past_due' });
    expect(answer.status, JSON.stringify(answer.body)).toBe(200);

    await runQueuedCharges(new Date());

    expect(callsFor(ids.company)).toHaveLength(2);
    expect((await chargeStatus(charges.queued)).status).not.toBe('cancelled');
  });

  it('PATCH status suspended is refused at the route (the DB has no such status) and changes nothing', async () => {
    const answer = await callRoute(patchRoute, 'PATCH', { status: 'suspended' });
    expect(answer.status).toBe(400);
    // The zod enum answered, not the DB's status CHECK (whose 400 says 'Failed to update').
    expect(JSON.stringify(answer.body)).toContain('Invalid input');
    expect((await subscriptionRow()).status).toBe('active');
  });
});
