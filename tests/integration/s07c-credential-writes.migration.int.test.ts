// tests/integration/s07c-credential-writes.migration.int.test.ts
//
// S-07c: migration 930 takes credential and membership writes away from the
// app pools and adds a rule per table to app_pool_reach_violations() (920),
// which the migration and every deploy (scripts/check-app-login-roles.ts) run.
// It applies twice, after 915-920, as a NON-superuser postgres, as production's
// deploy runs; 915 and 919 still re-apply after it; and every rule refuses the
// re-grant it exists for. What 930 closes: s07c-credential-writes.int.test.ts.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { closeSql, createSql } from '../../scripts/_pg';
import { appLoginRoleViolations } from '../../scripts/check-app-login-roles';
import { doBlock, fixture, migration, newIds, rolledBack, setup, teardown } from './s07b-app-pool-login-role.helpers';

const ids = newIds();
const BEFORE = ['915_app_pool_login_roles.sql', '915b_app_login_role_violations.sql', '916_service_role_member_guards.sql',
  '916b_revoke_app_user_backfill_view.sql', '917_app_role_hardening.sql', '917b_app_login_role_violations_views.sql',
  '918_users_email_off_service_pool.sql', '919_ar_view_summary_company_wrapper.sql', '920_app_pool_reach_violations.sql'].map(migration);
const M930 = migration('930_credential_membership_writes_off_app_pools.sql');
const GUARD_930 = doBlock(M930, "RAISE EXCEPTION '930: %'");
const PREFLIGHT_930 = doBlock(M930, 'which the S-07c code writes on it');

beforeAll(() => setup(ids), 60000);
afterAll(async () => { await closeSql(); await teardown(ids, []); });

type Q = (text: string) => Promise<unknown>;
const rows = async (q: Q, text: string) => ((await q(text)) as { rows: Array<Record<string, unknown>> }).rows;
const R = (who: string, what: string) => new RegExp(`930: ${who} \\(reachable from an app pool login\\) can ${what}`);
const APP = 'app_(service|user)';
/** A definer with no reviewed row (`sig` a regex-escaped signature). */
const D = (sig: string) => new RegExp(`930: ${sig} is a SECURITY DEFINER function not in app_definer_reviews`);

describe('S-07c: migration 930', () => {
  it('applies twice after 915-920 as a NON-superuser postgres, and 915-920 re-apply after it', async () => {
    await rolledBack(async (q) => {
      expect((await rows(q, 'SELECT rolsuper AS s FROM pg_roles WHERE rolname = current_user'))[0]!.s).toBe(true);
      await q('ALTER ROLE postgres NOSUPERUSER');
      for (let i = 0; i < 2; i++) for (const m of [...BEFORE, M930]) await q(m);
      expect((await rows(q, 'SELECT rolsuper AS s FROM pg_roles WHERE rolname = current_user'))[0]!.s).toBe(false);
      expect(await rows(q, 'SELECT * FROM public.app_pool_reach_violations()')).toEqual([]);
    });
  });

  it.each([
    ['PATs inserted by app_user', 'GRANT INSERT ON public.personal_access_tokens TO app_user', R(APP, 'INSERT personal_access_tokens\\.')],
    ['a PAT revivable', 'GRANT UPDATE (revoked_at) ON public.personal_access_tokens TO app_user', R(APP, 'UPDATE personal_access_tokens\\.revoked_at')],
    ['OAuth tokens re-keyable by PUBLIC', 'GRANT UPDATE (access_token_hash) ON public.oauth_authorisations TO PUBLIC',
      R('\\w+', 'UPDATE oauth_authorisations\\.access_token_hash')],
    ['OAuth grants inserted by app_service', 'GRANT INSERT ON public.oauth_authorisations TO app_service', R('app_service', 'INSERT oauth_authorisations\\.')],
    ['codes inserted by isaflow_service', 'GRANT INSERT ON public.oauth_authorisation_codes TO isaflow_service',
      R('isaflow_service', 'INSERT oauth_authorisation_codes\\.')],
    ['an OAuth app re-pointable', 'GRANT UPDATE (redirect_uris) ON public.oauth_apps TO app_user', R(APP, 'UPDATE oauth_apps\\.redirect_uris')],
    ['invitations by column', 'GRANT INSERT (company_id, email, role, invited_by, token, expires_at) ON public.company_invitations TO app_user',
      R(APP, 'INSERT company_invitations\\.')],
    ['an invitation re-pointable', 'GRANT UPDATE (email) ON public.company_invitations TO app_user', R(APP, 'UPDATE company_invitations\\.email')],
    ['memberships inserted', 'GRANT INSERT ON public.company_users TO app_user', R(APP, 'INSERT company_users\\.')],
    ['a membership movable', 'GRANT UPDATE (user_id) ON public.company_users TO app_user', R(APP, 'UPDATE company_users\\.user_id')],
    ['reset tokens readable', 'GRANT SELECT ON public.auth_password_reset_tokens TO app_user', R(APP, 'SELECT auth_password_reset_tokens\\.')],
    ['reset tokens deletable', 'GRANT DELETE ON public.auth_password_reset_tokens TO app_service', R('app_service', 'DELETE auth_password_reset_tokens$')],
    ['the stash re-targetable', 'GRANT UPDATE (target_user_id) ON public.admin_impersonation_stash TO app_user',
      R(APP, 'UPDATE admin_impersonation_stash\\.target_user_id')],
    ['the stash truncatable', 'GRANT TRUNCATE ON public.admin_impersonation_stash TO app_user', R(APP, 'TRUNCATE admin_impersonation_stash$')],
    ['the waitlist readable', 'GRANT SELECT (email) ON public.waitlist_signups TO app_user', R(APP, 'SELECT waitlist_signups\\.email')],
    ['a promoted signup insertable', 'GRANT INSERT (promoted_company_id) ON public.waitlist_signups TO app_user',
      R(APP, 'INSERT waitlist_signups\\.promoted_company_id')],
    ['the throttle state readable', 'GRANT SELECT ON public.matview_refresh_state TO app_service', R('app_service', 'SELECT matview_refresh_state\\.')],
    ['the waitlist without row security', 'ALTER TABLE public.waitlist_signups DISABLE ROW LEVEL SECURITY', /930: waitlist_signups has no row security/],
    ['memberships truncatable', 'GRANT TRUNCATE ON public.company_users TO app_user', R(APP, 'TRUNCATE company_users$')],
    ['PATs truncatable', 'GRANT TRUNCATE ON public.personal_access_tokens TO PUBLIC', R('\\w+', 'TRUNCATE personal_access_tokens$')],
    ['capture keys inserted', 'GRANT INSERT (company_id, label, key_hash, key_prefix) ON public.capture_api_keys TO app_user',
      R(APP, 'INSERT capture_api_keys\\.')],
    ['a capture key revivable', 'GRANT UPDATE (is_active) ON public.capture_api_keys TO app_service', R('app_service', 'UPDATE capture_api_keys\\.is_active')],
    ['a code re-openable', 'GRANT UPDATE (used_at) ON public.oauth_authorisation_codes TO app_user', R(APP, 'UPDATE oauth_authorisation_codes\\.used_at')],
    ['the stash deletable', 'GRANT DELETE ON public.admin_impersonation_stash TO app_user', R(APP, 'DELETE admin_impersonation_stash$')],
    ['the pre-491 reset tokens readable', 'GRANT SELECT ON public.password_reset_tokens TO app_user', R(APP, 'SELECT password_reset_tokens\\.')],
    ['a definer that mints, callable by app_user', `CREATE FUNCTION public.s07c_mint(u text) RETURNS void LANGUAGE sql SECURITY DEFINER
      AS $f$ INSERT INTO public.company_users (company_id, user_id, role) VALUES (gen_random_uuid(), u, 'owner') $f$;
      GRANT EXECUTE ON FUNCTION public.s07c_mint(text) TO app_user`, D('s07c_mint\\(text\\)')],
    ...([
      ['a quoted name', `INSERT INTO "company_users" (user_id) VALUES (u)`, 'company_users'],
      ['a comment between the keywords', `INSERT /* x */ INTO public.company_users (user_id) VALUES (u)`, 'company_users'],
      ['UPDATE ONLY, spaced schema', `UPDATE ONLY public . personal_access_tokens SET revoked_at = NULL WHERE user_id = u`, 'personal_access_tokens'],
      ['MERGE', `MERGE INTO public.capture_api_keys k USING (SELECT 1) s ON false WHEN NOT MATCHED THEN DO NOTHING`, 'capture_api_keys'],
      ['two comments around it', `/* a */ INSERT INTO public.company_users (user_id) VALUES (u) /* b */`, 'company_users'],
      ['a string that opens a comment', `PERFORM '/*'; INSERT INTO public.company_users (user_id) VALUES (u); PERFORM '*/'`, 'company_users'],
      ['a U& identifier', `INSERT INTO U&"\\0063ompany_users" (user_id) VALUES (u)`, 'company_users'],
    ] as const).map(([how, stmt, tbl]) => [`a definer that mints with ${how}`, `CREATE FUNCTION public.s07c_evade(u text) RETURNS void
      LANGUAGE plpgsql SECURITY DEFINER AS $f$ BEGIN ${stmt}; END $f$; GRANT EXECUTE ON FUNCTION public.s07c_evade(text) TO app_user`,
    D('s07c_evade\\(text\\)')] as [string, string, RegExp]),
    ['a definer that runs dynamic SQL', `CREATE FUNCTION public.s07c_dyn(t text) RETURNS void LANGUAGE plpgsql SECURITY DEFINER
      AS $f$ BEGIN EXECUTE format('DELETE FROM %I', t); END $f$; GRANT EXECUTE ON FUNCTION public.s07c_dyn(text) TO app_user`,
    D('s07c_dyn\\(text\\)')],
    ['a BEGIN ATOMIC body', `CREATE FUNCTION public.s07c_atomic(u text) RETURNS void LANGUAGE sql SECURITY DEFINER
      BEGIN ATOMIC INSERT INTO public.company_users (company_id, user_id, role) VALUES (gen_random_uuid(), u, 'owner'); END;
      GRANT EXECUTE ON FUNCTION public.s07c_atomic(text) TO app_user`, D('s07c_atomic\\(text\\)')],
    // Breaker round 4: a trigger function runs without EXECUTE, so every definer needs a row.
    ['a trigger-only definer', `CREATE FUNCTION public.s07c_trg() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
      AS $f$ BEGIN INSERT INTO public.company_users (company_id, user_id, role) VALUES (NEW.company_id, auth.uid(), 'owner'); RETURN NEW; END $f$;
      REVOKE ALL ON FUNCTION public.s07c_trg() FROM PUBLIC;
      CREATE TRIGGER s07c_trg AFTER INSERT ON public.customers FOR EACH ROW EXECUTE FUNCTION public.s07c_trg()`, D('s07c_trg\\(\\)')],
    ['a reviewed definer whose body changed', `CREATE OR REPLACE FUNCTION public.invite_token_company_name() RETURNS text LANGUAGE sql
      SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $f$ SELECT 'changed'::text $f$`,
    /930: invite_token_company_name\(\) is a SECURITY DEFINER function changed since its row in app_definer_reviews/],
    // Breaker round 5: settings outside the body change what a definer does.
    ...([
      ['search_path', `ALTER FUNCTION auth.set_default_company(uuid, uuid) SET search_path = pg_catalog, public, auth, pg_temp, public`],
      ['owner', `CREATE ROLE s07c_new_owner NOLOGIN; GRANT s07c_new_owner TO CURRENT_USER;
        ALTER FUNCTION auth.set_default_company(uuid, uuid) OWNER TO s07c_new_owner`],
      ['volatility', 'ALTER FUNCTION auth.set_default_company(uuid, uuid) STABLE'],
    ] as const).map(([what, alter]) => [`a reviewed definer whose ${what} changed`, alter,
      /930: auth\.set_default_company\(uuid,uuid\) is a SECURITY DEFINER function changed since its row in app_definer_reviews/] as [string, string, RegExp]),
    ['the review list writable', 'GRANT INSERT ON public.app_definer_reviews TO app_user', R(APP, 'INSERT app_definer_reviews\\.')],
    ['a definer in another schema', `CREATE SCHEMA s07c_other; CREATE FUNCTION s07c_other.mint(u text) RETURNS void LANGUAGE sql
      SECURITY DEFINER AS $f$ INSERT INTO public.company_invitations (email) VALUES (u) $f$;
      GRANT USAGE ON SCHEMA s07c_other TO app_user; GRANT EXECUTE ON FUNCTION s07c_other.mint(text) TO app_user`,
    D('s07c_other\\.mint\\(text\\)')],
    ['a definer that mints, callable through PUBLIC\'s default', `CREATE FUNCTION public.s07c_mint2() RETURNS void LANGUAGE sql
      SECURITY DEFINER AS $f$ UPDATE public.personal_access_tokens SET revoked_at = NULL $f$`,
    D('s07c_mint2\\(\\)')],
  ])('refuses the mutant: %s', async (_, mutate, msg) => {
    await rolledBack(async (q) => {
      await q(GUARD_930);
      await q(mutate);
      await expect(q(GUARD_930)).rejects.toThrow(msg);
    });
  });

  it.each([
    // A member's role, which 930 granted back, is a violation since 935 (s07d-credential-tables.migration).
    ['the bearer last-used stamp', 'GRANT UPDATE (last_used_at, last_used_ip) ON public.oauth_authorisations TO app_user'],
    ['a cancel', 'GRANT DELETE ON public.company_invitations TO app_user'],
    ['the capture-key last-used stamp', 'GRANT UPDATE (last_used_at) ON public.capture_api_keys TO app_user'],
    ['a definer once it is reviewed', `CREATE FUNCTION public.s07c_reviewed() RETURNS int LANGUAGE sql SECURITY DEFINER AS $f$ SELECT 1 $f$;
      GRANT EXECUTE ON FUNCTION public.s07c_reviewed() TO app_user;
      INSERT INTO public.app_definer_reviews VALUES ('s07c_reviewed()', 'nothing (test)', public.app_definer_hash('s07c_reviewed()'::regprocedure))`],
    ['a waitlist signup', 'GRANT INSERT (name, email) ON public.waitlist_signups TO app_user'],
  ])('allows what 930 grants back: %s', async (_, grant) => {
    await rolledBack(async (q) => {
      await q(grant);
      await q(GUARD_930);
    });
  });

  it.each([
    ['migration_admin, the PAT mint', 'REVOKE INSERT ON public.personal_access_tokens FROM migration_admin',
      /930: migration_admin cannot INSERT public\.personal_access_tokens/],
    ['migration_admin, the invitation refresh', 'REVOKE UPDATE ON public.company_invitations FROM migration_admin',
      /930: migration_admin cannot UPDATE public\.company_invitations/],
    ['migration_admin, the reset token read', 'REVOKE SELECT ON public.auth_password_reset_tokens FROM migration_admin',
      /930: migration_admin cannot SELECT public\.auth_password_reset_tokens/],
    ['platform_admin, suspension\'s revoke-all', 'REVOKE UPDATE ON public.oauth_authorisations FROM platform_admin',
      /930: platform_admin cannot UPDATE public\.oauth_authorisations/],
    ['migration_admin, the capture key mint', 'REVOKE INSERT ON public.capture_api_keys FROM migration_admin',
      /930: migration_admin cannot INSERT public\.capture_api_keys/],
    ['platform_admin, the waitlist promotion', 'REVOKE UPDATE ON public.waitlist_signups FROM platform_admin',
      /930: platform_admin cannot UPDATE public\.waitlist_signups/],
    ['the add-company definer\'s owner', `CREATE ROLE s07c_definer_owner NOLOGIN;
      ALTER FUNCTION public.create_company_with_owner(jsonb) OWNER TO s07c_definer_owner`,
    /930: the owner of create_company_with_owner\(jsonb\) cannot INSERT company_users/],
  ])('refuses a database where the moved writes could not run: %s', async (_, mutate, msg) => {
    await rolledBack(async (q) => {
      await q(PREFLIGHT_930);
      await q(mutate);
      await expect(q(PREFLIGHT_930)).rejects.toThrow(msg);
    });
  });

  // CI's fixture applies every migration on the branch: a definer added
  // without its reviewed row fails here, before it can stop a deploy.
  it('on the fixture as migrated, no violation; no reviewed row outlives its definer (renamed or dropped)', async () => {
    expect((await fixture.query('SELECT * FROM public.app_pool_reach_violations()')).rows).toEqual([]);
    expect((await fixture.query(`SELECT signature FROM public.app_definer_reviews r
      WHERE NOT EXISTS (SELECT 1 FROM pg_proc p WHERE p.prosecdef AND p.oid = to_regprocedure(r.signature))`)).rows).toEqual([]);
  });

  it('the deploy\'s check runs 930\'s rules', async () => {
    const url = new URL(String(fixture.options.connectionString));
    url.searchParams.set('sslmode', 'disable');
    const sql = createSql(url.toString());
    await fixture.query('GRANT INSERT ON public.personal_access_tokens TO app_service');
    try {
      expect(await appLoginRoleViolations(sql)).toContain(
        'app_service (reachable from an app pool login) can INSERT personal_access_tokens.token_hash');
    } finally {
      await fixture.query('REVOKE INSERT ON public.personal_access_tokens FROM app_service');
    }
    expect((await appLoginRoleViolations(sql))!.filter((v) => v.includes('reachable from an app pool login'))).toEqual([]);
  });

  it('the throttled refresh is a definer with pg_temp last; the old name delegates to it', async () => {
    const r = await fixture.query(`SELECT p.proname, p.prosecdef AS d, p.proconfig AS c, pg_get_function_result(p.oid) AS t,
        EXISTS (SELECT 1 FROM aclexplode(p.proacl) a WHERE a.grantee = 0) AS public
      FROM pg_proc p WHERE p.proname IN ('refresh_customer_invoice_view_summary', 'refresh_customer_invoice_view_summary_if_due')
      ORDER BY 1`);
    const config = ['search_path=pg_catalog, public, pg_temp'];
    expect(r.rows).toEqual([
      { proname: 'refresh_customer_invoice_view_summary', d: true, c: config, t: 'void', public: false },
      { proname: 'refresh_customer_invoice_view_summary_if_due', d: true, c: config, t: 'boolean', public: false },
    ]);
  });
});
