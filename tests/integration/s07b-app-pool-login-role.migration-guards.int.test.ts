// tests/integration/s07b-app-pool-login-role.migration-guards.int.test.ts
//
// Audit 2026-10-18 S-07b: migrations 916 (the member guards bind app_service)
// and 917 (schema_migrations read-only to the app, owner-run views, definer
// search paths). Each DO guard refuses the mutants it exists for. 915:
// ...migration.int.test.ts.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { doBlock, fixture, migration, newIds, rolledBack, setup, teardown } from './s07b-app-pool-login-role.helpers';

const ids = newIds();
const M916 = migration('916_service_role_member_guards.sql');
const M917 = migration('917_app_role_hardening.sql');
const PATCH_916 = doBlock(M916, 'expected exactly once');
const GUARD_916 = doBlock(M916, 'exempts every role but app_user');
const GUARD_917 = doBlock(M917, 'could no longer record migrations');

beforeAll(() => setup(ids), 60000);
afterAll(() => teardown(ids, []));

describe('S-07b: migration 916', () => {
  it.each([
    ['twice', 2, `IF current_user <> 'app_user' THEN RETURN NEW; END IF; IF current_user <> 'app_user' THEN RETURN NEW; END IF;`],
    ['not at all', 0, `IF current_user = 'platform_admin' THEN RETURN NEW; END IF;`],
  ])('patches a guard only where it holds the exemption line exactly once: refuses one holding it %s', async (_, n, body) => {
    await rolledBack(async (q) => {
      await q(`CREATE OR REPLACE FUNCTION public.company_users_role_guard() RETURNS trigger LANGUAGE plpgsql AS $f$
        BEGIN ${body} RETURN NEW; END $f$`);
      await expect(q(PATCH_916)).rejects.toThrow(new RegExp(`916: company_users_role_guard\\(\\) holds the exemption line ${n} time`));
    });
  });

  it('leaves a guard that already binds app_service as it is (a rewrite that merged the binding)', async () => {
    await rolledBack(async (q) => {
      const md5 = `SELECT md5(prosrc) AS m FROM pg_proc WHERE oid = 'public.company_users_role_guard()'::regprocedure`;
      const before = (await q(md5)) as { rows: Array<{ m: string }> };
      await q(PATCH_916);
      expect(((await q(md5)) as { rows: Array<{ m: string }> }).rows[0]!.m).toBe(before.rows[0]!.m);
    });
  });

  // The patch binds app_service holders but leaves a superuser or BYPASSRLS role exempt, as every role but
  // app_user was: pg_has_role(.., 'app_service', ..) is true for every superuser and for a BYPASSRLS member.
  it.each([
    ['a BYPASSRLS role holding app_service stays exempt', 'BYPASSRLS', null],
    ['a superuser without BYPASSRLS stays exempt', 'SUPERUSER NOBYPASSRLS', null],
    ['the same role without BYPASSRLS is bound', 'NOBYPASSRLS', /^Only owners and admins can change the members of a company$/],
  ])('%s', async (_, attr, refusal) => {
    await rolledBack(async (q) => {
      await q(`CREATE ROLE s07b_member_writer NOLOGIN ${attr}`);
      await q('GRANT app_service TO s07b_member_writer');
      await q('SET LOCAL ROLE s07b_member_writer');
      const write = q(`INSERT INTO company_users (company_id, user_id, role) VALUES ('${ids.other}', '${ids.me}', 'viewer')`);
      if (refusal) await expect(write).rejects.toThrow(refusal);
      else await expect(write).resolves.toBeTruthy();
    });
  });

  it.each([
    ['a trigger function in the old shape', `CREATE FUNCTION public.s07b_mutant_guard() RETURNS trigger LANGUAGE plpgsql AS $f$
      BEGIN IF current_user <> 'app_user' THEN RETURN NEW; END IF; RETURN NEW; END $f$`, /916: s07b_mutant_guard\(\) exempts every role but app_user/],
    ['the old shape spelled !=', `CREATE FUNCTION public.s07b_mutant_neq() RETURNS trigger LANGUAGE plpgsql AS $f$
      BEGIN IF current_user != 'app_user' THEN RETURN NEW; END IF; RETURN NEW; END $f$`, /916: s07b_mutant_neq\(\) exempts every role/],
    ['the old shape spelled IS DISTINCT FROM, on current_role', `CREATE FUNCTION public.s07b_mutant_idf() RETURNS trigger LANGUAGE plpgsql AS $f$
      BEGIN IF (current_role IS DISTINCT FROM 'app_user') THEN RETURN NEW; END IF; RETURN NEW; END $f$`, /916: s07b_mutant_idf\(\) exempts every role/],
    ['the old shape spelled the other way round', `CREATE FUNCTION public.s07b_mutant_rev() RETURNS trigger LANGUAGE plpgsql AS $f$
      BEGIN IF 'app_user' <> current_user THEN RETURN NEW; END IF; RETURN NEW; END $f$`, /916: s07b_mutant_rev\(\) exempts every role/],
  ])('916\'s guard refuses the mutant: %s', async (_, mutate, msg) => {
    await rolledBack(async (q) => {
      await q(GUARD_916);
      await q(mutate);
      await expect(q(GUARD_916)).rejects.toThrow(msg);
    });
  });
});

describe('S-07b: migration 917', () => {
  it('refuses settings rows with no company, which security_invoker would hide', async () => {
    const block = doBlock(M917, 'accounting_settings holds rows with no company_id');
    await rolledBack(async (q) => {
      await q(`ALTER TABLE public.accounting_settings ALTER COLUMN company_id DROP NOT NULL`);
      await q(`INSERT INTO public.accounting_settings (company_id, key, value) VALUES (NULL, 's07b_global', '1')`);
      await expect(q(block)).rejects.toThrow(/917: accounting_settings holds rows with no company_id/);
    });
  });

  it.each([
    ['an owner-run view app_user may read', `CREATE VIEW public.s07b_mutant_view AS SELECT id FROM public.customers;
      GRANT SELECT ON public.s07b_mutant_view TO app_user`, /917: view s07b_mutant_view runs as an RLS-bypassing owner/],
    ['app_user given DELETE on schema_migrations back', 'GRANT DELETE ON public.schema_migrations TO app_user',
      /917: app_user .* can still write schema_migrations/],
    ['app_service given only TRUNCATE on schema_migrations', 'GRANT TRUNCATE ON public.schema_migrations TO app_service',
      /917: app_service .* can still write schema_migrations/],
    ['a definer app_user can run without pg_temp last', `CREATE FUNCTION public.s07b_mutant_definer() RETURNS int LANGUAGE sql
      SECURITY DEFINER SET search_path = public AS $f$ SELECT 1 $f$; GRANT EXECUTE ON FUNCTION public.s07b_mutant_definer() TO app_user`,
    /917: definer function s07b_mutant_definer\(\) runs for app_user without pg_temp last/],
    // The runner also writes through the roles it belongs to (migration_admin, platform_admin), as 917 judges it.
    ['a runner that lost INSERT on schema_migrations', `ALTER ROLE postgres NOSUPERUSER;
      REVOKE INSERT ON public.schema_migrations FROM postgres, migration_admin, platform_admin`,
      /917: postgres \(running this migration\) could no longer record migrations/],
    ['a runner that lost UPDATE on schema_migrations', `ALTER ROLE postgres NOSUPERUSER;
      REVOKE UPDATE ON public.schema_migrations FROM postgres, migration_admin, platform_admin`,
      /917: postgres \(running this migration\) could no longer record migrations/],
  ])('917\'s guard refuses the mutant: %s', async (_, mutate, msg) => {
    await rolledBack(async (q) => {
      await q(GUARD_917);
      await q(mutate);
      await expect(q(GUARD_917)).rejects.toThrow(msg);
    });
  });

  it('the matview refresh wrapper runs for app_service only', async () => {
    const r = await fixture.query(`SELECT r, has_function_privilege(r, 'public.refresh_customer_invoice_view_summary()', 'EXECUTE') AS x
      FROM unnest(ARRAY['app_user', 'isaflow_app', 'app_service', 'isaflow_service']) r ORDER BY r`);
    expect(r.rows).toEqual([
      { r: 'app_service', x: true }, { r: 'app_user', x: false }, { r: 'isaflow_app', x: false }, { r: 'isaflow_service', x: true },
    ]);
  });
});
