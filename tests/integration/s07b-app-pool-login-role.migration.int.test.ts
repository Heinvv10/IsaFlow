// tests/integration/s07b-app-pool-login-role.migration.int.test.ts
//
// Audit 2026-10-18 S-07b: migration 915 (login roles, app_service policies,
// public.app_login_role_violations()). It applies twice, with 916 and 917, as a
// NON-superuser postgres, as production's deploy runs, and its guard refuses
// every mutant it exists for. 916 and 917: ...migration-guards.int.test.ts;
// what app_service's policies drop: ...policies.int.test.ts.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { appLoginRoleViolations } from '../../scripts/check-app-login-roles';
import { closeSql, createSql } from '../../scripts/_pg';
import { doBlock, fixture, migration, newIds, rolledBack, setup, teardown } from './s07b-app-pool-login-role.helpers';

const ids = newIds();
const M915 = migration('915_app_pool_login_roles.sql');
const M916 = migration('916_service_role_member_guards.sql');
const M917 = migration('917_app_role_hardening.sql');
const GUARD_915 = doBlock(M915, "RAISE EXCEPTION '915: %'");

beforeAll(() => setup(ids), 60000);
afterAll(async () => { await closeSql(); await teardown(ids, []); });

describe('S-07b: migration 915', () => {
  it('re-applies, with 916 and 917, as a NON-superuser postgres, twice', async () => {
    await rolledBack(async (q) => {
      // The harness's postgres is a superuser (run.sh promotes it after migrating); production's is not.
      expect(((await q(`SELECT rolsuper FROM pg_roles WHERE rolname = current_user`)) as { rows: Array<{ rolsuper: boolean }> }).rows[0]!.rolsuper).toBe(true);
      await q('ALTER ROLE postgres NOSUPERUSER');
      for (let i = 0; i < 2; i++) { await q(M915); await q(M916); await q(M917); }
      const r = (await q(`SELECT rolsuper FROM pg_roles WHERE rolname = current_user`)) as { rows: Array<{ rolsuper: boolean }> };
      expect(r.rows[0]!.rolsuper).toBe(false);
    });
  });

  it.each([
    ['isaflow_app granted an owner', 'GRANT migration_admin TO isaflow_app', /915: isaflow_app can reach role migration_admin/],
    ['isaflow_app granted app_service', 'GRANT app_service TO isaflow_app', /915: isaflow_app can reach role app_service/],
    ['isaflow_service granted migration_admin', 'GRANT migration_admin TO isaflow_service', /915: isaflow_service can reach role migration_admin/],
    ['app_user made BYPASSRLS', 'ALTER ROLE app_user BYPASSRLS', /915: isaflow_app can reach app_user, which is superuser, BYPASSRLS/],
    ['app_user made CREATEROLE', 'ALTER ROLE app_user CREATEROLE', /915: isaflow_app can reach app_user, which is superuser, BYPASSRLS, CREATEROLE/],
    ['app_service made REPLICATION', 'ALTER ROLE app_service REPLICATION', /915: isaflow_service can reach app_service, which is superuser/],
    ['app_service owning a table', 'CREATE TABLE s07b_mutant (x int); ALTER TABLE s07b_mutant OWNER TO app_service', /app_service, which owns objects/],
    ['app_service owning a function', `CREATE FUNCTION public.s07b_mutant_fn() RETURNS int LANGUAGE sql AS 'SELECT 1';
      ALTER FUNCTION public.s07b_mutant_fn() OWNER TO app_service`, /app_service, which owns objects/],
    ['app_user owning a schema', 'CREATE SCHEMA s07b_mutant AUTHORIZATION app_user', /app_user, which owns objects/],
    ['app_service owning a type', `CREATE TYPE public.s07b_mutant_t AS (a int); ALTER TYPE public.s07b_mutant_t OWNER TO app_service`,
      /app_service, which owns objects/],
    ['app_user owning a database', 'ALTER DATABASE postgres OWNER TO app_user', /app_user, which owns objects/],
    ['isaflow_app INHERIT', 'ALTER ROLE isaflow_app INHERIT', /915: isaflow_app must be NOINHERIT/],
    ['isaflow_app inheriting app_user through the grant (PG 16)', `DO $$ BEGIN IF current_setting('server_version_num')::int >= 160000
      THEN EXECUTE 'REVOKE app_user FROM isaflow_app'; EXECUTE 'GRANT app_user TO isaflow_app WITH INHERIT TRUE';
      ELSE EXECUTE 'ALTER ROLE isaflow_app INHERIT'; END IF; END $$`, /915: isaflow_app must be NOINHERIT and must not inherit/],
    ['a table granted to PUBLIC', 'GRANT SELECT ON public.companies TO PUBLIC', /915: companies grants SELECT to PUBLIC/],
  ])('915\'s guard refuses the mutant: %s', async (_, mutate, msg) => {
    await rolledBack(async (q) => {
      expect(await q(GUARD_915)).toBeTruthy();
      await q(mutate);
      await expect(q(GUARD_915)).rejects.toThrow(msg);
    });
  });

  it('refuses a role in reach owning a table in ANOTHER database of the cluster (pg_shdepend)', async () => {
    const url = new URL(String(fixture.options.connectionString));
    url.pathname = '/postgres';
    const elsewhere = new pg.Client({ connectionString: url.toString() });
    await elsewhere.connect();
    try {
      await elsewhere.query('CREATE TABLE s07b_elsewhere (x int)');
      await elsewhere.query('ALTER TABLE s07b_elsewhere OWNER TO app_service');
      await rolledBack(async (q) => {
        expect(((await q(`SELECT count(*)::int AS n FROM pg_class WHERE relowner = 'app_service'::regrole`)) as { rows: Array<{ n: number }> }).rows[0]!.n).toBe(0);
        await expect(q(GUARD_915)).rejects.toThrow(/915: isaflow_service can reach app_service, which owns objects in this cluster/);
      });
    } finally {
      await elsewhere.query('DROP TABLE IF EXISTS s07b_elsewhere');
      await elsewhere.end();
    }
  });

  it('with the logins live, also requires the runbook\'s event trigger and reserved roles', async () => {
    await rolledBack(async (q) => {
      const v = async (): Promise<string[]> =>
        ((await q(`SELECT public.app_login_role_violations(true) AS v`)) as { rows: Array<{ v: string }> }).rows.map((r) => r.v);
      expect(await v()).toEqual([
        'event trigger refuse_app_pool_ddl is missing or disabled in this database (runbook step 2)',
        'isaflow_app is not in supautils.reserved_roles (runbook step 3b)',
        'isaflow_service is not in supautils.reserved_roles (runbook step 3b)',
      ]);
      await q(`CREATE FUNCTION public.s07b_refuse_ddl() RETURNS event_trigger LANGUAGE plpgsql AS $f$ BEGIN END $f$`);
      await q(`CREATE EVENT TRIGGER refuse_app_pool_ddl ON ddl_command_start EXECUTE FUNCTION public.s07b_refuse_ddl()`);
      // Where supautils is loaded (production's image) the setting is the server's and a session cannot
      // change it, so the two reserved-role rows stay; elsewhere it is a plain placeholder setting.
      const reservedRows = ['isaflow_app is not in supautils.reserved_roles (runbook step 3b)',
        'isaflow_service is not in supautils.reserved_roles (runbook step 3b)'];
      let settable = true;
      await q('SAVEPOINT reserved');
      try {
        await q(`SET LOCAL supautils.reserved_roles = 'supabase_admin, anon*, isaflow_app,isaflow_service'`);
        await q('RELEASE SAVEPOINT reserved');
      } catch (err) {
        expect(String(err)).toMatch(/cannot be changed now/);
        await q('ROLLBACK TO SAVEPOINT reserved');
        settable = false;
      }
      const rest = settable ? [] : reservedRows;
      expect(await v()).toEqual(rest);
      await q(`ALTER EVENT TRIGGER refuse_app_pool_ddl DISABLE`);
      expect(await v()).toEqual(['event trigger refuse_app_pool_ddl is missing or disabled in this database (runbook step 2)', ...rest]);
    });
  });

  it('the post-deploy check reports the same, and judges the logins live once either can log in', async () => {
    const url = new URL(String(fixture.options.connectionString));
    url.searchParams.set('sslmode', 'disable');
    const sql = createSql(url.toString());
    // setup() gave both logins LOGIN, as runbook step 3 does; the harness has neither runbook control.
    expect(await appLoginRoleViolations(sql)).toEqual([
      'event trigger refuse_app_pool_ddl is missing or disabled in this database (runbook step 2)',
      'isaflow_app is not in supautils.reserved_roles (runbook step 3b)',
      'isaflow_service is not in supautils.reserved_roles (runbook step 3b)',
    ]);
  });

  it('app_service_sync_policies() creates what a new table needs, and only that; the runner calls it', async () => {
    await rolledBack(async (q) => {
      await q(`CREATE TABLE public.s07b_policy_probe (x int)`);
      await q(`ALTER TABLE public.s07b_policy_probe ENABLE ROW LEVEL SECURITY`);
      await q(`GRANT SELECT, INSERT, UPDATE, DELETE ON public.s07b_policy_probe TO app_user`);
      await q(`CREATE POLICY ins_never ON public.s07b_policy_probe FOR INSERT TO app_user WITH CHECK (false)`);
      await q(`CREATE POLICY upd_never ON public.s07b_policy_probe FOR UPDATE TO app_user USING (false)`);
      await q(`CREATE POLICY sel_ok ON public.s07b_policy_probe FOR SELECT TO app_user USING (x > 0)`);
      await q(`CREATE POLICY upd_check_never ON public.s07b_policy_probe FOR UPDATE TO app_user USING (true) WITH CHECK (false)`);
      await q(`CREATE POLICY all_read_only ON public.s07b_policy_probe FOR ALL TO app_user USING (x > 0) WITH CHECK (false)`);
      const made = (await q(`SELECT public.app_service_sync_policies() AS n`)) as { rows: Array<{ n: number }> };
      expect(made.rows[0]!.n).toBe(2);
      const r = (await q(`SELECT array_agg(polname::text ORDER BY polname) AS p FROM pg_policy
        WHERE polrelid = 'public.s07b_policy_probe'::regclass AND polname LIKE 'app\\_service\\_%'`)) as { rows: Array<{ p: string[] }> };
      // all_read_only admits SELECT and DELETE only; nothing admits INSERT or UPDATE.
      expect(r.rows[0]!.p).toEqual(['app_service_delete', 'app_service_select']);
      expect(((await q(`SELECT public.app_service_sync_policies() AS n`)) as { rows: Array<{ n: number }> }).rows[0]!.n).toBe(0);
    });
  });

  it('nothing but the migration runner may run either function', async () => {
    const r = await fixture.query(`SELECT f, r, has_function_privilege(r, f, 'EXECUTE') AS x
      FROM unnest(ARRAY['public.app_service_sync_policies()', 'public.app_login_role_violations(boolean)']) f,
           unnest(ARRAY['app_user', 'app_service', 'isaflow_app', 'isaflow_service']) r`);
    expect(r.rows.filter((x) => x.x)).toEqual([]);
  });
});
