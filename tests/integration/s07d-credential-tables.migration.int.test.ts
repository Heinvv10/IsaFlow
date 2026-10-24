// tests/integration/s07d-credential-tables.migration.int.test.ts
//
// S-07d: migration 937 takes the remaining credential, role and routing writes
// away from the app pools and adds a rule per table to
// app_pool_reach_violations() (920, 930, 932), which the migration and every
// deploy (scripts/check-app-login-roles.ts) run. It applies twice, after
// 915-936, as a NON-superuser postgres, as production's deploy runs; and every
// rule refuses the re-grant it exists for. What 937 closes:
// s07d-credential-tables.int.test.ts.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { closeSql, createSql } from '../../scripts/_pg';
import { appLoginRoleViolations } from '../../scripts/check-app-login-roles';
import { doBlock, fixture, migration, newIds, rolledBack, setup, teardown } from './s07b-app-pool-login-role.helpers';

const ids = newIds();
const BEFORE = ['915_app_pool_login_roles.sql', '915b_app_login_role_violations.sql', '916_service_role_member_guards.sql',
  '916b_revoke_app_user_backfill_view.sql', '917_app_role_hardening.sql', '917b_app_login_role_violations_views.sql',
  '918_users_email_off_service_pool.sql', '919_ar_view_summary_company_wrapper.sql', '920_app_pool_reach_violations.sql',
  '930_credential_membership_writes_off_app_pools.sql', '932_bureau_consent_links_off_app_pools.sql',
  '936_companies_standing_columns_off_app_pools.sql'].map(migration);
const M937 = migration('937_credential_tables_off_app_pools.sql');
const GUARD_937 = doBlock(M937, "RAISE EXCEPTION '937: %'");
const PREFLIGHT_937 = doBlock(M937, 'which the S-07d code writes on it');

beforeAll(() => setup(ids), 60000);
afterAll(async () => { await closeSql(); await teardown(ids, []); });

type Q = (text: string) => Promise<unknown>;
const rows = async (q: Q, text: string) => ((await q(text)) as { rows: Array<Record<string, unknown>> }).rows;
const R = (who: string, what: string) => new RegExp(`937: ${who} \\(reachable from an app pool login\\) can ${what}`);
const APP = 'app_(service|user)';

describe('S-07d: migration 937', () => {
  it('applies twice after 915-936 as a NON-superuser postgres', async () => {
    await rolledBack(async (q) => {
      await q('ALTER ROLE postgres NOSUPERUSER');
      for (let i = 0; i < 2; i++) for (const m of [...BEFORE, M937]) await q(m);
      expect((await rows(q, 'SELECT rolsuper AS s FROM pg_roles WHERE rolname = current_user'))[0]!.s).toBe(false);
      expect(await rows(q, 'SELECT * FROM public.app_pool_reach_violations()')).toEqual([]);
    });
  });

  it.each([
    ['a member\'s role writable again (930\'s grant)', 'GRANT UPDATE (role) ON public.company_users TO app_user', R(APP, 'UPDATE company_users\\.role')],
    ['magic links readable', 'GRANT SELECT (token) ON public.portal_magic_links TO app_service', R('app_service', 'SELECT portal_magic_links\\.token')],
    ['magic links insertable', 'GRANT INSERT ON public.portal_magic_links TO app_user', R(APP, 'INSERT portal_magic_links\\.')],
    ['magic links deletable', 'GRANT DELETE ON public.portal_magic_links TO app_user', R(APP, 'DELETE portal_magic_links$')],
    ['a portal contact re-addressable', 'GRANT UPDATE (email) ON public.portal_contacts TO app_user', R(APP, 'UPDATE portal_contacts\\.email')],
    ['portal contacts insertable', 'GRANT INSERT ON public.portal_contacts TO PUBLIC', R('\\w+', 'INSERT portal_contacts\\.')],
    ['an AR portal password settable', 'GRANT UPDATE (password_hash) ON public.portal_access TO app_user',
      R(APP, 'UPDATE portal_access\\.password_hash')],
    ['AR portal hashes readable by column', 'GRANT SELECT (password_hash) ON public.portal_access TO app_user',
      R(APP, 'SELECT public\\.portal_access\\.password_hash')],
    ['AR portal hashes readable by table', 'GRANT SELECT ON public.portal_access TO app_service',
      R('app_service', 'SELECT public\\.portal_access\\.password_hash')],
    ['an AR portal login revivable', 'GRANT UPDATE (is_active) ON public.portal_access TO app_user', R(APP, 'UPDATE portal_access\\.is_active')],
    ['share links insertable', 'GRANT INSERT ON public.share_links TO isaflow_service', R('isaflow_service', 'INSERT share_links\\.')],
    ['a share link revivable', 'GRANT UPDATE (revoked_at) ON public.share_links TO app_user', R(APP, 'UPDATE share_links\\.revoked_at')],
    ['auditor sessions insertable', 'GRANT INSERT ON public.audit_portal_sessions TO app_user', R(APP, 'INSERT audit_portal_sessions\\.')],
    ['an auditor session re-keyable', 'GRANT UPDATE (token_hash) ON public.audit_portal_sessions TO app_user',
      R(APP, 'UPDATE audit_portal_sessions\\.token_hash')],
    ['WhatsApp claims insertable', 'GRANT INSERT ON public.capture_whatsapp_claims TO app_user', R(APP, 'INSERT capture_whatsapp_claims\\.')],
    ['a capture inbox re-addressable', 'GRANT UPDATE (address) ON public.capture_inboxes TO app_user', R(APP, 'UPDATE capture_inboxes\\.address')],
    ['capture inboxes insertable', 'GRANT INSERT ON public.capture_inboxes TO app_service', R('app_service', 'INSERT capture_inboxes\\.')],
    ['a pairing revivable', 'GRANT UPDATE (is_active) ON public.bank_feed_connections TO app_user',
      R(APP, 'UPDATE bank_feed_connections\\.is_active')],
    ['pairings insertable', 'GRANT INSERT (id, company_id) ON public.bank_feed_connections TO app_user', R(APP, 'INSERT bank_feed_connections\\.')],
    ['share links truncatable', 'GRANT TRUNCATE ON public.share_links TO app_user', R(APP, 'TRUNCATE share_links$')],
    ['members removable', 'GRANT DELETE ON public.company_users TO app_user', R(APP, 'DELETE company_users$')],
    ['members insertable (930\'s rule kept)', 'GRANT INSERT (company_id, user_id, role) ON public.company_users TO app_user',
      R(APP, 'INSERT company_users\\.')],
    ['AR portal logins insertable', 'GRANT INSERT (client_id, email, password_hash, name) ON public.portal_access TO app_user',
      R(APP, 'INSERT portal_access\\.')],
    ['an AR portal login re-pointed at another company', 'GRANT UPDATE (company_id) ON public.portal_access TO app_service',
      R('app_service', 'UPDATE portal_access\\.company_id')],
    ['magic links re-openable', 'GRANT UPDATE (used_at) ON public.portal_magic_links TO app_user', R(APP, 'UPDATE portal_magic_links\\.used_at')],
    ['a WhatsApp claim re-keyable', 'GRANT UPDATE (token_hash) ON public.capture_whatsapp_claims TO app_user',
      R(APP, 'UPDATE capture_whatsapp_claims\\.token_hash')],
    ['936\'s rule kept: a company\'s standing writable', 'GRANT UPDATE (status) ON public.companies TO app_user',
      R(APP, 'UPDATE companies\\.status')],
    ['932\'s rule kept: bureau links insertable', 'GRANT INSERT ON public.bureau_companies TO app_user', R(APP, 'INSERT bureau_companies\\.')],
    ['930\'s rule kept: PATs insertable', 'GRANT INSERT ON public.personal_access_tokens TO app_user', R(APP, 'INSERT personal_access_tokens\\.')],
  ])('refuses the mutant: %s', async (_, mutate, msg) => {
    await rolledBack(async (q) => {
      await q(GUARD_937);
      await q(mutate);
      await expect(q(GUARD_937)).rejects.toThrow(msg);
    });
  });

  it.each([
    ['the share link view counter', 'GRANT UPDATE (view_count, last_viewed_at) ON public.share_links TO app_user'],
    ['the auditor session use stamp', 'GRANT UPDATE (last_used_at, use_count) ON public.audit_portal_sessions TO app_user'],
    ['the bank feed sync stamps', 'GRANT UPDATE (last_sync_status, scraper_version) ON public.bank_feed_connections TO app_user'],
    ['AR portal columns but the hash', 'GRANT SELECT (email, is_active) ON public.portal_access TO app_user'],
    ['removing a share link', 'GRANT DELETE ON public.share_links TO app_user'],
  ])('allows what 937 grants back: %s', async (_, grant) => {
    await rolledBack(async (q) => {
      await q(grant);
      await q(GUARD_937);
    });
  });

  it.each([
    ['the role change', 'REVOKE UPDATE ON public.company_users FROM migration_admin', /937: migration_admin cannot UPDATE public\.company_users/],
    ['the magic link read', 'REVOKE SELECT ON public.portal_magic_links FROM migration_admin',
      /937: migration_admin cannot SELECT public\.portal_magic_links/],
    ['the share link mint', 'REVOKE INSERT ON public.share_links FROM migration_admin', /937: migration_admin cannot INSERT public\.share_links/],
    ['the WhatsApp claim clean-up', 'REVOKE DELETE ON public.capture_whatsapp_claims FROM migration_admin',
      /937: migration_admin cannot DELETE public\.capture_whatsapp_claims/],
    ['the bank feed disconnect', 'REVOKE UPDATE ON public.bank_feed_connections FROM migration_admin',
      /937: migration_admin cannot UPDATE public\.bank_feed_connections/],
    ['row security bypass', 'ALTER ROLE migration_admin NOBYPASSRLS', /937: migration_admin must bypass row security/],
    ['the contact edit\'s RETURNING', 'REVOKE SELECT ON public.portal_contacts FROM migration_admin',
      /937: migration_admin cannot SELECT public\.portal_contacts/],
    ['the members guard predicate', 'REVOKE EXECUTE ON FUNCTION public.company_member_role_is_owner(text) FROM migration_admin, PUBLIC',
      /937: migration_admin cannot EXECUTE company_member_role_is_owner/],
  ])('refuses a database where the moved writes could not run: %s', async (_, mutate, msg) => {
    await rolledBack(async (q) => {
      await q(PREFLIGHT_937);
      await q(mutate);
      await expect(q(PREFLIGHT_937)).rejects.toThrow(msg);
    });
  });

  it('the deploy\'s check runs 937\'s rules', async () => {
    const url = new URL(String(fixture.options.connectionString));
    url.searchParams.set('sslmode', 'disable');
    const sql = createSql(url.toString());
    await fixture.query('GRANT UPDATE (role) ON public.company_users TO app_user');
    try {
      expect(await appLoginRoleViolations(sql)).toContain('app_user (reachable from an app pool login) can UPDATE company_users.role');
    } finally {
      await fixture.query('REVOKE UPDATE (role) ON public.company_users FROM app_user');
    }
    expect((await appLoginRoleViolations(sql))!.filter((v) => v.includes('reachable from an app pool login'))).toEqual([]);
  });
});
