-- Migration 916b: app_user loses its grant on ap_payment_document_backfill_candidates.
--
-- Audit 2026-10-18 S-07b. Runs before 917, whose guard refuses any view owned
-- by an RLS-bypassing role that app_user may use. On production the view is
-- owned by postgres (BYPASSRLS) and app_user holds SELECT on it (a grant dev
-- never got); on dev it is owned by migration_admin and app_user holds
-- nothing, so the deploy's parity gate passed and 917 would have refused on
-- production (found by the runbook's 0b pre-check, 2026-10-23).
--
-- Nothing in the app reads the view. Its one reader is
-- scripts/ap-backfill-supplier-payments.ts, which connects as the owner
-- (OWNER_DATABASE_URL). No app_user caller exists, so the grant goes rather
-- than the view changing shape.

DO $$
BEGIN
  IF pg_catalog.to_regclass('public.ap_payment_document_backfill_candidates') IS NOT NULL THEN
    REVOKE ALL ON public.ap_payment_document_backfill_candidates FROM app_user;
  END IF;
END $$;
