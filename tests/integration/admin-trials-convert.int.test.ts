/**
 * Admin audit 1.6: "Convert to Paid" on a trial, through the real route
 * (withAdmin -> withPlatformAdmin on a real platform_admin login).
 *
 * On master the subscription step was `INSERT ... ON CONFLICT (company_id)`
 * against a table with no unique index on company_id, so every convert failed
 * with 42P10, answered 400 with the raw SQL message. When it did not fail it
 * would have set no period (billing skips a NULL current_period_end) and left
 * the trial subscription beside a second, active one.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import convertRoute from '../../pages/api/admin/trials/convert';
import {
  addMandate, asAdmin, auditCount, companyRow, makeCompany, nowSkewSeconds, pool, seedPlans, startAdmin, stopAdmin, subsOf, tag,
  type TrialPlans,
} from './admin-trials.helpers';

let plans: TrialPlans;
const FAIL_FN = `wp2_fail_sub_${tag}`;

beforeAll(async () => {
  await startAdmin();
  plans = await seedPlans();
}, 60000);

afterAll(async () => {
  try {
    await pool.query(`DROP TRIGGER IF EXISTS wp2_fail ON subscriptions`);
    await pool.query(`DROP FUNCTION IF EXISTS ${FAIL_FN}()`);
  } finally {
    await stopAdmin();
    await pool.end();
  }
}, 60000);

const convert = (companyId: string, planId: string) =>
  asAdmin(convertRoute, 'POST', { body: { companyId, planId } });
const errorOf = (r: { body: unknown }) => (r.body as { error?: { message?: string } }).error?.message ?? '';

describe('convert a trial to paid', () => {
  it('a running trial: one active subscription on the chosen plan, period set, company active', async () => {
    const id = await makeCompany({ name: 'Convert fresh', endsInDays: 12, status: 'trial',
      sub: { plan: plans.trial, status: 'trial' } });
    const r = await convert(id, plans.paid);
    expect(r.status, JSON.stringify(r.body)).toBe(200);

    const subs = await subsOf(id);
    expect(subs).toHaveLength(1);
    expect(subs[0]).toMatchObject({ plan_id: plans.paid, status: 'active', billing_cycle: 'monthly', cancel_at_period_end: false });
    expect(nowSkewSeconds(subs[0].current_period_start, 0)).toBeLessThan(120);
    const days = (new Date(subs[0].current_period_end).getTime() - new Date(subs[0].current_period_start).getTime()) / 86400000;
    expect(days).toBeGreaterThanOrEqual(28);
    expect(days).toBeLessThanOrEqual(31);
    expect(await companyRow(id)).toMatchObject({ status: 'active', plan_id: plans.paid });
    expect(await auditCount('trial.convert_to_paid', id)).toBe(1);
  }, 30000);

  it('an expired trial converts the same way', async () => {
    const id = await makeCompany({ name: 'Convert expired', endsInDays: -20,
      sub: { plan: plans.trial, status: 'trial' } });
    const r = await convert(id, plans.paid2);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const subs = await subsOf(id);
    expect(subs).toHaveLength(1);
    expect(subs[0]).toMatchObject({ plan_id: plans.paid2, status: 'active' });
    expect(new Date(subs[0].current_period_end).getTime()).toBeGreaterThan(Date.now());
  }, 30000);

  it('a company that is "active" on the free trial plan (period long past) is updated in place', async () => {
    const id = await makeCompany({ name: 'Convert active-on-trial-plan', endsInDays: -60,
      sub: { plan: plans.trial, status: 'active', periodEndDays: -45 } });
    const before = (await subsOf(id))[0];
    const r = await convert(id, plans.paid);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const subs = await subsOf(id);
    expect(subs).toHaveLength(1);
    expect(subs[0].id).toBe(before.id);
    expect(subs[0]).toMatchObject({ plan_id: plans.paid, status: 'active' });
    expect(new Date(subs[0].current_period_end).getTime()).toBeGreaterThan(Date.now());
  }, 30000);

  it('a company with no subscription gets exactly one', async () => {
    const id = await makeCompany({ name: 'Convert no sub', endsInDays: 3 });
    const r = await convert(id, plans.paid);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const subs = await subsOf(id);
    expect(subs).toHaveLength(1);
    expect(subs[0]).toMatchObject({ plan_id: plans.paid, status: 'active' });
    expect(subs[0].current_period_end).not.toBeNull();
  }, 30000);

  it('a convert that lost the race (another one committed while it waited on the company lock) is refused, not applied on top', async () => {
    const id = await makeCompany({ name: 'Convert race', endsInDays: 5, sub: { plan: plans.trial, status: 'trial' } });
    const rival = await pool.connect();
    try {
      await rival.query('BEGIN');
      await rival.query('SELECT id FROM companies WHERE id = $1 FOR UPDATE', [id]);
      const loser = convert(id, plans.paid2);
      await new Promise((resolve) => setTimeout(resolve, 400)); // it is queued behind the rival's lock
      await rival.query(`UPDATE subscriptions SET status = 'active', plan_id = $2, current_period_end = NOW() + interval '1 month'
        WHERE company_id = $1`, [id, plans.paid]);
      await rival.query('COMMIT');
      const r = await loser;
      expect(r.status, JSON.stringify(r.body)).toBe(409);
    } finally {
      rival.release();
    }
    const subs = await subsOf(id);
    expect(subs).toHaveLength(1);
    expect(subs[0]).toMatchObject({ status: 'active', plan_id: plans.paid });
    expect(await auditCount('trial.convert_to_paid', id)).toBe(0);
  }, 60000);

  it('converting twice leaves one subscription: the second is refused, as is one for another plan', async () => {
    const id = await makeCompany({ name: 'Convert twice', endsInDays: 5, sub: { plan: plans.trial, status: 'trial' } });
    expect((await convert(id, plans.paid)).status).toBe(200);
    expect((await convert(id, plans.paid)).status).toBe(409);
    expect((await convert(id, plans.paid2)).status).toBe(409);
    const subs = await subsOf(id);
    expect(subs).toHaveLength(1);
    expect(subs[0]).toMatchObject({ status: 'active', plan_id: plans.paid });
    expect(await auditCount('trial.convert_to_paid', id)).toBe(1);
  }, 60000);

  it('a cancelled subscription is left alone and a fresh one is created', async () => {
    const id = await makeCompany({ name: 'Convert after cancel', endsInDays: -3, sub: { plan: plans.paid, status: 'cancelled' } });
    const r = await convert(id, plans.paid2);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const subs = await subsOf(id);
    expect(subs.map((s) => s.status).sort()).toEqual(['active', 'cancelled']);
  }, 30000);
});

describe('what convert refuses', () => {
  it.each([['trial'], ['payg'], ['archived']] as const)('the %s plan: 400, nothing written', async (which) => {
    const id = await makeCompany({ name: `Refuse ${which}`, endsInDays: 4, status: 'trial', sub: { plan: plans.trial, status: 'trial' } });
    const r = await convert(id, plans[which]);
    expect(r.status).toBe(400);
    expect(await companyRow(id)).toMatchObject({ status: 'trial', plan_id: null });
    const subs = await subsOf(id);
    expect(subs).toHaveLength(1);
    expect(subs[0]).toMatchObject({ status: 'trial', plan_id: plans.trial });
  }, 30000);

  it('an unknown plan is a 404 and an unknown or deleted company is a 404', async () => {
    const id = await makeCompany({ name: 'Refuse unknown plan', endsInDays: 4 });
    expect((await convert(id, crypto.randomUUID())).status).toBe(404);
    expect((await convert(crypto.randomUUID(), plans.paid)).status).toBe(404);
    const gone = await makeCompany({ name: 'Refuse deleted', endsInDays: 4, status: 'deleted' });
    expect((await convert(gone, plans.paid)).status).toBe(404);
    expect(await subsOf(gone)).toHaveLength(0);
    expect(await companyRow(gone)).toMatchObject({ status: 'deleted' });
  }, 30000);
});

describe('review: company standing, stray trial rows, the first charge', () => {
  it.each([['suspended'], ['cancelled']] as const)('a %s company is refused (409) and left exactly as it was', async (status) => {
    const id = await makeCompany({ name: `Standing ${status}`, endsInDays: -4, status, sub: { plan: plans.trial, status: 'trial' } });
    await pool.query(`UPDATE companies SET suspended_at = NOW() - interval '2 days', suspended_reason = 'unpaid' WHERE id = $1`, [id]);
    const before = (await pool.query('SELECT status, plan_id, suspended_at, suspended_reason, updated_at FROM companies WHERE id = $1', [id])).rows[0];
    const r = await convert(id, plans.paid);
    expect(r.status, JSON.stringify(r.body)).toBe(409);
    expect((await pool.query('SELECT status, plan_id, suspended_at, suspended_reason, updated_at FROM companies WHERE id = $1', [id])).rows[0]).toEqual(before);
    const subs = await subsOf(id);
    expect(subs).toHaveLength(1);
    expect(subs[0]).toMatchObject({ status: 'trial', plan_id: plans.trial });
    expect(await auditCount('trial.convert_to_paid', id)).toBe(0);
  }, 30000);

  it('two live trial rows: the newest is converted and the other is cancelled, so one live subscription remains', async () => {
    const id = await makeCompany({ name: 'Two trial rows', endsInDays: 5, status: 'trial',
      sub: { plan: plans.trial, status: 'trial', createdDaysAgo: 9 },
      moreSubs: [{ plan: plans.trial, status: 'active', periodEndDays: -3, createdDaysAgo: 2 }, { plan: plans.trial, status: 'trial' }] });
    const [oldest, middle, newest] = await subsOf(id);
    const r = await convert(id, plans.paid);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const after = await subsOf(id);
    const byId = new Map(after.map((x) => [x.id, x]));
    expect(byId.get(newest.id)).toMatchObject({ status: 'active', plan_id: plans.paid });
    for (const stray of [oldest, middle]) {
      expect(byId.get(stray.id)).toMatchObject({ status: 'cancelled', plan_id: plans.trial });
      expect(byId.get(stray.id)!.cancelled_at).not.toBeNull();
    }
    expect(after.filter((x) => x.status !== 'cancelled')).toHaveLength(1);
  }, 30000);

  it('a paused subscription is refused (409, "paused") and nothing is written', async () => {
    const id = await makeCompany({ name: 'Paused sub', endsInDays: 5, status: 'trial', sub: { plan: plans.paid, status: 'paused' } });
    const r = await convert(id, plans.paid2);
    expect(r.status, JSON.stringify(r.body)).toBe(409);
    expect(errorOf(r)).toMatch(/paused/i);
    expect(await companyRow(id)).toMatchObject({ status: 'trial', plan_id: null });
    expect((await subsOf(id))[0]).toMatchObject({ status: 'paused', plan_id: plans.paid });
  }, 30000);

  it('answers the first charge date and whether an active Paystack mandate exists', async () => {
    const withMandate = await makeCompany({ name: 'Mandate yes', endsInDays: 5, status: 'trial', sub: { plan: plans.trial, status: 'trial' } });
    await addMandate(withMandate);
    const a = (await convert(withMandate, plans.paid)).body as { data: { firstChargeAt: string; hasActiveMandate: boolean } };
    expect(a.data.hasActiveMandate).toBe(true);
    expect(new Date(a.data.firstChargeAt).getTime()).toBe(new Date((await subsOf(withMandate))[0].current_period_end).getTime());

    const without = await makeCompany({ name: 'Mandate revoked', endsInDays: 5, status: 'trial', sub: { plan: plans.trial, status: 'trial' } });
    await addMandate(without, 'revoked');
    const b = (await convert(without, plans.paid)).body as { data: { hasActiveMandate: boolean } };
    expect(b.data.hasActiveMandate).toBe(false);
  }, 30000);
});

describe('a failure part-way rolls the whole convert back', () => {
  it('the subscription write fails: 500, a plain message, the company is untouched', async () => {
    const id = await makeCompany({ name: 'Rollback', endsInDays: 6, status: 'trial', sub: { plan: plans.trial, status: 'trial' } });
    await pool.query(`CREATE OR REPLACE FUNCTION ${FAIL_FN}() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'wp2 forced failure: secret_table_name'; END $$`);
    await pool.query(`CREATE TRIGGER wp2_fail BEFORE INSERT OR UPDATE ON subscriptions
      FOR EACH ROW WHEN (NEW.company_id = '${id}') EXECUTE FUNCTION ${FAIL_FN}()`);
    try {
      const r = await convert(id, plans.paid);
      expect(r.status).toBe(500);
      expect(errorOf(r)).not.toMatch(/secret_table_name|wp2 forced|ON CONFLICT|violates|relation|column/i);
    } finally {
      await pool.query(`DROP TRIGGER IF EXISTS wp2_fail ON subscriptions`);
    }
    expect(await companyRow(id)).toMatchObject({ status: 'trial', plan_id: null });
    const subs = await subsOf(id);
    expect(subs).toHaveLength(1);
    expect(subs[0]).toMatchObject({ status: 'trial', plan_id: plans.trial });
    expect(await auditCount('trial.convert_to_paid', id)).toBe(0);
  }, 30000);

  it('the audit row cannot be written: the convert does not commit', async () => {
    const id = await makeCompany({ name: 'Rollback audit', endsInDays: 6, status: 'trial', sub: { plan: plans.trial, status: 'trial' } });
    await pool.query(`ALTER TABLE admin_audit_log ADD CONSTRAINT wp2_no_convert CHECK (action <> 'trial.convert_to_paid') NOT VALID`);
    try {
      const r = await convert(id, plans.paid);
      expect(r.status).toBeGreaterThanOrEqual(500);
    } finally {
      await pool.query(`ALTER TABLE admin_audit_log DROP CONSTRAINT IF EXISTS wp2_no_convert`);
    }
    expect(await companyRow(id)).toMatchObject({ status: 'trial', plan_id: null });
    expect((await subsOf(id))[0]).toMatchObject({ status: 'trial', plan_id: plans.trial });
  }, 30000);
});
