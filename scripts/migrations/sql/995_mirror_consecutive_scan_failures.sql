-- scripts/migrations/sql/995_mirror_consecutive_scan_failures.sql
-- A mirror scan that fails for a passing reason (DNS gave no answer, or an answer the target guard refuses; the
-- network refused, timed out or dropped the connection) is retried next interval instead of flipping the
-- connection to 'error' at once (2026-11-15: one DNS blip disabled a new mailbox for good, and nothing sets a
-- connection back to 'active'). This counter bounds the retries: each such failure adds one, any successful scan
-- (the success and cursor stamps) and a reactivation reset it, and the failure that brings it to about a day's
-- worth of scans at the row's own interval flips 'active' to 'error' (mirrorScanError.ts COUNT_FAILURE).
--
-- Additive and idempotent: existing rows start at 0. No grant: only migration_admin writes these tables, on its
-- table-level privileges (946), which cover a new column; the app roles keep SELECT only, catalog-derived checks in
-- s07e-b-routes.migration.int.test.ts cover the new column. The preflight refuses a database where migration_admin
-- could not write it.
--
-- ADD COLUMN with a constant default rewrites nothing, but takes each table's ACCESS EXCLUSIVE lock for an instant
-- and would queue requests behind a long transaction while it waits: lock_timeout makes it fail fast instead.
SET LOCAL lock_timeout = '5s';

ALTER TABLE public.imap_mirror_connections ADD COLUMN IF NOT EXISTS consecutive_scan_failures integer NOT NULL DEFAULT 0;
ALTER TABLE public.sent_mirror_connections ADD COLUMN IF NOT EXISTS consecutive_scan_failures integer NOT NULL DEFAULT 0;

DO $$
DECLARE tbl text;
BEGIN
  IF pg_catalog.to_regrole('migration_admin') IS NULL THEN RETURN; END IF;
  FOREACH tbl IN ARRAY ARRAY['public.imap_mirror_connections', 'public.sent_mirror_connections'] LOOP
    IF NOT pg_catalog.has_column_privilege('migration_admin', tbl, 'consecutive_scan_failures', 'UPDATE') THEN
      RAISE EXCEPTION '995: migration_admin cannot UPDATE %.consecutive_scan_failures, which the scan stamps write', tbl;
    END IF;
  END LOOP;
END $$;
