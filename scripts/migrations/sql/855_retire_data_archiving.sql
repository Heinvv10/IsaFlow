-- 855: drop the data-archiving tables (archive redesign spec PR #641, D0 = retire, Hein 2026-10-05).
--
-- executeArchive copied posted history into these mirror tables and deleted
-- the originals. Every balance-sheet, TB and bank figure is cumulative from
-- inception over the live tables, so a run changed today's reports. The code
-- was removed in PR #647, which must be LIVE before this deploys: deploy.sh
-- rolls back code only, and the code before #647 writes these tables. Closes
-- N1 (R-197): archive_gl_journal_lines had no company_id, no RLS and full
-- app_user DML.
--
-- Guard: the migration refuses if any table holds a row. A row can mean
-- history left the live ledger (a completed run), a copy whose original is
-- still live (a run that died before its delete), or only a record of an
-- attempt (a failed archive_runs row). The count cannot tell these apart, so
-- someone decides per run before the drop: run the spec's section 9 census,
-- then empty the table on purpose or keep it.
--
-- Each table is locked before it is counted, so no row can arrive between
-- the count and the drop. lock_timeout bounds the wait behind a live reader.
-- Five of the six tables FORCE RLS, and a role subject to RLS would count 0
-- rows there. row_security = off turns that into an error ("query would be
-- affected by row-level security policy"). So this file can only be applied
-- by a superuser or a BYPASSRLS role, and only in ONE transaction: the
-- migration runner, or psql -1. In autocommit the guard and the drops are
-- separate transactions and the lock no longer protects the drop.
--
-- No CASCADE: nothing depends on these tables on the master schema, and an
-- unexpected dependent must fail the drop, not vanish with it.

DO $$
DECLARE
  t text;
  n bigint;
  prev_row_security text := current_setting('row_security');
  prev_lock_timeout text := current_setting('lock_timeout');
BEGIN
  PERFORM set_config('row_security', 'off', true);
  PERFORM set_config('lock_timeout', '10s', true);
  FOREACH t IN ARRAY ARRAY[
    'archive_gl_journal_entries', 'archive_gl_journal_lines', 'archive_bank_transactions',
    'archive_customer_invoices', 'archive_supplier_invoices', 'archive_runs'
  ] LOOP
    IF to_regclass('public.' || t) IS NOT NULL THEN
      EXECUTE format('LOCK TABLE public.%I IN ACCESS EXCLUSIVE MODE', t);
      EXECUTE format('SELECT count(*) FROM public.%I', t) INTO n;
      IF n > 0 THEN
        RAISE EXCEPTION '855: % has % row(s). Not dropping any archive table. Decide per run first (archive redesign spec, PR #641, section 9 census and D0a).', t, n;
      END IF;
    END IF;
  END LOOP;
  -- Restore both for the rest of the runner's transaction.
  PERFORM set_config('row_security', prev_row_security, true);
  PERFORM set_config('lock_timeout', prev_lock_timeout, true);
END $$;

DROP TABLE IF EXISTS public.archive_gl_journal_lines;
DROP TABLE IF EXISTS public.archive_gl_journal_entries;
DROP TABLE IF EXISTS public.archive_bank_transactions;
DROP TABLE IF EXISTS public.archive_customer_invoices;
DROP TABLE IF EXISTS public.archive_supplier_invoices;
DROP TABLE IF EXISTS public.archive_runs;
