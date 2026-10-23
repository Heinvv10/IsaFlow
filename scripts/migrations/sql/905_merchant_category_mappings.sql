-- 905: merchant_categories + company_category_mappings — the shared merchant-pattern pool's category layer
-- (learning loop PR 2; Hein's decisions 2026-10-21, decision 1).
--
-- 1. merchant_categories: the fixed ISAFlow category list (about 30 common SA expense categories). The pool
--    stores a merchant's CATEGORY, never an account name or id, so every company reads it through its own
--    mapping. Platform-global reference data: no company_id, nothing tenant-specific in it. The canonical
--    list is MERCHANT_CATEGORIES in src/modules/accounting/services/sharedPool/merchantCategories.ts (list
--    version 1); tests/unit/sharedPool/merchantCategories.test.ts fails when this seed and that constant
--    drift. The isaflow_standard template is NOT the key: it is a TS constant with eight expense accounts,
--    a company's template choice is stored nowhere, and 476's default chart reuses its codes under other
--    names (merchantCategories.ts says more). Codes are never renamed or deleted (pool rows and mappings
--    reference them); a new category is an upsert in a later migration.
--    poolable = false: mappable, never published (salaries).
--    Access: every non-owner role loses everything, then app_user may SELECT (the mapping page lists it).
--
-- 2. company_category_mappings: one row per (company, category) -> that company's OWN gl account. Composite
--    (gl_account_id, company_id) FK to gl_accounts (489's pattern), so a mapping can never name another
--    tenant's account; ON DELETE CASCADE drops a mapping with its account. mapping_source 'auto' = proposed
--    by the one-click auto-map (account name equals a category alias), 'manual' = picked by a person;
--    mapped_by is the users.id (character varying) of whoever saved it. Several categories may map to one
--    account (Telephone & Internet); the aggregation job then cannot tell which category a line on that
--    account was, so it ignores such accounts (merchantPool.ts accountToCategory).
--    RLS: 897's active-company form. Writers: categoryMappingService.ts under withAuth (app_user). The
--    aggregation job reads it on the BYPASSRLS pool role, scoped by company_id.
--    Grants: SELECT, INSERT, DELETE and UPDATE of the mapping columns only, for app_user.
--
-- Rollback (906 references both tables: roll 906 back first):
--   DROP TABLE IF EXISTS public.company_category_mappings;
--   DROP TABLE IF EXISTS public.merchant_categories;
-- Locks: two new tables; brief SHARE ROW EXCLUSIVE on companies and gl_accounts for the FK triggers.

CREATE TABLE IF NOT EXISTS merchant_categories (
  code         TEXT PRIMARY KEY CHECK (code ~ '^[a-z][a-z_]{1,39}$'),
  label        TEXT NOT NULL,
  list_version INTEGER NOT NULL CHECK (list_version >= 1),
  poolable     BOOLEAN NOT NULL DEFAULT true,
  sort_order   INTEGER NOT NULL
);

INSERT INTO merchant_categories (code, label, list_version, poolable, sort_order) VALUES
  ('electricity', 'Electricity', 1, true, 1),
  ('water_rates', 'Water, rates & municipal', 1, true, 2),
  ('telephone', 'Telephone & cellphone', 1, true, 3),
  ('internet', 'Internet & data', 1, true, 4),
  ('fuel', 'Fuel', 1, true, 5),
  ('tolls_parking', 'Tolls & parking', 1, true, 6),
  ('motor_vehicle_repairs', 'Motor vehicle repairs & maintenance', 1, true, 7),
  ('bank_charges', 'Bank charges', 1, true, 8),
  ('interest_paid', 'Interest paid', 1, true, 9),
  ('rent', 'Rent', 1, true, 10),
  ('insurance', 'Insurance', 1, true, 11),
  ('sars_payments', 'SARS payments', 1, true, 12),
  ('salaries', 'Salaries & wages', 1, false, 13),
  ('stationery', 'Stationery & printing', 1, true, 14),
  ('software_subscriptions', 'Software & subscriptions', 1, true, 15),
  ('advertising', 'Advertising & marketing', 1, true, 16),
  ('travel', 'Travel', 1, true, 17),
  ('accommodation', 'Accommodation', 1, true, 18),
  ('meals_entertainment', 'Meals & entertainment', 1, true, 19),
  ('courier_postage', 'Courier & postage', 1, true, 20),
  ('cleaning', 'Cleaning', 1, true, 21),
  ('security', 'Security', 1, true, 22),
  ('professional_fees', 'Professional & consulting fees', 1, true, 23),
  ('accounting_fees', 'Accounting & audit fees', 1, true, 24),
  ('legal_fees', 'Legal fees', 1, true, 25),
  ('repairs_maintenance', 'Repairs & maintenance', 1, true, 26),
  ('staff_welfare', 'Staff welfare', 1, true, 27),
  ('donations', 'Donations', 1, true, 28),
  ('consumables', 'Groceries & consumables', 1, true, 29),
  ('equipment_hire', 'Equipment hire', 1, true, 30)
ON CONFLICT (code) DO UPDATE SET label = EXCLUDED.label, list_version = EXCLUDED.list_version,
  poolable = EXCLUDED.poolable, sort_order = EXCLUDED.sort_order;

CREATE TABLE IF NOT EXISTS company_category_mappings (
  company_id     UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  category_code  TEXT NOT NULL REFERENCES merchant_categories(code),
  gl_account_id  UUID NOT NULL,
  mapping_source TEXT NOT NULL CHECK (mapping_source IN ('manual', 'auto')),
  -- users.id is character varying(255), not uuid.
  mapped_by      TEXT NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, category_code),
  CONSTRAINT company_category_mappings_gl_fk FOREIGN KEY (gl_account_id, company_id)
    REFERENCES gl_accounts (id, company_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS company_category_mappings_account_idx
  ON company_category_mappings (company_id, gl_account_id);

ALTER TABLE public.company_category_mappings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.company_category_mappings FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON public.company_category_mappings;
CREATE POLICY tenant_isolation ON public.company_category_mappings
  FOR ALL TO app_user
  USING (company_id = app.current_company_id() AND company_id IN (SELECT auth.user_companies()))
  WITH CHECK (company_id = app.current_company_id() AND company_id IN (SELECT auth.user_companies()));

DO $$
DECLARE r RECORD; t pg_catalog.text;
BEGIN
  FOREACH t IN ARRAY ARRAY['merchant_categories', 'company_category_mappings'] LOOP
    FOR r IN
      SELECT DISTINCT grantee FROM information_schema.role_table_grants
      WHERE table_schema = 'public' AND table_name = t
        AND grantee <> (SELECT pg_catalog.pg_get_userbyid(c.relowner) FROM pg_catalog.pg_class c
                        WHERE c.oid = pg_catalog.format('public.%I', t)::pg_catalog.regclass)
    LOOP
      EXECUTE pg_catalog.format('REVOKE ALL ON public.%I FROM %I', t, r.grantee);
    END LOOP;
    EXECUTE pg_catalog.format('REVOKE ALL ON public.%I FROM PUBLIC', t);
  END LOOP;
END $$;
GRANT SELECT ON public.merchant_categories TO app_user;
GRANT SELECT, INSERT, DELETE ON public.company_category_mappings TO app_user;
GRANT UPDATE (gl_account_id, mapping_source, mapped_by, updated_at) ON public.company_category_mappings TO app_user;

DO $$
DECLARE
  v_ok pg_catalog.bool;
BEGIN
  SELECT c.relrowsecurity AND c.relforcerowsecurity
     AND (SELECT pg_catalog.count(*) FROM pg_catalog.pg_policies p
           WHERE p.schemaname = 'public' AND p.tablename = 'company_category_mappings') = 1
     AND EXISTS (SELECT 1 FROM pg_catalog.pg_policies p
                  WHERE p.schemaname = 'public' AND p.tablename = 'company_category_mappings'
                    AND p.policyname = 'tenant_isolation' AND p.cmd = 'ALL'
                    AND p.roles = ARRAY['app_user']::pg_catalog.name[]
                    AND p.qual LIKE '%app.current_company_id()%' AND p.qual LIKE '%auth.user_companies()%'
                    AND p.with_check LIKE '%app.current_company_id()%' AND p.with_check LIKE '%auth.user_companies()%')
     AND NOT pg_catalog.has_table_privilege('app_user', 'public.merchant_categories', 'INSERT')
     AND NOT pg_catalog.has_table_privilege('app_user', 'public.merchant_categories', 'UPDATE')
     AND NOT pg_catalog.has_table_privilege('app_user', 'public.merchant_categories', 'DELETE')
     AND NOT pg_catalog.has_column_privilege('app_user', 'public.company_category_mappings', 'company_id', 'UPDATE')
     AND NOT pg_catalog.has_table_privilege('app_user', 'public.company_category_mappings', 'TRUNCATE')
     AND (SELECT pg_catalog.count(*) FROM public.merchant_categories) >= 30
    INTO v_ok
    FROM pg_catalog.pg_class c
   WHERE c.oid = 'public.company_category_mappings'::pg_catalog.regclass;
  IF NOT v_ok THEN
    RAISE EXCEPTION 'migration 905: company_category_mappings is not under FORCE RLS with exactly the active-company policy, or merchant_categories is writable by app_user / unseeded';
  END IF;
END $$;

COMMENT ON TABLE merchant_categories IS
  'Fixed ISAFlow merchant category list (shared merchant-pattern pool). Canonical copy: sharedPool/merchantCategories.ts. Codes are never renamed or deleted.';
COMMENT ON TABLE company_category_mappings IS
  'Per-company map from an ISAFlow merchant category to the company''s own GL account. Written by categoryMappingService.ts.';
