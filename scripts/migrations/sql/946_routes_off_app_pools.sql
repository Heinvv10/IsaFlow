-- Migration 946 (S-07e part B): a company's outbound routes off the app pools.
--
-- SQL injected on either app pool can forge request.jwt.claims and
-- app.current_company_id (app_service's mirror policies admit every row), so a
-- row an app role may write is whatever the forged claims say. These tables
-- hold a company's standing routes to the outside:
--   webhook_endpoints        where a company's events are POSTed: a planted,
--                            re-pointed, re-subscribed or revived endpoint is
--                            a feed that outlives the injection;
--   imap_mirror_connections,
--   sent_mirror_connections  the mailbox a company's documents are read from:
--                            re-pointing a victim's connection at another host
--                            makes the scan cron decrypt the victim's stored
--                            mailbox password and present it to that host.
-- app_user (and through it app_service and both logins) loses INSERT, DELETE
-- and UPDATE on them; UPDATE comes back only on what a delivery or a scan
-- stamps. Creating, changing, disconnecting and deleting them, and a scan or
-- delivery that changes a connection's or endpoint's status, run on the
-- migration_admin pool from fixed statements keyed on the verified company
-- (S-07e part B). They stay readable: the scan cron and the dispatcher read
-- the encrypted credentials and signing secret, which the app's key decrypts.
-- No new SECURITY DEFINER function, so no new app_definer_reviews row.
-- Every rule joins app_pool_reach_violations() (920, 930, 932, 936, 937, 945).
--
-- Also in part B, in code only (no privilege): every storage read takes the
-- reading company and refuses a pointer not under `${companyId}/`
-- (supabaseStorage.ts). On 2026-10-25 every stored pointer on production was
-- under its own company's prefix (captured_documents 1266, customer_invoices
-- 1052, audit_trail_exports 1).
--
-- updated_at is not among the stamp columns: the table's touch trigger sets it
-- on every UPDATE, and a trigger's change to NEW needs no column privilege.
--
-- Deploy window: until the new code is live, and after a code-only rollback,
-- the previous release's writes are refused 42501 and write nothing: webhook
-- create, edit and delete; mirror connection create, edit, disconnect,
-- reconnect and delete. Scans and deliveries keep running and stamping, but two
-- of their failure paths now throw: on the OLD code a scan error's status write
-- is refused 42501 and the error ESCAPES the scan, so the cron tick stops at
-- that connection and the connections after it wait for the next tick; and a
-- failed delivery's stamp (the old UPDATE names is_active) is refused 42501, so
-- the event's remaining endpoints are skipped and failure_count is not stamped
-- (a success's stamp is unaffected). Production on
-- 2026-10-25: 0 webhook endpoints, 1 IMAP mirror connection (inactive),
-- 0 sent-mirror connections.
--
-- Named limits. The stamp columns stay writable under forged claims, so an
-- injected request can reset or raise a webhook endpoint's failure_count (delay
-- or hasten its auto-disable) and move a mailbox's scan_cursor (skip a
-- mailbox's mail, or re-ingest it; ingestion de-dupes by hash). That is an
-- integrity limit only: it changes no route and exposes no credential.
--
-- The preflight below (migration_admin's privileges and BYPASSRLS) is skipped
-- when the migration_admin role does not exist, as in 936, 937 and 945.
--
-- Rollback (break-glass, docs/runbooks/s07b-app-pool-login-roles.md), which
-- reopens the forgery and makes every deploy's check refuse until this
-- migration's state is restored:
--   GRANT INSERT, UPDATE, DELETE ON public.webhook_endpoints, public.imap_mirror_connections,
--     public.sent_mirror_connections TO app_user;

REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.webhook_endpoints, public.imap_mirror_connections,
  public.sent_mirror_connections FROM app_user, app_service, PUBLIC;
GRANT UPDATE (last_triggered_at, failure_count) ON public.webhook_endpoints TO app_user;
GRANT UPDATE (scan_cursor, last_scan_at, last_success_at, last_error, messages_ingested_total) ON public.imap_mirror_connections TO app_user;
GRANT UPDATE (scan_cursor, last_scan_at, last_success_at, last_error, messages_captured_total, messages_linked_total) ON public.sent_mirror_connections TO app_user;

-- app_service's mirrors follow app_user's privileges (915).
SELECT public.app_service_sync_policies();

-- 930's, 932's, 936's, 937's and 945's rules, plus 946's. A migration that
-- changes this function again keeps them.
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
  -- 930 (and 932, 936, 937, 945, 946): per table, the columns an app role may still INSERT or UPDATE, and
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
,
    -- 945: billing. What a plan, bundle or flag gives, which plan a company
    -- is on, its charges and mandate, and its Flows are read-only to the app
    -- pools; the writes run on migration_admin or platform_admin.
    ('public.plans',                         '{}', '{}', true,  false),
    ('public.plan_features',                 '{}', '{}', true,  false),
    ('public.feature_flags',                 '{}', '{}', true,  false),
    ('public.company_feature_overrides',     '{}', '{}', true,  false),
    ('public.flow_bundles',                  '{}', '{}', true,  false),
    ('public.flow_wallet',                   '{}', '{}', true,  false),
    ('public.flow_ledger',                   '{}', '{}', true,  false),
    ('public.flow_purchases',                '{}', '{}', true,  false),
    ('public.subscriptions',                 '{}', '{}', true,  false),
    ('public.subscription_charges',          '{}', '{}', true,  false),
    ('public.subscription_mandates',         '{}', '{}', true,  false),
    -- 945: a payment request's link is written once, at insert.
    ('public.paystack_payment_requests',
     '{id,company_id,purpose,customer_invoice_id,subscription_charge_id,flow_purchase_id,paystack_reference,paystack_access_code,paystack_transaction_id,authorization_url,amount_cents,currency,status,failure_reason,channel,payer_name,payer_email,created_at,updated_at,completed_at,mandate_id,portal_payment_link_id}',
     '{status,completed_at,paystack_transaction_id,channel,failure_reason,paystack_access_code,authorization_url,updated_at}',
                                                                  true,  false),
    -- 946: a company's outbound routes are written on migration_admin; the
    -- scans and the deliveries keep their stamps.
    ('public.webhook_endpoints',        '{}', '{last_triggered_at,failure_count}', true,  false),
    ('public.imap_mirror_connections',  '{}', '{scan_cursor,last_scan_at,last_success_at,last_error,messages_ingested_total}', true,  false),
    ('public.sent_mirror_connections',  '{}', '{scan_cursor,last_scan_at,last_success_at,last_error,messages_captured_total,messages_linked_total}', true,  false)
  ),
  -- 937: columns no app role may read on a table it otherwise reads.
  unreadable (tbl, col) AS (VALUES
    ('public.portal_access', 'password_hash'),
    -- 945: what a charge or an auto top-up is made with.
    ('public.flow_wallet', 'payment_method_token'),
    ('public.subscription_mandates', 'paystack_authorization_code'),
    ('public.subscription_mandates', 'paystack_customer_code'),
    ('public.subscription_mandates', 'paystack_subscription_code'),
    ('public.subscription_mandates', 'paystack_email_token'),
    ('public.subscription_charges', 'paystack_authorization_code'),
    ('public.paystack_payment_requests', 'paystack_authorization_code'),
    ('public.paystack_payment_requests', 'paystack_customer_code')
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
  -- 945: an object an app role creates is found, by an unqualified name, ahead
  -- of the real one: a temporary table outlives its transaction on a pooled
  -- connection, so the next request on it reads (or writes) the attacker's.
  SELECT pg_catalog.format('%s (reachable from an app pool login) can create %s objects in database %s', reach.rolname,
                           CASE p.priv WHEN 'TEMPORARY' THEN 'temporary' ELSE 'schema' END, pg_catalog.current_database())
    FROM reach CROSS JOIN (VALUES ('TEMPORARY'), ('CREATE')) p(priv)
   WHERE pg_catalog.has_database_privilege(reach.oid, pg_catalog.current_database(), p.priv)
  UNION ALL
  SELECT pg_catalog.format('%s (reachable from an app pool login) can CREATE in schema %s', reach.rolname, n.nspname)
    FROM reach
   CROSS JOIN pg_catalog.pg_namespace n
   WHERE n.nspname NOT LIKE 'pg\_%' AND n.nspname <> 'information_schema'
     AND pg_catalog.has_schema_privilege(reach.oid, n.oid, 'CREATE')
  UNION ALL
  SELECT pg_catalog.format('%s has no row security', t.tbl)
    FROM (VALUES ('waitlist_signups'), ('bureaus'), ('bureau_users'), ('bureau_companies')) t(tbl)
   WHERE NOT COALESCE((SELECT c.relrowsecurity FROM pg_catalog.pg_class c
                        WHERE c.oid = pg_catalog.to_regclass('public.' || t.tbl)), true)
$$;

DO $$
DECLARE
  v text;
BEGIN
  FOR v IN SELECT * FROM public.app_pool_reach_violations() ORDER BY 1 LOOP
    RAISE EXCEPTION '946: %', v;
  END LOOP;
END $$;

-- The writes this takes from the app pools run on migration_admin: refuse,
-- before the code switch, a database where it could not make them.
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN SELECT w.tbl, p.priv FROM (VALUES
      ('public.webhook_endpoints', 'SELECT, INSERT, UPDATE, DELETE'),
      ('public.imap_mirror_connections', 'SELECT, INSERT, UPDATE, DELETE'),
      ('public.sent_mirror_connections', 'SELECT, INSERT, UPDATE, DELETE')) w(tbl, privs),
    LATERAL pg_catalog.unnest(pg_catalog.string_to_array(w.privs, ', ')) p(priv)
  LOOP
    -- One privilege at a time: has_table_privilege with a list is true if ANY is held.
    IF pg_catalog.to_regrole('migration_admin') IS NOT NULL AND NOT pg_catalog.has_table_privilege('migration_admin', r.tbl, r.priv) THEN
      RAISE EXCEPTION '946: migration_admin cannot % %, which the code writes on it', r.priv, r.tbl;
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'migration_admin' AND NOT rolbypassrls) THEN
    RAISE EXCEPTION '946: migration_admin must bypass row security, which the part B code relies on';
  END IF;
END $$;
