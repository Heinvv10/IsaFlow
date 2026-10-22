// tests/integration/s07b-app-pool-login-role.migration.int.test.ts
//
// Audit 2026-10-18 S-07b: migrations 910 (login roles, app_service policies)
// and 911 (member guards bind app_service; schema_migrations read-only to the
// app). Each applies twice as a NON-superuser postgres, as production's deploy
// runs, and each DO guard refuses the mutants it exists for.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { doBlock, fixture, migration, newIds, setup, teardown } from './s07b-app-pool-login-role.helpers';

const ids = newIds();
const M910 = migration('910_app_pool_login_roles.sql');
const M911 = migration('911_service_role_member_guards.sql');
const GUARD_910 = doBlock(M910, 'outside its allowlist');
const POLICIES_910 = doBlock(M910, `'app_service_' || r.cmd`);
const GUARD_911 = doBlock(M911, 'exempts every role but app_user');

beforeAll(() => setup(ids), 60000);
afterAll(() => teardown(ids, []));

/** Run `body` in a transaction on the fixture's own connection, always rolled back. */
async function rolledBack(body: (q: (text: string) => Promise<unknown>) => Promise<void>): Promise<void> {
  const c = await fixture.connect();
  try {
    await c.query('BEGIN');
    await body((text) => c.query(text));
  } finally {
    await c.query('ROLLBACK');
    c.release();
  }
}

describe('S-07b: migration 910', () => {
  it('gives app_service a policy for every command an app_user or PUBLIC policy admits, where app_user holds the privilege', async () => {
    // users is the case a table-level privilege test misses: 902 left app_user only column UPDATE.
    const users = await fixture.query(`SELECT polname FROM pg_policy WHERE polrelid = 'public.users'::regclass
      AND polname LIKE 'app\\_service\\_%' ORDER BY 1`);
    expect(users.rows.map((r) => r.polname)).toEqual(['app_service_select', 'app_service_update']);
    const missing = await fixture.query(`
      SELECT DISTINCT p.polrelid::regclass::text AS t, p.polcmd AS c FROM pg_policy p
       WHERE p.polpermissive AND p.polname NOT LIKE 'app\\_service\\_%'
         AND p.polrelid <> 'public.impersonation_sessions'::regclass
         AND (p.polroles = '{0}'::oid[] OR 'app_user'::regrole = ANY (p.polroles))
         AND NOT CASE p.polcmd
               WHEN 'r' THEN coalesce(pg_get_expr(p.polqual, p.polrelid), 'true') = 'false'
               WHEN 'd' THEN coalesce(pg_get_expr(p.polqual, p.polrelid), 'true') = 'false'
               WHEN 'a' THEN coalesce(pg_get_expr(p.polwithcheck, p.polrelid), 'true') = 'false'
               ELSE coalesce(pg_get_expr(p.polqual, p.polrelid), 'true') = 'false'
                    AND coalesce(pg_get_expr(p.polwithcheck, p.polrelid), pg_get_expr(p.polqual, p.polrelid), 'true') = 'false'
             END
         AND CASE p.polcmd WHEN 'd' THEN has_table_privilege('app_user', p.polrelid, 'DELETE')
               ELSE has_any_column_privilege('app_user', p.polrelid, CASE p.polcmd WHEN 'r' THEN 'SELECT'
                      WHEN 'a' THEN 'INSERT' WHEN 'w' THEN 'UPDATE' ELSE 'SELECT, INSERT, UPDATE' END)
                    OR (p.polcmd = '*' AND has_table_privilege('app_user', p.polrelid, 'DELETE')) END
         AND NOT EXISTS (SELECT 1 FROM pg_policy s WHERE s.polrelid = p.polrelid
                         AND 'app_service'::regrole = ANY (s.polroles) AND s.polcmd IN (p.polcmd, '*'))`);
    expect(missing.rows).toEqual([]);
  });

  it('opens nothing an app_user policy keeps shut, for each command (blind review M1)', async () => {
    await rolledBack(async (q) => {
      await q(`CREATE TABLE public.s07b_policy_probe (x int)`);
      await q(`ALTER TABLE public.s07b_policy_probe ENABLE ROW LEVEL SECURITY`);
      await q(`GRANT SELECT, INSERT, UPDATE, DELETE ON public.s07b_policy_probe TO app_user`);
      await q(`CREATE POLICY ins_never ON public.s07b_policy_probe FOR INSERT TO app_user WITH CHECK (false)`);
      await q(`CREATE POLICY upd_never ON public.s07b_policy_probe FOR UPDATE TO app_user USING (false)`);
      await q(`CREATE POLICY sel_ok ON public.s07b_policy_probe FOR SELECT TO app_user USING (x > 0)`);
      await q(POLICIES_910);
      const r = (await q(`SELECT array_agg(polname::text ORDER BY polname) AS p FROM pg_policy
        WHERE polrelid = 'public.s07b_policy_probe'::regclass AND polname LIKE 'app\\_service\\_%'`)) as { rows: Array<{ p: string[] }> };
      expect(r.rows[0]!.p).toEqual(['app_service_select']);
    });
  });

  it('re-applies, with 911, as a NON-superuser postgres, twice', async () => {
    await rolledBack(async (q) => {
      await q('ALTER ROLE postgres NOSUPERUSER');
      for (let i = 0; i < 2; i++) { await q(M910); await q(M911); }
      const r = (await q(`SELECT rolsuper FROM pg_roles WHERE rolname = current_user`)) as { rows: Array<{ rolsuper: boolean }> };
      expect(r.rows[0]!.rolsuper).toBe(false);
    });
  });

  it.each([
    ['isaflow_app granted an owner', 'GRANT migration_admin TO isaflow_app', /910: isaflow_app can reach role migration_admin/],
    ['isaflow_app granted app_service', 'GRANT app_service TO isaflow_app', /910: isaflow_app can reach role app_service/],
    ['isaflow_service granted migration_admin', 'GRANT migration_admin TO isaflow_service', /910: isaflow_service can reach role migration_admin/],
    ['app_user made BYPASSRLS', 'ALTER ROLE app_user BYPASSRLS', /which is superuser, BYPASSRLS/],
    ['app_service owning a table', 'CREATE TABLE s07b_mutant (x int); ALTER TABLE s07b_mutant OWNER TO app_service', /app_service, which owns objects/],
    ['isaflow_app INHERIT', 'ALTER ROLE isaflow_app INHERIT', /910: isaflow_app must be NOINHERIT/],
    ['isaflow_app inheriting app_user through the grant (PG 16)', `DO $$ BEGIN IF current_setting('server_version_num')::int >= 160000
      THEN EXECUTE 'REVOKE app_user FROM isaflow_app'; EXECUTE 'GRANT app_user TO isaflow_app WITH INHERIT TRUE';
      ELSE EXECUTE 'ALTER ROLE isaflow_app INHERIT'; END IF; END $$`, /910: isaflow_app must be NOINHERIT and must not inherit/],
  ])('910\'s guard refuses the mutant: %s', async (_, mutate, msg) => {
    await rolledBack(async (q) => {
      await q(mutate);
      await expect(q(GUARD_910)).rejects.toThrow(msg);
    });
  });
});

describe('S-07b: migration 911', () => {
  it.each([
    ['a trigger function in the old shape', `CREATE FUNCTION public.s07b_mutant_guard() RETURNS trigger LANGUAGE plpgsql AS $f$
      BEGIN IF current_user <> 'app_user' THEN RETURN NEW; END IF; RETURN NEW; END $f$`, /911: s07b_mutant_guard\(\) exempts every role but app_user/],
    ['app_user given schema_migrations back', 'GRANT DELETE ON public.schema_migrations TO app_user', /911: app_user .* can still write schema_migrations/],
  ])('911\'s guard refuses the mutant: %s', async (_, mutate, msg) => {
    await rolledBack(async (q) => {
      await q(mutate);
      await expect(q(GUARD_911)).rejects.toThrow(msg);
    });
  });
});
