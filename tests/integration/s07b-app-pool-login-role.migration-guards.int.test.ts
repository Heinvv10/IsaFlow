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
const M916B = migration('916b_revoke_app_user_backfill_view.sql');
const M917 = migration('917_app_role_hardening.sql');
const PATCH_916 = doBlock(M916, 'expected exactly once');
const GUARD_916 = doBlock(M916, 'exempts every role but app_user');
const GUARD_917 = doBlock(M917, 'could no longer record migrations');
const GUARD_917B = doBlock(migration('917b_app_login_role_violations_views.sql'), "RAISE EXCEPTION '917b: %'");

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
      // app_service has no INSERT since 930; the guard, not the privilege, is under test.
      await q('GRANT INSERT ON company_users TO s07b_member_writer');
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
    // 917 names the first holder its unordered pg_roles scan meets: the grantee or a login inheriting it.
    ['app_user given DELETE on schema_migrations back', 'GRANT DELETE ON public.schema_migrations TO app_user',
      /917: (app_user|app_service|isaflow_service) .* can still write schema_migrations/],
    ['app_service given only TRUNCATE on schema_migrations', 'GRANT TRUNCATE ON public.schema_migrations TO app_service',
      /917: (app_service|isaflow_service) .* can still write schema_migrations/],
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

  // Production's shape (2026-10-23): app_user held SELECT on the backfill view, which 917 refuses. 916b revokes it.
  it('916b clears production\'s grant on the backfill view, so 917\'s guard passes', async () => {
    await rolledBack(async (q) => {
      await q('GRANT SELECT ON public.ap_payment_document_backfill_candidates TO app_user');
      await q('SAVEPOINT before_guard');
      await expect(q(GUARD_917)).rejects.toThrow(/917: view ap_payment_document_backfill_candidates runs as an RLS-bypassing owner/);
      await q('ROLLBACK TO SAVEPOINT before_guard');
      await q(M916B);
      await expect(q(GUARD_917)).resolves.toBeTruthy();
    });
  });

  // REVOKE by a runner holding the view without the grant option only warns; 916b must refuse, not leave it to 917.
  it('916b refuses when its runner could not revoke the grant', async () => {
    await rolledBack(async (q) => {
      await q('GRANT SELECT ON public.ap_payment_document_backfill_candidates TO app_user');
      await q('CREATE ROLE s07b_weak_runner NOLOGIN');
      await q('GRANT SELECT ON public.ap_payment_document_backfill_candidates TO s07b_weak_runner');
      await q('SET LOCAL ROLE s07b_weak_runner');
      await expect(q(M916B)).rejects.toThrow(/916b: app_user still holds a privilege on ap_payment_document_backfill_candidates; s07b_weak_runner could not revoke it/);
    });
  });

  // 917b: the deploy's check repeats 917's view rule, so a view a later migration adds as postgres is caught.
  it('917b: app_login_role_violations() names an owner-run view app_user may use, and 917b refuses it', async () => {
    const VIEW_ROW = 'view s07b_later_view runs as an RLS-bypassing owner and app_user may use it; set security_invoker or revoke app_user';
    await rolledBack(async (q) => {
      const rows = async () => ((await q(`SELECT public.app_login_role_violations(false) AS v`)) as { rows: Array<{ v: string }> }).rows.map((r) => r.v);
      expect(await rows()).toEqual([]);
      await q(`CREATE VIEW public.s07b_later_view AS SELECT id FROM public.customers;
        GRANT SELECT ON public.s07b_later_view TO app_user`);
      expect(await rows()).toEqual([VIEW_ROW]);
      await q('SAVEPOINT before_917b');
      await expect(q(GUARD_917B)).rejects.toThrow(`917b: ${VIEW_ROW}`);
      await q('ROLLBACK TO SAVEPOINT before_917b');
      await q('ALTER VIEW public.s07b_later_view SET (security_invoker = true)');
      expect(await rows()).toEqual([]);
    });
  });

  it.each(['refresh_customer_invoice_view_summary', 'refresh_customer_invoice_view_summary_if_due'])(
    'the matview refresh wrapper %s() runs for app_service only', async (fn) => {
      const r = await fixture.query(`SELECT r, has_function_privilege(r, $1, 'EXECUTE') AS x
        FROM unnest(ARRAY['app_user', 'isaflow_app', 'app_service', 'isaflow_service']) r ORDER BY r`, [`public.${fn}()`]);
      expect(r.rows).toEqual([
        { r: 'app_service', x: true }, { r: 'app_user', x: false }, { r: 'isaflow_app', x: false }, { r: 'isaflow_service', x: true },
      ]);
    });
});
