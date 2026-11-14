/**
 * Admin audit 3.1 follow-up — the one rule behind every void path: a charge for
 * a period the subscription was NOT yet granted is never debited once it is
 * cancelled; a debt for a period it WAS granted stays collectible. Also the
 * races (cancel in flight, cancel mid-flight), reactivation, atomicity and
 * cancelled_at (audit F11). Core cases: admin-cancel-voids-charges suite.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import type { PoolClient } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { acquireCronLock, releaseCronLock } from './subscription-cron.lock';
import { adminCancelFixture, cancelRoute, patchRoute } from './helpers/adminCancelCharges';
import { log } from '@/lib/logger';

assertDisposable();

const chargeAuthorization = vi.fn();
vi.mock('@/modules/billing/services/paystackClient', () => ({
  chargeAuthorization: (...args: unknown[]) => chargeAuthorization(...args),
  verifyTransaction: vi.fn(),
}));

const { runQueuedCharges, generateDueCharges } = await import(
  '@/modules/billing/services/subscriptionBillingService'
);

const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
const fx = adminCancelFixture(pool);
const { ids, charges, chargeStatus, subscriptionRow, callRoute } = fx;
let cronLock: PoolClient;

beforeAll(async () => {
  cronLock = await acquireCronLock(pool);
  await fx.setup();
}, 60000);

beforeEach(async () => {
  vi.restoreAllMocks();
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

function callsFor(company: string): unknown[] {
  return chargeAuthorization.mock.calls.filter(
    (c) => (c[0] as { metadata: { company_id: string } }).metadata.company_id === company,
  );
}

describe('granted-period debt stays collectible; ungranted never is', () => {
  it('the runner still collects a granted-period debt on a cancelled subscription', async () => {
    await pool.query('DELETE FROM subscription_charges WHERE company_id=$1', [ids.company]);
    const debt = await fx.insertGrantedDebt();
    await pool.query("UPDATE subscriptions SET status='cancelled', cancelled_at=now() WHERE id=$1", [ids.sub]);

    await runQueuedCharges(new Date());

    expect(callsFor(ids.company)).toHaveLength(1);
    expect((await chargeStatus(debt)).status).toBe('submitted');
  });

  it('after a cancel_at_period_end close-out the kept debt is collected', async () => {
    const now = new Date();
    await pool.query('DELETE FROM subscription_charges WHERE company_id=$1', [ids.company]);
    const debt = await fx.insertGrantedDebt();
    await pool.query("UPDATE subscriptions SET cancel_at_period_end=true, status='past_due' WHERE id=$1", [ids.sub]);

    const generated = await generateDueCharges(now);
    expect(generated.cancelled).toBe(1);
    expect((await subscriptionRow()).status).toBe('cancelled');
    expect((await chargeStatus(debt)).status).toBe('failed');

    await runQueuedCharges(now);
    expect(callsFor(ids.company)).toHaveLength(1);
  });

  it('admin cancel voids only ungranted periods; a granted-period debt is kept and collected', async () => {
    await pool.query("UPDATE subscriptions SET current_period_end = now() + interval '20 days' WHERE id=$1", [ids.sub]);
    // queued covers day -1..29, failed covers 29..59: with the period granted to +20d the
    // queued one is service already taken, the failed one (starts day 29) is not.
    await callRoute(cancelRoute, 'POST', { at_period_end: false });

    expect((await chargeStatus(charges.queued)).status).toBe('queued');
    expect((await chargeStatus(charges.failed)).status).toBe('cancelled');

    await runQueuedCharges(new Date());
    expect(callsFor(ids.company)).toHaveLength(1);
  });

  it('cancelling subscription A leaves a second subscription B of the same company debitable', async () => {
    const subB = crypto.randomUUID();
    await fx.insertSubscription(subB, ids.company);
    await pool.query('UPDATE subscription_charges SET subscription_id=$2 WHERE id=$1', [charges.queued, subB]);

    await callRoute(cancelRoute, 'POST', { at_period_end: false });
    await runQueuedCharges(new Date());

    expect((await chargeStatus(charges.queued)).status).not.toBe('cancelled');
    expect(callsFor(ids.company)).toHaveLength(1);
    await pool.query('DELETE FROM paystack_payment_requests WHERE company_id=$1', [ids.company]);
    await pool.query('DELETE FROM subscription_charges WHERE company_id=$1', [ids.company]);
    await pool.query('DELETE FROM subscriptions WHERE id=$1', [subB]);
  });
});

describe('reactivation', () => {
  it('voids stale ungranted charges left by a pre-fix cancel, keeps a granted debt', async () => {
    await pool.query("UPDATE subscriptions SET status='cancelled', cancelled_at=now() WHERE id=$1", [ids.sub]);
    const debt = await fx.insertGrantedDebt();

    const answer = await callRoute(patchRoute, 'PATCH', { status: 'active' });
    expect(answer.status, JSON.stringify(answer.body)).toBe(200);
    await runQueuedCharges(new Date());

    expect((await chargeStatus(charges.queued)).status).toBe('cancelled');
    expect((await chargeStatus(charges.failed)).status).toBe('cancelled');
    expect(callsFor(ids.company)).toHaveLength(1);
    expect((await chargeStatus(debt)).status).toBe('submitted');
  });
});

describe('races and atomicity', () => {
  it('a cancel whose transaction is open (not committed) stops the claim: no debit before or after commit', async () => {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await c.query("UPDATE subscriptions SET status='cancelled', cancelled_at=now() WHERE id=$1", [ids.sub]);
      const run = runQueuedCharges(new Date());
      await new Promise((r) => setTimeout(r, 400));
      const during = callsFor(ids.company).length;
      await c.query('COMMIT');
      await run;
      expect(during, 'card charged while the cancel was mid-commit').toBe(0);
      expect(callsFor(ids.company)).toHaveLength(0);
    } finally {
      c.release();
    }
  });

  it('a failing void rolls the whole cancel back: the subscription stays active', async () => {
    await pool.query(`CREATE OR REPLACE FUNCTION zz_adm_cancel_fail() RETURNS trigger LANGUAGE plpgsql AS
      $$ BEGIN RAISE EXCEPTION 'zz_adm_cancel'; END $$`);
    // Scoped to this suite's own company: it cannot touch a parallel suite's charges.
    await pool.query(`CREATE TRIGGER zz_adm_cancel BEFORE UPDATE ON subscription_charges
      FOR EACH ROW WHEN (NEW.status = 'cancelled' AND NEW.company_id = '${ids.company}')
      EXECUTE FUNCTION zz_adm_cancel_fail()`);
    try {
      await callRoute(cancelRoute, 'POST', { at_period_end: false });
      expect((await subscriptionRow()).status).toBe('active');
    } finally {
      await pool.query('DROP TRIGGER zz_adm_cancel ON subscription_charges');
      await pool.query('DROP FUNCTION zz_adm_cancel_fail()');
    }
  });

  it.each([['success', 'settled'], ['pending', 'submitted']])(
    'a cancel landing during the Paystack call (answer %s) is not overwritten, and the refund case is logged',
    async (paystackStatus) => {
      const warn = vi.spyOn(log, 'warn');
      chargeAuthorization.mockImplementation(async (a: { metadata: { company_id: string } }) => {
        if (a.metadata.company_id === ids.company) await callRoute(cancelRoute, 'POST', { at_period_end: false });
        return { status: paystackStatus, reference: `ref_${crypto.randomUUID()}` };
      });

      const ran = await runQueuedCharges(new Date());

      // Counted apart from a real submission: the card was debited and nothing records it.
      expect(ran.refundNeeded).toBe(1);
      expect(ran.submitted).toBe(1); // the other tenant's charge
      expect(callsFor(ids.company)).toHaveLength(1);
      expect((await chargeStatus(charges.queued)).status).toBe('cancelled');
      expect(warn.mock.calls.some((c) => String(c[0]).includes('voided mid-flight')
        && (c[1] as { chargeId: string }).chargeId === charges.queued)).toBe(true);
      // No period granted for the debit that slipped through.
      const { rows } = await pool.query('SELECT current_period_end < now() AS stale FROM subscriptions WHERE id=$1', [ids.sub]);
      expect(rows[0].stale).toBe(true);
    });

  it('a failed Paystack call after a mid-flight cancel leaves the charge voided, not failed and retryable', async () => {
    chargeAuthorization.mockImplementation(async (a: { metadata: { company_id: string } }) => {
      if (a.metadata.company_id === ids.company) await callRoute(cancelRoute, 'POST', { at_period_end: false });
      throw new Error('declined');
    });

    await runQueuedCharges(new Date());

    expect((await chargeStatus(charges.queued)).status).toBe('cancelled');
  });
});

describe('cancelled_at (audit F11)', () => {
  const stamp = async () => (await subscriptionRow()).cancelled_at;

  it('PATCH cancelled stamps it, re-cancelling keeps it, reactivation clears it', async () => {
    expect(await stamp()).toBeNull();
    await callRoute(patchRoute, 'PATCH', { status: 'cancelled' });
    const first = await stamp();
    expect(first).not.toBeNull();

    await pool.query("UPDATE subscriptions SET cancelled_at = cancelled_at - interval '3 days' WHERE id=$1", [ids.sub]);
    const backdated = await stamp();
    await callRoute(patchRoute, 'PATCH', { status: 'cancelled' });
    expect((await stamp())?.toISOString()).toBe(backdated?.toISOString());

    await callRoute(patchRoute, 'PATCH', { status: 'active' });
    expect(await stamp()).toBeNull();
  });

  it('POST cancel on an already cancelled subscription does not move cancelled_at', async () => {
    await callRoute(cancelRoute, 'POST', { at_period_end: false });
    await pool.query("UPDATE subscriptions SET cancelled_at = cancelled_at - interval '3 days' WHERE id=$1", [ids.sub]);
    const backdated = await stamp();

    await callRoute(cancelRoute, 'POST', { at_period_end: false });

    expect((await stamp())?.toISOString()).toBe(backdated?.toISOString());
  });
});
