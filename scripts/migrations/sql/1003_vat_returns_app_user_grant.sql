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
--           (and DROP POLICY tenant_isolation ON public.vat_returns only if this migration created it).
--
-- Lock: GRANT and ALTER ... ROW LEVEL SECURITY take a brief ACCESS EXCLUSIVE lock on vat_returns (a small table).

GRANT SELECT, INSERT, UPDATE, DELETE ON public.vat_returns TO app_user;

ALTER TABLE public.vat_returns ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.vat_returns FORCE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_policies
    WHERE schemaname = 'public' AND tablename = 'vat_returns' AND 'app_user' = ANY (roles)
  ) THEN
    CREATE POLICY tenant_isolation ON public.vat_returns FOR ALL TO app_user
      USING (company_id = app.current_company_id() AND company_id IN (SELECT auth.user_companies()))
      WITH CHECK (company_id = app.current_company_id() AND company_id IN (SELECT auth.user_companies()));
  END IF;
END
$$;
