-- Migration 919: the AR "last viewed" materialized view is no longer readable
-- across tenants.
--
-- S-07b follow-up C (2026-10-23, pre-existing, LOW). customer_invoice_view_summary
-- (427) is a materialized view, and Postgres has no RLS on those: app_user
-- held SELECT on it, so any request (and, by inheritance, the service pool)
-- could read every company's per-invoice view counts and last-viewed times.
--
-- The readers (customerInvoiceReadService: list, count, export, detail;
-- readReceiptService.getLastViewedSummary) now read
-- public.current_company_invoice_view_summary(), a SECURITY DEFINER function
-- that returns only the rows of app.current_company_id(), the company withAuth,
-- the bearer pipeline and extension tokens set on every request transaction.
-- With no company set it returns nothing. That puts the view on the same
-- footing as an RLS table (the claim is the boundary); it is not a view owned
-- by an RLS-bypassing role, which 917 refuses. The refresh cron is unchanged:
-- it calls 915's definer wrapper.

CREATE OR REPLACE FUNCTION public.current_company_invoice_view_summary()
RETURNS TABLE (customer_invoice_id uuid, company_id uuid, last_viewed_at timestamptz,
               view_count bigint, distinct_sessions bigint)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT s.customer_invoice_id, s.company_id, s.last_viewed_at, s.view_count, s.distinct_sessions
    FROM public.customer_invoice_view_summary s
   WHERE s.company_id = app.current_company_id()
$$;
REVOKE ALL ON FUNCTION public.current_company_invoice_view_summary() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.current_company_invoice_view_summary() TO app_user;

REVOKE SELECT ON public.customer_invoice_view_summary FROM app_user, PUBLIC;
-- The baseline also grants app_user INSERT/UPDATE/DELETE on it (348's default
-- privileges); a materialized view refuses those anyway, but nothing should
-- read as granted that cannot be used.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.customer_invoice_view_summary FROM app_user, PUBLIC;

-- Refuse the migration if any role either app login can reach may SELECT a
-- materialized view: none has RLS, so each would be cross-tenant. A later
-- materialized view gets a company-filtered definer like the one above.
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN SELECT ro.rolname, c.relname
             FROM pg_catalog.pg_class c
             JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
             CROSS JOIN pg_catalog.pg_roles ro
            WHERE c.relkind = 'm' AND n.nspname IN ('public', 'auth', 'app', 'platform_shared')
              AND (pg_catalog.pg_has_role('isaflow_app', ro.oid, 'MEMBER')
                   OR pg_catalog.pg_has_role('isaflow_service', ro.oid, 'MEMBER'))
              AND pg_catalog.has_table_privilege(ro.oid, c.oid, 'SELECT')
            ORDER BY ro.rolname, c.relname LOOP
    RAISE EXCEPTION '919: % (reachable from an app pool login) can SELECT the materialized view %', r.rolname, r.relname;
  END LOOP;
END $$;
