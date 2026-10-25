# Runbook: S-07b app pool login roles

Do the steps in this order, after 17:00 SAST on a weekday, with Hein's approval for each.

The PR that ships migrations 915, 915b, 916 and 917 creates the roles with no
password and no LOGIN, and every new env var falls back to `DATABASE_URL`, so
the app keeps logging in as today. These do take effect on deploy:

- POST /api/invite/[token] writes on the migration_admin pool, as
  /api/invitations/[token]/accept already did. In production the app now
  refuses to boot without `MIGRATION_ADMIN_DATABASE_URL` (prod has it).
- app_user can no longer write `schema_migrations` (917).
- The views `clients` and `app_settings` run as the caller (917,
  `security_invoker`): each request sees only its own company's rows through
  them. Some readers filtered by key only (drc-vat-export, budget exports,
  pdfShared) and could read another tenant's row before; a "missing setting"
  report after deploy is this, not a regression.
- Three definer functions get `pg_temp` last on their search path (917).
- The member guards bind app_service holders (916). Nothing logs in as one
  yet, so no request changes.
- Every migration run (deploy, parity gate on dev, `bun run db:migrate`) ends
  with `SELECT public.app_service_sync_policies()`, which makes app_service's
  policies match app_user's: it adds them for a table a migration added and
  drops them where a migration dropped or narrowed the policy they mirror.
- app_service's policies are the sync's alone. It drops a mirror whose source
  app_user policy is gone, and a hand-made policy that applies to app_service
  (any other name or shape) is reported by the deploy check below, which then
  stops the deploy until a person removes it. Give a service path access by
  an app_user policy, never by a policy for app_service.
- `scripts/deploy.sh`, right after the migrations and the drift audit and
  before the code switch, runs `scripts/check-app-login-roles.ts`:
  `public.app_login_role_violations()` as the owner. Any row stops the deploy
  there, with the old code still serving (no rollback runs; the migrations
  have applied, as when a migration fails). Once either login can log in
  (step 3 below) it also requires the event trigger (step 2) and the reserved
  roles (step 3b).
- Every boot in production writes `[env] S-07b: the request pool logs in as
  "postgres", not isaflow_app` to stderr until step 5 is done.

The follow-up PR (migrations 918 and 919, 2026-10-23) also takes effect on deploy:

- change-email, the POPIA erasure and the signup verification tokens
  (register, verify-email) run on the migration_admin pool, and app_service
  loses `UPDATE (email, updated_at)` on `users` and every grant on
  `auth_email_verification_tokens` (918), whose payload email verify-email
  writes into `users`. That
  closes 915's documented residual (a service-pool injection could rewrite any
  user's email). change-email now writes the profile first and calls GoTrue
  second: a GoTrue refusal leaves both emails as they were, a missing profile
  row answers 404, and an address another profile holds answers 409 before
  GoTrue is asked.
- The AR "last viewed" materialized view is renamed
  `customer_invoice_view_summary_mv` and no app role may read it (919). The old
  name is now a `security_invoker` view over
  `current_company_invoice_view_summary()`, which returns only the request's
  company, so the AR list, export and invoice-views drawer work unchanged, in
  the new code and in the old (during the deploy window and after a code-only
  rollback). 920 makes "no app login reaches `users.email` or a materialized
  view" a deploy check: `scripts/check-app-login-roles.ts` refuses the code
  switch on either from then on.
- `drc-vat-export` reads only its own company's `vat_rate`, and a failed read
  answers 500 instead of being swallowed.
- The deploy and the backup scripts read the owner URL from
  `/etc/isaflow/owner.env` first (step 5). Until that file exists they read
  `.env.local` as before, with a warning.

S-07c (migration 930, 2026-10-23) also takes effect on deploy:

- No app role may INSERT or UPDATE `personal_access_tokens`, `oauth_apps`,
  `oauth_authorisation_codes`, `oauth_authorisations`, `capture_api_keys`,
  `company_invitations` or `company_users`, except `company_users.role` (the
  members screen) and the last-used stamps on the three token tables.
  `auth_password_reset_tokens` and `admin_impersonation_stash` lose every app
  role grant. The code makes those writes on the migration_admin pool: PAT and
  capture-key create and revoke, every OAuth mint, refresh and revoke,
  invitation create, resend and send status, password reset, and the
  impersonation stash. The OAuth token endpoint checks a code or refresh token
  on the service pool first, so a bogus one never takes a migration_admin
  connection. 930 refuses to apply unless migration_admin holds those
  privileges and platform_admin keeps UPDATE on the token tables (admin
  suspension) and on `waitlist_signups` (promotion).
- An invitation never adds an existing account: every invitee gets a link and
  accepts it. The members screen says "Invitation sent" for everyone.
- `waitlist_signups` gets row security; the public form may only INSERT.
- The AR matview refresh runs at most once per 10 minutes and never twice at
  once, on the migration_admin pool only; the cron's answer says whether it
  refreshed.
- verify-email provisions a tenant only when GoTrue's address for the token's
  user equals the signup's.
- During the deploy window (930 applied, old code still serving) the old
  release's writes to those tables are refused (42501) and answer an error,
  minting nothing. That includes REVOKING: a user cannot revoke a PAT, a
  capture key or an OAuth app, or disconnect an OAuth app, until the new code
  is live; admin suspension (platform_admin) still revokes everything a user
  holds. Also refused: OAuth code exchange and refresh (connected MCP clients
  fail until the new code is live, then reconnect), invitation create,
  password reset, "Return to my session" after Login-as (the admin signs out
  instead), and the public waitlist form (its `RETURNING` needs SELECT: leads
  submitted in the window are lost), and the nightly AR "last viewed"
  refresh (the old cron calls it on the service pool, which may no longer;
  the summary stays a day stale). Reads, bearer and capture-key
  validation, invite acceptance and logins keep working.
- A code-only rollback leaves that state for as long as the old code runs. If
  it must run for more than an hour, re-grant the old writes by hand (as the
  owner), and expect `scripts/check-app-login-roles.ts` to refuse the next
  deploy until they are revoked again (re-run 930's REVOKE and column GRANT
  lines, and its `ENABLE ROW LEVEL SECURITY` on `waitlist_signups`):

  ```sql
  -- BREAK-GLASS, old code only: undoes 930's protection. Revert before deploying.
  GRANT INSERT, UPDATE ON public.personal_access_tokens, public.oauth_apps, public.oauth_authorisation_codes,
    public.oauth_authorisations, public.capture_api_keys, public.company_invitations TO app_user;
  GRANT SELECT, INSERT, UPDATE, DELETE ON public.auth_password_reset_tokens, public.admin_impersonation_stash TO app_user;
  GRANT SELECT ON public.waitlist_signups TO app_user;
  ALTER TABLE public.waitlist_signups DISABLE ROW LEVEL SECURITY;
  SELECT public.app_service_sync_policies();
  ```
Migration 932 (bureau consent and client links, 2026-10-24) also takes effect on deploy:

- No app role may INSERT, UPDATE, DELETE or TRUNCATE `bureaus`, `bureau_users`
  or `bureau_companies`; `bureau_audit_log` stays unreadable to them.
  `bureaus` and `bureau_users` get row security (owner or member reads a
  bureau). The sharing toggle and its history, and client link and unlink, run
  on the migration_admin pool; 932 grants migration_admin SELECT and INSERT on
  `bureau_audit_log` and refuses to apply unless migration_admin holds the
  bureau writes and platform_admin can still create bureaus (admin convert).
- During the deploy window, and after a code-only rollback, the old release's
  sharing toggle, client link and client unlink answer an error (42501),
  writing nothing. The old toggle already failed (no app role could write the
  audit log). Production had no bureau rows on 2026-10-24.
- If old code must run for more than an hour and needs bureau links:

  ```sql
  -- BREAK-GLASS, old code only: undoes 932's protection (reopens the consent forgery). Revert before deploying.
  GRANT INSERT, UPDATE, DELETE ON public.bureaus, public.bureau_users, public.bureau_companies TO app_user;
  ALTER TABLE public.bureaus DISABLE ROW LEVEL SECURITY;
  ALTER TABLE public.bureau_users DISABLE ROW LEVEL SECURITY;
  ```
  To revert, re-run 932 (it is idempotent). Until then every deploy's
  `app_pool_reach_violations()` check refuses the code switch.

Migration 937 (S-07d: the remaining credential tables, 2026-10-24) also takes effect on deploy:

- No app role may UPDATE or DELETE `company_users` (930 had kept `UPDATE (role)`):
  member role changes and removals run on the migration_admin pool, which
  re-checks the member guard's rules in TypeScript (`memberWrites.ts`).
- No app role may INSERT or UPDATE `portal_contacts`, `share_links`,
  `audit_portal_sessions`, `capture_whatsapp_claims`, `capture_inboxes` or
  `bank_feed_connections`, nor touch `portal_magic_links` at all, nor read
  `portal_access.password_hash` or write `portal_access` (DELETE stays).
  Granted back: `share_links (view_count, last_viewed_at)`,
  `audit_portal_sessions (last_used_at, use_count)`, and
  `bank_feed_connections`' sync stamps. `portal_access` gains `company_id`
  (backfilled from each login's customer): an AR portal login signs in only
  to that company, so a login created by hand from now on must set it, or it
  signs in nowhere (nothing in the app creates logins). 937 refuses to apply unless
  migration_admin holds the moved writes and bypasses row security.
- During the deploy window, and after a code-only rollback, the old release
  answers an error (42501), writing nothing, for: member role change and
  removal; AFS portal sign-in (no link is sent; an emailed link does not
  verify) and portal contact edits; AR portal login and customer merge (the
  merge rolls back); share link create and revoke; auditor session issue and
  revoke; capture email inbox mint and rotate, WhatsApp claim and
  verification, the IMAP mirror's inbox upsert; bank feed create and
  disconnect. Viewing a share link, an auditor's download, extension ingest
  and sync keep working. The revocations among these fail OPEN while old code
  runs (access that should end stays live); revoke by hand instead, as the
  owner, keyed on what the user asked to revoke:

  ```sql
  -- Emergency revocations while old code runs after 937 (each touches one row; check the count is 1).
  DELETE FROM public.company_users WHERE company_id = '<company>' AND user_id = '<user>' AND role <> 'owner';
  UPDATE public.share_links SET revoked_at = now(), revoked_by = '<operator>' WHERE id = '<link>' AND company_id = '<company>' AND revoked_at IS NULL;
  UPDATE public.audit_portal_sessions SET revoked_at = now() WHERE id = '<session>' AND company_id = '<company>' AND revoked_at IS NULL;
  UPDATE public.bank_feed_connections SET is_active = false, status = 'disconnected', updated_at = now() WHERE id = '<connection>' AND company_id = '<company>';
  UPDATE public.portal_contacts SET active = false, updated_at = now() WHERE id = '<contact>' AND company_id = '<company>';
  ```
- The old IMAP mirror cron fails on the inbox upsert for every scanned
  invoice and moves its cursor past the message, so mail scanned while old
  code ran after 937 is not captured (its document row is left `pending`).
  Recover it as soon as the new code is live, before many new scans: moving a
  cursor back re-scans EVERY message after that uid, and re-captures any of
  them the new code has captured since. Read-only first:

  ```sql
  -- Messages the old code refused, per connection.
  SELECT c.id, c.folder, c.scan_cursor, min(l.imap_uid::bigint) AS first_refused_uid, max(l.imap_uid::bigint) AS last_refused_uid
    FROM public.imap_mirror_connections c
    JOIN public.imap_mirror_scan_log l ON l.connection_id = c.id
   WHERE l.outcome = 'error' AND l.error LIKE 'permission denied for table capture_inboxes%'
   GROUP BY c.id;
  -- Messages the new code captured since, wholly or in part (each would be captured again by a cursor move).
  SELECT l.connection_id, l.imap_uid, l.outcome FROM public.imap_mirror_scan_log l
   WHERE l.outcome IN ('ingested', 'error') AND l.error IS DISTINCT FROM 'permission denied for table capture_inboxes'
     AND l.imap_uid::bigint > <first_refused_uid> AND l.connection_id = '<connection>';
  -- If that list is empty, take the connection out of the scan list (no new scan picks it up), wait
  -- until last_scan_at is over a minute old (a scan in flight would write its own cursor over yours),
  -- move the cursor to first_refused_uid - 1 only if still nothing was captured, then put it back:
  -- UPDATE public.imap_mirror_connections SET status = 'disconnected' WHERE id = '<connection>' AND status = 'active';
  -- UPDATE public.imap_mirror_connections c SET scan_cursor = jsonb_set(c.scan_cursor, '{<folder>}', '<uid>')
  --  WHERE c.id = '<connection>' AND NOT EXISTS (SELECT 1 FROM public.imap_mirror_scan_log l WHERE l.connection_id = c.id
  --    AND l.outcome IN ('ingested', 'error') AND l.error IS DISTINCT FROM 'permission denied for table capture_inboxes'
  --    AND l.imap_uid::bigint > <first_refused_uid>);
  -- UPDATE public.imap_mirror_connections SET status = 'active' WHERE id = '<connection>' AND status = 'disconnected';
  ```
  If it is not empty, do not move the cursor: ask the company to forward the
  refused emails to its capture address instead.
- After 937 the new code retries a message only when none of it was
  ingested. A message passed part-ingested (a database failure on its second
  or later attachment) keeps its first attachments and loses the rest; it is
  logged as an error. Find them with
  `SELECT connection_id, imap_uid, error, scanned_at FROM imap_mirror_scan_log
  WHERE outcome = 'error' AND attachment_count > 1 ORDER BY scanned_at DESC`, and
  recover the rest by forwarding the email to the company's capture address
  (a cursor move would capture the first attachments twice).
- The orphaned `pending` documents those failures left (a failure after a
  document row, before its event) are listed by
  `SELECT id FROM captured_documents d WHERE d.status = 'pending' AND NOT EXISTS
  (SELECT 1 FROM capture_events e WHERE e.captured_document_id = d.id)`.
- If old code must run for more than an hour and needs these:

  ```sql
  -- BREAK-GLASS, old code only: undoes 937's protection (reopens the forgeries). Revert before deploying.
  GRANT UPDATE (role), DELETE ON public.company_users TO app_user;
  GRANT SELECT, INSERT, UPDATE, DELETE ON public.portal_magic_links, public.portal_contacts, public.portal_access,
    public.share_links, public.audit_portal_sessions, public.capture_whatsapp_claims, public.capture_inboxes,
    public.bank_feed_connections TO app_user;
  SELECT public.app_service_sync_policies();
  ```
  To revert, re-run 937 (it is idempotent). Until then every deploy's
  `app_pool_reach_violations()` check refuses the code switch.

Migration 945 (S-07e: billing tables and TEMPORARY, 2026-10-25) also takes effect on deploy:

- The billing tables are read-only to the app roles: `flow_wallet`,
  `flow_ledger`, `flow_purchases`, `flow_bundles`, `plans`, `plan_features`,
  `feature_flags`, `company_feature_overrides`, `subscriptions`,
  `subscription_charges`, `subscription_mandates`. Metering, Flow purchases,
  auto top-up settings, mandate create/verify/revoke, the subscription-charge
  and Flow-month crons and the Paystack webhook write them on migration_admin;
  the admin site keeps writing on platform_admin. 945 refuses to apply unless
  both still can.
- No app role may read `flow_wallet.payment_method_token`, or the Paystack
  authorisation, customer, subscription and email-token columns of
  `subscription_mandates` (and `subscription_charges.paystack_authorization_code`).
- `paystack_payment_requests` stays app-insertable, but its link (company,
  purpose, purchase/charge/mandate/invoice, reference, amount) cannot change
  after insert, no app role may delete a request, and its two card-code columns
  are unreadable and no longer written (one prod row held one on 2026-10-25; it
  is left in place). The webhook and mandate verify also refuse a payment whose
  Paystack metadata names another company or row: the request gets
  `failure_reason = 'review:…'` and an error log, and nothing is credited.
- Billing writes use a pool of their own on the migration_admin login (`BILLING_ADMIN_POOL_MAX`, default 6), so metering never queues a sign-in or credential write; the credential pool stays 4 (`MIGRATION_ADMIN_POOL_MAX`). Up to 10 migration_admin connections per app process.
- Auto top-up cannot be switched on (409): v1 cannot store a payment method. A wallet already switched on can change its bundle or be switched off.
- PUBLIC loses TEMPORARY on the database. Every role that had it through
  PUBLIC, except the roles the app logins reach, is granted it back by name,
  so GoTrue, storage, pgbouncer and the deploy keep it. **A role created
  later has no TEMPORARY until it is granted** (`GRANT TEMPORARY ON DATABASE
  isaflow TO <role>`). The rule also refuses CREATE on the database or any
  schema for the app pools' roles.
- Deploy window: until the new code is live (and after a code-only
  rollback) the old release's billing writes answer 500 and write nothing:
  metered PAYG requests, purchases, mandate flows, the two crons, and the
  Paystack webhook's settlement (Paystack retries). On 2026-10-25 prod had no
  PAYG subscription, no wallet and no mandate, so nothing is expected to hit it.
- Break-glass, only if an app pool must write billing before a fix ships:

  ```sql
  -- BREAK-GLASS: undoes 945's protection (a tenant can set its own Flows and plan). Revert before deploying.
  GRANT SELECT, INSERT, UPDATE, DELETE ON public.flow_wallet, public.flow_ledger, public.flow_purchases,
    public.flow_bundles, public.plans, public.plan_features, public.feature_flags, public.company_feature_overrides,
    public.subscriptions, public.subscription_charges, public.subscription_mandates,
    public.paystack_payment_requests TO app_user;
  -- and, only if something on an app pool needs temp tables:
  GRANT TEMPORARY ON DATABASE isaflow TO app_user;
  ```
  To revert, re-run 945 (it is idempotent). Until then every deploy's
  `app_pool_reach_violations()` check refuses the code switch.

Migration 936 (company standing and billing columns, 2026-10-24) also takes effect on deploy:

- No app role may INSERT, DELETE or TRUNCATE `companies`, or UPDATE its 13
  standing and billing columns: `status`, `suspended_at`, `suspended_reason`,
  `is_active`, `plan_id`, `trial_ends_at`, `stripe_customer_id`,
  `payg_eligible`, `is_demo`, `fx_documents_enabled`, `metadata`,
  `billing_email`, `billing_contact`. UPDATE comes back on every other column
  except `id` and `created_at` (company settings, onboarding, chase, CIPC,
  logo, PIS, client-query WhatsApp). The admin site (platform_admin) and signup provisioning
  (migration_admin) write the 13; onboarding inserts through
  `create_company_with_owner(jsonb)`. 936 refuses to apply unless they still can.
- A column added to `companies` later gets no app privilege. Granting one
  UPDATE is a violation until a migration adds it to the companies rule in
  `app_pool_reach_violations()`.
- The deploy window changes nothing: no release writes the 13, or inserts or
  deletes a company, on an app pool.
- On production `companies` is owned by migration_admin, not postgres. The
  deploy role is a member of it, so 936's REVOKE runs as the owner.
- Break-glass, only if something on an app pool must write one of the 13 before a fix ships:

  ```sql
  -- BREAK-GLASS: undoes 936's protection (a tenant can un-suspend its company). Revert before deploying.
  GRANT INSERT, UPDATE, DELETE ON public.companies TO app_user;
  ```
  To revert, re-run 936 (it is idempotent). Until then every deploy's
  `app_pool_reach_violations()` check refuses the code switch.

- 930's rules join 920's in `app_pool_reach_violations()`, so every later
  deploy refuses the code switch if one of these privileges comes back.
- Every SECURITY DEFINER function is listed in `app_definer_reviews` with a
  hash of its definition and owner, taken when 930 applies. It approves what
  prod has at that moment: a definer someone changed by hand on prod would be
  approved as it stands. The definer pre-check below lists any that the repo
  does not know; a later migration that adds or changes one must update its
  row, or CI and every deploy refuse it. Named limit: code a reviewed definer
  reaches indirectly (an invoker function it calls, a trigger on a table it
  writes) runs with its owner's rights and is not hashed; review those with
  the definer. After a PostgreSQL MAJOR upgrade the definitions can deparse
  differently and every row is refused: re-review and re-hash them in a
  migration (`UPDATE app_definer_reviews SET body_md5 = app_definer_hash(...)`).

## 0. Before you start

- Prod and dev share one PostgreSQL 15.8 cluster (`isaflow-supabase`, port 7772).
  Roles are cluster-wide, so 915 creates `isaflow_app`, `isaflow_service` and
  `app_service` for every database the first time it runs anywhere. The first
  run is normally the deploy's parity gate applying it to `isaflow_dev`.
- The prod env file is `/home/velo/isaflow/.env.local` (velo:velo 0600). You
  edit it as velo, or with sudo.

## 0b. Read-only pre-check (as the owner, on `isaflow`)

Each query must return zero rows; any row is a migration that would refuse
mid-deploy, after the migrations before it have applied:

```sql
-- 917: settings rows with no company
SELECT count(*) FROM accounting_settings WHERE company_id IS NULL HAVING count(*) > 0;
-- 917: views owned by an RLS-bypassing role that app_user can use, without security_invoker
SELECT c.oid::regclass FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  JOIN pg_roles o ON o.oid = c.relowner
 WHERE c.relkind = 'v' AND n.nspname IN ('public','auth','app','platform_shared')
   AND (o.rolsuper OR o.rolbypassrls)
   AND has_table_privilege('app_user', c.oid, 'SELECT, INSERT, UPDATE, DELETE')
   AND c.oid::regclass::text NOT IN ('clients', 'app_settings')
   AND NOT coalesce(c.reloptions && ARRAY['security_invoker=true','security_invoker=on','security_invoker=1'], false);
-- 917: app_user-executable definer functions without pg_temp last (917 fixes these three only)
SELECT p.oid::regprocedure FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE p.prosecdef AND n.nspname IN ('public','auth','app','platform_shared')
   AND has_function_privilege('app_user', p.oid, 'EXECUTE')
   AND NOT EXISTS (SELECT 1 FROM unnest(coalesce(p.proconfig, '{}')) c WHERE c ~ '^search_path=.*pg_temp"?$')
   AND p.oid::regprocedure::text NOT IN ('auth.user_admin_companies(text)', 'auth.set_default_company(uuid,uuid)', 'invite_token_company_name()');
-- 915b: a relation granted to PUBLIC, which every login holds after RESET ROLE
SELECT n.nspname || '.' || c.relname, a.privilege_type
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace, aclexplode(c.relacl) a
 WHERE a.grantee = 0 AND n.nspname NOT IN ('pg_catalog', 'information_schema');
-- 915b: app_user (the one existing role in either login's reach) superuser,
-- BYPASSRLS, CREATEROLE or REPLICATION, or owning anything in the cluster
SELECT rolname FROM pg_roles WHERE rolname = 'app_user'
   AND (rolsuper OR rolbypassrls OR rolcreaterole OR rolreplication
        OR EXISTS (SELECT 1 FROM pg_shdepend WHERE refclassid = 'pg_authid'::regclass
                     AND refobjid = pg_roles.oid AND deptype = 'o'));
-- 915b: app_user may SET ROLE to another role (it must reach nothing)
SELECT r.rolname FROM pg_roles r
 WHERE pg_has_role('app_user', r.oid, 'MEMBER') AND r.rolname <> 'app_user';
-- 918: app_user (or PUBLIC) must not be able to write users.email. app_service
-- does not exist yet: 915 creates it and grants it the column, 918 revokes it.
SELECT 'app_user' WHERE has_column_privilege('app_user', 'public.users', 'email', 'UPDATE');
-- 920: materialized views other than the AR view summary that app_user can read
SELECT c.oid::regclass FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE c.relkind = 'm' AND n.nspname IN ('public','auth','app','platform_shared')
   AND has_any_column_privilege('app_user', c.oid, 'SELECT')
   AND c.oid::regclass::text <> 'customer_invoice_view_summary';
-- 930: the writes 930 moves onto migration_admin, and suspension's revoke on
-- platform_admin (930 refuses to apply without them)
SELECT w.role, w.tbl, p.priv FROM (VALUES
    ('migration_admin', 'public.company_invitations', 'SELECT, INSERT, UPDATE, DELETE'),
    ('migration_admin', 'public.company_users', 'SELECT, INSERT, UPDATE'),
    ('migration_admin', 'public.users', 'SELECT'),
    ('migration_admin', 'public.personal_access_tokens', 'SELECT, INSERT, UPDATE'),
    ('migration_admin', 'public.oauth_apps', 'SELECT, INSERT, UPDATE'),
    ('migration_admin', 'public.oauth_authorisation_codes', 'SELECT, INSERT, UPDATE'),
    ('migration_admin', 'public.oauth_authorisations', 'SELECT, INSERT, UPDATE'),
    ('migration_admin', 'public.auth_password_reset_tokens', 'SELECT, INSERT, UPDATE, DELETE'),
    ('migration_admin', 'public.admin_impersonation_stash', 'SELECT, INSERT, DELETE'),
    ('migration_admin', 'public.capture_api_keys', 'SELECT, INSERT, UPDATE'),
    ('platform_admin', 'public.waitlist_signups', 'SELECT, UPDATE'),
    ('platform_admin', 'public.personal_access_tokens', 'UPDATE'),
    ('platform_admin', 'public.oauth_authorisations', 'UPDATE')) w(role, tbl, privs),
  unnest(string_to_array(w.privs, ', ')) p(priv)
 WHERE NOT has_table_privilege(w.role, w.tbl, p.priv);
-- 930: a grant on its tables to a role either login reaches, other than
-- app_user and PUBLIC (930 revokes from those two only, so this would survive
-- and 930's own check would refuse the migration)
SELECT c.oid::regclass, a.grantee::regrole, a.privilege_type FROM pg_class c, aclexplode(c.relacl) a
 WHERE c.oid = ANY (ARRAY['public.personal_access_tokens', 'public.oauth_apps', 'public.oauth_authorisation_codes',
         'public.oauth_authorisations', 'public.capture_api_keys', 'public.company_invitations', 'public.company_users',
         'public.auth_password_reset_tokens',
         'public.admin_impersonation_stash', 'public.waitlist_signups']::regclass[])
   AND a.grantee <> 0 AND a.grantee <> 'app_user'::regrole
   AND (pg_has_role('isaflow_app', a.grantee, 'MEMBER') OR pg_has_role('isaflow_service', a.grantee, 'MEMBER'));
-- 930: a table whose REVOKE the deploy role could not make (it must be the
-- owner or a member of it; otherwise the REVOKE is a WARNING and 930 refuses)
SELECT c.oid::regclass, pg_get_userbyid(c.relowner) FROM pg_class c
 WHERE c.oid = ANY (ARRAY['public.personal_access_tokens', 'public.oauth_apps', 'public.oauth_authorisation_codes',
         'public.oauth_authorisations', 'public.capture_api_keys', 'public.company_invitations', 'public.company_users',
         'public.auth_password_reset_tokens', 'public.admin_impersonation_stash', 'public.waitlist_signups']::regclass[])
   AND NOT pg_has_role(current_user, c.relowner, 'USAGE');
-- 930: a SECURITY DEFINER function 930 does not list in app_definer_reviews
-- (930 refuses until a migration reviews and lists it; trigger functions too)
SET search_path = pg_catalog, public;
SELECT p.oid::regprocedure FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE p.prosecdef AND n.nspname NOT IN ('pg_catalog', 'information_schema')
   AND p.oid::regprocedure::text NOT IN (
    'auth.set_default_company(uuid,uuid)', 'auth.user_admin_companies()', 'auth.user_admin_companies(text)',
    'auth.user_companies()', 'approval_company_member_name(uuid,text)', 'approval_company_member_profile(uuid,text)',
    'approval_company_other_members(uuid,text)', 'approval_enforcement_set(uuid,text,boolean,text)',
    'approval_request_decide(uuid,uuid,text,text,text,text)', 'approval_request_lock(uuid,uuid)',
    'approval_request_raise(uuid,text,uuid,uuid,text)', 'approval_request_rebind(uuid,uuid,uuid,text)',
    'approval_rule_create(uuid,text,text,text,text,text,numeric,text)', 'approval_rule_delete(uuid,uuid,text)',
    'approval_rule_lock(uuid,uuid,text)', 'approval_rule_update(uuid,uuid,text,text,text,text,numeric,text,boolean)',
    'audit_check_run_record(jsonb,jsonb)', 'audit_snapshot_record(jsonb,jsonb,jsonb,jsonb)',
    'company_member_directory(uuid)', 'create_company_with_owner(jsonb)', 'current_company_invoice_view_summary()',
    'invite_token_company_name()', 'payment_approval_cleared(uuid,text,uuid)',
    'refresh_customer_invoice_view_summary()', 'refresh_customer_invoice_view_summary_if_due()',
    'seed_company_afs_statement_lines(uuid)', 'seed_company_chart_of_accounts(uuid)',
    'seed_company_default_taxonomy(uuid)', 'seed_company_fiscal_periods(uuid)', 'entity_change_capture()',
    'credit_note_approval_gate()', 'customer_invoice_approval_gate()', 'fx_document_currency_gate()',
    'fx_settlement_refusal()', 'manual_journal_approval_gate()', 'payment_batch_approval_gate()',
    'payment_batch_member_gate()', 'supplier_invoice_approval_gate()', 'supplier_payment_approval_gate()');
RESET search_path;
-- 930: adding a company must not depend on app_user's INSERT (930 refuses otherwise)
SELECT pg_get_userbyid(p.proowner) FROM pg_proc p WHERE p.oid = 'public.create_company_with_owner(jsonb)'::regprocedure
   AND NOT has_table_privilege(p.proowner, 'public.company_users', 'INSERT');
-- 932: the bureau writes it moves onto migration_admin, and bureau creation on
-- platform_admin (932 refuses to apply without them; zero rows)
SELECT w.role, w.tbl, p.priv FROM (VALUES
    ('migration_admin', 'public.bureaus', 'SELECT, UPDATE'),
    ('migration_admin', 'public.bureau_users', 'SELECT'),
    ('migration_admin', 'public.bureau_companies', 'SELECT, INSERT, DELETE'),
    ('migration_admin', 'public.company_users', 'SELECT'),
    ('migration_admin', 'public.companies', 'SELECT'),
    ('migration_admin', 'public.users', 'SELECT'),
    ('platform_admin', 'public.bureaus', 'SELECT, INSERT'),
    ('platform_admin', 'public.bureau_users', 'INSERT')) w(role, tbl, privs),
  unnest(string_to_array(w.privs, ', ')) p(priv)
 WHERE NOT has_table_privilege(w.role, w.tbl, p.priv);
-- 932: a grant on the bureau tables to a role either login reaches, other than
-- app_user (932 revokes from app_user, app_service and PUBLIC only; zero rows)
SELECT c.oid::regclass, a.grantee::regrole, a.privilege_type FROM pg_class c, aclexplode(c.relacl) a
 WHERE c.oid = ANY (ARRAY['public.bureaus', 'public.bureau_users', 'public.bureau_companies',
         'public.bureau_audit_log']::regclass[])
   AND a.grantee <> 0 AND a.grantee NOT IN ('app_user'::regrole, 'app_service'::regrole)
   AND (pg_has_role('isaflow_app', a.grantee, 'MEMBER') OR pg_has_role('isaflow_service', a.grantee, 'MEMBER'));
-- 937: the writes it moves onto migration_admin (937 refuses to apply without them; zero rows)
SELECT w.tbl, p.priv FROM (VALUES
    ('public.company_users', 'SELECT, UPDATE, DELETE'),
    ('public.portal_magic_links', 'SELECT, INSERT, UPDATE, DELETE'),
    ('public.portal_contacts', 'SELECT, INSERT, UPDATE'),
    ('public.portal_access', 'SELECT, UPDATE'),
    ('public.customers', 'SELECT'),
    ('public.share_links', 'SELECT, INSERT, UPDATE'),
    ('public.audit_portal_sessions', 'SELECT, INSERT, UPDATE'),
    ('public.audit_trail_exports', 'SELECT'),
    ('public.capture_whatsapp_claims', 'SELECT, INSERT, UPDATE, DELETE'),
    ('public.capture_inboxes', 'SELECT, INSERT, UPDATE'),
    ('public.companies', 'SELECT'),
    ('public.users', 'SELECT'),
    ('public.bank_feed_connections', 'SELECT, INSERT, UPDATE')) w(tbl, privs),
  unnest(string_to_array(w.privs, ', ')) p(priv)
 WHERE NOT has_table_privilege('migration_admin', w.tbl, p.priv);
SELECT rolname FROM pg_roles WHERE rolname = 'migration_admin' AND NOT rolbypassrls;  -- zero rows
-- 937: a grant on its tables to a role either login reaches, other than
-- app_user and app_service (937 revokes from those and PUBLIC only; zero rows)
SELECT c.oid::regclass, a.grantee::regrole, a.privilege_type FROM pg_class c, aclexplode(c.relacl) a
 WHERE c.oid = ANY (ARRAY['public.company_users', 'public.portal_magic_links', 'public.portal_contacts',
         'public.portal_access', 'public.share_links', 'public.audit_portal_sessions',
         'public.capture_whatsapp_claims', 'public.capture_inboxes', 'public.bank_feed_connections']::regclass[])
   AND a.grantee <> 0 AND a.grantee NOT IN ('app_user'::regrole, 'app_service'::regrole)
   AND (pg_has_role('isaflow_app', a.grantee, 'MEMBER') OR pg_has_role('isaflow_service', a.grantee, 'MEMBER'));
-- 937: how much each moved table holds (counts only), to judge the deploy window
SELECT 'portal_magic_links' AS t, count(*) FROM portal_magic_links WHERE used_at IS NULL AND expires_at > now()
UNION ALL SELECT 'portal_contacts', count(*) FROM portal_contacts WHERE active
UNION ALL SELECT 'portal_access', count(*) FROM portal_access WHERE is_active
UNION ALL SELECT 'share_links', count(*) FROM share_links WHERE revoked_at IS NULL AND expires_at > now()
UNION ALL SELECT 'audit_portal_sessions', count(*) FROM audit_portal_sessions WHERE revoked_at IS NULL AND expires_at > now()
UNION ALL SELECT 'capture_inboxes', count(*) FROM capture_inboxes WHERE is_active
UNION ALL SELECT 'bank_feed_connections', count(*) FROM bank_feed_connections WHERE is_active;
-- 945: the writes it moves onto migration_admin, and the admin site's on platform_admin (zero rows)
SELECT w.who, w.tbl, p.priv FROM (VALUES
    ('migration_admin', 'public.flow_wallet', 'SELECT, INSERT, UPDATE'),
    ('migration_admin', 'public.flow_ledger', 'SELECT, INSERT'),
    ('migration_admin', 'public.flow_purchases', 'SELECT, INSERT, UPDATE'),
    ('migration_admin', 'public.flow_bundles', 'SELECT'),
    ('migration_admin', 'public.plans', 'SELECT'),
    ('migration_admin', 'public.subscriptions', 'SELECT, UPDATE'),
    ('migration_admin', 'public.subscription_charges', 'SELECT, INSERT, UPDATE'),
    ('migration_admin', 'public.subscription_mandates', 'SELECT, INSERT, UPDATE'),
    ('platform_admin', 'public.plans', 'SELECT, INSERT, UPDATE'),
    ('platform_admin', 'public.feature_flags', 'SELECT, UPDATE'),
    ('platform_admin', 'public.company_feature_overrides', 'SELECT, INSERT, UPDATE, DELETE'),
    ('platform_admin', 'public.subscriptions', 'SELECT, INSERT, UPDATE'),
    ('platform_admin', 'public.subscription_charges', 'SELECT, UPDATE'),
    ('platform_admin', 'public.flow_wallet', 'SELECT, INSERT, UPDATE'),
    ('platform_admin', 'public.flow_ledger', 'INSERT'),
    ('platform_admin', 'public.flow_bundles', 'SELECT, INSERT, UPDATE')) w(who, tbl, privs),
  unnest(string_to_array(w.privs, ', ')) p(priv)
 WHERE NOT has_table_privilege(w.who, w.tbl, p.priv);
-- 945: a grant on its tables to a role either login reaches, other than
-- app_user and app_service (945 revokes from those and PUBLIC only; zero rows)
SELECT c.oid::regclass, a.grantee::regrole, a.privilege_type FROM pg_class c, aclexplode(c.relacl) a
 WHERE c.oid = ANY (ARRAY['public.flow_wallet', 'public.flow_ledger', 'public.flow_purchases', 'public.flow_bundles',
         'public.plans', 'public.plan_features', 'public.feature_flags', 'public.company_feature_overrides',
         'public.subscriptions', 'public.subscription_charges', 'public.subscription_mandates',
         'public.paystack_payment_requests']::regclass[])
   AND a.grantee <> 0 AND a.grantee NOT IN ('app_user'::regrole, 'app_service'::regrole)
   AND (pg_has_role('isaflow_app', a.grantee, 'MEMBER') OR pg_has_role('isaflow_service', a.grantee, 'MEMBER'));
-- 945: TEMPORARY or CREATE held by a role either login reaches other than through
-- PUBLIC (945 revokes PUBLIC's only; zero rows), and the deploy role must own or
-- be a member of the database's owner (one row: t)
SELECT d.datname, a.grantee::regrole, a.privilege_type FROM pg_database d, aclexplode(d.datacl) a
 WHERE d.datname = current_database() AND a.grantee <> 0
   AND (pg_has_role('isaflow_app', a.grantee, 'MEMBER') OR pg_has_role('isaflow_service', a.grantee, 'MEMBER'));
SELECT pg_has_role('postgres', datdba, 'USAGE') FROM pg_database WHERE datname = current_database();
-- 945: how much the moved tables hold (counts only), to judge the deploy window
SELECT (SELECT count(*) FROM flow_wallet) AS wallets, (SELECT count(*) FROM subscription_mandates) AS mandates,
       (SELECT count(*) FROM subscriptions s JOIN plans p ON p.id = s.plan_id WHERE p.code = 'payg' AND s.status = 'active') AS payg;
-- 936: a table or column grant on companies to a role either login reaches,
-- other than app_user (936 revokes from app_user, app_service and PUBLIC only;
-- zero rows). Also check the owner: 936 runs its REVOKE as the owner, so the
-- deploy role must be a member of it (one row: t).
SELECT 'companies' AS t, a.grantee::regrole, a.privilege_type FROM pg_class c, aclexplode(c.relacl) a
 WHERE c.oid = 'public.companies'::regclass
   AND a.grantee <> 0 AND a.grantee NOT IN ('app_user'::regrole, 'app_service'::regrole)
   AND (pg_has_role('isaflow_app', a.grantee, 'MEMBER') OR pg_has_role('isaflow_service', a.grantee, 'MEMBER'))
UNION ALL
SELECT 'companies.' || att.attname, a.grantee::regrole, a.privilege_type FROM pg_attribute att, aclexplode(att.attacl) a
 WHERE att.attrelid = 'public.companies'::regclass AND att.attacl IS NOT NULL
   AND a.grantee <> 0 AND a.grantee NOT IN ('app_user'::regrole, 'app_service'::regrole)
   AND (pg_has_role('isaflow_app', a.grantee, 'MEMBER') OR pg_has_role('isaflow_service', a.grantee, 'MEMBER'));
SELECT pg_has_role('postgres', relowner, 'USAGE') FROM pg_class WHERE oid = 'public.companies'::regclass;
-- 936: the writers of the 13 (936 refuses to apply without them; zero rows)
SELECT w.role, w.priv, c.col FROM (VALUES
    ('platform_admin', 'UPDATE', 'status,suspended_at,suspended_reason,is_active,plan_id,trial_ends_at,stripe_customer_id,payg_eligible,is_demo,fx_documents_enabled,metadata,billing_email,billing_contact'),
    ('platform_admin', 'INSERT', 'name,registered_name,trading_name,email,phone,country,default_currency,status,annual_turnover_cents,payg_eligible'),
    ('migration_admin', 'INSERT', 'name,email,phone,is_active,annual_turnover_cents,payg_eligible,trial_ends_at')) w(role, priv, cols),
  unnest(string_to_array(w.cols, ',')) c(col)
 WHERE NOT has_column_privilege(w.role, 'public.companies', c.col, w.priv);
-- After the deploy, 930's, 932's, 936's, 937's and 945's rules run on every deploy; by hand (zero rows):
--   SELECT * FROM public.app_pool_reach_violations();
-- 916: each guard must hold the old exemption line exactly once
SELECT proname, hits FROM (
  SELECT proname, prosrc, (length(prosrc) - length(replace(prosrc, l, ''))) / length(l) AS hits
    FROM pg_proc, (VALUES ($$IF current_user <> 'app_user' THEN$$)) v(l)
   WHERE proname IN ('company_users_role_guard', 'company_invitations_role_guard')) g
 WHERE prosrc !~ 'pg_has_role\(current_user' AND hits <> 1;
```

## 1. Deploy the code (migrations 915-920 and 930 included)

915b refuses to apply if a role either app login can reach owns an object in ANY
database of the cluster (pg_shdepend). It fails safe, and the parity gate meets
it on dev first. If it fires, the message names the role: reassign that
object's ownership, do not weaken the check.

`bash scripts/deploy.sh`, from a clean worktree at master.

The deploy logs a `WARNING: OWNER_DATABASE_URL is not set` line. That is expected
at this step: the deploy falls back to `DATABASE_URL`, which is still `postgres`.

Verify:
```sql
SELECT rolname, rolcanlogin, rolinherit, rolbypassrls FROM pg_roles
 WHERE rolname IN ('isaflow_app','isaflow_service','app_service');
-- 3 rows, rolcanlogin = false, rolbypassrls = false; isaflow_app rolinherit = false
SELECT count(*) FROM pg_policy WHERE polname LIKE 'app\_service\_%';   -- > 200, in isaflow
SELECT has_table_privilege('app_user', 'schema_migrations', 'DELETE');  -- false (917)
SELECT * FROM public.app_login_role_violations(false);                  -- no rows
```

## 2. Refuse DDL from the app logins (once per cluster, as `supabase_admin`)

The Supabase image preloads `supautils`. supautils lets ANY login run CREATE
EXTENSION for its `privileged_extensions` list (dblink, postgres_fdw, pg_net,
http, pgsodium, pg_graphql, postgis, pg_tle, plv8, ...). It installs them as
`supabase_admin`, whatever the caller's database privileges. Several of these
then hand the caller EXECUTE on supabase_admin-owned SECURITY DEFINER functions,
and pg_net/http give the database an outbound network channel. Today's
`postgres` login can do the same, so this predates S-07b. But it is the one
route by which isaflow_app / isaflow_service could get objects created as a
superuser (S-07b breaker round 2, N1, verified on supabase/postgres:15.8.1.085).

The app runs no DDL at runtime (checked: no CREATE/ALTER/DROP/TRUNCATE in
src/ or pages/), except the AR cron's REFRESH MATERIALIZED VIEW. That runs
inside an owner-run definer function, which the trigger lets through.
Verified on supabase/postgres:15.8.1.085: both logins are refused CREATE
EXTENSION dblink and pgsodium (as supabase_admin), CREATE TEMP TABLE (as
themselves and as app_user) and ALTER TABLE. postgres can still CREATE
EXTENSION. The refresh wrapper works, and the s07b attack and path suites pass. So refuse all DDL from the two app logins. Only a superuser
can create an event trigger, so run this as `supabase_admin` in each database
the app uses (`isaflow`, and `isaflow_dev` if dev moves to the new logins):

```sql
CREATE OR REPLACE FUNCTION public.refuse_app_pool_ddl() RETURNS event_trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  -- Judged on the EFFECTIVE role. An app login running as itself, as
  -- app_user/app_service, or as a superuser (supautils runs a privileged
  -- CREATE EXTENSION as supabase_admin) is refused. A SECURITY DEFINER
  -- function owned by the non-superuser postgres is let through: the AR
  -- cron's refresh_customer_invoice_view_summary() (915) runs REFRESH ...
  -- CONCURRENTLY, which creates a temp table internally. This relies on prod's
  -- postgres being NOSUPERUSER (it is: rolsuper = f).
  IF session_user IN ('isaflow_app', 'isaflow_service')
     AND (current_user IN ('isaflow_app', 'isaflow_service', 'app_user', 'app_service')
          OR (SELECT r.rolsuper FROM pg_catalog.pg_roles r WHERE r.rolname = current_user)) THEN
    RAISE EXCEPTION 'DDL (%) refused for % (as %)', tg_tag, session_user, current_user USING ERRCODE = '42501';
  END IF;
END $$;
CREATE EVENT TRIGGER refuse_app_pool_ddl ON ddl_command_start
  EXECUTE FUNCTION public.refuse_app_pool_ddl();
```

Verify it after step 3 (the logins need a password first). As each login, in
`isaflow`:
```sql
BEGIN; CREATE EXTENSION dblink;   -- expect ERROR 42501 "DDL (CREATE EXTENSION) refused for isaflow_app (as supabase_admin)"
ROLLBACK;
```
As `postgres`, a CREATE EXTENSION inside BEGIN ... ROLLBACK must still succeed:
the deploy's migrations run as postgres. And the AR cron must still answer 200:
`curl -X POST -H "X-Cron-Secret: $CRON_SECRET" http://127.0.0.1:3101/api/cron/ar-matview-refresh`.

Separate ops item (not S-07b, pre-existing): on this image,
`GRANT <role> TO PUBLIC` or `GRANT <role> TO current_user` from any login
crashes the backend with SIGSEGV (supautils), and the whole cluster restarts.
Repro, affected tags and mitigation: `docs/runbooks/supautils-grant-public-segfault.md`.

## 3. Enable the logins (once per cluster)

Run as `postgres`. Generate the passwords with
`openssl rand -base64 33 | tr -d '/+='` and store them in `~/.secrets`.
Do not put them on a command line: use `psql` and `\password`, or `-v` from a
0600 file.

```sql
ALTER ROLE isaflow_app     LOGIN PASSWORD '<app password>';
ALTER ROLE isaflow_service LOGIN PASSWORD '<service password>';
```

Check that pg_hba lets both roles in from the app host, the same way it lets
`postgres` in, using the Supavisor/pooler user format if the URL goes through
the pooler:
```bash
psql "postgresql://isaflow_app:<pw>@100.96.203.105:7772/isaflow" -c 'select current_user'
```

## 3b. Make the two logins reserved roles (once per cluster, after step 3)

Any role may change its own password and its own session defaults, and the
event trigger does not see ALTER ROLE. One injected statement could therefore
run `ALTER ROLE isaflow_service SET default_transaction_read_only = on`, a
read-only app that survives restarts, or change the login's password (S-07b
verifier, P2). supautils refuses every change to a reserved role that does
not come from a superuser:

1. In the IsaFlow Supabase db container, append the two logins to
   `supautils.reserved_roles` in `/etc/postgresql-custom/supautils.conf`:
   `..., anon*, isaflow_app, isaflow_service'`. Check first that the file is
   on a mounted volume (`docker inspect`), or the change is lost when the
   container is recreated.
2. As supabase_admin: `SELECT pg_reload_conf();`

Verify, as isaflow_service:
`ALTER ROLE isaflow_service SET statement_timeout = 1;` must fail with
`"isaflow_service" is a reserved role, only superusers can modify it`.

From then on, rotate either password as supabase_admin, not as postgres.
Migration 915 changes the roles only when they differ from what it expects, so
re-running it, or applying it to another database of the cluster, still works
(verified on supabase/postgres:15.8.1.085 with non-superuser postgres).

## 4. Reinstall the backup scripts (before the env change)

The backup and restore-drill units run root-owned copies in `/opt/isaflow-ops`.
Those copies read `DATABASE_URL`, which step 5 turns into `isaflow_app`, and
pg_dump would fail as that role. Reinstall the copies first, so they read
`OWNER_DATABASE_URL` (and fall back to `DATABASE_URL`, still `postgres`, until
step 5), leaving no window in which a backup or WAL archive runs on the old
copies with the new env:

`sudo bash scripts/ops/install-backup-ops.sh` (it installs `ownerDatabaseUrl.sh` beside `lib-pgconn.sh`)

Then check: `sudo grep -c owner_database_url_for /opt/isaflow-ops/lib-pgconn.sh` (expect ≥ 1).

## 5. Move the owner URL out of the app's env, then change the prod env

The app runs as `velo` with `EnvironmentFile=/home/velo/isaflow/.env.local`,
so anything in that file is in the app process's environment. The owner URL
goes in its own file instead, which only the deploy (through `sudo`) and the
root-run backup scripts read: `/etc/isaflow/owner.env`, `root:root 0600`.
It is outside `/home/velo/isaflow`, which every deploy `rsync --delete`s
(only `.env.local` and its backup patterns survive there), and outside the
rollback snapshot. `scripts/ops/ownerDatabaseUrl.sh` reads it first, then
`.env.local`'s `OWNER_DATABASE_URL` (warning that the app loads it), then
`.env.local`'s `DATABASE_URL` (warning that it is not set).

5a. Create the owner file with today's `DATABASE_URL` value (still `postgres`).
The value is copied file to file, never printed or put on a command line:

```bash
sudo install -d -o root -g root -m 0700 /etc/isaflow
sudo sh -c 'umask 077; grep -E "^DATABASE_URL=" /home/velo/isaflow/.env.local | head -1 \
  | sed "s/^DATABASE_URL=/OWNER_DATABASE_URL=/" > /etc/isaflow/owner.env'
sudo chown root:root /etc/isaflow/owner.env && sudo chmod 0600 /etc/isaflow/owner.env
```

Verify, by count and owner only:
```bash
sudo stat -c '%U:%G %a' /etc/isaflow/owner.env           # root:root 600
sudo grep -c '^OWNER_DATABASE_URL=postgres' /etc/isaflow/owner.env   # 1
sudo -u velo cat /etc/isaflow/owner.env                  # must FAIL: Permission denied
sudo bash -c '. scripts/ops/ownerDatabaseUrl.sh; owner_database_url_for /home/velo/isaflow/.env.local' 2>&1 >/dev/null | grep -c WARNING   # 0
```
The last line, run from the repo, runs the deploy's own lookup with its output
discarded and counts its warnings: 0 means it took the owner file.

5b. Change `/home/velo/isaflow/.env.local`. If `CRON_SECRET` has not been
rotated yet (`docs/runbooks/cron-secret-management-packs.md`), rotate it
first: the copy made here is the rollback point and would otherwise keep the
leaked value. Keep a copy, as velo (a root `cp` into velo's directory would
follow a symlink velo planted): `sudo -u velo cp -p /home/velo/isaflow/.env.local /home/velo/isaflow/.env.local.pre-s07b`.

```
SERVICE_DATABASE_URL=postgresql://isaflow_service:<pw>@<same host:port>/isaflow?<same params>
DATABASE_URL=postgresql://isaflow_app:<pw>@<same host:port>/isaflow?<same params>
```

Do NOT add `OWNER_DATABASE_URL` here; if an earlier attempt added it, remove
it. Leave `PLATFORM_ADMIN_DATABASE_URL` and `MIGRATION_ADMIN_DATABASE_URL` as
they are. The app refuses to boot if `DATABASE_URL` names isaflow_app while
`SERVICE_DATABASE_URL` is unset (validateEnv), so set both together.

Check: `sudo grep -c '^OWNER_DATABASE_URL=' /home/velo/isaflow/.env.local` → 0.

5c. Restart the WAL archiver, a long-running unit that loaded its connection
when it started (step 4's `enable --now` does not restart a running unit):
`sudo systemctl restart isaflow-wal-archive` and check that
`journalctl -u isaflow-wal-archive --since -2min` shows it connected, with no
`OWNER_DATABASE_URL` warning.

One-off owner scripts read `OWNER_DATABASE_URL` and fall back to
`DATABASE_URL`, which is now isaflow_app: run that way they fail with
`permission denied` (for example `scripts/ap-backfill-supplier-payments.ts`
reads `ap_payment_document_backfill_candidates`, which app_user may not read,
916b). Load it inside the
command, so the value never reaches an argv (`/proc/<pid>/cmdline` is
world-readable) or your shell history, and never copy it into `.env.local`:
`sudo bash -c 'export OWNER_DATABASE_URL="$(sed -n "s/^OWNER_DATABASE_URL=//p" /etc/isaflow/owner.env)"; exec bun <script>'`.
Do not `source` the file: a URL's `&` would end the assignment.

## 6. Restart and verify

`sudo systemctl restart isaflow`. Then:

- `journalctl -u isaflow --since -2min` shows no `permission denied` and no
  `row-level security` errors.
- In the database, `SELECT usename, count(*) FROM pg_stat_activity WHERE datname = 'isaflow' GROUP BY 1`
  shows connections from isaflow_app and isaflow_service, and none from
  `postgres` belonging to the app.
- Log in, open a company, list invoices, and save a profile change (withAuth).
- Open `/api/auth/me` (service).
- Read an admin page (the platform-admin gate runs on isaflow_app).
- Fire one cron by hand:
  `curl -X POST -H "X-Cron-Secret: $CRON_SECRET" http://127.0.0.1:3101/api/cron/ar-matview-refresh`.
- Bugsink shows no new `42501` / `permission denied` issues for 30 minutes.

## Rollback (instant, no code change)

1. Restore `.env.local.pre-s07b`.
2. `sudo systemctl restart isaflow`.

`/etc/isaflow/owner.env` can stay: it names `postgres`, which is what the
restored `.env.local` names too.

A code rollback to a release from before the follow-up PR, with the env still
on the new logins: that release's change-email updates GoTrue first and then
fails its `users` write (918 took it from the service pool), logs the drift
and answers 200, so the login and profile emails diverge; its register and
verify-email recovery path fail with `permission denied for table
auth_email_verification_tokens` (918). Restore the env first, as above.

**Env first, then code.** Never run `scripts/rollback-deploy.sh` to a release
older than this PR while the env still names `isaflow_app`: the old code
ignores `SERVICE_DATABASE_URL` and has no boot check, so every cron, login and
public route would fail with 42501, and its `deploy.sh` would migrate as
`isaflow_app`. Restore the env and restart first; roll the code back after.

Once the logins can log in, every deploy stops before its code switch if the
event trigger or the reserved roles are missing (for example after the db
container was recreated and `supautils.conf` reverted), so finish steps 2 and
3b before the next deploy, and re-check them after any change to the db
container. The deploy's message names what is missing.

The roles and policies can stay; nothing uses them. To remove the logins as well:
`ALTER ROLE isaflow_app NOLOGIN; ALTER ROLE isaflow_service NOLOGIN;`.

## Dev (optional, after prod is stable)

Dev's workspace `.env.local` can follow the same pattern against
`isaflow_dev`: `SERVICE_DATABASE_URL` and `DATABASE_URL` on the new logins, plus
`OWNER_DATABASE_URL` naming `postgres`. Dev keeps the owner URL in the
workspace `.env.local`: the deploy's parity gate reads it from there
(`owner_database_url`, not the `/etc/isaflow/owner.env` lookup, which is
production's), and no long-running service loads that file.
