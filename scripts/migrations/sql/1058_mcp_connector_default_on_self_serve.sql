-- 1058: the MCP connector is on by default for NEW companies, and a company owner or admin can switch it on or off.
--
-- WHAT
--   company_feature_overrides.set_via: who wrote an override row. NULL (every row written before 1058, and every
--     row pre-1058 code writes) reads as platform_admin. Catalogue-only column, no default, no rewrite.
--   company_feature_overrides_stamp_update (BEFORE UPDATE trigger, SECURITY INVOKER): every UPDATE of the table
--     is stamped platform_admin. The only UPDATE of this table is the platform-admin upsert
--     (featureFlagService.setCompanyFeatureOverride); the two functions below never UPDATE (default-on is
--     INSERT ... ON CONFLICT DO NOTHING, the toggle is DELETE + INSERT). So after a code-only rollback an admin
--     OFF written by pre-1058 code over a company_admin row still becomes a lock.
--   enable_mcp_connector_default(company, actor), SECURITY INVOKER: one mcp_connector row (enabled, reason
--     'Default on for new companies', set_via default_new_company) for a company created in the last 10 minutes;
--     never overwrites (ON CONFLICT DO NOTHING), never raises. EXECUTE: migration_admin (tenant provisioning),
--     platform_admin (admin create and waitlist promote), and the owner of create_company_with_owner. Not app_user:
--     app_user reaches it only through create_company_with_owner, which runs as its owner.
--   create_company_with_owner(jsonb): the 513 body verbatim plus one PERFORM of the above. Re-registered (930).
--   mcp_connector_self_serve_set(company, enabled), SECURITY DEFINER owned by migration_admin, EXECUTE app_user:
--     the settings page toggle. Own session company only, signed-in owner or admin only (checked in SQL; the route
--     checks the role too), hard-coded to mcp_connector.
--
-- PRECEDENCE (also in src/lib/mcp/connectorSetting.ts)
--   1. hasFeature is unchanged: override row, else is_global, else plan. mcp_connector stays non-global, in no plan.
--   2. A row with enabled = false and set_via NULL or platform_admin is a compliance lock: owners and admins
--      cannot switch it on ("Switched off by IsaFlow. Contact IsaFlow support.").
--   3. Owners and admins can always switch it OFF, whoever switched it on.
--   4. A platform admin can always set either state; that write is stamped platform_admin.
--   5. A platform admin REMOVING the row is not a lock: with no row the connector is off and an owner may switch
--      it on. To lock, set OFF.
--   6. Existing companies with no row are off and may self-serve on. This is not a backfill.
--
-- NO BACKFILL: this file contains no INSERT, UPDATE or DELETE over existing companies or their overrides.
--
-- ADMIN-CREATED COMPANIES: a company a platform admin creates (admin create, waitlist promote) has no owner yet,
--   so its default-on row carries the platform admin's user id in set_by.
--
-- RESIDUAL (930's header): the toggle's role check is keyed on the session claims. Under SQL injection with
--   forged claims it could flip the connector of a company that is not platform-locked. It mints no credential:
--   every /api/mcp call still needs a real bearer, and tokens are written on migration_admin since 930.
--
-- DEPLOY WINDOW: migrations apply before the colour switch. Pre-1058 code never names set_via: its admin INSERT
--   leaves NULL (read as platform_admin) and its admin UPDATE is stamped by the trigger; it never calls the two new
--   functions. Old code on the new schema already gets default-on through create_company_with_owner (harmless).
--   After a code-only rollback the same holds; self-serve rows stay and hasFeature honours them.
--
-- ROLLBACK (by hand, code first, in this order):
--   -- 1. List what self-serve and default-on wrote (the column carries the provenance):
--   SELECT company_id, enabled, set_via, set_by, created_at FROM public.company_feature_overrides
--    WHERE set_via IN ('company_admin', 'default_new_company') ORDER BY set_via, created_at;
--   -- 2. Default-on rows only, mcp_connector only. Platform-admin rows (set_via NULL or platform_admin) and
--   --    every other feature's rows are never touched, whatever their reason.
--   DELETE FROM public.company_feature_overrides o USING public.feature_flags ff
--    WHERE ff.id = o.feature_id AND ff.code = 'mcp_connector' AND o.set_via = 'default_new_company';
--   -- 3. Optional: company_admin rows (mcp_connector only). Deleting an ON row switches that company's connector off.
--   -- DELETE FROM public.company_feature_overrides o USING public.feature_flags ff
--   --  WHERE ff.id = o.feature_id AND ff.code = 'mcp_connector' AND o.set_via = 'company_admin';
--   -- 4. Restore create_company_with_owner: re-run its CREATE OR REPLACE from 513, then
--   --    sed -n '/^CREATE OR REPLACE FUNCTION public.create_company_with_owner/,/^\$\$;/p' scripts/migrations/sql/513_create_company_writes_vat_system_type.sql | psql ...
--   UPDATE public.app_definer_reviews SET body_md5 = public.app_definer_hash('public.create_company_with_owner(jsonb)'::regprocedure),
--          writes = 'a NEW company, with its caller as owner (company_users); grants nothing over an existing one'
--    WHERE signature = 'create_company_with_owner(jsonb)';
--   DROP FUNCTION IF EXISTS public.mcp_connector_self_serve_set(uuid, boolean);
--   DELETE FROM public.app_definer_reviews WHERE signature = 'mcp_connector_self_serve_set(uuid,boolean)';
--   DROP FUNCTION IF EXISTS public.enable_mcp_connector_default(uuid, uuid);
--   DROP TRIGGER IF EXISTS company_feature_overrides_stamp_update ON public.company_feature_overrides;
--   DROP FUNCTION IF EXISTS public.company_feature_overrides_stamp_update();
--   ALTER TABLE public.company_feature_overrides DROP CONSTRAINT IF EXISTS company_feature_overrides_set_via_check;
--   ALTER TABLE public.company_feature_overrides DROP COLUMN IF EXISTS set_via;   -- only once step 3 ran or the rows are accepted unstamped

SET LOCAL lock_timeout = '5s';

-- ── set_via ─────────────────────────────────────────────────────────────────

ALTER TABLE public.company_feature_overrides ADD COLUMN IF NOT EXISTS set_via TEXT;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint
                  WHERE conrelid = 'public.company_feature_overrides'::pg_catalog.regclass
                    AND conname = 'company_feature_overrides_set_via_check') THEN
    ALTER TABLE public.company_feature_overrides ADD CONSTRAINT company_feature_overrides_set_via_check
      CHECK (set_via IS NULL OR set_via IN ('platform_admin', 'company_admin', 'default_new_company'));
  END IF;
END $$;

COMMENT ON COLUMN public.company_feature_overrides.set_via IS
  'Who wrote this override: platform_admin, company_admin (mcp_connector_self_serve_set) or default_new_company (enable_mcp_connector_default). NULL = written before 1058 or by pre-1058 code: read as platform_admin.';

-- ── the stamp trigger ───────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.company_feature_overrides_stamp_update()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  -- The only UPDATE of this table is the platform-admin upsert (1058 header).
  NEW.set_via := 'platform_admin';
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.company_feature_overrides_stamp_update() FROM PUBLIC;

DROP TRIGGER IF EXISTS company_feature_overrides_stamp_update ON public.company_feature_overrides;
CREATE TRIGGER company_feature_overrides_stamp_update
  BEFORE UPDATE ON public.company_feature_overrides
  FOR EACH ROW EXECUTE FUNCTION public.company_feature_overrides_stamp_update();

-- ── default-on for a new company ────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.enable_mcp_connector_default(p_company uuid, p_actor uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  -- New companies only (never a backfill tool), never overwrites, never raises: a missing flag row or an older
  -- company writes nothing and answers false. p_actor is the new owner, or the platform admin who created it.
  INSERT INTO public.company_feature_overrides (company_id, feature_id, enabled, reason, set_by, set_via, created_at)
  SELECT c.id, ff.id, true, 'Default on for new companies', p_actor, 'default_new_company', pg_catalog.now()
    FROM public.companies c
    JOIN public.feature_flags ff ON ff.code = 'mcp_connector'
   WHERE c.id = p_company
     AND p_actor IS NOT NULL
     AND c.created_at >= pg_catalog.now() - interval '10 minutes'
  ON CONFLICT (company_id, feature_id) DO NOTHING;
  RETURN FOUND;
END;
$$;
ALTER FUNCTION public.enable_mcp_connector_default(uuid, uuid) OWNER TO migration_admin;
REVOKE ALL ON FUNCTION public.enable_mcp_connector_default(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.enable_mcp_connector_default(uuid, uuid) TO migration_admin;
DO $$ BEGIN
  IF pg_catalog.to_regrole('platform_admin') IS NOT NULL THEN
    GRANT EXECUTE ON FUNCTION public.enable_mcp_connector_default(uuid, uuid) TO platform_admin;
  END IF;
  IF pg_catalog.to_regrole('app_service') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.enable_mcp_connector_default(uuid, uuid) FROM app_service;
  END IF;
  REVOKE ALL ON FUNCTION public.enable_mcp_connector_default(uuid, uuid) FROM app_user;
END $$;

-- ── create_company_with_owner: the 513 body verbatim plus one PERFORM ────────

CREATE OR REPLACE FUNCTION public.create_company_with_owner(payload jsonb)
  RETURNS public.companies
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = public, pg_temp
AS $$
DECLARE
  caller_id        text := auth.uid();
  is_first_company boolean;
  new_row          public.companies;
BEGIN
  IF caller_id IS NULL OR caller_id = '' THEN
    RAISE EXCEPTION 'create_company_with_owner: not authenticated';
  END IF;

  IF COALESCE(payload->>'name', '') = '' THEN
    RAISE EXCEPTION 'create_company_with_owner: name is required';
  END IF;

  INSERT INTO public.companies (
    name, registered_name, trading_name, registration_number, vat_number, tax_number,
    email, phone, website,
    address_line1, address_line2, city, province, postal_code, country,
    logo_data,
    bank_name, bank_account_number, bank_branch_code, bank_account_type,
    financial_year_start, vat_period, vat_period_alignment, vat_system_type, default_currency
  ) VALUES (
    payload->>'name',
    payload->>'name',
    payload->>'tradingName',
    payload->>'registrationNumber',
    payload->>'vatNumber',
    payload->>'taxNumber',
    payload->>'email',
    payload->>'phone',
    payload->>'website',
    payload->>'addressLine1',
    payload->>'addressLine2',
    payload->>'city',
    payload->>'province',
    payload->>'postalCode',
    COALESCE(payload->>'country', 'South Africa'),
    payload->>'logoData',
    payload->>'bankName',
    payload->>'bankAccountNumber',
    payload->>'bankBranchCode',
    COALESCE(payload->>'bankAccountType', 'current'),
    COALESCE((payload->>'financialYearStart')::int, 3),
    COALESCE(payload->>'vatPeriod', 'bi-monthly'),
    COALESCE(payload->>'vatPeriodAlignment', 'odd'),
    -- A company created as "not registered for VAT" sends vatPeriod='none';
    -- keep vat_system_type in step so the two columns never disagree, because
    -- the AFS accounting-policy notes read vat_system_type.
    COALESCE(
      payload->>'vatSystemType',
      CASE WHEN LOWER(TRIM(COALESCE(payload->>'vatPeriod', ''))) = 'none'
           THEN 'none' ELSE 'invoice' END
    ),
    COALESCE(payload->>'defaultCurrency', 'ZAR')
  ) RETURNING * INTO new_row;

  SELECT NOT EXISTS (
    SELECT 1 FROM public.company_users WHERE user_id = caller_id
  ) INTO is_first_company;

  INSERT INTO public.company_users (company_id, user_id, role, is_default)
  VALUES (new_row.id, caller_id, 'owner', is_first_company);

  -- 1058: the MCP connector is on by default for a new company (its owner is set_by).
  PERFORM public.enable_mcp_connector_default(new_row.id, caller_id::uuid);

  -- New: seed the default taxonomy so every workbench/portfolio/AFS feature
  -- has the GL accounts and fiscal periods it expects on day 1.
  PERFORM public.seed_company_default_taxonomy(new_row.id);

  RETURN new_row;
END;
$$;

REVOKE ALL ON FUNCTION public.create_company_with_owner(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.create_company_with_owner(jsonb) TO app_user, migration_admin;

-- The owner of create_company_with_owner (never set by a migration: read it, do not assume) runs the default-on
-- function and its INSERT. Grant what it needs, then refuse to ship without it.
DO $$
DECLARE
  v_owner text := (SELECT pg_catalog.pg_get_userbyid(p.proowner) FROM pg_catalog.pg_proc p
                    WHERE p.oid = 'public.create_company_with_owner(jsonb)'::pg_catalog.regprocedure);
BEGIN
  EXECUTE pg_catalog.format('GRANT EXECUTE ON FUNCTION public.enable_mcp_connector_default(uuid, uuid) TO %I', v_owner);
  IF NOT pg_catalog.has_function_privilege(v_owner, 'public.enable_mcp_connector_default(uuid, uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION '1058: % (owner of create_company_with_owner) cannot EXECUTE enable_mcp_connector_default', v_owner;
  END IF;
  IF NOT pg_catalog.has_table_privilege(v_owner, 'public.company_feature_overrides', 'INSERT') THEN
    RAISE EXCEPTION '1058: % (owner of create_company_with_owner) cannot INSERT company_feature_overrides', v_owner;
  END IF;
  IF NOT pg_catalog.has_table_privilege(v_owner, 'public.feature_flags', 'SELECT') THEN
    RAISE EXCEPTION '1058: % (owner of create_company_with_owner) cannot SELECT feature_flags', v_owner;
  END IF;
END $$;

-- migration_admin (tenant provisioning, the toggle's owner) and platform_admin (admin create): one privilege at a time.
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT * FROM (VALUES
      ('migration_admin', 'public.company_feature_overrides', 'INSERT'),
      ('migration_admin', 'public.company_feature_overrides', 'SELECT'),
      ('migration_admin', 'public.company_feature_overrides', 'DELETE'),
      ('migration_admin', 'public.feature_flags', 'SELECT'),
      ('migration_admin', 'public.company_users', 'SELECT'),
      ('migration_admin', 'public.companies', 'SELECT'),
      ('platform_admin', 'public.company_feature_overrides', 'INSERT'),
      ('platform_admin', 'public.company_feature_overrides', 'SELECT'),
      ('platform_admin', 'public.company_feature_overrides', 'UPDATE'),
      ('platform_admin', 'public.company_feature_overrides', 'DELETE'),
      ('platform_admin', 'public.feature_flags', 'SELECT'),
      ('platform_admin', 'public.companies', 'SELECT')) w(role, tbl, priv)
  LOOP
    CONTINUE WHEN pg_catalog.to_regrole(r.role) IS NULL;
    IF NOT pg_catalog.has_table_privilege(r.role, r.tbl, r.priv) THEN
      RAISE EXCEPTION '1058: % cannot % %, which the MCP connector default-on or toggle writes on it', r.role, r.priv, r.tbl;
    END IF;
  END LOOP;
END $$;

-- ── the owner/admin toggle ──────────────────────────────────────────────────

-- Results: forbidden (not signed in, not the session company, not an owner or admin of it), locked (a platform
-- admin switched it off and this asks for ON: nothing written), unchanged (already in that state: nothing
-- written, so a platform-admin ON stamp is kept), ok (written; was_enabled / was_set_via are the previous row's,
-- NULL when there was none). OFF is always allowed.
CREATE OR REPLACE FUNCTION public.mcp_connector_self_serve_set(p_company uuid, p_enabled boolean)
RETURNS TABLE (result text, was_enabled boolean, was_set_via text)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_uid text := auth.uid();
  v_feature uuid;
  v_had boolean := false;
  v_was boolean;
  v_was_via text;
BEGIN
  IF v_uid IS NULL OR v_uid = '' OR p_company IS NULL OR p_enabled IS NULL THEN
    RETURN QUERY SELECT 'forbidden'::text, NULL::boolean, NULL::text; RETURN;
  END IF;
  IF p_company IS DISTINCT FROM app.current_company_id() THEN
    RETURN QUERY SELECT 'forbidden'::text, NULL::boolean, NULL::text; RETURN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.company_users cu
                  WHERE cu.company_id = p_company AND cu.user_id = v_uid AND cu.role IN ('owner', 'admin')) THEN
    RETURN QUERY SELECT 'forbidden'::text, NULL::boolean, NULL::text; RETURN;
  END IF;

  SELECT ff.id INTO v_feature FROM public.feature_flags ff WHERE ff.code = 'mcp_connector';
  IF v_feature IS NULL THEN
    RETURN QUERY SELECT 'forbidden'::text, NULL::boolean, NULL::text; RETURN;
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('mcp_connector_self_serve:' || p_company::text, 0));

  -- No row lock: FOR SHARE / FOR UPDATE need UPDATE privilege, which migration_admin is not given here. The
  -- advisory lock above is the serialisation: every application writer of this row takes it first (this
  -- function, and both platform-admin writes in featureFlagService), so no other write can land between this
  -- read and the DELETE + INSERT below, and this read (a fresh READ COMMITTED snapshot) sees every write committed
  -- before it. Not serialised, and harmless: enable_mcp_connector_default (a company no other session can see
  -- yet), pre-1058 code during the deploy window, and the dev-only scripts/sandbox reviewer script.
  SELECT o.enabled, COALESCE(o.set_via, 'platform_admin') INTO v_was, v_was_via
    FROM public.company_feature_overrides o
   WHERE o.company_id = p_company AND o.feature_id = v_feature;
  v_had := FOUND;

  IF v_had THEN
    -- The compliance lock: a platform admin's OFF (set_via NULL reads as platform_admin) cannot be switched on here.
    IF p_enabled AND NOT v_was AND v_was_via = 'platform_admin' THEN
      RETURN QUERY SELECT 'locked'::text, v_was, v_was_via; RETURN;
    END IF;
    IF v_was = p_enabled THEN
      RETURN QUERY SELECT 'unchanged'::text, v_was, v_was_via; RETURN;
    END IF;
    -- DELETE + INSERT, never UPDATE: every UPDATE of this table is stamped platform_admin by the trigger.
    DELETE FROM public.company_feature_overrides WHERE company_id = p_company AND feature_id = v_feature;
  END IF;

  INSERT INTO public.company_feature_overrides (company_id, feature_id, enabled, reason, set_by, set_via, created_at)
  VALUES (p_company, v_feature, p_enabled,
          CASE WHEN p_enabled THEN 'Switched on by a company owner or admin' ELSE 'Switched off by a company owner or admin' END,
          v_uid::uuid, 'company_admin', pg_catalog.now());

  RETURN QUERY SELECT 'ok'::text, v_was, v_was_via;
END;
$$;
ALTER FUNCTION public.mcp_connector_self_serve_set(uuid, boolean) OWNER TO migration_admin;
REVOKE ALL ON FUNCTION public.mcp_connector_self_serve_set(uuid, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.mcp_connector_self_serve_set(uuid, boolean) TO app_user;

-- ── definer registry (930): after create and owner change ───────────────────

INSERT INTO public.app_definer_reviews (signature, writes, body_md5)
SELECT v.signature, v.writes, public.app_definer_hash(v.fn::regprocedure)
  FROM (VALUES
    ('create_company_with_owner(jsonb)', 'public.create_company_with_owner(jsonb)',
     'a NEW company, with its caller as owner (company_users); since 1058 also that new company''s mcp_connector override (enabled, default_new_company) through enable_mcp_connector_default; grants nothing over an existing one'),
    ('mcp_connector_self_serve_set(uuid,boolean)', 'public.mcp_connector_self_serve_set(uuid, boolean)',
     'company_feature_overrides: the one row (session company, mcp_connector) for a signed-in owner or admin of the session company, by DELETE + INSERT stamped company_admin; cannot turn on a row a platform admin switched off; a read of company_users and feature_flags; one advisory key per company; mints no credential (tokens are written on migration_admin since 930); nothing for another company')
  ) AS v(signature, fn, writes)
ON CONFLICT (signature) DO UPDATE SET writes = EXCLUDED.writes, body_md5 = EXCLUDED.body_md5;

-- ── the halts ───────────────────────────────────────────────────────────────

-- PUBLIC execute on either function, app_user missing on the toggle or holding the default-on function, the
-- toggle not owned by migration_admin or its registry row not holding its hash, a search_path not pinned.
DO $$
DECLARE
  d RECORD;
BEGIN
  FOR d IN SELECT * FROM (VALUES
      ('public.mcp_connector_self_serve_set(uuid, boolean)', 'mcp_connector_self_serve_set(uuid,boolean)', true),
      ('public.enable_mcp_connector_default(uuid, uuid)', NULL, false)) AS x(fn, sig, app) LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_proc p WHERE p.oid = d.fn::regprocedure AND p.proconfig @> ARRAY['search_path=pg_catalog, public, pg_temp']) THEN
      RAISE EXCEPTION '1058: % does not pin its search_path', d.fn;
    END IF;
    IF d.sig IS NOT NULL AND ((SELECT pg_catalog.pg_get_userbyid(p.proowner) FROM pg_catalog.pg_proc p WHERE p.oid = d.fn::regprocedure) <> 'migration_admin'
       OR NOT EXISTS (SELECT 1 FROM public.app_definer_reviews r WHERE r.signature = d.sig AND r.body_md5 = public.app_definer_hash(d.fn::regprocedure))) THEN
      RAISE EXCEPTION '1058: % is not owned by migration_admin, or its registry row does not hold its hash', d.fn;
    END IF;
    IF pg_catalog.has_function_privilege('public', d.fn, 'EXECUTE') THEN
      RAISE EXCEPTION '1058: PUBLIC can execute %', d.fn;
    END IF;
    IF pg_catalog.has_function_privilege('app_user', d.fn, 'EXECUTE') IS DISTINCT FROM d.app THEN
      RAISE EXCEPTION '1058: app_user % execute %', CASE WHEN d.app THEN 'cannot' ELSE 'can' END, d.fn;
    END IF;
  END LOOP;
END $$;

-- RLS stays on, and app_user still cannot write the table directly (that would bypass the toggle's
-- tenant, role, feature and platform-admin lock checks).
DO $$
DECLARE p text;
BEGIN
  IF NOT COALESCE((SELECT c.relrowsecurity FROM pg_catalog.pg_class c
                    WHERE c.oid = 'public.company_feature_overrides'::pg_catalog.regclass), false) THEN
    RAISE EXCEPTION '1058: company_feature_overrides does not have row security';
  END IF;
  FOREACH p IN ARRAY ARRAY['INSERT', 'UPDATE', 'DELETE'] LOOP
    IF pg_catalog.to_regrole('app_user') IS NOT NULL
       AND pg_catalog.has_table_privilege('app_user', 'public.company_feature_overrides', p) THEN
      RAISE EXCEPTION '1058: app_user can % company_feature_overrides', p;
    END IF;
  END LOOP;
END $$;

-- 930's rules still hold for the objects 1058 touches (scoped like 1010d so the advisory run on
-- production's older schema does not trip on unrelated functions such as 997b; the integration gate checks all).
DO $$
DECLARE v text;
BEGIN
  FOR v IN SELECT x FROM public.app_pool_reach_violations() AS x
    WHERE x ~ 'company_feature_overrides|create_company_with_owner|mcp_connector_self_serve_set|enable_mcp_connector_default'
    ORDER BY 1 LOOP
    RAISE EXCEPTION '1058: %', v;
  END LOOP;
END $$;
