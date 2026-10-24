-- Migration 936: a company's standing and billing columns off the app pools.
--
-- app_user (so both app pool logins: app_service inherits it) held INSERT,
-- UPDATE and DELETE on every column of public.companies. RLS admits an UPDATE
-- of any company the caller administers (companies_admin_update), and SQL
-- injected on either pool can forge request.jwt.claims (S-07c, migration 930)
-- and so administer any company. A tenant could then lift what the platform
-- holds it to:
--   status, suspended_at, suspended_reason, is_active
--                         un-suspend or un-delete a company; withAuth
--                         (liveCompanies.ts) admits it again;
--   plan_id, trial_ends_at, stripe_customer_id, payg_eligible
--                         move plan, extend a trial, set the admin's PAYG
--                         override;
--   is_demo, fx_documents_enabled, metadata, billing_email, billing_contact
--                         platform flags and billing contact.
-- Only privileges hold against forged claims, so the app roles lose INSERT,
-- UPDATE, DELETE and TRUNCATE on companies, and get UPDATE back on every
-- other column (company settings, onboarding, chase, CIPC, logo, PIS, client
-- query WhatsApp all write those) except id and created_at, which nothing
-- rewrites. annual_turnover_cents stays writable (Hein, 2026-10-24): a
-- self-declaration; an admin overrides PAYG with payg_eligible. Named limit:
-- paygEligibilityService.isEligible also counts a declared turnover under the
-- threshold as eligible; nothing calls it today, and whatever wires it in must
-- not trust the declaration.
-- No app-pool path inserts or deletes a company: onboarding creates one
-- through create_company_with_owner(jsonb) (a SECURITY DEFINER, owner rights;
-- it sets none of the 13), and RLS already gave app roles no INSERT or DELETE
-- policy. So neither comes back.
-- Who writes the 13 (census, PR body): the admin site on platform_admin
-- (adminCompanyService, companyLifecycleService, trialService, bulk-action,
-- PAYG eligibility, waitlist promote), and signup's provisionTenant on
-- migration_admin (is_active, payg_eligible, trial_ends_at). No code change.
--
-- The grant-back is computed (every column but the 13, id and created_at),
-- and the rule in app_pool_reach_violations() lists the allowed columns by
-- name, so the two
-- are checked against each other below. A column added to companies later
-- gets no app privilege (UPDATE is column-level now); granting it one is a
-- violation until a migration adds it to the rule. That is intended: someone
-- decides whether a tenant may write it.
-- No new SECURITY DEFINER function, so no new app_definer_reviews row.
-- The fx_documents_enabled triggers (871) and the change-history trigger
-- (888) are unchanged: they guard what is written, not who may write. 871's
-- refusal now fires only for a role that holds the column, which app roles
-- no longer do.
--
-- Production: companies is owned by migration_admin there (postgres on dev and
-- CI). The deploy role postgres is a member of it, so the REVOKE and GRANT
-- below run as the owner. The violations check refuses the migration if any
-- revoke did not take.
--
-- Deploy window: migrations apply before the code switch. The previous
-- release writes none of the 13 on an app pool and inserts or deletes no
-- company there (census), so nothing it does changes, before or after a
-- code-only rollback.
--
-- Rollback (break-glass, in docs/runbooks/s07b-app-pool-login-roles.md):
--   GRANT INSERT, UPDATE, DELETE ON public.companies TO app_user;
-- which reopens the un-suspend, and makes every deploy's
-- app_pool_reach_violations() check refuse until this migration's state is
-- restored.

REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.companies FROM app_user, app_service, PUBLIC;

DO $$
DECLARE
  v_cols text;
BEGIN
  SELECT pg_catalog.string_agg(pg_catalog.quote_ident(a.attname), ', ' ORDER BY a.attnum) INTO v_cols
    FROM pg_catalog.pg_attribute a
   WHERE a.attrelid = 'public.companies'::regclass AND a.attnum > 0 AND NOT a.attisdropped
     AND a.attname NOT IN ('status', 'suspended_at', 'suspended_reason', 'is_active', 'plan_id', 'trial_ends_at',
                           'stripe_customer_id', 'payg_eligible', 'is_demo', 'fx_documents_enabled', 'metadata',
                           'billing_email', 'billing_contact', 'id', 'created_at');
  EXECUTE pg_catalog.format('GRANT UPDATE (%s) ON public.companies TO app_user', v_cols);
END $$;

-- 932's function, every rule kept, plus 936's: companies is readable, never
-- inserted, deleted or truncated, and UPDATE only on the columns listed. A
-- migration that changes this function again keeps them.
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
  -- 930 (and 932, 936): per table, the columns an app role may still INSERT or UPDATE, and
  -- whether it may read and DELETE. Every other column privilege, DELETE where
  -- not allowed, and TRUNCATE anywhere, is a violation.
  rules (tbl, may_insert, may_update, may_read, may_delete) AS (VALUES
    ('public.company_invitations',        '{}'::text[], '{}'::text[],                    true,  true),
    ('public.company_users',              '{}',         '{role}',                        true,  true),
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
                                                                                     true,  false)
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

-- Also catches the computed grant-back and the listed rule disagreeing: a
-- column granted above but not listed is a violation here.
DO $$
DECLARE
  v text;
BEGIN
  FOR v IN SELECT * FROM public.app_pool_reach_violations() ORDER BY 1 LOOP
    RAISE EXCEPTION '936: %', v;
  END LOOP;
END $$;

-- The 13 are written on platform_admin (the admin site) and migration_admin
-- (signup), and onboarding inserts through the definer, as its owner: refuse,
-- before the code switch, a database where any of them could not.
DO $$
DECLARE
  r record;
  v_owner name;
BEGIN
  SELECT p.proowner::regrole::name INTO v_owner FROM pg_catalog.pg_proc p
   WHERE p.oid = pg_catalog.to_regprocedure('public.create_company_with_owner(jsonb)');
  FOR r IN SELECT * FROM (VALUES
      ('platform_admin', 'SELECT', 'id,status,suspended_at,suspended_reason,trial_ends_at,plan_id,payg_eligible'),
      ('platform_admin', 'UPDATE', 'status,suspended_at,suspended_reason,is_active,plan_id,trial_ends_at,stripe_customer_id,'
                                   || 'payg_eligible,is_demo,fx_documents_enabled,metadata,billing_email,billing_contact,updated_at'),
      ('platform_admin', 'INSERT', 'name,registered_name,trading_name,email,phone,country,default_currency,status,'
                                   || 'annual_turnover_cents,payg_eligible'),
      ('migration_admin', 'SELECT', 'id,financial_year_start'),
      ('migration_admin', 'INSERT', 'name,email,phone,is_active,annual_turnover_cents,payg_eligible,trial_ends_at'),
      (v_owner, 'INSERT', 'name,registered_name,trading_name,registration_number,vat_number,tax_number,email,phone,website,'
                          || 'address_line1,address_line2,city,province,postal_code,country,logo_data,bank_name,'
                          || 'bank_account_number,bank_branch_code,bank_account_type,financial_year_start,vat_period,'
                          || 'vat_period_alignment,vat_system_type,default_currency')) w(role, priv, cols),
    LATERAL pg_catalog.unnest(pg_catalog.string_to_array(w.cols, ',')) c(col)
  LOOP
    IF r.role IS NULL THEN
      RAISE EXCEPTION '936: create_company_with_owner(jsonb) is missing, and onboarding creates companies through it';
    END IF;
    -- One privilege and column at a time: a list is true if ANY is held.
    IF pg_catalog.to_regrole(r.role) IS NOT NULL
       AND NOT pg_catalog.has_column_privilege(r.role, 'public.companies', r.col, r.priv) THEN
      RAISE EXCEPTION '936: % cannot % companies.%, which the code writes on it', r.role, r.priv, r.col;
    END IF;
  END LOOP;
  -- The admin writes reach every company, and provisionTenant inserts with no
  -- membership yet: both rely on bypassing row security.
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname IN ('migration_admin', 'platform_admin') AND NOT rolbypassrls) THEN
    RAISE EXCEPTION '936: migration_admin and platform_admin must bypass row security, which the company writes rely on';
  END IF;
END $$;
