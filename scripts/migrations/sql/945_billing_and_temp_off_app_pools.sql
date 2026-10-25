-- Migration 945 (S-07e): the billing tables, and TEMPORARY, off the app pools.
--
-- SQL injected on either app pool can forge request.jwt.claims and
-- app.current_company_id (app_service's mirror policies admit every row), and
-- a tenant needs no forgery at all for its own rows. app_user (and through it
-- app_service and both logins) held INSERT, UPDATE and DELETE on:
--   flow_wallet             the Flows balance, and payment_method_token: with
--                           one set, auto top-up (v1, no gateway) credits a
--                           bundle with no payment;
--   flow_ledger,
--   flow_purchases          the Flows record, and the purchase a Paystack
--                           payment completes (its flows and price);
--   flow_bundles, plans,
--   plan_features,
--   feature_flags,
--   company_feature_overrides
--                           what a bundle, a plan or a flag gives; plans,
--                           plan_features and feature_flags have no row
--                           security, so renaming the PAYG plan stopped
--                           metering for every tenant;
--   subscriptions           which plan a company is on: only PAYG is metered;
--   subscription_charges,
--   subscription_mandates   the charges, and the Paystack authorisation a
--                           recurring charge is made with (a mandate pointed
--                           at another company's authorisation charges that
--                           company's card).
--   paystack_payment_requests the link from a Paystack payment to the purchase,
--                           charge or mandate it pays for, which the webhook
--                           then acts on as migration_admin: rewriting a
--                           victim's paid request to the attacker's company and
--                           purchase credited the attacker with the victim's
--                           money. It stays app-insertable (the checkouts
--                           write it), but no app role may change a link after
--                           insert, delete a request, or read the card codes it
--                           used to copy; the webhook and mandate verify also
--                           check the link against the checkout's own
--                           Paystack metadata (paystackLinkBinding.ts).
-- All of the others are now read-only to the app roles. Their writes run on the
-- migration_admin pool (metering, purchases, auto top-up settings, the
-- subscription and charge crons, the Paystack webhook, mandate create, verify
-- and revoke) or stay on platform_admin (the admin site), from fixed
-- statements keyed on the verified request (S-07e). No app role may read the
-- columns a charge is made with.
--
-- TEMPORARY: the database's default ACL gives every role TEMPORARY through
-- PUBLIC. A temporary object outlives its transaction on a pooled connection,
-- and an unqualified name finds it first: CREATE TEMP TABLE companies made
-- withAuth admit a suspended company for every later request on that
-- connection (936's breaker). Production refuses app-login DDL with an event
-- trigger (runbook step 2), which every deploy checks; this takes the
-- privilege too, so it no longer rests on a trigger outside the migrations.
-- PUBLIC loses TEMPORARY on this database; every role that had it through
-- PUBLIC, other than the roles the app logins reach, is granted it back, so
-- nothing else changes (a role created later must be granted it). The AR
-- view refresh creates its temp table inside a definer, as the definer's
-- owner, who keeps it. The rule also refuses CREATE on the database or on any
-- schema for those roles (none holds either today).
--
-- No new SECURITY DEFINER function, so no new app_definer_reviews row.
-- Every rule joins app_pool_reach_violations() (920, 930, 932, 936, 937),
-- which this migration and every deploy (scripts/check-app-login-roles.ts) run.
--
-- Deploy window: migrations apply before the code switch. Until the new code
-- is live, and after a code-only rollback, the previous release's billing
-- writes are refused 42501 and write nothing: metered requests of a PAYG
-- company answer 500 (production has no PAYG company, no wallet and no
-- mandate today), Flow purchases and auto top-up settings, mandate create,
-- verify and revoke, the subscription-charge and Flow-month crons, and the
-- Paystack webhook's settlement (Paystack retries a failed webhook). The
-- old webhook and verify also wrote card codes onto payment requests: those
-- statements now 42501 too. The admin site's billing writes keep working.
--
-- Rollback (break-glass, in docs/runbooks/s07b-app-pool-login-roles.md), which
-- reopens the forgery and makes every deploy's check refuse until this
-- migration's state is restored:
--   GRANT SELECT, INSERT, UPDATE, DELETE ON public.flow_wallet, public.flow_ledger,
--     public.flow_purchases, public.flow_bundles, public.plans, public.plan_features,
--     public.feature_flags, public.company_feature_overrides, public.subscriptions,
--     public.subscription_charges, public.subscription_mandates, public.paystack_payment_requests TO app_user;
--   GRANT TEMPORARY ON DATABASE <this database> TO PUBLIC;

REVOKE ALL ON public.plans, public.plan_features, public.feature_flags, public.company_feature_overrides,
  public.flow_bundles, public.flow_ledger, public.flow_purchases, public.subscriptions
  FROM app_user, app_service, PUBLIC;
GRANT SELECT ON public.plans, public.plan_features, public.feature_flags, public.company_feature_overrides,
  public.flow_bundles, public.flow_ledger, public.flow_purchases, public.subscriptions TO app_user;

-- paystack_payment_requests: INSERT and SELECT on every column but the card's
-- codes (nothing reads them back; one production row holds one, left in place
-- and unreadable), UPDATE only on its status and checkout columns.
REVOKE ALL ON public.paystack_payment_requests FROM app_user, app_service, PUBLIC;
DO $$
DECLARE
  cols text;
BEGIN
  SELECT pg_catalog.string_agg(pg_catalog.quote_ident(a.attname), ', ' ORDER BY a.attnum) INTO cols
    FROM pg_catalog.pg_attribute a
   WHERE a.attrelid = 'public.paystack_payment_requests'::regclass AND a.attnum > 0 AND NOT a.attisdropped
     AND a.attname NOT IN ('paystack_authorization_code', 'paystack_customer_code');
  EXECUTE pg_catalog.format('GRANT SELECT (%1$s), INSERT (%1$s) ON public.paystack_payment_requests TO app_user', cols);
END $$;
GRANT UPDATE (status, completed_at, paystack_transaction_id, channel, failure_reason, paystack_access_code, authorization_url, updated_at) ON public.paystack_payment_requests TO app_user;

-- SELECT back on every column but the ones a charge or a top-up is made with,
-- computed from the catalogue so a column added later is decided by its own migration.
DO $$
DECLARE
  r record;
  cols text;
BEGIN
  FOR r IN SELECT * FROM (VALUES
      ('flow_wallet', ARRAY['payment_method_token']),
      ('subscription_mandates', ARRAY['paystack_authorization_code', 'paystack_customer_code', 'paystack_subscription_code',
                                      'paystack_email_token']),
      ('subscription_charges', ARRAY['paystack_authorization_code'])) t(tbl, hidden)
  LOOP
    EXECUTE pg_catalog.format('REVOKE ALL ON public.%I FROM app_user, app_service, PUBLIC', r.tbl);
    SELECT pg_catalog.string_agg(pg_catalog.quote_ident(a.attname), ', ' ORDER BY a.attnum) INTO cols
      FROM pg_catalog.pg_attribute a
     WHERE a.attrelid = pg_catalog.to_regclass('public.' || r.tbl) AND a.attnum > 0 AND NOT a.attisdropped
       AND NOT (a.attname::text = ANY (r.hidden));
    EXECUTE pg_catalog.format('GRANT SELECT (%s) ON public.%I TO app_user', cols, r.tbl);
  END LOOP;
END $$;

-- app_service's mirrors follow app_user's privileges (915).
SELECT public.app_service_sync_policies();

-- TEMPORARY: off PUBLIC, back to every role that is not an app pool's.
DO $$
DECLARE
  r record;
BEGIN
  EXECUTE pg_catalog.format('REVOKE TEMPORARY ON DATABASE %I FROM PUBLIC', pg_catalog.current_database());
  FOR r IN SELECT rolname FROM pg_catalog.pg_roles
            WHERE rolname !~ '^pg_' AND NOT rolsuper AND rolname NOT IN ('app_user', 'app_service')
              AND NOT (pg_catalog.to_regrole('isaflow_app') IS NOT NULL AND pg_catalog.pg_has_role('isaflow_app', oid, 'MEMBER'))
              AND NOT (pg_catalog.to_regrole('isaflow_service') IS NOT NULL AND pg_catalog.pg_has_role('isaflow_service', oid, 'MEMBER'))
            ORDER BY 1
  LOOP
    EXECUTE pg_catalog.format('GRANT TEMPORARY ON DATABASE %I TO %I', pg_catalog.current_database(), r.rolname);
  END LOOP;
END $$;

-- 930's, 932's, 936's and 937's rules, plus 945's. A migration that changes
-- this function again keeps them.
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
  -- 930 (and 932, 936, 937, 945): per table, the columns an app role may still INSERT or UPDATE, and
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
                                                                  true,  false)
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
    RAISE EXCEPTION '945: %', v;
  END LOOP;
END $$;

-- The writes this takes from the app pools run on migration_admin, and the
-- admin site's stay on platform_admin: refuse, before the code switch, a
-- database where either could not make them, or where the AR view refresh
-- could not create its temp table.
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN SELECT w.who, w.tbl, p.priv FROM (VALUES
      ('migration_admin', 'public.flow_wallet', 'SELECT, INSERT, UPDATE'),
      ('migration_admin', 'public.flow_ledger', 'SELECT, INSERT'),
      ('migration_admin', 'public.flow_purchases', 'SELECT, INSERT, UPDATE'),
      ('migration_admin', 'public.flow_bundles', 'SELECT'),
      ('migration_admin', 'public.plans', 'SELECT'),
      ('migration_admin', 'public.subscriptions', 'SELECT, UPDATE'),
      ('migration_admin', 'public.subscription_charges', 'SELECT, INSERT, UPDATE'),
      ('migration_admin', 'public.subscription_mandates', 'SELECT, INSERT, UPDATE'),
      ('migration_admin', 'public.companies', 'SELECT'),
      ('migration_admin', 'public.users', 'SELECT'),
      ('migration_admin', 'public.subscriptions', 'INSERT'),
      ('platform_admin', 'public.plans', 'SELECT, INSERT, UPDATE'),
      ('platform_admin', 'public.feature_flags', 'SELECT, UPDATE'),
      ('platform_admin', 'public.company_feature_overrides', 'SELECT, INSERT, UPDATE, DELETE'),
      ('platform_admin', 'public.subscriptions', 'SELECT, INSERT, UPDATE'),
      ('platform_admin', 'public.subscription_charges', 'SELECT, UPDATE'),
      ('platform_admin', 'public.flow_wallet', 'SELECT, INSERT, UPDATE'),
      ('platform_admin', 'public.flow_ledger', 'SELECT, INSERT'),
      ('platform_admin', 'public.subscription_mandates', 'SELECT'),
      ('platform_admin', 'public.flow_bundles', 'SELECT, INSERT, UPDATE')) w(who, tbl, privs),
    LATERAL pg_catalog.unnest(pg_catalog.string_to_array(w.privs, ', ')) p(priv)
  LOOP
    -- One privilege at a time: has_table_privilege with a list is true if ANY is held.
    IF pg_catalog.to_regrole(r.who) IS NOT NULL AND NOT pg_catalog.has_table_privilege(r.who, r.tbl, r.priv) THEN
      RAISE EXCEPTION '945: % cannot % %, which the code writes on it', r.who, r.priv, r.tbl;
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname IN ('migration_admin', 'platform_admin') AND NOT rolbypassrls) THEN
    RAISE EXCEPTION '945: migration_admin and platform_admin must bypass row security, which the billing code relies on';
  END IF;
  FOR r IN SELECT p.oid::regprocedure AS fn, p.proowner::regrole AS owner FROM pg_catalog.pg_proc p
            WHERE p.oid IN (pg_catalog.to_regprocedure('public.refresh_customer_invoice_view_summary()'),
                            pg_catalog.to_regprocedure('public.refresh_customer_invoice_view_summary_if_due()'))
              AND NOT pg_catalog.has_database_privilege(p.proowner, pg_catalog.current_database(), 'TEMPORARY')
  LOOP
    RAISE EXCEPTION '945: % (owner %) cannot create the temporary table REFRESH ... CONCURRENTLY needs', r.fn, r.owner;
  END LOOP;
  -- REFRESH ... CONCURRENTLY runs as the materialized view's owner.
  FOR r IN SELECT c.oid::regclass AS mv, c.relowner::regrole AS owner FROM pg_catalog.pg_class c
            WHERE c.relkind = 'm' AND c.oid = pg_catalog.to_regclass('public.customer_invoice_view_summary')
              AND NOT pg_catalog.has_database_privilege(c.relowner, pg_catalog.current_database(), 'TEMPORARY')
  LOOP
    RAISE EXCEPTION '945: % (owner %) cannot create the temporary table REFRESH ... CONCURRENTLY needs', r.mv, r.owner;
  END LOOP;
END $$;
