/**
 * R-035 N1b (C, migration 883): who writes company_users and
 * company_invitations, census by TABLE over the source tree on disk.
 *
 * 883's guards judge two roles — app_user (withAuth requests) and
 * platform_admin (the admin portal) — and let every other role through: the
 * owners, migration_admin (invite accept, tenant provisioning), the deploy
 * role and the seed scripts. So a NEW writer is a new answer to "which role
 * does this write as, and is that the rule the app means?" — it fails here
 * until someone classifies it. Each pinned writer below was read (PR C
 * census, W1–W18).
 *
 * Migrations: every migration but 883 is judged for anything that would turn
 * the guards off or hand a write back — a trigger dropped, disabled or
 * altered; a guard function redefined, altered or dropped; any ALTER of
 * either table; a table grant on either; ALL TABLES grants; a role grant to
 * app_user or platform_admin; and any write to either (a migration, or a
 * definer function it adds, writes as the owner, unjudged). The ones before
 * 883 are pinned by name.
 */
import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { sourceFiles, stripComments, type SourceFile } from '../../helpers/sourceCensus';

const MIGRATIONS = 'scripts/migrations/sql/';
const OWN = '883_company_member_role_guard.sql';
const TABLE = String.raw`(?:only\s+)?(?:"?public"?\s*\.\s*)?"?company_(?:users|invitations)"?\b`;
const WRITE = [
  new RegExp(String.raw`\b(?:insert\s+into|update|delete\s+from|merge\s+into)\s+${TABLE}`, 'i'),
  /\btruncate\b[^;]*?\bcompany_(?:users|invitations)\b/i,
];
const LOCK = /\bfor\s+(?:no\s+key\s+update|key\s+share|update|share)\b/i;
const QUOTED = /['"`]company_(?:users|invitations)['"`]/;

export function violations(text: string, file = 'x.ts'): string[] {
  const code = stripComments(text, file);
  const out: string[] = [];
  if (WRITE.some((re) => re.test(code))) out.push('writes');
  if (QUOTED.test(code)) out.push('names as a string');
  for (const chunk of code.split(/`/)) {
    if (/\bcompany_(?:users|invitations)\b/i.test(chunk) && LOCK.test(chunk)) out.push('locks');
  }
  return [...new Set(out)];
}

const GUARD_OFF = [
  /\b(?:drop|alter)\s+trigger\b[^;]*\bcompany_(?:users|invitations)_role_guard\b/i,
  /\b(?:create\s+(?:or\s+replace\s+)?|alter\s+|drop\s+)function\s+(?:if\s+exists\s+)?(?:"?public"?\.)?"?(?:company_users_role_guard|company_invitations_role_guard|company_member_actor_role|company_member_role_is_owner)\b/i,
  /\balter\s+table\s+(?:only\s+)?(?:if\s+exists\s+)?(?:"?public"?\.)?"?company_(?:users|invitations)"?\b/i,
  // A guard rewritten from its own definition at apply time (916) names neither CREATE nor the function together.
  /\bpg_get_functiondef\b[\s\S]*\bcompany_(?:users|invitations)_role_guard\b|\bcompany_(?:users|invitations)_role_guard\b[\s\S]*\bpg_get_functiondef\b/i,
];
const GRANTED = [
  /\bgrant\b[^;]*\bon\s+(?:table\s+)?(?:[\w".\s]+,\s*)*(?:"?public"?\.)?"?company_(?:users|invitations)\b[^;]*\bto\b/i,
  /\bgrant\b[^;]*\bon\s+all\s+tables\s+in\s+schema\s+"?public"?/i,
  /\bgrant\s+(?![^;]*\bon\b)[^;]*\bto\s+[^;]*\b(?:app_user|platform_admin)\b/i,
];

export function migrationViolations(text: string): string[] {
  const code = stripComments(text, 'm.sql');
  const out: string[] = [];
  if (GUARD_OFF.some((re) => re.test(code))) out.push('alters');
  if (GRANTED.some((re) => re.test(code))) out.push('grants');
  // A write in a migration runs as the owner, unjudged — and so does a SECURITY
  // DEFINER function a migration adds that writes either table (blind review
  // of PR #691, L4): both need reading.
  if (WRITE.some((re) => re.test(code))) out.push('writes');
  return out;
}

/** Every app writer, each read (PR C census; the role it writes as decides which rules apply). */
const KNOWN_WRITERS = [
  'pages/api/invitations/[token]/accept.ts: writes', // W9 invite accept — migration_admin pool, invitation's role
  'pages/api/invitations/index.ts: writes', // W7 second invitation system — migration_admin pool since S-07c (930), assertCanInvite
  'pages/api/invitations/revoke/[id].ts: writes', // W8 revoke — app_user
  'pages/api/invite/[token].ts: locks', // W10's invitation row, FOR UPDATE inside the accept transaction (S-07b review)
  'pages/api/invite/[token].ts: writes', // W10 /invite accept — migration_admin pool since S-07b (916), invitation's role
  'scripts/ci/userIdCastRules.ts: names as a string', // a lint's table list
  'scripts/acceptance/entity-onboarding-admin.ts: writes', // browser acceptance admin scenarios — throwaway DB via psql
  'scripts/acceptance/entity-onboarding-seed.ts: writes', // browser acceptance seed — throwaway DB via psql
  'scripts/acceptance/entity-onboarding-server.ts: names as a string', // browser acceptance: counts the four setup tables before and after a refused request (SELECT only, throwaway DB)
  'scripts/large-scale-seed.ts: writes', // W18 seed — postgres
  'scripts/provision-isademo2.ts: writes', // W18 demo provisioning — postgres
  'scripts/qa-check-demo-db.ts: names as a string', // read-only table list
  'scripts/qa-cleanup-run.ts: names as a string', // W18 QA cleanup by company — postgres
  'scripts/sandbox/reviewerSandboxIdentity.ts: writes', // fictional reviewer sandbox seed (docs/mcp/REVIEWER-SANDBOX.md)
  'scripts/stress-test.ts: writes', // W18 stress seed — postgres
  'src/modules/accounting/services/core/userAccessService.ts: locks', // S-04: the target's row, FOR UPDATE before the owner check — app_user
  'src/modules/accounting/services/core/userAccessService.ts: writes', // W1/W2 — app_user: role (930's one column grant) and removal
  'src/modules/accounting/services/core/userInvitationService.ts: locks', // assertCanInvite: the inviter's membership, FOR SHARE — migration_admin pool (S-07c)
  'src/modules/accounting/services/core/userInvitationService.ts: writes', // W3–W6 — migration_admin pool since S-07c (930), no auto-add; the cancel DELETE — app_user
  'src/modules/admin/services/adminUserActionsService.ts: writes', // W13–W14 delete-user, reset-onboarding — platform_admin; refused whole for a company's only owner (908b)
  'src/modules/admin/services/companyMembershipService.ts: locks', // the membership row, FOR UPDATE — platform_admin
  'src/modules/admin/services/companyMembershipService.ts: writes', // W11–W12 link, re-role, remove — platform_admin, last-owner rule
  'src/modules/onboarding/services/tenantProvisioningService.ts: writes', // W15 — migration_admin pool
];

/**
 * Before 883, each read: 220 and 251 seed memberships; 260 and 350 add
 * invitation columns; 293 is the one-off user-id repair; 348 enables RLS and
 * grants app_user; 352 grants platform_admin; 459, 476 and 513 are the
 * versions of create_company_with_owner (the creator as owner); 516 is
 * set_default_company (is_default only); 662 expires stale invitations once.
 * After: 886 re-writes both guards and adds their owner predicate (PR #691
 * review round 5, PR #693 reviews), read as 883 was; 908b re-writes the
 * member guard with two owner rules (S-04/S-08 follow-ups A and B); 916
 * re-writes both so app_service (S-07b's service pool) takes app_user's
 * rules, patching the exemption line in place (pg_get_functiondef), read as
 * 886 was; 930 (S-07c) revokes INSERT and UPDATE on both from app_user and
 * grants back only UPDATE (role) on company_users.
 */
const KNOWN_MIGRATIONS: Record<string, string[]> = {
  '220_multi_company_scoping.sql': ['writes'],
  '251_demo_seed_data.sql': ['writes'],
  '260_invitation_email_tracking.sql': ['alters'],
  '293_fix_admin_user_uuid.sql': ['writes'],
  '348_rls_and_auth_helpers.sql': ['alters', 'grants'],
  '350_invitations_gotrue_link.sql': ['alters'],
  '352_platform_admin_role.sql': ['grants'],
  '459_fix_company_create_rls.sql': ['writes'],
  '476_seed_company_taxonomy_on_create.sql': ['writes'],
  '513_create_company_writes_vat_system_type.sql': ['writes'],
  '516_set_default_company_fn.sql': ['writes'],
  '662_invite_token_encoding_retire_stale.sql': ['writes'],
  '886_company_member_role_guard_round5.sql': ['alters'],
  '908b_company_member_owner_rules.sql': ['alters'],
  '916_service_role_member_guards.sql': ['alters'],
  '930_credential_membership_writes_off_app_pools.sql': ['grants'],
};

const all = (() => { let cache: SourceFile[] | undefined; return () => (cache ??= sourceFiles()); })();
const isMigration = (file: string) => file.startsWith(MIGRATIONS) && file.endsWith('.sql');

describe('company_users / company_invitations writers (census by table)', () => {
  it('reads what it claims', () => {
    expect(all().length).toBeGreaterThan(3000);
    expect(all().some((f) => f.file === 'src/modules/accounting/services/core/userAccessService.ts')).toBe(true);
  });

  it('every app writer is one of the classified ones', () => {
    const found = all()
      .filter(({ file }) => !isMigration(file))
      .flatMap(({ file, text }) => violations(text, file).map((why) => `${file}: ${why}`))
      .sort();
    expect(found).toEqual([...KNOWN_WRITERS].sort());
  });

  it('no migration but 883 and the pinned others turns the guards off or grants a write', () => {
    const found = Object.fromEntries(all()
      .filter(({ file }) => isMigration(file) && path.basename(file) !== OWN)
      .map(({ file, text }) => [path.basename(file), migrationViolations(text)] as const)
      .filter(([, why]) => why.length > 0));
    expect(found).toEqual(KNOWN_MIGRATIONS);
  });
});

describe('the census detects (counterexamples)', () => {
  it.each([
    ['an UPDATE of a role', "sql`UPDATE company_users SET role = 'owner' WHERE user_id = ${u}`", 'writes'],
    ['a quoted, qualified INSERT', 'sql`INSERT INTO "public"."company_invitations" (role) VALUES (${r})`', 'writes'],
    ['a TRUNCATE of a list', "pool.query('TRUNCATE companies, company_users')", 'writes'],
    ['a lock', 'sql`SELECT 1 FROM company_users WHERE id = ${i} FOR UPDATE`', 'locks'],
    ['a dynamic name', "for (const t of ['company_users']) await sql.unsafe(`DELETE FROM ${t}`)", 'names as a string'],
  ])('%s', (_label, text, why) => {
    expect(violations(text)).toContain(why);
  });

  it.each([
    'CREATE FUNCTION f() RETURNS void LANGUAGE sql SECURITY DEFINER AS $$ UPDATE company_users SET role = $1 $$;',
    'DROP TRIGGER company_users_role_guard ON company_users;',
    'ALTER TABLE company_users DISABLE TRIGGER company_users_role_guard;',
    'ALTER TABLE public.company_invitations DISABLE TRIGGER ALL;',
    'CREATE OR REPLACE FUNCTION public.company_users_role_guard() RETURNS trigger AS $$ BEGIN RETURN NEW; END $$ LANGUAGE plpgsql;',
    'ALTER FUNCTION company_member_actor_role(uuid) SECURITY DEFINER;',
    "CREATE OR REPLACE FUNCTION public.company_member_role_is_owner(p_role text) RETURNS bool LANGUAGE sql AS $$ SELECT false $$;",
    'GRANT TRUNCATE ON company_users TO app_user;',
    'GRANT INSERT ON public.company_invitations TO anon;',
    'GRANT ALL ON ALL TABLES IN SCHEMA public TO app_user;',
    'GRANT migration_admin TO platform_admin;',
    "DO $$ BEGIN EXECUTE replace(pg_get_functiondef('public.company_users_role_guard()'::regprocedure), 'x', 'y'); END $$;",
  ])('a later migration: %s', (stmt) => {
    expect(migrationViolations(stmt)).not.toEqual([]);
  });

  it('and passes a read-only migration', () => {
    expect(migrationViolations('SELECT role FROM company_users WHERE false;')).toEqual([]);
  });
});
