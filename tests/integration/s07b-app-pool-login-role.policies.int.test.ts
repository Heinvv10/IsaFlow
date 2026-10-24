// tests/integration/s07b-app-pool-login-role.policies.int.test.ts
//
// Audit 2026-10-18 S-07b: what app_service holds. Migration 915 gives it, per
// table, a USING (true) policy for each command an app_user (or PUBLIC)
// policy admits. That drops EVERY predicate of the policy it mirrors, so it is
// safe only while each app_user predicate is one injected SQL can satisfy
// anyway by forging its claims (request.jwt.claims, app.current_company_id).
// This suite pins every predicate that is not, so one that limits rows by
// their state (a status, a date, a flag) cannot arrive unreviewed.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { fixture, newIds, setup, teardown } from './s07b-app-pool-login-role.helpers';

const ids = newIds();
beforeAll(() => setup(ids), 60000);
afterAll(() => teardown(ids, []));

// Predicates a session satisfies by setting its own claims; any table prefix.
const FORGEABLE: RegExp[] = [
  /(\w+\.)?company_id IN \( SELECT company_users\.company_id FROM company_users WHERE \(company_users\.user_id = auth\.uid\(\)\)\)/g,
  /(\w+\.)?id IN \( SELECT company_users\.company_id FROM company_users WHERE \(company_users\.user_id = auth\.uid\(\)\)\)/g,
  /(\w+\.)?company_id = app\.current_company_id\(\)/g,
  /(\w+\.)?company_id IN \( SELECT auth\.user_companies\(\) AS user_companies\)/g,
  /(\w+\.)?(company_id|id) IN \( SELECT auth\.user_admin_companies\(\) AS user_admin_companies\)/g,
  /company_id = \(current_setting\('app\.current_company_id'::text, true\)\)::uuid/g,
  /(user_id|owner_user_id|verified_by|proposed_by|decided_by|\((id|user_id|owner_user_id)\)::text) = auth\.uid\(\)/g,
  /company_id = \( SELECT s\.c FROM \( SELECT app\.current_company_id\(\) AS c\) s WHERE audit_snapshot_reader\(s\.c\)\)/g,
  /session_id = \(\(NULLIF\(current_setting\('request\.jwt\.claims'::text, true\), ''::text\)\)::jsonb ->> 'session_id'::text\)/g,
];

/** `expr` with every forgeable predicate folded away: 'T' when nothing else is left. */
function residue(expr: string | null): string {
  let e = expr ?? 'T';
  for (let prev = ''; prev !== e;) {
    prev = e;
    for (const re of FORGEABLE) e = e.replace(re, 'T');
    e = e.replace(/\(\s*T\s*\)/g, 'T').replace(/T AND T/g, 'T').replace(/T OR T/g, 'T');
  }
  return e;
}

// Every app_user/PUBLIC policy with a predicate claims cannot satisfy, and why
// app_service's USING (true) on the same commands grants nothing a forger lacks.
const REVIEWED: Record<string, string> = {
  'bank_transaction_attachments.tenant_isolation_via_parent': 'tenant through the parent row; the FK requires the parent',
  'payroll_batch_lines.tenant_isolation_via_parent': 'tenant through the parent row; the FK requires the parent',
  'portal_payment_links.tenant_isolation_via_parent': 'tenant through the parent row; the FK requires the parent',
  'procurement_documents.tenant_isolation_via_parent': 'tenant through the parent row, plus six entity_type values: a service path could write another entity_type, data only, no reach',
  'company_invitations.invites_by_token': 'SELECT only; invites_tenant admits the same rows to forged claims',
  'oauth_apps.oauth_apps_dynamic_read': 'SELECT only; oauth_apps_owner (ALL) admits every row to a forged owner id',
  'entity_changes.entity_changes_read': 'SELECT only; the CASE is the caller\'s company role, which forged claims of an owner satisfy',
  'bureaus.bureaus_owner_member_read': 'SELECT only (932); membership is a bureau_users row with user_id = auth.uid(), which forged claims of a member satisfy; the service pool reads every bureau, as the bureau routes do',
};

describe('S-07b: app_service\'s policies drop only forgeable predicates', () => {
  it('every app_user/PUBLIC predicate is a forgeable claim, or reviewed above', async () => {
    const r = await fixture.query(`
      SELECT c.relname || '.' || p.polname AS name,
             regexp_replace(pg_get_expr(p.polqual, p.polrelid), '\\s+', ' ', 'g') AS q,
             regexp_replace(pg_get_expr(p.polwithcheck, p.polrelid), '\\s+', ' ', 'g') AS w
        FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND p.polname NOT LIKE 'app\\_service\\_%'
         AND (p.polroles = '{0}' OR 'app_user'::regrole = ANY (p.polroles))`);
    expect(r.rows.length).toBeGreaterThan(200);
    const residual = r.rows
      .filter((p) => [p.q, p.w].some((e: string | null) => !['T', 'true', 'false'].includes(residue(e))))
      .map((p) => p.name as string).sort();
    expect(residual).toEqual(Object.keys(REVIEWED).sort());
  });

  it('the folding is not vacuous: a state predicate survives it', () => {
    expect(residue(`((company_id = app.current_company_id()) AND ((status)::text = 'draft'::text))`)).not.toBe('T');
    expect(residue(`(company_id IN ( SELECT auth.user_companies() AS user_companies))`)).toBe('T');
  });

  it('pins app_service\'s commands on tables whose answer is known by hand', async () => {
    const r = await fixture.query(`SELECT t, coalesce((SELECT string_agg(polcmd::text, '' ORDER BY polcmd) FROM pg_policy
        WHERE polrelid = t::regclass AND 'app_service'::regrole = ANY (polroles)), '') AS cmds
      FROM unnest(ARRAY['users', 'companies', 'gl_journal_entries', 'flow_bundles', 'impersonation_sessions',
                        'entity_changes', 'audit_snapshots', 'company_invitations', 'approval_requests',
                        'company_users', 'personal_access_tokens', 'oauth_apps', 'oauth_authorisation_codes',
                        'oauth_authorisations', 'waitlist_signups', 'portal_magic_links', 'portal_contacts',
                        'share_links', 'audit_portal_sessions', 'capture_whatsapp_claims', 'capture_inboxes',
                        'bank_feed_connections']) t`);
    expect(Object.fromEntries(r.rows.map((x) => [x.t, x.cmds]))).toEqual({
      users: 'rw',                    // 902: app_user selects and updates columns; no insert or delete
      companies: 'rw',                // app_user creates no company (the definer does)
      gl_journal_entries: 'adrw',
      flow_bundles: 'r',              // bundles_no_tenant_writes is `false`
      impersonation_sessions: '',     // excluded: no service path reads it
      entity_changes: 'r',            // the forensic log: app_user only reads it
      audit_snapshots: 'r',           // written by the definer only
      company_invitations: 'dr',      // 930: written on the migration_admin pool; a cancel deletes
      approval_requests: 'r',         // 872: writes only through the definer functions
      // 930: no app role inserts a credential or a membership. UPDATE stays only
      // where a column grant came back: the bearer last-used stamp. 937: nor
      // updates or removes a membership.
      company_users: 'r',
      personal_access_tokens: 'drw',
      oauth_apps: 'dr',               // the dynamic-client prune deletes
      oauth_authorisation_codes: 'dr',
      oauth_authorisations: 'drw',
      waitlist_signups: 'a',          // 930: the public form inserts; nothing reads it
      // 937: written on the migration_admin pool; UPDATE stays only for a
      // bearer's use stamps, DELETE where it only removes access.
      portal_magic_links: '',         // no privilege at all
      portal_contacts: 'dr',
      share_links: 'drw',             // the view counter
      audit_portal_sessions: 'drw',   // the auditor's last use
      capture_whatsapp_claims: 'dr',
      capture_inboxes: 'dr',
      bank_feed_connections: 'drw',   // the sync stamps
    });
  });

  it('app_service holds no direct table or column grant beyond what it inherits from app_user', async () => {
    // 918 took back users.email / updated_at (change-email, the erasure) and the verification
    // tokens (emailVerificationService): all now on the migration_admin pool.
    const t = await fixture.query(`SELECT c.relname, a.privilege_type FROM pg_class c, aclexplode(c.relacl) a
      WHERE a.grantee = 'app_service'::regrole ORDER BY 1, 2`);
    expect(t.rows).toEqual([]);
    const c = await fixture.query(`SELECT table_name, column_name, privilege_type FROM information_schema.column_privileges
      WHERE grantee = 'app_service' ORDER BY 1, 2`);
    expect(c.rows).toEqual([]);
  });
});
