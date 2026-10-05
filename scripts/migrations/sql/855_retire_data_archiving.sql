-- 855: retire physical data archiving (docs/design/archive-redesign.md, D0 = A, Hein 2026-10-05).
--
-- executeArchive copied posted history into these mirror tables and deleted the
-- originals. Every balance-sheet, TB and bank figure is cumulative from
-- inception over the live tables, so a run changed today's reports. The code is
-- removed in the same change; this drops its tables. Closes N1 too:
-- archive_gl_journal_lines had no company_id, no RLS and full app_user DML.
--
-- Guard: a row in any of them means history already left the live ledger
-- (spec D0a). Dropping it would lose that history for good, so the migration
-- refuses and someone decides per run. The tables are locked first so no row
-- can arrive between the count and the drop. Five of the six FORCE RLS: a
-- migration role without BYPASSRLS would count 0 there. row_security = off
-- makes that an error ("query would be affected by row-level security
-- policy") instead of a filtered, vacuous count.
--
-- No CASCADE: nothing depends on these tables (no FK, view or function on the
-- master schema), and an unexpected dependent must fail the drop, not vanish.

DO $$
DECLARE
  t text;
  n bigint;
BEGIN
  SET LOCAL row_security = off;
  FOREACH t IN ARRAY ARRAY[
    'archive_gl_journal_entries', 'archive_gl_journal_lines', 'archive_bank_transactions',
    'archive_customer_invoices', 'archive_supplier_invoices', 'archive_runs'
  ] LOOP
    IF to_regclass('public.' || t) IS NOT NULL THEN
      EXECUTE format('LOCK TABLE public.%I IN ACCESS EXCLUSIVE MODE', t);
      EXECUTE format('SELECT count(*) FROM public.%I', t) INTO n;
      IF n > 0 THEN
        RAISE EXCEPTION '855: % has % row(s); archived history has left the live ledger. Not dropping. See docs/design/archive-redesign.md D0a.', t, n;
      END IF;
    END IF;
  END LOOP;
  -- Back on for the rest of the runner's transaction (its schema_migrations insert).
  SET LOCAL row_security = on;
END $$;

DROP TABLE IF EXISTS public.archive_gl_journal_lines;
DROP TABLE IF EXISTS public.archive_gl_journal_entries;
DROP TABLE IF EXISTS public.archive_bank_transactions;
DROP TABLE IF EXISTS public.archive_customer_invoices;
DROP TABLE IF EXISTS public.archive_supplier_invoices;
DROP TABLE IF EXISTS public.archive_runs;
