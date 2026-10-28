/**
 * companiesWithFeature (one query for many companies, used by the OAuth consent
 * picker) must answer exactly what hasFeature answers per company: override
 * first, then the global flag, then the plan. Seeds one company per branch.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { sql } from '@/lib/neon';
import { companiesWithFeature, hasFeature } from '@/modules/admin/services/featureFlagService';
import { assertNotProductionDb } from '../helpers/assertNotProductionDb';
import { assertLocalFixtureDbUrl } from './fixtureDbGuard';

const tag = randomUUID().slice(0, 8);
const LOCAL_FLAG = `zz_batch_parity_local_${tag}`;
const GLOBAL_FLAG = `zz_batch_parity_global_${tag}`;
const plan = randomUUID();
const admin = randomUUID();
const co = {
  overrideOn: randomUUID(),
  overrideOff: randomUUID(), // on the plan, overridden off
  planOnly: randomUUID(),
  nothing: randomUUID(),
};
const ALL = Object.values(co);
const flagIds: Record<string, string> = {};

describe.skipIf(!process.env.DATABASE_URL)('companiesWithFeature matches hasFeature', () => {
  beforeAll(async () => {
    assertNotProductionDb('feature flag batch parity');
    assertLocalFixtureDbUrl('DATABASE_URL', process.env.DATABASE_URL, ['isaflow_test', 'isaflow_schema_fixture']);
    await sql`INSERT INTO users (id, email, role, is_active) VALUES (${admin}, ${`${admin}@test.local`}, 'super_admin', true)`;
    await sql`INSERT INTO plans (id, code, name) VALUES (${plan}::uuid, ${`zz_parity_${tag}`}, 'Parity plan')`;
    for (const [code, isGlobal] of [[LOCAL_FLAG, false], [GLOBAL_FLAG, true]] as const) {
      const rows = (await sql`
        INSERT INTO feature_flags (code, name, is_global) VALUES (${code}, ${code}, ${isGlobal}) RETURNING id
      `) as { id: string }[];
      flagIds[code] = String(rows[0]!.id);
    }
    for (const id of ALL) {
      const onPlan = id === co.overrideOff || id === co.planOnly;
      await sql`INSERT INTO companies (id, name, plan_id) VALUES (${id}::uuid, ${`Parity ${tag}`}, ${onPlan ? plan : null}::uuid)`;
    }
    for (const code of [LOCAL_FLAG, GLOBAL_FLAG]) {
      await sql`INSERT INTO plan_features (plan_id, feature_id) VALUES (${plan}::uuid, ${flagIds[code]}::uuid)`;
      await sql`
        INSERT INTO company_feature_overrides (company_id, feature_id, enabled, set_by)
        VALUES (${co.overrideOn}::uuid, ${flagIds[code]}::uuid, true, ${admin}::uuid),
               (${co.overrideOff}::uuid, ${flagIds[code]}::uuid, false, ${admin}::uuid)
      `;
    }
  });

  afterAll(async () => {
    const ids = Object.values(flagIds);
    await sql`DELETE FROM company_feature_overrides WHERE feature_id = ANY(${ids}::uuid[])`;
    await sql`DELETE FROM plan_features WHERE feature_id = ANY(${ids}::uuid[])`;
    await sql`DELETE FROM feature_flags WHERE id = ANY(${ids}::uuid[])`;
    await sql`DELETE FROM companies WHERE id = ANY(${ALL}::uuid[])`;
    await sql`DELETE FROM plans WHERE id = ${plan}::uuid`;
    await sql`DELETE FROM users WHERE id = ${admin}`;
  });

  it.each([LOCAL_FLAG, GLOBAL_FLAG])('agrees with hasFeature company by company (%s)', async (code) => {
    const batch = await companiesWithFeature(ALL, code);
    for (const id of ALL) expect(batch.has(id), id).toBe(await hasFeature(id, code));
  });

  it('answers each precedence branch as expected', async () => {
    expect(await companiesWithFeature(ALL, LOCAL_FLAG)).toEqual(new Set([co.overrideOn, co.planOnly]));
    expect(await companiesWithFeature(ALL, GLOBAL_FLAG)).toEqual(new Set([co.overrideOn, co.planOnly, co.nothing]));
  });

  it('answers nothing for an unknown flag or no companies', async () => {
    expect(await companiesWithFeature(ALL, `zz_missing_${tag}`)).toEqual(new Set());
    expect(await companiesWithFeature([], LOCAL_FLAG)).toEqual(new Set());
  });
});
