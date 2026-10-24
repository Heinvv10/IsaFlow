// tests/integration/bureau-consent-links.migration.int.test.ts
//
// Migration 932 takes every write on bureaus, bureau_users and
// bureau_companies away from the app pools, puts bureaus and bureau_users
// under row security, and adds a rule per table to app_pool_reach_violations()
// (920, 930), which the migration and every deploy run. It applies twice,
// after 930, as a NON-superuser postgres, as production's deploy runs; 930
// still re-applies after it; and every rule refuses the re-grant it exists
// for. What 932 closes: bureau-consent-links.int.test.ts.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { closeSql, createSql } from '../../scripts/_pg';
import { appLoginRoleViolations } from '../../scripts/check-app-login-roles';
import { doBlock, fixture, migration, newIds, rolledBack, setup, teardown } from './s07b-app-pool-login-role.helpers';

const ids = newIds();
const M930 = migration('930_credential_membership_writes_off_app_pools.sql');
const M932 = migration('932_bureau_consent_links_off_app_pools.sql');
const GUARD_932 = doBlock(M932, "RAISE EXCEPTION '932: %'");
const PREFLIGHT_932 = doBlock(M932, 'which the bureau code writes on it');

beforeAll(() => setup(ids), 60000);
afterAll(async () => { await closeSql(); await teardown(ids, []); });

type Q = (text: string) => Promise<unknown>;
const rows = async (q: Q, text: string) => ((await q(text)) as { rows: Array<Record<string, unknown>> }).rows;
const R = (who: string, what: string) => new RegExp(`932: ${who} \\(reachable from an app pool login\\) can ${what}`);
const APP = 'app_(service|user)';

describe('932: migration', () => {
  it('applies twice as a NON-superuser postgres; 930 then 932 re-apply; no violation after', async () => {
    await rolledBack(async (q) => {
      await q('ALTER ROLE postgres NOSUPERUSER');
      for (let i = 0; i < 2; i++) await q(M932);
      await q(M930);
      await q(M932);
      expect((await rows(q, 'SELECT rolsuper AS s FROM pg_roles WHERE rolname = current_user'))[0]!.s).toBe(false);
      expect(await rows(q, 'SELECT * FROM public.app_pool_reach_violations()')).toEqual([]);
    });
  });

  it('leaves bureaus and bureau_users under row security, with only the read policies for app_user', async () => {
    const r = await fixture.query(`SELECT c.relname, c.relrowsecurity AS rls,
        (SELECT array_agg(p.policyname || ':' || p.cmd ORDER BY p.policyname) FROM pg_policies p
          WHERE p.tablename = c.relname AND 'app_user' = ANY (p.roles)) AS app_user_policies
      FROM pg_class c WHERE c.oid IN ('public.bureaus'::regclass, 'public.bureau_users'::regclass) ORDER BY 1`);
    expect(r.rows).toEqual([
      { relname: 'bureau_users', rls: true, app_user_policies: ['bureau_users_own_read:SELECT'] },
      { relname: 'bureaus', rls: true, app_user_policies: ['bureaus_owner_member_read:SELECT'] },
    ]);
  });

  it.each([
    ['consent writable by app_user', 'GRANT UPDATE (share_merchant_patterns) ON public.bureaus TO app_user',
      R(APP, 'UPDATE bureaus\\.share_merchant_patterns')],
    ['a bureau owner re-pointable', 'GRANT UPDATE (owner_user_id) ON public.bureaus TO app_service', R('app_service', 'UPDATE bureaus\\.owner_user_id')],
    ['bureaus insertable by PUBLIC', 'GRANT INSERT ON public.bureaus TO PUBLIC', R('\\w+', 'INSERT bureaus\\.')],
    ['a bureau deletable', 'GRANT DELETE ON public.bureaus TO app_user', R(APP, 'DELETE bureaus$')],
    ['bureaus truncatable', 'GRANT TRUNCATE ON public.bureaus TO isaflow_service', R('isaflow_service', 'TRUNCATE bureaus$')],
    ['a bureau joinable', 'GRANT INSERT (bureau_id, user_id, role) ON public.bureau_users TO app_user', R(APP, 'INSERT bureau_users\\.')],
    ['a membership movable', 'GRANT UPDATE (user_id) ON public.bureau_users TO app_user', R(APP, 'UPDATE bureau_users\\.user_id')],
    ['a membership deletable', 'GRANT DELETE ON public.bureau_users TO app_service', R('app_service', 'DELETE bureau_users$')],
    ['a link insertable', 'GRANT INSERT ON public.bureau_companies TO app_user', R(APP, 'INSERT bureau_companies\\.')],
    ['a link re-pointable', 'GRANT UPDATE (bureau_id) ON public.bureau_companies TO isaflow_app', R('isaflow_app', 'UPDATE bureau_companies\\.bureau_id')],
    ['an unlink by DELETE', 'GRANT DELETE ON public.bureau_companies TO app_user', R(APP, 'DELETE bureau_companies$')],
    ['links truncatable', 'GRANT TRUNCATE ON public.bureau_companies TO app_user', R(APP, 'TRUNCATE bureau_companies$')],
    ['the audit log readable', 'GRANT SELECT (actor_user_id) ON public.bureau_audit_log TO app_service',
      R('app_service', 'SELECT bureau_audit_log\\.actor_user_id')],
    ['the audit log forgeable', 'GRANT INSERT ON public.bureau_audit_log TO app_user', R(APP, 'INSERT bureau_audit_log\\.')],
    ['bureaus without row security', 'ALTER TABLE public.bureaus DISABLE ROW LEVEL SECURITY', /932: bureaus has no row security/],
    ['bureau_users without row security', 'ALTER TABLE public.bureau_users DISABLE ROW LEVEL SECURITY', /932: bureau_users has no row security/],
    ['bureau_companies without row security', 'ALTER TABLE public.bureau_companies DISABLE ROW LEVEL SECURITY',
      /932: bureau_companies has no row security/],
    // 930's rules are kept: one of each kind.
    ['930: a PAT mintable', 'GRANT INSERT ON public.personal_access_tokens TO app_user', R(APP, 'INSERT personal_access_tokens\\.')],
    ['930: the waitlist without row security', 'ALTER TABLE public.waitlist_signups DISABLE ROW LEVEL SECURITY',
      /932: waitlist_signups has no row security/],
    ['930: an unreviewed definer', `CREATE FUNCTION public.b932_definer() RETURNS void LANGUAGE sql SECURITY DEFINER
      AS $f$ UPDATE public.bureaus SET share_merchant_patterns = true $f$`,
    /932: b932_definer\(\) is a SECURITY DEFINER function not in app_definer_reviews/],
  ])('refuses the mutant: %s', async (_, mutate, msg) => {
    await rolledBack(async (q) => {
      await q(GUARD_932);
      await q(mutate);
      await expect(q(GUARD_932)).rejects.toThrow(msg);
    });
  });

  it.each([
    ['reading bureaus', 'GRANT SELECT ON public.bureaus TO app_user'],
    ['reading a client link', 'GRANT SELECT ON public.bureau_companies TO app_user'],
  ])('allows what 932 leaves: %s', async (_, grant) => {
    await rolledBack(async (q) => {
      await q(grant);
      await q(GUARD_932);
    });
  });

  it.each([
    ['migration_admin, the consent write', 'REVOKE UPDATE ON public.bureaus FROM migration_admin',
      /932: migration_admin cannot UPDATE public\.bureaus/],
    ['migration_admin, the link', 'REVOKE INSERT ON public.bureau_companies FROM migration_admin',
      /932: migration_admin cannot INSERT public\.bureau_companies/],
    ['migration_admin, the unlink', 'REVOKE DELETE ON public.bureau_companies FROM migration_admin',
      /932: migration_admin cannot DELETE public\.bureau_companies/],
    ['migration_admin, the audit row', 'REVOKE INSERT ON public.bureau_audit_log FROM migration_admin',
      /932: migration_admin cannot INSERT public\.bureau_audit_log/],
    ['migration_admin, the history', 'REVOKE SELECT ON public.bureau_audit_log FROM migration_admin',
      /932: migration_admin cannot SELECT public\.bureau_audit_log/],
    ['migration_admin, the live role read', 'REVOKE SELECT ON public.company_users FROM migration_admin',
      /932: migration_admin cannot SELECT public\.company_users/],
    ['platform_admin, bureau creation', 'REVOKE INSERT ON public.bureaus FROM platform_admin',
      /932: platform_admin cannot INSERT public\.bureaus/],
    ['migration_admin under row security', 'ALTER ROLE migration_admin NOBYPASSRLS',
      /932: migration_admin and platform_admin must bypass row security/],
  ])('refuses a database where the moved writes could not run: %s', async (_, mutate, msg) => {
    await rolledBack(async (q) => {
      await q(PREFLIGHT_932);
      await q(mutate);
      await expect(q(PREFLIGHT_932)).rejects.toThrow(msg);
    });
  });

  it('the deploy\'s check runs 932\'s rules', async () => {
    const url = new URL(String(fixture.options.connectionString));
    url.searchParams.set('sslmode', 'disable');
    const sql = createSql(url.toString());
    await fixture.query('GRANT UPDATE (share_merchant_patterns) ON public.bureaus TO app_service');
    try {
      expect(await appLoginRoleViolations(sql)).toContain(
        'app_service (reachable from an app pool login) can UPDATE bureaus.share_merchant_patterns');
    } finally {
      await fixture.query('REVOKE UPDATE (share_merchant_patterns) ON public.bureaus FROM app_service');
    }
    expect((await appLoginRoleViolations(sql))!.filter((v) => v.includes('reachable from an app pool login'))).toEqual([]);
  });
});
