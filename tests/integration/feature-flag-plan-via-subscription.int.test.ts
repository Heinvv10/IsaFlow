/**
 * Plan-level feature gating resolves the plan through the company's CURRENT
 * subscription (currentPlanSql.ts: the latest created live one; live = active,
 * past_due, or a trial whose end, the later of current_period_end and
 * companies.trial_ends_at, is in the future), never through the vestigial
 * companies.plan_id. An expired trial, or a trial with no end date, grants
 * nothing. All three readers in
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
import { als } from '@/lib/als';
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
  trial: randomUUID(), // trial ending in the future
  trialExpired: randomUUID(),
  trialNoEnd: randomUUID(), // trial with no end date recorded: fail closed
  expiredTrialOverActive: randomUUID(), // older active grant, newer expired trial: the active one is current
  trialPeriodExpired: randomUUID(), // past current_period_end, no companies.trial_ends_at
  trialPeriodLive: randomUUID(), // future current_period_end (self-signup shape), no trial_ends_at
  trialExtended: randomUUID(), // past current_period_end, admin-extended future trial_ends_at
  staleTrialAfterCancelled: randomUUID(), // old expired grant trial, newer paying sub cancelled: nothing resurfaces
  tieHigherIdGrants: randomUUID(), // same created_at: the higher id is current
  tieLowerIdGrants: randomUUID(),
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
  trialExpired: false,
  trialNoEnd: false,
  expiredTrialOverActive: true,
  trialPeriodExpired: false,
  trialPeriodLive: true,
  trialExtended: true,
  staleTrialAfterCancelled: false,
  tieHigherIdGrants: true,
  tieLowerIdGrants: false,
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
const sub = (
  company: string, plan: string, status: string, createdAt: string,
  extra: { id?: string; periodEnd?: string } = {}
) =>
  q(
    `INSERT INTO subscriptions (id, company_id, plan_id, status, created_at, current_period_end)
     VALUES (COALESCE($1::uuid, gen_random_uuid()), $2, $3, $4, $5::timestamptz, $6::timestamptz)`,
    [extra.id ?? null, company, plan, status, createdAt, extra.periodEnd ?? null]
  );
/** companies.trial_ends_at per company; absent means NULL. */
const TRIAL_ENDS: Partial<Record<keyof typeof co, string>> = {
  trial: '2999-01-01',
  trialExpired: '2020-01-01',
  expiredTrialOverActive: '2020-01-01',
  trialExtended: '2999-01-01',
  staleTrialAfterCancelled: '2020-01-01',
};
/** Subscription ids for the created_at tie: the higher id must win. */
const ID = {
  hi1: 'ffffffff-ffff-4fff-8fff-fffffffffff1', lo1: '00000000-0000-4000-8000-000000000001',
  hi2: 'ffffffff-ffff-4fff-8fff-fffffffffff2', lo2: '00000000-0000-4000-8000-000000000002',
};

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
      const name = (Object.keys(co) as Array<keyof typeof co>).find((k) => co[k] === id)!;
      const trialEnd = TRIAL_ENDS[name] ?? null;
      await q('INSERT INTO companies (id, name, plan_id, trial_ends_at) VALUES ($1, $2, $3, $4::timestamptz)', [
        id, `PlanSub ${tag}`, vestigial ? planGrant : null, trialEnd,
      ]);
    }
    await sub(co.active, planGrant, 'active', '2026-01-01');
    await sub(co.trial, planGrant, 'trial', '2026-01-01');
    await sub(co.trialExpired, planGrant, 'trial', '2026-01-01');
    await sub(co.trialNoEnd, planGrant, 'trial', '2026-01-01');
    await sub(co.expiredTrialOverActive, planGrant, 'active', '2026-01-01');
    await sub(co.expiredTrialOverActive, planGrant, 'trial', '2026-02-01');
    await sub(co.trialPeriodExpired, planGrant, 'trial', '2026-01-01', { periodEnd: '2020-01-01' });
    await sub(co.trialPeriodLive, planGrant, 'trial', '2026-01-01', { periodEnd: '2999-01-01' });
    await sub(co.trialExtended, planGrant, 'trial', '2026-01-01', { periodEnd: '2020-01-01' });
    await sub(co.staleTrialAfterCancelled, planGrant, 'trial', '2026-01-01');
    await sub(co.staleTrialAfterCancelled, planOther, 'cancelled', '2026-02-01');
    await sub(co.tieHigherIdGrants, planGrant, 'active', '2026-01-01', { id: ID.hi1 });
    await sub(co.tieHigherIdGrants, planOther, 'active', '2026-01-01', { id: ID.lo1 });
    await sub(co.tieLowerIdGrants, planGrant, 'active', '2026-01-01', { id: ID.lo2 });
    await sub(co.tieLowerIdGrants, planOther, 'active', '2026-01-01', { id: ID.hi2 });
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
    await q(`INSERT INTO company_users (company_id, user_id, role) VALUES ($1, $2, 'owner')`, [co.active, admin]);
    // Before the first query: the app pool is created lazily from this URL.
    vi.stubEnv('SERVICE_DATABASE_URL', await loginUrl(process.env.DATABASE_URL!, 'isaflow_service'));
  });

  afterAll(async () => {
    const ids = Object.values(flagIds);
    await q('DELETE FROM company_feature_overrides WHERE feature_id = ANY($1::uuid[])', [ids]);
    await q('DELETE FROM plan_features WHERE feature_id = ANY($1::uuid[])', [ids]);
    await q('DELETE FROM feature_flags WHERE id = ANY($1::uuid[])', [ids]);
    await q('DELETE FROM company_users WHERE company_id = ANY($1::uuid[])', [ALL]);
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

  describe('as app_user under RLS (a tenant request)', () => {
    /** Run `fn` on a client that is app_user, with `admin` as the signed-in member of co.active only. */
    async function asTenant<T>(fn: () => Promise<T>): Promise<T> {
      const client = await getPoolForTests().connect();
      try {
        await client.query('BEGIN');
        await client.query('SET LOCAL ROLE app_user');
        await client.query(`SELECT set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: admin })]);
        return await als.run({ client, userId: admin, claims: {} } as never, fn);
      } finally {
        await client.query('ROLLBACK');
        client.release();
      }
    }

    it('a member sees its own plan feature through all three readers', async () => {
      await asTenant(async () => {
        expect(await hasFeature(co.active, PLAN_FLAG)).toBe(true);
        expect((await getCompanyEffectiveFeatures(co.active)).find((r) => r.code === PLAN_FLAG)?.enabled).toBe(true);
        expect(await companiesWithFeature([co.active], PLAN_FLAG)).toEqual(new Set([co.active]));
      });
    });

    it('a company the user is not a member of yields no plan feature, though it has the same plan', async () => {
      await asTenant(async () => {
        expect(await hasFeature(co.pastDue, PLAN_FLAG)).toBe(false);
        expect((await getCompanyEffectiveFeatures(co.pastDue)).find((r) => r.code === PLAN_FLAG)?.enabled).toBe(false);
        expect(await companiesWithFeature([co.pastDue], PLAN_FLAG)).toEqual(new Set());
      });
    });
  });
});
