/**
 * companiesWithFeature (one query for many companies, used by the OAuth consent
 * picker) must answer exactly what hasFeature answers per company: override
 * first, then the global flag (NULL counts as false), then the plan. Seeds one
 * company per branch.
 *
 * Both functions run on the app's pool logged in as isaflow_service, as the
 * consent page's getServerSideProps does in production (no request
 * transaction, so serviceDatabaseUrl()): company_feature_overrides and
 * companies are RLS-forced, and a superuser would see rows that role cannot.
 * Seeding and cleanup go through the harness's own connection.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { companiesWithFeature, hasFeature } from '@/modules/admin/services/featureFlagService';
import { assertLocalFixtureDbUrl } from './fixtureDbGuard';
import { fixture, loginUrl } from './s07b-app-pool-login-role.helpers';

const tag = randomUUID().slice(0, 8);
const LOCAL_FLAG = `zz_batch_parity_local_${tag}`;
const GLOBAL_FLAG = `zz_batch_parity_global_${tag}`;
const NULL_GLOBAL_FLAG = `zz_batch_parity_nullglobal_${tag}`;
const FLAGS: Array<[string, boolean | null]> = [[LOCAL_FLAG, false], [GLOBAL_FLAG, true], [NULL_GLOBAL_FLAG, null]];
const plan = randomUUID();
const admin = randomUUID();
const co = {
  overrideOn: randomUUID(),
  overrideOff: randomUUID(), // on the plan, overridden off
  planOnly: randomUUID(),
  nothing: randomUUID(),
};
const ALL = Object.values(co);
const flagIds: string[] = [];

describe.skipIf(!process.env.DATABASE_URL)('companiesWithFeature matches hasFeature', () => {
  beforeAll(async () => {
    // The s07b helpers' import already ran assertDisposable (isaflow_schema_fixture only).
    assertLocalFixtureDbUrl('DATABASE_URL', process.env.DATABASE_URL, ['isaflow_schema_fixture']);
    const q = (text: string, values: unknown[] = []) => fixture.query(text, values);
    await q(`INSERT INTO users (id, email, role, is_active) VALUES ($1, $2, 'super_admin', true)`, [admin, `${admin}@test.local`]);
    await q('INSERT INTO plans (id, code, name) VALUES ($1, $2, $3)', [plan, `zz_parity_${tag}`, 'Parity plan']);
    for (const [code, isGlobal] of FLAGS) {
      const r = await q('INSERT INTO feature_flags (code, name, is_global) VALUES ($1, $1, $2) RETURNING id', [code, isGlobal]);
      flagIds.push(String(r.rows[0]!.id));
    }
    for (const id of ALL) {
      const onPlan = id === co.overrideOff || id === co.planOnly;
      await q('INSERT INTO companies (id, name, plan_id) VALUES ($1, $2, $3)', [id, `Parity ${tag}`, onPlan ? plan : null]);
    }
    for (const featureId of flagIds) {
      await q('INSERT INTO plan_features (plan_id, feature_id) VALUES ($1, $2)', [plan, featureId]);
      await q(`INSERT INTO company_feature_overrides (company_id, feature_id, enabled, set_by)
        VALUES ($1, $3, true, $4), ($2, $3, false, $4)`, [co.overrideOn, co.overrideOff, featureId, admin]);
    }
    // Before the first query: the app pool is created lazily from this URL.
    vi.stubEnv('SERVICE_DATABASE_URL', await loginUrl(process.env.DATABASE_URL!, 'isaflow_service'));
  });

  afterAll(async () => {
    const q = (text: string, values: unknown[] = []) => fixture.query(text, values);
    await q('DELETE FROM company_feature_overrides WHERE feature_id = ANY($1::uuid[])', [flagIds]);
    await q('DELETE FROM plan_features WHERE feature_id = ANY($1::uuid[])', [flagIds]);
    await q('DELETE FROM feature_flags WHERE id = ANY($1::uuid[])', [flagIds]);
    await q('DELETE FROM companies WHERE id = ANY($1::uuid[])', [ALL]);
    await q('DELETE FROM plans WHERE id = $1', [plan]);
    await q('DELETE FROM users WHERE id = $1', [admin]);
    vi.unstubAllEnvs();
    await fixture.end();
  });

  it.each(FLAGS.map(([code]) => code))('agrees with hasFeature company by company (%s)', async (code) => {
    const batch = await companiesWithFeature(ALL, code);
    for (const id of ALL) expect(batch.has(id), id).toBe(await hasFeature(id, code));
  });

  it('answers each precedence branch as expected', async () => {
    const onByOverrideOrPlan = new Set([co.overrideOn, co.planOnly]);
    expect(await companiesWithFeature(ALL, LOCAL_FLAG)).toEqual(onByOverrideOrPlan);
    expect(await companiesWithFeature(ALL, NULL_GLOBAL_FLAG)).toEqual(onByOverrideOrPlan);
    expect(await companiesWithFeature(ALL, GLOBAL_FLAG)).toEqual(new Set([co.overrideOn, co.planOnly, co.nothing]));
  });

  it('answers nothing for an unknown flag or no companies', async () => {
    expect(await companiesWithFeature(ALL, `zz_missing_${tag}`)).toEqual(new Set());
    expect(await companiesWithFeature([], LOCAL_FLAG)).toEqual(new Set());
  });
});
