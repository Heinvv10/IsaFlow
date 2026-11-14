/**
 * A company the admin creates on a plan starts a trial subscription. Plan
 * gating counts a trial only while its end is in the future (currentPlanSql.ts),
 * so createCompany must record the trial end the way tenant provisioning does
 * (trialEndsAt, TRIAL_DAYS): otherwise an admin-created company on Professional
 * gets none of Professional's features. Without a plan there is no trial and no
 * trial end.
 *
 * Disposable schema fixture only (assertLocalFixtureDbUrl); the app pool is the
 * harness's own `postgres` connection, which writes companies.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { getPoolForTests } from '@/lib/neon';
import { createCompany } from '@/modules/admin/services/adminCompanyService';
import { hasFeature } from '@/modules/admin/services/featureFlagService';
import { TRIAL_DAYS } from '@/modules/onboarding/services/tenantProvisioningService';
import { assertLocalFixtureDbUrl } from './fixtureDbGuard';

const tag = randomUUID().slice(0, 8);
const FLAG = `zz_create_co_${tag}`;
const plan = randomUUID();
const created: string[] = [];
let flagId = '';

describe.skipIf(!process.env.DATABASE_URL)('admin createCompany on a plan', () => {
  const pool = () => getPoolForTests();

  beforeAll(async () => {
    assertLocalFixtureDbUrl('DATABASE_URL', process.env.DATABASE_URL, ['isaflow_schema_fixture']);
    await pool().query('INSERT INTO plans (id, code, name) VALUES ($1, $2, $3)', [plan, `zz_cc_${tag}`, 'Create-company plan']);
    const f = await pool().query('INSERT INTO feature_flags (code, name, is_global) VALUES ($1, $1, false) RETURNING id', [FLAG]);
    flagId = String(f.rows[0].id);
    await pool().query('INSERT INTO plan_features (plan_id, feature_id) VALUES ($1, $2)', [plan, flagId]);
  });

  afterAll(async () => {
    await pool().query('DELETE FROM subscriptions WHERE company_id = ANY($1::uuid[])', [created]);
    await pool().query('DELETE FROM companies WHERE id = ANY($1::uuid[])', [created]);
    await pool().query('DELETE FROM plan_features WHERE plan_id = $1', [plan]);
    await pool().query('DELETE FROM feature_flags WHERE id = $1', [flagId]);
    await pool().query('DELETE FROM plans WHERE id = $1', [plan]);
    await pool().end();
  });

  it('an admin-created company on a plan has the plan features and a trial end (company and subscription) TRIAL_DAYS out', async () => {
    const before = Date.now();
    const company = await createCompany({ name: `CreateCo ${tag}`, plan_id: plan });
    created.push(company.id);

    expect(await hasFeature(company.id, FLAG)).toBe(true);
    const row = await pool().query('SELECT trial_ends_at FROM companies WHERE id = $1', [company.id]);
    const end = new Date(row.rows[0].trial_ends_at).getTime();
    const day = 24 * 60 * 60 * 1000;
    expect(end).toBeGreaterThanOrEqual(before + TRIAL_DAYS * day);
    expect(end).toBeLessThanOrEqual(Date.now() + TRIAL_DAYS * day);
    const sub = await pool().query('SELECT status, current_period_end FROM subscriptions WHERE company_id = $1', [company.id]);
    expect(sub.rows[0].status).toBe('trial');
    expect(new Date(sub.rows[0].current_period_end).getTime()).toBe(end);
  });

  it('an admin-created company with no plan has no subscription, no trial end and no plan feature', async () => {
    const company = await createCompany({ name: `CreateCo none ${tag}` });
    created.push(company.id);

    expect(await hasFeature(company.id, FLAG)).toBe(false);
    const row = await pool().query('SELECT trial_ends_at FROM companies WHERE id = $1', [company.id]);
    expect(row.rows[0].trial_ends_at).toBeNull();
  });
});
