-- Migration 919: the AR "last viewed" materialized view is no longer readable
-- across tenants.
--
-- S-07b follow-up C (2026-10-23, pre-existing, LOW). customer_invoice_view_summary
-- (427) was a materialized view, and Postgres has no RLS on those: app_user
-- held SELECT on it, so any request (and, by inheritance, the service pool)
-- could read every company's per-invoice view counts and last-viewed times.
--
-- Shape after this migration:
--   customer_invoice_view_summary_mv   the materialized view, renamed; no app
--                                      role may read it (refused below, and
--                                      on every deploy by 920).
--   current_company_invoice_view_summary()
--                                      SECURITY DEFINER; the _mv rows of
--                                      app.current_company_id() only, the
--                                      company withAuth, the bearer pipeline
--                                      and extension tokens set on every
--                                      request transaction; nothing when no
--                                      company is set.
--   customer_invoice_view_summary      a security_invoker view over that
--                                      function, under the OLD name, so the
--                                      readers (customerInvoiceReadService list
--                                      / count / export, readReceiptService
--                                      getLastViewedSummary) are unchanged.
--
-- Why a view under the old name: deploy.sh applies migrations before the code
-- switch, and rollback-deploy.sh (run automatically when post-deploy
-- verification fails) reverts code only. Code from before this migration
-- reads customer_invoice_view_summary as app_user; with the view it still
-- works, and still sees only its own company. security_invoker, so 917's rule
-- against views running as an RLS-bypassing owner holds; the caller needs
-- only EXECUTE on the function. That puts the counts on the same footing as
-- an RLS table: the request's company claim is the boundary.
--
-- Cost: Postgres never inlines a SECURITY DEFINER function, so each query
-- reads the company's whole summary (indexed on company_id; one row per
-- viewed invoice) and joins or filters it, and the AR list's count can no
-- longer drop the unused join. Bounded per company; acceptable at today's
-- sizes.
--
-- The refresh cron calls 915's refresh_customer_invoice_view_summary(),
-- replaced here to refresh the renamed view; same name, same grant.

DO $$
BEGIN
  IF (SELECT c.relkind FROM pg_catalog.pg_class c
       WHERE c.oid = pg_catalog.to_regclass('public.customer_invoice_view_summary')) = 'm' THEN
    ALTER MATERIALIZED VIEW public.customer_invoice_view_summary RENAME TO customer_invoice_view_summary_mv;
  END IF;
END $$;

REVOKE ALL ON public.customer_invoice_view_summary_mv FROM app_user, PUBLIC;

CREATE OR REPLACE FUNCTION public.refresh_customer_invoice_view_summary()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  REFRESH MATERIALIZED VIEW CONCURRENTLY public.customer_invoice_view_summary_mv;
END;
$$;

CREATE OR REPLACE FUNCTION public.current_company_invoice_view_summary()
RETURNS TABLE (customer_invoice_id uuid, company_id uuid, last_viewed_at timestamptz,
               view_count bigint, distinct_sessions bigint)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT s.customer_invoice_id, s.company_id, s.last_viewed_at, s.view_count, s.distinct_sessions
    FROM public.customer_invoice_view_summary_mv s
   WHERE s.company_id = app.current_company_id()
$$;
REVOKE ALL ON FUNCTION public.current_company_invoice_view_summary() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.current_company_invoice_view_summary() TO app_user;

CREATE OR REPLACE VIEW public.customer_invoice_view_summary WITH (security_invoker = true) AS
  SELECT customer_invoice_id, company_id, last_viewed_at, view_count, distinct_sessions
    FROM public.current_company_invoice_view_summary();
-- Only SELECT: 348's default privileges would also give app_user writes, which
-- a view over a function refuses anyway.
REVOKE ALL ON public.customer_invoice_view_summary FROM app_user, PUBLIC;
GRANT SELECT ON public.customer_invoice_view_summary TO app_user;
