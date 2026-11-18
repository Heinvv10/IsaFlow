-- 1003: vat_returns reachable by app_user again (prod bug: "permission denied for table vat_returns", 42501).
--
-- WHAT. In production the month-end workbench's VAT card (vatPeriodFilings reads vat_returns as app_user) fails with
-- SQLSTATE 42501 nine times a day: app_user holds no privilege on vat_returns there, while isaflow_dev has the
-- table-level SELECT, INSERT, UPDATE and DELETE the code needs (submitVATReturn inserts, vatPeriodFilings and the
-- VAT reports read, nothing but the old code updates or deletes). It is the prod/dev privilege divergence of
-- 348's default privileges, which only reach tables created after them.
--
-- HOW. Grant exactly dev's four privileges to app_user, no TRUNCATE/REFERENCES/TRIGGER, and make sure the table keeps
-- forced RLS with a policy for app_user, so the grant never exposes another tenant's rows. Idempotent: a GRANT that
-- is already held is a no-op, and the policy is only added when app_user has none.
--
-- Rollback: REVOKE SELECT, INSERT, UPDATE, DELETE ON public.vat_returns FROM app_user;
--           (and DROP POLICY vat_returns_tenant_isolation ON public.vat_returns if this migration created it).
--
-- Prod's ACL/policies were not readable when this was written, so every step guards its own assumption: RLS is only
-- switched on or forced when it is not already, the policy gets its own name (no clash with an existing
-- tenant_isolation on another role) and is only added when no policy already covers app_user, and the migration
-- RAISES if app_user still lacks a privilege afterwards (a GRANT by a non-owner is otherwise only a warning).
--
-- Lock: GRANT and ALTER ... ROW LEVEL SECURITY take a brief ACCESS EXCLUSIVE lock on vat_returns (a small table).

GRANT SELECT, INSERT, UPDATE, DELETE ON public.vat_returns TO app_user;

DO $$
DECLARE
  v_rls pg_catalog.bool;
  v_forced pg_catalog.bool;
  v_priv pg_catalog.text;
BEGIN
  SELECT c.relrowsecurity, c.relforcerowsecurity INTO v_rls, v_forced
    FROM pg_catalog.pg_class c WHERE c.oid = 'public.vat_returns'::pg_catalog.regclass;
  IF NOT v_rls THEN ALTER TABLE public.vat_returns ENABLE ROW LEVEL SECURITY; END IF;
  IF NOT v_forced THEN ALTER TABLE public.vat_returns FORCE ROW LEVEL SECURITY; END IF;

  -- Only when nothing (a policy for app_user or for PUBLIC) already scopes app_user's access.
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_policies
    WHERE schemaname = 'public' AND tablename = 'vat_returns' AND (roles && ARRAY['app_user', 'public']::pg_catalog.name[])
  ) THEN
    DROP POLICY IF EXISTS vat_returns_tenant_isolation ON public.vat_returns;
    CREATE POLICY vat_returns_tenant_isolation ON public.vat_returns FOR ALL TO app_user
      USING (company_id = app.current_company_id() AND company_id IN (SELECT auth.user_companies()))
      WITH CHECK (company_id = app.current_company_id() AND company_id IN (SELECT auth.user_companies()));
  END IF;

  FOREACH v_priv IN ARRAY ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE'] LOOP
    IF NOT pg_catalog.has_table_privilege('app_user', 'public.vat_returns', v_priv) THEN
      RAISE EXCEPTION '1003: app_user still lacks % on vat_returns (is the migration role its owner?)', v_priv;
    END IF;
  END LOOP;
END
$$;
