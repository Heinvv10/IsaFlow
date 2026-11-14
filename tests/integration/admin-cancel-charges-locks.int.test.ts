/**
 * Admin audit 3.1 round 2 — lock order and reactivation. A webhook settle, an
 * admin cancel and the attempt claim all take the subscription row before the
 * charge row, so racing each other cannot deadlock; and reactivating a
 * subscription cancelled long ago starts a new period from today instead of
 * back-billing every missed cycle. Policy cases: admin-cancel-charges-policy.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import type { PoolClient } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { acquireCronLock, releaseCronLock } from './subscription-cron.lock';
import { adminCancelFixture, cancelRoute, patchRoute } from './helpers/adminCancelCharges';
import { inTx, type Fixture } from './helpers/l1FifoFixture';

assertDisposable();

const chargeAuthorization = vi.fn();
vi.mock('@/modules/billing/services/paystackClient', () => ({
  chargeAuthorization: (...args: unknown[]) => chargeAuthorization(...args),
  verifyTransaction: vi.fn(),
}));

const { runQueuedCharges, generateDueCharges } = await import(
  '@/modules/billing/services/subscriptionBillingService'
);
const { deleteCompany, restoreCompany } = await import('@/modules/admin/services/companyLifecycleService');
const { claimChargeAttempt, settleSubscriptionCharge } = await import(
  '@/modules/billing/services/subscriptionPeriod'
);

const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
const fx = adminCancelFixture(pool);
const { ids, charges, subscriptionRow, callRoute } = fx;
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

function callsFor(company: string): unknown[] {
  return chargeAuthorization.mock.calls.filter(
    (c) => (c[0] as { metadata: { company_id: string } }).metadata.company_id === company,
  );
}

describe('lock order: settle, cancel and claim', () => {
  it('a webhook settle racing an admin cancel of the same failed charge: both finish, no deadlock', async () => {
    const f2 = await fx.insertCharge({ company: ids.company, subscription: ids.sub, mandate: ids.mandate,
      start: -1, end: 29, status: 'failed', attempts: 1, lastAttemptHoursAgo: 25 });
    await pool.query(`CREATE OR REPLACE FUNCTION zz_adm_slow() RETURNS trigger LANGUAGE plpgsql AS
      $$ BEGIN PERFORM pg_sleep(2.5); RETURN NEW; END $$`);
    await pool.query(`CREATE TRIGGER zz_adm_slow BEFORE UPDATE ON subscription_charges
      FOR EACH ROW WHEN (NEW.status = 'settled' AND NEW.company_id = '${ids.company}')
      EXECUTE FUNCTION zz_adm_slow()`);
    try {
      const settle = settleSubscriptionCharge(f2, ids.company).then(() => 'settle ok', (e: Error) => `settle ERR ${e.message}`);
      await new Promise((r) => setTimeout(r, 400));
      const cancel = callRoute(cancelRoute, 'POST', { at_period_end: false }).then((a) => `cancel ${a.status}`);
      const out = await Promise.all([settle, cancel]);
      expect(out).toEqual(['settle ok', 'cancel 200']);
      expect((await subscriptionRow()).status).toBe('cancelled');
    } finally {
      await pool.query('DROP TRIGGER zz_adm_slow ON subscription_charges');
      await pool.query('DROP FUNCTION zz_adm_slow()');
    }
  }, 30000);

  it('two settles of different charges on one subscription are serialised, not deadlocked (no lock upgrade)', async () => {
    const a = await fx.insertCharge({ company: ids.company, subscription: ids.sub, mandate: ids.mandate,
      start: 100, end: 130, status: 'queued' });
    const b = await fx.insertCharge({ company: ids.company, subscription: ids.sub, mandate: ids.mandate,
      start: 130, end: 160, status: 'queued' });
    await pool.query(`CREATE OR REPLACE FUNCTION zz_adm_slow2() RETURNS trigger LANGUAGE plpgsql AS
      $$ BEGIN PERFORM pg_sleep(1.5); RETURN NEW; END $$`);
    await pool.query(`CREATE TRIGGER zz_adm_slow2 BEFORE UPDATE ON subscription_charges
      FOR EACH ROW WHEN (NEW.status = 'settled' AND NEW.company_id = '${ids.company}')
      EXECUTE FUNCTION zz_adm_slow2()`);
    try {
      const results = await Promise.allSettled([
        settleSubscriptionCharge(a, ids.company),
        settleSubscriptionCharge(b, ids.company),
      ]);
      expect(results.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled']);
      expect((await fx.chargeStatus(a)).status).toBe('settled');
      expect((await fx.chargeStatus(b)).status).toBe('settled');
    } finally {
      await pool.query('DROP TRIGGER zz_adm_slow2 ON subscription_charges');
      await pool.query('DROP FUNCTION zz_adm_slow2()');
    }
  }, 30000);

  it('restoreCompany racing a webhook settle of one of its failed charges: both finish, no deadlock', async () => {
    const f2 = await fx.insertCharge({ company: ids.company, subscription: ids.sub, mandate: ids.mandate,
      start: -1, end: 29, status: 'failed', attempts: 1, lastAttemptHoursAgo: 25 });
    await deleteCompany(ids.company);
    await pool.query("UPDATE subscription_charges SET status='failed' WHERE id=$1", [f2]); // un-void so restore has work
    await pool.query(`CREATE OR REPLACE FUNCTION zz_adm_slow3() RETURNS trigger LANGUAGE plpgsql AS
      $$ BEGIN PERFORM pg_sleep(2.5); RETURN NEW; END $$`);
    await pool.query(`CREATE TRIGGER zz_adm_slow3 BEFORE UPDATE ON subscription_charges
      FOR EACH ROW WHEN (NEW.status = 'cancelled' AND NEW.failure_reason = 'company_deleted'
                         AND NEW.company_id = '${ids.company}')
      EXECUTE FUNCTION zz_adm_slow3()`);
    try {
      // As the admin route runs it: one request transaction, which keeps the subscription lock to commit.
      const txFx = { pool, companyId: ids.company, userId: ids.admin } as unknown as Fixture;
      const restore = inTx(txFx, () => restoreCompany(ids.company)).then((v) => `restore ${v}`, (e: Error) => `restore ERR ${e.message}`);
      await new Promise((r) => setTimeout(r, 500));
      const settle = settleSubscriptionCharge(f2, ids.company).then(() => 'settle ok', (e: Error) => `settle ERR ${e.message}`);
      expect(await Promise.all([restore, settle])).toEqual(['restore true', 'settle ok']);
    } finally {
      await pool.query('DROP TRIGGER zz_adm_slow3 ON subscription_charges');
      await pool.query('DROP FUNCTION zz_adm_slow3()');
    }
  }, 30000);

  it('restoring a company that is not deleted takes no subscription lock', async () => {
    const holder = await pool.connect();
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT id FROM subscriptions WHERE id=$1 FOR UPDATE', [ids.sub]);
      const txFx = { pool, companyId: ids.company, userId: ids.admin } as unknown as Fixture;
      const restore = inTx(txFx, () => restoreCompany(ids.company));
      const outcome = await Promise.race([
        restore.then((v) => `returned ${v}`),
        new Promise<string>((r) => setTimeout(() => r('blocked on the subscription lock'), 2000)),
      ]);
      await holder.query('COMMIT');
      await restore;
      expect(outcome).toBe('returned false');
    } finally {
      await holder.query('ROLLBACK').catch(() => undefined);
      holder.release();
    }
  }, 30000);

  it('restoring a lapsed company restarts the whole period, start and end together', async () => {
    await pool.query(`UPDATE subscriptions SET current_period_start = now() - interval '130 days',
      current_period_end = now() - interval '100 days' WHERE id=$1`, [ids.sub]);
    await deleteCompany(ids.company);
    const txFx = { pool, companyId: ids.company, userId: ids.admin } as unknown as Fixture;

    expect(await inTx(txFx, () => restoreCompany(ids.company))).toBe(true);

    const { rows } = await pool.query(
      `SELECT current_period_end = current_period_start AS flat, current_period_end > now() - interval '1 minute' AS fresh
       FROM subscriptions WHERE id=$1`, [ids.sub]);
    expect(rows[0]).toEqual({ flat: true, fresh: true });
  });

  it('claim, cancel and settle fired together 20 times: none is rejected', async () => {
    const rejected: string[] = [];
    for (let i = 0; i < 20; i++) {
      await pool.query("UPDATE subscriptions SET status='active', cancelled_at=NULL WHERE id=$1", [ids.sub]);
      await pool.query("UPDATE subscription_charges SET status='queued', attempt_count=0 WHERE id=$1", [charges.queued]);
      const results = await Promise.allSettled([
        claimChargeAttempt(charges.queued, ids.company, 'queued', 0),
        callRoute(cancelRoute, 'POST', { at_period_end: false }),
        settleSubscriptionCharge(charges.queued, ids.company),
      ]);
      for (const r of results) if (r.status === 'rejected') rejected.push((r.reason as Error).message);
    }
    expect(rejected).toEqual([]);
  }, 120000);
});

describe('reactivating a long-lapsed subscription', () => {
  it('starts a new period from today: one reactivation and 8 cron rounds debit once, not once per missed cycle', async () => {
    await pool.query('DELETE FROM subscription_charges WHERE company_id=$1', [ids.company]);
    await pool.query(`UPDATE subscriptions SET status='cancelled', cancelled_at=now() - interval '150 days',
      current_period_end = now() - interval '150 days' WHERE id=$1`, [ids.sub]);
    chargeAuthorization.mockImplementation(async () => ({ status: 'success', reference: `ref_${crypto.randomUUID()}` }));

    const answer = await callRoute(patchRoute, 'PATCH', { status: 'active' });
    expect(answer.status, JSON.stringify(answer.body)).toBe(200);
    for (let i = 0; i < 8; i++) {
      await generateDueCharges(new Date());
      await runQueuedCharges(new Date());
    }

    expect(callsFor(ids.company)).toHaveLength(1);
  });

  it('restarts the whole period: start moves with end, so the admin UI and CSV show no multi-month span', async () => {
    await pool.query(`UPDATE subscriptions SET status='cancelled', cancelled_at=now(),
      current_period_start = now() - interval '130 days', current_period_end = now() - interval '100 days' WHERE id=$1`, [ids.sub]);

    await callRoute(patchRoute, 'PATCH', { status: 'active' });

    const { rows } = await pool.query(
      `SELECT current_period_end = current_period_start AS flat, current_period_end > now() - interval '1 minute' AS fresh
       FROM subscriptions WHERE id=$1`, [ids.sub]);
    expect(rows[0]).toEqual({ flat: true, fresh: true });
  });

  it('leaves the period alone while a charge is still in flight at Paystack', async () => {
    await pool.query('DELETE FROM subscription_charges WHERE company_id=$1', [ids.company]);
    await fx.insertCharge({ company: ids.company, subscription: ids.sub, mandate: ids.mandate,
      start: -60, end: -30, status: 'submitted' });
    await pool.query(`UPDATE subscriptions SET status='cancelled', cancelled_at=now(),
      current_period_end = now() - interval '60 days' WHERE id=$1`, [ids.sub]);

    await callRoute(patchRoute, 'PATCH', { status: 'active' });

    const { rows } = await pool.query('SELECT current_period_end < now() - interval \'59 days\' AS kept FROM subscriptions WHERE id=$1', [ids.sub]);
    expect(rows[0].kept).toBe(true);
  });

  it('does not move a period that has not lapsed', async () => {
    await pool.query(`UPDATE subscriptions SET status='cancelled', cancelled_at=now(),
      current_period_end = now() + interval '10 days' WHERE id=$1`, [ids.sub]);

    await callRoute(patchRoute, 'PATCH', { status: 'active' });

    const { rows } = await pool.query("SELECT current_period_end > now() + interval '9 days' AS kept FROM subscriptions WHERE id=$1", [ids.sub]);
    expect(rows[0].kept).toBe(true);
  });
});
