-- Migration 937 (S-07d): the credential tables S-07c's class sweep left on
-- the app pools.
--
-- SQL injected on either app pool can forge request.jwt.claims and
-- app.current_company_id (and app_service's mirror policies admit every row),
-- so a row an app role may write is whatever the forged claims say. Each table
-- below holds rows a privileged path later honours as a role, a credential or
-- a route:
--   company_users           the members screen's role change (930 kept
--                           UPDATE (role)) and removal: an owner's forged
--                           claims raised any member to owner (bureau
--                           link/unlink, 932, reads that role) or removed the
--                           other members and owners;
--   portal_magic_links      the RAW token that signs an AFS portal contact in;
--   portal_contacts         who may ask for one, and the portal role;
--   portal_access           an AR portal login's bcrypt password hash (and,
--                           new here, the company it signs in to);
--   share_links             a read link to a company's reports;
--   audit_portal_sessions   an outside auditor's download of an export's pack;
--   capture_whatsapp_claims,
--   capture_inboxes         which company a mailed or WhatsApp document goes
--                           to (a moved address, or a re-keyed webhook token,
--                           routed another company's documents);
--   bank_feed_connections   is_active revokes an extension's 90-day pairing
--                           JWT (an INSERT could re-create a deleted pairing
--                           under its old id).
-- Only privileges hold against forged claims, so app_user (and through it
-- app_service and both logins) loses INSERT and UPDATE on all of them; the
-- writes run on the migration_admin pool from fixed statements keyed on the
-- verified request (S-07d). Column grants come back only for what a bearer's
-- use stamps: share_links' view counter, audit_portal_sessions' last use,
-- bank_feed_connections' sync status. portal_magic_links loses every
-- privilege (its tokens are raw); portal_access keeps SELECT on every column
-- but password_hash, and DELETE. DELETE stays where it only removes access
-- (with INSERT gone, a deleted row cannot come back).
-- company_users_role_guard judges only app_user and app_service, so the role
-- change and the removal re-check its rules (RC001-RC006, RC010) in
-- TypeScript on migration_admin, against the memberships as they stand, as
-- 930 did for invitations; RC011 (last owner) still runs for migration_admin.
-- (A row lock needs an UPDATE privilege, so the removal's FOR UPDATE could
-- not stay on app_user once UPDATE (role) went.)
-- No new SECURITY DEFINER function, so no new app_definer_reviews row.
--
-- Every rule is added to app_pool_reach_violations() (920, 930, 932, 936), which
-- this migration and every deploy (scripts/check-app-login-roles.ts) run.
--
-- Deploy window: migrations apply before the code switch. Until the new code
-- is live, and after a code-only rollback, the previous release's writes to
-- these tables are refused 42501 and answer an error, minting nothing:
--   member role changes and removals (500; invite and accept keep working);
--   AFS portal sign-in links are not sent (the request answers as always; the
--     failure is logged) and an emailed link does not verify (500);
--   AFS portal contact create, edit and remove;
--   AR portal login (it reads password_hash; 500), and customer merge (it
--     deactivated the source customer's portal logins; the merge rolls back);
--   share link create and revoke (viewing a link keeps working);
--   auditor session issue and revoke (the auditor's download keeps working);
--   capture email inbox mint and rotate, WhatsApp inbox claim and its provider
--     verification, and the IMAP mirror's per-message inbox upsert (the old
--     cron commits the document first, then fails, logs the message as an
--     error and moves its cursor past it: re-scan after the window, see the
--     runbook; the new code stops before such a message and retries it);
--   bank feed create and disconnect (extension pairing of an existing
--     connection, ingest and sync keep working).
-- Reads and every bearer's use keep working. The revocations among these
-- (member removal, share link and auditor session revoke, bank feed
-- disconnect, portal contact deactivate) fail OPEN for that time: access that
-- should end stays live. The runbook gives the operator SQL to revoke by hand.
--
-- Rollback (break-glass, in docs/runbooks/s07b-app-pool-login-roles.md), which
-- reopens the forgery and makes every deploy's check refuse until this
-- migration's state is restored:
--   GRANT UPDATE (role), DELETE ON public.company_users TO app_user;
--   GRANT SELECT, INSERT, UPDATE, DELETE ON public.portal_magic_links,
--     public.portal_contacts, public.portal_access, public.share_links,
--     public.audit_portal_sessions, public.capture_whatsapp_claims,
--     public.capture_inboxes, public.bank_feed_connections TO app_user;

REVOKE UPDATE, DELETE, TRUNCATE ON public.company_users FROM app_user, app_service, PUBLIC;

REVOKE ALL ON public.portal_magic_links FROM app_user, app_service, PUBLIC;

REVOKE INSERT, UPDATE, TRUNCATE ON public.portal_contacts FROM app_user, app_service, PUBLIC;

-- An AR portal login takes its company from its customer, and app roles may
-- write customers.company_id: so the login's company is pinned on the login
-- itself, which only migration_admin writes, and login and every portal
-- request require the two to agree (breaker, S-07d round 1). Every tenant's
-- rows, deliberately: each takes its own customer's company. A login whose
-- customer is gone keeps NULL, which matches nothing.
ALTER TABLE public.portal_access ADD COLUMN IF NOT EXISTS company_id uuid REFERENCES public.companies(id) ON DELETE CASCADE;
UPDATE public.portal_access pa SET company_id = c.company_id
  FROM public.customers c WHERE c.id = pa.client_id AND pa.company_id IS NULL;

REVOKE ALL ON public.portal_access FROM app_user, app_service, PUBLIC;
GRANT SELECT (id, client_id, company_id, email, name, is_active, last_login_at, created_at, updated_at), DELETE
  ON public.portal_access TO app_user;

REVOKE INSERT, UPDATE, TRUNCATE ON public.share_links FROM app_user, app_service, PUBLIC;
GRANT UPDATE (view_count, last_viewed_at) ON public.share_links TO app_user;

REVOKE INSERT, UPDATE, TRUNCATE ON public.audit_portal_sessions FROM app_user, app_service, PUBLIC;
GRANT UPDATE (last_used_at, use_count) ON public.audit_portal_sessions TO app_user;

REVOKE INSERT, UPDATE, TRUNCATE ON public.capture_whatsapp_claims FROM app_user, app_service, PUBLIC;
REVOKE INSERT, UPDATE, TRUNCATE ON public.capture_inboxes FROM app_user, app_service, PUBLIC;

REVOKE INSERT, UPDATE, TRUNCATE ON public.bank_feed_connections FROM app_user, app_service, PUBLIC;
GRANT UPDATE (last_sync_at, last_success_at, last_sync_status, last_sync_error, updated_at, last_scraper_version, scraper_version)
  ON public.bank_feed_connections TO app_user;

-- app_service's mirrors follow app_user's privileges (915).
SELECT public.app_service_sync_policies();

-- 930's, 932's and 936's rules, with company_users' role no longer writable,
-- plus 937's. A migration that changes this function again keeps them.
CREATE OR REPLACE FUNCTION public.app_pool_reach_violations()
RETURNS SETOF text
LANGUAGE sql
STABLE
SET search_path = pg_catalog, public, pg_temp
AS $$
  WITH reach AS (
    SELECT r.oid, r.rolname FROM pg_catalog.pg_roles r
     WHERE (pg_catalog.to_regrole('isaflow_app') IS NOT NULL AND pg_catalog.pg_has_role('isaflow_app', r.oid, 'MEMBER'))
        OR (pg_catalog.to_regrole('isaflow_service') IS NOT NULL AND pg_catalog.pg_has_role('isaflow_service', r.oid, 'MEMBER'))
  ),
  -- 930 (and 932, 936, 937): per table, the columns an app role may still INSERT or UPDATE, and
  -- whether it may read and DELETE. Every other column privilege, DELETE where
  -- not allowed, and TRUNCATE anywhere, is a violation.
  rules (tbl, may_insert, may_update, may_read, may_delete) AS (VALUES
    ('public.company_invitations',        '{}'::text[], '{}'::text[],                    true,  true),
    ('public.company_users',              '{}',         '{}',                            true,  false),
    ('public.personal_access_tokens',     '{}',         '{last_used_at,last_used_ip}',   true,  true),
    ('public.oauth_apps',                 '{}',         '{}',                            true,  true),
    ('public.oauth_authorisation_codes',  '{}',         '{}',                            true,  true),
    ('public.oauth_authorisations',       '{}',         '{last_used_at,last_used_ip}',   true,  true),
    ('public.capture_api_keys',           '{}',         '{last_used_at}',                true,  true),
    ('public.auth_password_reset_tokens', '{}',         '{}',                            false, false),
    ('public.password_reset_tokens',      '{}',         '{}',                            false, false),
    ('public.admin_impersonation_stash',  '{}',         '{}',                            false, false),
    ('public.matview_refresh_state',      '{}',         '{}',                            false, false),
    ('public.app_definer_reviews',        '{}',         '{}',                            false, false),
    ('public.waitlist_signups',
     '{name,email,signup_type,company_name,practice_name,phone,annual_turnover_cents,ip,user_agent}',
                                                        '{}',                            false, false),
    -- 932: bureaus, their members and their client links are read-only to the app pools.
    ('public.bureaus',                    '{}',         '{}',                            true,  false),
    ('public.bureau_users',               '{}',         '{}',                            true,  false),
    ('public.bureau_companies',           '{}',         '{}',                            true,  false),
    ('public.bureau_audit_log',           '{}',         '{}',                            false, false),
    -- 936: a company's standing and billing columns are not among them (the header).
    ('public.companies',                  '{}',
     '{
      name,trading_name,registration_number,vat_number,tax_number,address_line1,address_line2,city,
      province,postal_code,country,phone,email,website,logo_url,bank_name,bank_account_number,
      bank_branch_code,bank_account_type,financial_year_start,vat_period,default_currency,
      updated_at,logo_data,lockdown_enabled,lockdown_date,vat_system_type,entity_type,registered_name,
      tax_office,contact_name,fax,mobile,physical_address_line1,physical_address_line2,physical_city,
      physical_province,physical_postal_code,tax_practitioner_reg_number,tax_practitioner_name,
      sars_contact_first_name,sars_contact_last_name,sars_contact_capacity,sars_contact_number,
      sars_contact_telephone,logo_position,logo_on_emails,logo_on_portal,rounding_type,round_to_nearest,
      qty_decimal_places,value_decimal_places,hours_decimal_places,cost_price_decimal_places,
      selling_price_decimal_places,currency_symbol,date_format,email_use_for_communication,email_always_cc,
      email_use_service_from,warn_duplicate_customer_ref,warn_duplicate_supplier_inv,
      display_inactive_customers_processing,display_inactive_suppliers_processing,
      display_inactive_customers_reports,display_inactive_suppliers_reports,use_inclusive_processing,
      use_account_default_line_type,warn_item_qty_below_zero,block_item_qty_below_zero,warn_item_cost_zero,
      warn_item_selling_below_cost,display_inactive_items_processing,display_inactive_items_reports,
      sales_orders_reserve_qty,display_inactive_bundles,ageing_monthly,ageing_based_on,
      vat_period_alignment,industry,business_structure,social_facebook,social_linkedin,social_x,
      functional_currency,aging_basis,aging_period_type,aging_bucket1_days,aging_bucket2_days,
      aging_bucket3_days,invoice_email_subject,invoice_email_body,quote_email_subject,quote_email_body,
      statement_email_subject,statement_email_body,decimal_separator,thousands_separator,decimal_places,
      invoice_logo_position,rounding_method,invoice_email_signature,quote_email_signature,
      statement_email_signature,credit_note_email_signature,sales_order_email_signature,
      recurring_invoice_email_signature,credit_note_email_subject,credit_note_email_body,
      sales_order_email_subject,sales_order_email_body,recurring_invoice_email_subject,
      recurring_invoice_email_body,portal_display_name,portal_tagline,portal_mode,
      portal_show_account_balance,portal_show_transaction_history,portal_allow_payments,
      portal_payment_instructions,portal_welcome_message,portal_primary_color,invoice_layout,quote_layout,
      statement_layout,netcash_service_key,netcash_payouts_key,netcash_enabled,paye_reference_number,
      sdl_reference_number,uif_reference_number,sic7_code,employee_count_beginning,employee_count_end,
      shareholder_count,all_shareholders_are_directors,nature_of_business,registered_address,
      chase_auto_send_enabled,chase_grace_days,whatsapp_chase_enabled,sars_km_rate,
      share_anonymised_signals,annual_turnover_cents,primary_color,idle_timeout_minutes,
      client_query_whatsapp,cipc_annual_return_submitted,cipc_annual_return_submitted_at,
      require_project_on_cos,onboarding_request_key
     }',
                                                                                     true,  false),
    -- 937: portal, share-link, audit-portal, capture-routing and bank-feed
    -- credentials are written on migration_admin only; the stamps a bearer's
    -- use writes stay.
    ('public.portal_magic_links',         '{}',         '{}',                            false, false),
    ('public.portal_contacts',            '{}',         '{}',                            true,  true),
    ('public.portal_access',              '{}',         '{}',                            true,  true),
    ('public.share_links',                '{}',         '{view_count,last_viewed_at}',   true,  true),
    ('public.audit_portal_sessions',      '{}',         '{last_used_at,use_count}',      true,  true),
    ('public.capture_whatsapp_claims',    '{}',         '{}',                            true,  true),
    ('public.capture_inboxes',            '{}',         '{}',                            true,  true),
    ('public.bank_feed_connections',      '{}',
     '{last_sync_at,last_success_at,last_sync_status,last_sync_error,updated_at,last_scraper_version,scraper_version}',
                                                                                         true,  true)
  ),
  -- 937: columns no app role may read on a table it otherwise reads.
  unreadable (tbl, col) AS (VALUES
    ('public.portal_access', 'password_hash')
  ),
  ruled AS (
    SELECT pg_catalog.to_regclass(r.tbl) AS rel, r.* FROM rules r WHERE pg_catalog.to_regclass(r.tbl) IS NOT NULL
  )
  SELECT pg_catalog.format('%s (reachable from an app pool login) can %s users.email', reach.rolname, p.priv)
    FROM reach CROSS JOIN (VALUES ('INSERT'), ('UPDATE')) p(priv)
   WHERE pg_catalog.has_column_privilege(reach.oid, 'public.users', 'email', p.priv)
  UNION ALL
  SELECT pg_catalog.format('%s (reachable from an app pool login) can %s auth_email_verification_tokens', reach.rolname, p.priv)
    FROM reach CROSS JOIN (VALUES ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE'), ('TRUNCATE')) p(priv)
   -- SELECT, INSERT and UPDATE can also be granted per column: count those.
   WHERE CASE WHEN p.priv IN ('SELECT', 'INSERT', 'UPDATE')
              THEN pg_catalog.has_any_column_privilege(reach.oid, pg_catalog.to_regclass('public.auth_email_verification_tokens'), p.priv)
              ELSE pg_catalog.has_table_privilege(reach.oid, pg_catalog.to_regclass('public.auth_email_verification_tokens'), p.priv) END
  UNION ALL
  SELECT pg_catalog.format('%s (reachable from an app pool login) can SELECT the materialized view %s', reach.rolname, c.oid::regclass)
    FROM reach
   CROSS JOIN pg_catalog.pg_class c
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
   WHERE c.relkind = 'm' AND n.nspname IN ('public', 'auth', 'app', 'platform_shared')
     AND pg_catalog.has_any_column_privilege(reach.oid, c.oid, 'SELECT')
  UNION ALL
  -- has_column_privilege counts table-level grants, PUBLIC and inherited roles.
  SELECT pg_catalog.format('%s (reachable from an app pool login) can %s %s.%s', reach.rolname, p.priv, ruled.rel, a.attname)
    FROM reach
   CROSS JOIN ruled
    JOIN pg_catalog.pg_attribute a ON a.attrelid = ruled.rel AND a.attnum > 0 AND NOT a.attisdropped
   CROSS JOIN (VALUES ('INSERT'), ('UPDATE'), ('SELECT')) p(priv)
   WHERE CASE p.priv WHEN 'INSERT' THEN NOT (a.attname::text = ANY (ruled.may_insert))
                     WHEN 'UPDATE' THEN NOT (a.attname::text = ANY (ruled.may_update))
                     ELSE NOT ruled.may_read END
     AND pg_catalog.has_column_privilege(reach.oid, ruled.rel, a.attnum, p.priv)
  UNION ALL
  SELECT pg_catalog.format('%s (reachable from an app pool login) can %s %s', reach.rolname, p.priv, ruled.rel)
    FROM reach
   CROSS JOIN ruled
   CROSS JOIN (VALUES ('DELETE'), ('TRUNCATE')) p(priv)
   WHERE (p.priv = 'TRUNCATE' OR NOT ruled.may_delete)
     AND pg_catalog.has_table_privilege(reach.oid, ruled.rel, p.priv)
  UNION ALL
  SELECT pg_catalog.format('%s (reachable from an app pool login) can SELECT %s.%s', reach.rolname, u.tbl, u.col)
    FROM reach
   CROSS JOIN unreadable u
   WHERE pg_catalog.to_regclass(u.tbl) IS NOT NULL
     AND pg_catalog.has_column_privilege(reach.oid, pg_catalog.to_regclass(u.tbl), u.col, 'SELECT')
  UNION ALL
  -- 932: TRIGGER on any table. A trigger an app role creates on a table the
  -- migration_admin pool writes (bureau_companies, say) runs its function in
  -- that pool's session, as migration_admin.
  SELECT pg_catalog.format('%s (reachable from an app pool login) can TRIGGER %s', reach.rolname, c.oid::regclass)
    FROM reach
   CROSS JOIN pg_catalog.pg_class c
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
   -- Views take INSTEAD OF triggers. A temporary table is its own session's (its
   -- owner holds TRIGGER), and no other session writes it: not a violation, or any
   -- session could stop every deploy with one CREATE TEMP TABLE.
   WHERE c.relkind IN ('r', 'p', 'v', 'f') AND c.relpersistence <> 't'
     AND n.nspname NOT IN ('pg_catalog', 'information_schema')
     AND pg_catalog.has_table_privilege(reach.oid, c.oid, 'TRIGGER')
  UNION ALL
  -- A definer runs as its owner, so no privilege rule sees what it writes.
  SELECT pg_catalog.format('%s is a SECURITY DEFINER function %s app_definer_reviews: review what it writes, then insert or update its row, with public.app_definer_hash(oid), in the migration that %s it',
                           p.oid::regprocedure, CASE WHEN r.signature IS NULL THEN 'not in' ELSE 'changed since its row in' END,
                           CASE WHEN r.signature IS NULL THEN 'creates' ELSE 'changes' END)
    FROM pg_catalog.pg_proc p
    JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
    LEFT JOIN public.app_definer_reviews r ON r.signature = p.oid::regprocedure::text
   WHERE p.prosecdef AND n.nspname NOT IN ('pg_catalog', 'information_schema')
     AND r.body_md5 IS DISTINCT FROM public.app_definer_hash(p.oid)
  UNION ALL
  SELECT pg_catalog.format('%s has no row security', t.tbl)
    FROM (VALUES ('waitlist_signups'), ('bureaus'), ('bureau_users'), ('bureau_companies')) t(tbl)
   WHERE NOT COALESCE((SELECT c.relrowsecurity FROM pg_catalog.pg_class c
                        WHERE c.oid = pg_catalog.to_regclass('public.' || t.tbl)), true)
$$;
REVOKE ALL ON FUNCTION public.app_pool_reach_violations() FROM PUBLIC;

DO $$
DECLARE
  v text;
BEGIN
  FOR v IN SELECT * FROM public.app_pool_reach_violations() ORDER BY 1 LOOP
    RAISE EXCEPTION '937: %', v;
  END LOOP;
END $$;

-- The writes this takes from the app pools run on migration_admin: refuse,
-- before the code switch, a database where it could not make them.
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN SELECT * FROM (VALUES
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
    LATERAL pg_catalog.unnest(pg_catalog.string_to_array(w.privs, ', ')) p(priv)
  LOOP
    -- One privilege at a time: has_table_privilege with a list is true if ANY is held.
    IF pg_catalog.to_regrole('migration_admin') IS NOT NULL AND NOT pg_catalog.has_table_privilege('migration_admin', r.tbl, r.priv) THEN
      RAISE EXCEPTION '937: migration_admin cannot % %, which the S-07d code writes on it', r.priv, r.tbl;
    END IF;
  END LOOP;
  IF pg_catalog.to_regrole('migration_admin') IS NOT NULL
     AND NOT pg_catalog.has_function_privilege('migration_admin', 'public.company_member_role_is_owner(text)', 'EXECUTE') THEN
    RAISE EXCEPTION '937: migration_admin cannot EXECUTE company_member_role_is_owner(text), which memberWrites.ts calls';
  END IF;
  -- Several of these tables force row security, with no policy for it.
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'migration_admin' AND NOT rolbypassrls) THEN
    RAISE EXCEPTION '937: migration_admin must bypass row security, which the S-07d code relies on';
  END IF;
END $$;
