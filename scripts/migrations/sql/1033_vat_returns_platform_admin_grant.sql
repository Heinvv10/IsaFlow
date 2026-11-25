-- 1033: vat_returns readable by platform_admin (prod bug: "permission denied for table vat_returns", 42501).
--
-- WHAT. GET /api/accounting/portfolio-workbench reads each of the caller's companies on the platform_admin pool, and its
-- VAT card (vatPeriodFilings) reads vat_returns. In production platform_admin holds no SELECT on the table, so the card
-- fails. isaflow_dev holds the privilege. 1003 repaired the same divergence for app_user only.
--
-- HOW. Grant SELECT on this one table to platform_admin: nothing else on this path writes it. No other privilege, no
-- other table, no policy change. platform_admin is BYPASSRLS, so RLS never narrows what it reads: the company filters
-- in the SQL are the tenant boundary (vatPeriodFilings filters every vat_returns read by company_id).
-- Whatever else a database already grants platform_admin here (isaflow_dev: INSERT, UPDATE, DELETE) is left as it is.
-- Idempotent: a GRANT that is already held is a no-op. A database without the role is left alone, with a notice. The
-- migration RAISES if platform_admin still lacks SELECT afterwards (a GRANT by a non-owner is otherwise only a warning).
--
-- Rollback: REVOKE SELECT ON public.vat_returns FROM platform_admin;
--           (only where platform_admin did not hold it before this migration, as on production; isaflow_dev did).
--
-- Lock: GRANT takes no lock on vat_returns itself (it rewrites the table's pg_class row), so reads and writes of the
-- table carry on.

DO $$
BEGIN
  IF pg_catalog.to_regrole('platform_admin') IS NULL THEN
    RAISE NOTICE '1033: role platform_admin does not exist; nothing granted';
    RETURN;
  END IF;

  GRANT SELECT ON public.vat_returns TO platform_admin;

  IF NOT pg_catalog.has_table_privilege('platform_admin', 'public.vat_returns', 'SELECT') THEN
    RAISE EXCEPTION '1033: platform_admin still lacks SELECT on vat_returns (is the migration role its owner?)';
  END IF;
END
$$;
