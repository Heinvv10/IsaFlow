/**
 * Plan-level feature gating resolves the plan through the company's CURRENT
 * subscription (latest created of status trial / active / past_due), never
 * through the vestigial companies.plan_id. All three readers in
 * featureFlagService (hasFeature, companiesWithFeature,
 * getCompanyEffectiveFeatures) must answer the same. Precedence stays
 * override > global flag > plan.
 *
 * Runs on the app pool logged in as isaflow_service (as the OAuth consent page
 * does in production): subscriptions and company_feature_overrides are
 * RLS-forced, and a superuser would see rows that role cannot. Seeding and
 * cleanup go through the harness's own connection.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { getPoolForTests } from '@/lib/neon';
import {
  companiesWithFeature,
  getCompanyEffectiveFeatures,
  hasFeature,
} from '@/modules/admin/services/featureFlagService';
import { assertLocalFixtureDbUrl } from './fixtureDbGuard';
import { fixture, loginUrl } from './s07b-app-pool-login-role.helpers';

const tag = randomUUID().slice(0, 8);
const PLAN_FLAG = `zz_plan_sub_plan_${tag}`; // non-global, in planGrant only
const GLOBAL_FLAG = `zz_plan_sub_global_${tag}`; // global on, in no plan
const planGrant = randomUUID();
const planOther = randomUUID(); // grants nothing
const admin = randomUUID();
const co = {
  active: randomUUID(),
  trial: randomUUID(),
  pastDue: randomUUID(),
  vestigialOnly: randomUUID(), // companies.plan_id -> planGrant, no subscription
  noSub: randomUUID(),
  cancelledOnly: randomUUID(),
  pausedOnly: randomUUID(),
  newerLiveOtherPlan: randomUUID(), // older live grant, newer live non-grant: latest wins
  newerCancelled: randomUUID(), // live grant, then a later cancelled one: grant stays
  olderCancelledGrant: randomUUID(), // cancelled grant, newer live non-grant
  overrideOnNoSub: randomUUID(),
  overrideOffOnPlan: randomUUID(),
  overrideOffOnGlobal: randomUUID(),
  vestigialBlocksNothing: randomUUID(), // active non-grant sub, companies.plan_id -> planGrant
};
const ALL = Object.values(co);
const flagIds: Record<string, string> = {};

const EXPECTED_PLAN: Record<keyof typeof co, boolean> = {
  active: true,
  trial: true,
  pastDue: true,
  vestigialOnly: false,
  noSub: false,
  cancelledOnly: false,
  pausedOnly: false,
  newerLiveOtherPlan: false,
  newerCancelled: true,
  olderCancelledGrant: false,
  overrideOnNoSub: true,
  overrideOffOnPlan: false,
  overrideOffOnGlobal: false,
  vestigialBlocksNothing: false,
};

const q = (text: string, values: unknown[] = []) => fixture.query(text, values);
const sub = (company: string, plan: string, status: string, createdAt: string) =>
  q(
    `INSERT INTO subscriptions (company_id, plan_id, status, created_at) VALUES ($1, $2, $3, $4::timestamptz)`,
    [company, plan, status, createdAt]
  );

describe.skipIf(!process.env.DATABASE_URL)('feature gating reads the plan from subscriptions', () => {
  beforeAll(async () => {
    assertLocalFixtureDbUrl('DATABASE_URL', process.env.DATABASE_URL, ['isaflow_schema_fixture']);
    await q(`INSERT INTO users (id, email, role, is_active) VALUES ($1, $2, 'super_admin', true)`, [admin, `${admin}@test.local`]);
    for (const [id, code] of [[planGrant, 'grant'], [planOther, 'other']] as const) {
      await q('INSERT INTO plans (id, code, name) VALUES ($1, $2, $3)', [id, `zz_ps_${code}_${tag}`, `Plan ${code}`]);
    }
    for (const [code, isGlobal] of [[PLAN_FLAG, false], [GLOBAL_FLAG, true]] as const) {
      const r = await q('INSERT INTO feature_flags (code, name, is_global) VALUES ($1, $1, $2) RETURNING id', [code, isGlobal]);
      flagIds[code] = String(r.rows[0]!.id);
    }
    await q('INSERT INTO plan_features (plan_id, feature_id) VALUES ($1, $2)', [planGrant, flagIds[PLAN_FLAG]]);
    for (const id of ALL) {
      const vestigial = id === co.vestigialOnly || id === co.vestigialBlocksNothing;
      await q('INSERT INTO companies (id, name, plan_id) VALUES ($1, $2, $3)', [id, `PlanSub ${tag}`, vestigial ? planGrant : null]);
    }
    await sub(co.active, planGrant, 'active', '2026-01-01');
    await sub(co.trial, planGrant, 'trial', '2026-01-01');
    await sub(co.pastDue, planGrant, 'past_due', '2026-01-01');
    await sub(co.cancelledOnly, planGrant, 'cancelled', '2026-01-01');
    await sub(co.pausedOnly, planGrant, 'paused', '2026-01-01');
    await sub(co.newerLiveOtherPlan, planGrant, 'active', '2026-01-01');
    await sub(co.newerLiveOtherPlan, planOther, 'active', '2026-02-01');
    await sub(co.newerCancelled, planGrant, 'active', '2026-01-01');
    await sub(co.newerCancelled, planOther, 'cancelled', '2026-02-01');
    await sub(co.olderCancelledGrant, planGrant, 'cancelled', '2026-01-01');
    await sub(co.olderCancelledGrant, planOther, 'active', '2026-02-01');
    await sub(co.overrideOffOnPlan, planGrant, 'active', '2026-01-01');
    await sub(co.vestigialBlocksNothing, planOther, 'active', '2026-01-01');
    const override = (company: string, flag: string, enabled: boolean) =>
      q(
        'INSERT INTO company_feature_overrides (company_id, feature_id, enabled, set_by) VALUES ($1, $2, $3, $4)',
        [company, flagIds[flag], enabled, admin]
      );
    await override(co.overrideOnNoSub, PLAN_FLAG, true);
    await override(co.overrideOffOnPlan, PLAN_FLAG, false);
    await override(co.overrideOffOnGlobal, GLOBAL_FLAG, false);
    // Before the first query: the app pool is created lazily from this URL.
    vi.stubEnv('SERVICE_DATABASE_URL', await loginUrl(process.env.DATABASE_URL!, 'isaflow_service'));
  });

  afterAll(async () => {
    const ids = Object.values(flagIds);
    await q('DELETE FROM company_feature_overrides WHERE feature_id = ANY($1::uuid[])', [ids]);
    await q('DELETE FROM plan_features WHERE feature_id = ANY($1::uuid[])', [ids]);
    await q('DELETE FROM feature_flags WHERE id = ANY($1::uuid[])', [ids]);
    await q('DELETE FROM subscriptions WHERE company_id = ANY($1::uuid[])', [ALL]);
    await q('DELETE FROM companies WHERE id = ANY($1::uuid[])', [ALL]);
    await q('DELETE FROM plans WHERE id = ANY($1::uuid[])', [[planGrant, planOther]]);
    await q('DELETE FROM users WHERE id = $1', [admin]);
    vi.unstubAllEnvs();
    await getPoolForTests().end();
    await fixture.end();
  });

  const names = Object.keys(co) as Array<keyof typeof co>;

  it.each(names)('hasFeature: %s', async (name) => {
    expect(await hasFeature(co[name], PLAN_FLAG)).toBe(EXPECTED_PLAN[name]);
  });

  it('companiesWithFeature answers the same set in one query', async () => {
    const expected = new Set(names.filter((n) => EXPECTED_PLAN[n]).map((n) => co[n]));
    expect(await companiesWithFeature(ALL, PLAN_FLAG)).toEqual(expected);
  });

  it.each(names)('getCompanyEffectiveFeatures: %s', async (name) => {
    const rows = await getCompanyEffectiveFeatures(co[name]);
    const row = rows.find((r) => r.code === PLAN_FLAG);
    expect(row?.enabled).toBe(EXPECTED_PLAN[name]);
  });

  it('effective features name the plan as the source for a subscribed company', async () => {
    const row = (await getCompanyEffectiveFeatures(co.active)).find((r) => r.code === PLAN_FLAG);
    expect(row).toMatchObject({ enabled: true, source: 'plan' });
  });

  it('an override beats the plan in all three readers', async () => {
    expect(await hasFeature(co.overrideOffOnPlan, PLAN_FLAG)).toBe(false);
    expect(await hasFeature(co.overrideOnNoSub, PLAN_FLAG)).toBe(true);
    const on = (await getCompanyEffectiveFeatures(co.overrideOnNoSub)).find((r) => r.code === PLAN_FLAG);
    expect(on).toMatchObject({ enabled: true, source: 'override' });
    const batch = await companiesWithFeature([co.overrideOffOnPlan, co.overrideOnNoSub], PLAN_FLAG);
    expect(batch).toEqual(new Set([co.overrideOnNoSub]));
  });

  it('a global flag is on without any subscription, and an override off beats it', async () => {
    expect(await hasFeature(co.noSub, GLOBAL_FLAG)).toBe(true);
    expect(await hasFeature(co.overrideOffOnGlobal, GLOBAL_FLAG)).toBe(false);
    const batch = await companiesWithFeature([co.noSub, co.overrideOffOnGlobal], GLOBAL_FLAG);
    expect(batch).toEqual(new Set([co.noSub]));
    const eff = (await getCompanyEffectiveFeatures(co.noSub)).find((r) => r.code === GLOBAL_FLAG);
    expect(eff).toMatchObject({ enabled: true, source: 'global' });
  });
});
