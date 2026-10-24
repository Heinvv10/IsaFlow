// tests/integration/companies-standing-columns.migration.int.test.ts
//
// Migration 936 takes INSERT, UPDATE, DELETE and TRUNCATE on companies away
// from the app roles, grants UPDATE back on every column but the 13 standing
// and billing columns, and adds a companies rule to
// app_pool_reach_violations() (920, 930, 932), which the migration and every
// deploy run. It applies twice, after 930 and 932, as a NON-superuser
// postgres, as production's deploy runs; also on companies owned by
// migration_admin, as production has it; and every rule refuses the re-grant
// it exists for. What 936 closes: companies-standing-columns.int.test.ts.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { closeSql, createSql } from '../../scripts/_pg';
import { appLoginRoleViolations } from '../../scripts/check-app-login-roles';
import { getAuthPool } from '@/lib/auth/authPool';
import { doBlock, fixture, migration, newIds, rolledBack, setup, teardown } from './s07b-app-pool-login-role.helpers';

const ids = newIds();
const M930 = migration('930_credential_membership_writes_off_app_pools.sql');
const M932 = migration('932_bureau_consent_links_off_app_pools.sql');
const M936 = migration('936_companies_standing_columns_off_app_pools.sql');
const GUARD = doBlock(M936, "RAISE EXCEPTION '936: %'");
const PREFLIGHT = doBlock(M936, 'which the code writes on it');
const LOCKED = ['status', 'suspended_at', 'suspended_reason', 'is_active', 'plan_id', 'trial_ends_at', 'stripe_customer_id',
  'payg_eligible', 'is_demo', 'fx_documents_enabled', 'metadata', 'billing_email', 'billing_contact'];

beforeAll(() => setup(ids), 60000);
afterAll(async () => { await closeSql(); await teardown(ids, [getAuthPool()]); });

type Q = (text: string) => Promise<unknown>;
const rows = async (q: Q, text: string) => ((await q(text)) as { rows: Array<Record<string, unknown>> }).rows;
const R = (who: string, what: string) => new RegExp(`936: ${who} \\(reachable from an app pool login\\) can ${what}`);
const APP = 'app_(service|user)';

/** Per privilege, the companies columns app_user holds, as has_column_privilege counts them. */
const held = (q: Q, priv: string) => rows(q, `SELECT a.attname AS col FROM pg_attribute a
  WHERE a.attrelid = 'public.companies'::regclass AND a.attnum > 0 AND NOT a.attisdropped
    AND has_column_privilege('app_user', 'public.companies', a.attnum, '${priv}') ORDER BY 1`)
  .then((r) => r.map((x) => String(x.col)));

describe('936: migration', () => {
  it('applies twice as a NON-superuser postgres from master\'s grants; 930, 932 and 936 re-apply; no violation after', async () => {
    await rolledBack(async (q) => {
      await q('GRANT SELECT, INSERT, UPDATE, DELETE ON public.companies TO app_user'); // master's state
      await q('ALTER ROLE postgres NOSUPERUSER');
      for (let i = 0; i < 2; i++) await q(M936);
      await q(M930);
      await q(M932);
      await q(M936);
      expect((await rows(q, 'SELECT rolsuper AS s FROM pg_roles WHERE rolname = current_user'))[0]!.s).toBe(false);
      expect(await rows(q, 'SELECT * FROM public.app_pool_reach_violations()')).toEqual([]);
      expect(await held(q, 'INSERT')).toEqual([]);
      expect((await held(q, 'UPDATE')).filter((c) => LOCKED.includes(c))).toEqual([]);
    });
  });

  it('applies on companies owned by migration_admin with its grants, as production has it', async () => {
    await rolledBack(async (q) => {
      await q('ALTER TABLE public.companies OWNER TO migration_admin');
      await q('SET LOCAL ROLE migration_admin');
      await q('GRANT SELECT, INSERT, UPDATE, DELETE ON public.companies TO app_user');
      await q('RESET ROLE');
      await q('ALTER ROLE postgres NOSUPERUSER');
      await q(M936);
      expect((await rows(q, 'SELECT rolsuper AS s FROM pg_roles WHERE rolname = current_user'))[0]!.s).toBe(false);
      expect(await rows(q, 'SELECT * FROM public.app_pool_reach_violations()')).toEqual([]);
      expect(await held(q, 'INSERT')).toEqual([]);
      expect((await held(q, 'UPDATE')).filter((c) => LOCKED.includes(c))).toEqual([]);
    });
  });

  it('leaves app_user SELECT on every column, UPDATE on every column but the 13, no INSERT, DELETE or TRUNCATE', async () => {
    const q: Q = (text) => fixture.query(text);
    const all = (await rows(q, `SELECT attname AS col FROM pg_attribute WHERE attrelid = 'public.companies'::regclass
      AND attnum > 0 AND NOT attisdropped ORDER BY 1`)).map((x) => String(x.col));
    expect(LOCKED.every((c) => all.includes(c))).toBe(true);
    expect(await held(q, 'SELECT')).toEqual(all);
    expect(await held(q, 'UPDATE')).toEqual(all.filter((c) => !LOCKED.includes(c)));
    expect(await held(q, 'INSERT')).toEqual([]);
    const t = await rows(q, `SELECT has_table_privilege('app_user', 'public.companies', 'DELETE') AS d,
      has_table_privilege('app_user', 'public.companies', 'TRUNCATE') AS t,
      has_table_privilege('app_user', 'public.companies', 'UPDATE') AS u`);
    expect(t).toEqual([{ d: false, t: false, u: false }]);
  });

  it.each([
    ['a status writable by app_user', 'GRANT UPDATE (status) ON public.companies TO app_user', R(APP, 'UPDATE companies\\.status')],
    ['a suspension liftable', 'GRANT UPDATE (suspended_at) ON public.companies TO app_service',
      R('app_service', 'UPDATE companies\\.suspended_at')],
    ['a plan movable by the login itself', 'GRANT UPDATE (plan_id) ON public.companies TO isaflow_app',
      R('isaflow_app', 'UPDATE companies\\.plan_id')],
    ['PAYG switchable by PUBLIC', 'GRANT UPDATE (payg_eligible) ON public.companies TO PUBLIC', R('\\w+', 'UPDATE companies\\.payg_eligible')],
    ['every column writable again', 'GRANT UPDATE ON public.companies TO app_user', R(APP, 'UPDATE companies\\.billing_contact')],
    ['a company insertable by column', 'GRANT INSERT (name) ON public.companies TO app_user', R(APP, 'INSERT companies\\.name')],
    ['a company insertable by PUBLIC', 'GRANT INSERT ON public.companies TO PUBLIC', R('\\w+', 'INSERT companies\\.')],
    ['a company deletable', 'GRANT DELETE ON public.companies TO app_user', R(APP, 'DELETE companies$')],
    ['companies truncatable', 'GRANT TRUNCATE ON public.companies TO isaflow_service', R('isaflow_service', 'TRUNCATE companies$')],
    ['a new column granted before anyone decided', `ALTER TABLE public.companies ADD COLUMN x936_new text;
      GRANT UPDATE (x936_new) ON public.companies TO app_user`, R(APP, 'UPDATE companies\\.x936_new')],
    // 932's and 930's rules are kept: one of each kind.
    ['932: a bureau consent writable', 'GRANT UPDATE (share_merchant_patterns) ON public.bureaus TO app_user',
      R(APP, 'UPDATE bureaus\\.share_merchant_patterns')],
    ['932: a link deletable', 'GRANT DELETE ON public.bureau_companies TO app_user', R(APP, 'DELETE bureau_companies$')],
    ['932: bureaus without row security', 'ALTER TABLE public.bureaus DISABLE ROW LEVEL SECURITY', /936: bureaus has no row security/],
    ['932: a trigger creatable', 'GRANT TRIGGER ON public.customers TO app_user', R(APP, 'TRIGGER customers$')],
    ['930: a PAT mintable', 'GRANT INSERT ON public.personal_access_tokens TO app_user', R(APP, 'INSERT personal_access_tokens\\.')],
    ['920: users.email writable', 'GRANT UPDATE (email) ON public.users TO app_user', R(APP, 'UPDATE users\\.email')],
    ['918: the verification tokens readable', 'GRANT SELECT ON public.auth_email_verification_tokens TO app_service',
      R('app_service', 'SELECT auth_email_verification_tokens')],
    ['930: an unreviewed definer', `CREATE FUNCTION public.c936_definer() RETURNS void LANGUAGE sql SECURITY DEFINER
      AS $f$ UPDATE public.companies SET status = 'active' $f$`,
    /936: c936_definer\(\) is a SECURITY DEFINER function not in app_definer_reviews/],
  ])('refuses the mutant: %s', async (_, mutate, msg) => {
    await rolledBack(async (q) => {
      await q(GUARD);
      await q(mutate);
      await expect(q(GUARD)).rejects.toThrow(msg);
    });
  });

  it('a materialized view readable is still refused (920)', async () => {
    await rolledBack(async (q) => {
      await q('CREATE MATERIALIZED VIEW public.c936_mv AS SELECT 1 AS x; GRANT SELECT ON public.c936_mv TO app_user');
      await expect(q(GUARD)).rejects.toThrow(R(APP, 'SELECT the materialized view c936_mv'));
    });
  });

  it.each([
    ['a new column nobody granted', 'ALTER TABLE public.companies ADD COLUMN x936_quiet text'],
    ['annual_turnover_cents, the self-declaration', 'GRANT UPDATE (annual_turnover_cents) ON public.companies TO app_user'],
    ['reading every column', 'GRANT SELECT ON public.companies TO app_user'],
  ])('allows what 936 leaves: %s', async (_, change) => {
    await rolledBack(async (q) => {
      await q(change);
      await q(GUARD);
    });
  });

  it.each([
    ['platform_admin, suspend and reactivate', 'REVOKE UPDATE ON public.companies FROM platform_admin',
      /936: platform_admin cannot UPDATE companies\.status, which the code writes on it/],
    ['platform_admin, create a company', 'REVOKE INSERT ON public.companies FROM platform_admin',
      /936: platform_admin cannot INSERT companies\.name/],
    ['platform_admin, the guarded reads', 'REVOKE SELECT ON public.companies FROM platform_admin',
      /936: platform_admin cannot SELECT companies\.id/],
    ['migration_admin, signup provisioning', 'REVOKE INSERT ON public.companies FROM migration_admin',
      /936: migration_admin cannot INSERT companies\.name/],
    ['the onboarding definer\'s owner', 'ALTER FUNCTION public.create_company_with_owner(jsonb) OWNER TO app_user',
      /936: app_user cannot INSERT companies\.name/],
    ['the onboarding definer gone', 'DROP FUNCTION public.create_company_with_owner(jsonb)',
      /936: create_company_with_owner\(jsonb\) is missing/],
    ['platform_admin under row security', 'ALTER ROLE platform_admin NOBYPASSRLS',
      /936: migration_admin and platform_admin must bypass row security/],
  ])('refuses a database where a writer of the 13 could not write: %s', async (_, mutate, msg) => {
    await rolledBack(async (q) => {
      await q(PREFLIGHT);
      await q(mutate);
      await expect(q(PREFLIGHT)).rejects.toThrow(msg);
    });
  });

  it('the deploy\'s check runs 936\'s rule', async () => {
    const url = new URL(String(fixture.options.connectionString));
    url.searchParams.set('sslmode', 'disable');
    const sql = createSql(url.toString());
    await fixture.query('GRANT UPDATE (suspended_at) ON public.companies TO app_service');
    try {
      expect(await appLoginRoleViolations(sql)).toContain(
        'app_service (reachable from an app pool login) can UPDATE companies.suspended_at');
    } finally {
      await fixture.query('REVOKE UPDATE (suspended_at) ON public.companies FROM app_service');
    }
    expect((await appLoginRoleViolations(sql))!.filter((v) => v.includes('reachable from an app pool login'))).toEqual([]);
  });
});
