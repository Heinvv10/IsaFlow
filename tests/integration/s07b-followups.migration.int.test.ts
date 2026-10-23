// tests/integration/s07b-followups.migration.int.test.ts
//
// S-07b follow-ups: migrations 918 (users.email off app_service), 919 (the AR
// view-summary matview renamed, behind a company-filtered definer and a
// security_invoker view under its old name) and 920 (both rules as
// app_pool_reach_violations(), refused by the migration and by every deploy's
// check). They apply twice, after 915-917, as a NON-superuser postgres, as
// production's deploy runs. What they close: s07b-followups.int.test.ts.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { closeSql, createSql } from '../../scripts/_pg';
import { appLoginRoleViolations } from '../../scripts/check-app-login-roles';
import { doBlock, fixture, migration, newIds, rolledBack, setup, teardown } from './s07b-app-pool-login-role.helpers';

const ids = newIds();
const S07B = ['915_app_pool_login_roles.sql', '915b_app_login_role_violations.sql', '916_service_role_member_guards.sql',
  '917_app_role_hardening.sql'].map(migration);
const M918 = migration('918_users_email_off_service_pool.sql');
const M919 = migration('919_ar_view_summary_company_wrapper.sql');
const M920 = migration('920_app_pool_reach_violations.sql');
const GUARD_920 = doBlock(M920, "RAISE EXCEPTION '920: %'");

beforeAll(() => setup(ids), 60000);
afterAll(async () => { await closeSql(); await teardown(ids, []); });

type Q = (text: string) => Promise<unknown>;
const one = async <T>(q: Q, text: string): Promise<T> => ((await q(text)) as { rows: T[] }).rows[0]!;

describe('S-07b follow-ups: migrations 918, 919 and 920', () => {
  it('re-apply after 915-917 as a NON-superuser postgres, twice', async () => {
    await rolledBack(async (q) => {
      expect((await one<{ s: boolean }>(q, 'SELECT rolsuper AS s FROM pg_roles WHERE rolname = current_user')).s).toBe(true);
      await q('ALTER ROLE postgres NOSUPERUSER');
      for (let i = 0; i < 2; i++) for (const m of [...S07B, M918, M919, M920]) await q(m);
      expect((await one<{ s: boolean }>(q, 'SELECT rolsuper AS s FROM pg_roles WHERE rolname = current_user')).s).toBe(false);
    });
  });

  it('918 leaves migration_admin, which change-email and the erasure now write on, able to write users.email', async () => {
    await rolledBack(async (q) => {
      await q(M918);
      expect(await one(q, `SELECT has_column_privilege('migration_admin', 'public.users', 'email', 'UPDATE') AS e,
        has_column_privilege('app_service', 'public.users', 'email', 'UPDATE') AS s`)).toEqual({ e: true, s: false });
    });
  });

  it.each([
    ['users.email re-granted to app_service', 'GRANT UPDATE (email) ON public.users TO app_service', /920: app_service \(reachable from an app pool login\) can UPDATE users\.email/],
    ['users granted to isaflow_service', 'GRANT UPDATE ON public.users TO isaflow_service', /920: isaflow_service \(reachable from an app pool login\) can UPDATE users\.email/],
    ['users.email granted to app_user', 'GRANT UPDATE (email) ON public.users TO app_user', /920: app_(service|user) \(reachable from an app pool login\) can UPDATE users\.email/],
    ['users.email granted to PUBLIC', 'GRANT UPDATE (email) ON public.users TO PUBLIC', /920: \w+ \(reachable from an app pool login\) can UPDATE users\.email/],
    ['the matview re-granted to app_user', 'GRANT SELECT ON public.customer_invoice_view_summary_mv TO app_user',
      /920: app_(service|user) \(reachable from an app pool login\) can SELECT the materialized view customer_invoice_view_summary_mv/],
    ['one matview column granted to PUBLIC', 'GRANT SELECT (view_count) ON public.customer_invoice_view_summary_mv TO PUBLIC',
      /920: \w+ \(reachable from an app pool login\) can SELECT the materialized view customer_invoice_view_summary_mv/],
    ['a new matview, granted by 348\'s default privileges', 'CREATE MATERIALIZED VIEW public.s07b_mutant_mv AS SELECT 1 AS x',
      /920: app_(service|user) \(reachable from an app pool login\) can SELECT the materialized view s07b_mutant_mv/],
  ])('920 refuses the mutant: %s, and so does every deploy\'s check', async (_, mutate, msg) => {
    await rolledBack(async (q) => {
      await q(GUARD_920);
      await q(mutate);
      await expect(q(GUARD_920)).rejects.toThrow(msg);
    });
  });

  it('the deploy\'s check runs 920\'s rules', async () => {
    const url = new URL(String(fixture.options.connectionString));
    url.searchParams.set('sslmode', 'disable');
    const sql = createSql(url.toString());
    await fixture.query('GRANT UPDATE (email) ON public.users TO app_service');
    try {
      expect(await appLoginRoleViolations(sql)).toContain('app_service (reachable from an app pool login) can UPDATE users.email');
    } finally {
      await fixture.query('REVOKE UPDATE (email) ON public.users FROM app_service');
    }
    expect((await appLoginRoleViolations(sql))!.filter((v) => v.includes('reachable from an app pool login'))).toEqual([]);
  });

  it('919 renamed the matview and left a security_invoker view, readable by app_user only, under the old name', async () => {
    await rolledBack(async (q) => {
      expect(await one(q, `SELECT
          (SELECT relkind FROM pg_class WHERE oid = 'public.customer_invoice_view_summary_mv'::regclass) AS mv,
          (SELECT relkind FROM pg_class WHERE oid = 'public.customer_invoice_view_summary'::regclass) AS v,
          (SELECT reloptions FROM pg_class WHERE oid = 'public.customer_invoice_view_summary'::regclass) AS o,
          has_table_privilege('app_user', 'public.customer_invoice_view_summary', 'SELECT') AS sel,
          has_table_privilege('app_user', 'public.customer_invoice_view_summary', 'INSERT') AS ins`))
        .toEqual({ mv: 'm', v: 'v', o: ['security_invoker=true'], sel: true, ins: false });
    });
  });

  it('919\'s wrapper is a definer with pg_temp last, executable by app_user and not by PUBLIC', async () => {
    await rolledBack(async (q) => {
      await q(M919);
      expect(await one(q, `SELECT p.prosecdef AS d, p.proconfig AS c,
          has_function_privilege('app_user', p.oid, 'EXECUTE') AS app_user,
          EXISTS (SELECT 1 FROM aclexplode(p.proacl) a WHERE a.grantee = 0) AS public
        FROM pg_proc p WHERE p.oid = 'public.current_company_invoice_view_summary()'::regprocedure`))
        .toEqual({ d: true, c: ['search_path=pg_catalog, public, pg_temp'], app_user: true, public: false });
    });
  });
});
