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
-- affected by row-level security policy"), so this file applies only as a
-- superuser or BYPASSRLS role that owns the tables.
--
-- Everything, the drops included, is inside ONE DO statement. A DO block is a
-- single statement, so it is one transaction in every client mode: a refusal
-- drops nothing even under `psql -f` in autocommit, where top-level DROPs after
-- a failed guard would still have run.
--
-- No CASCADE: a view or SQL-standard function on these tables fails the drop.
-- A plpgsql function body does not create a dependency, so the guard also
-- refuses if any function outside the system schemas names one of the tables
-- by literal text (whole word, any case). A name built at runtime is not seen.

DO $$
DECLARE
  -- Keep in step with the six literal DROPs at the end of this block.
  tables text[] := ARRAY[
    'archive_gl_journal_entries', 'archive_gl_journal_lines', 'archive_bank_transactions',
    'archive_customer_invoices', 'archive_supplier_invoices', 'archive_runs'
  ];
  t text;
  n bigint;
  fn text;
  prev_row_security text := current_setting('row_security');
  prev_lock_timeout text := current_setting('lock_timeout');
BEGIN
  PERFORM set_config('row_security', 'off', true);
  PERFORM set_config('lock_timeout', '10s', true);

  SELECT string_agg(p.oid::regprocedure::text, ', ') INTO fn
  FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
  WHERE ns.nspname NOT IN ('pg_catalog', 'information_schema')
    -- E'' so the word boundaries survive standard_conforming_strings = off.
    AND p.prosrc ~* E'\\marchive_(gl_journal_entries|gl_journal_lines|bank_transactions|customer_invoices|supplier_invoices|runs)\\M';
  IF fn IS NOT NULL THEN
    RAISE EXCEPTION '855: function(s) % reference an archive table. Not dropping any archive table.', fn;
  END IF;

  FOREACH t IN ARRAY tables LOOP
    IF to_regclass('public.' || t) IS NOT NULL THEN
      EXECUTE format('LOCK TABLE public.%I IN ACCESS EXCLUSIVE MODE', t);
      EXECUTE format('SELECT count(*) FROM public.%I', t) INTO n;
      IF n > 0 THEN
        RAISE EXCEPTION '855: % has % row(s). Not dropping any archive table. Decide per run first (archive redesign spec, PR #641, section 9 census and D0a).', t, n;
      END IF;
    END IF;
  END LOOP;

  -- Literal statements, not EXECUTE format(...): scripts/audit-schema-drift.ts
  -- reads DROP TABLE <name> from the file text to stop expecting a table, and
  -- runs right after the migrations on every deploy.
  DROP TABLE IF EXISTS public.archive_gl_journal_lines;
  DROP TABLE IF EXISTS public.archive_gl_journal_entries;
  DROP TABLE IF EXISTS public.archive_bank_transactions;
  DROP TABLE IF EXISTS public.archive_customer_invoices;
  DROP TABLE IF EXISTS public.archive_supplier_invoices;
  DROP TABLE IF EXISTS public.archive_runs;

  -- Restore both for the rest of the runner's transaction.
  PERFORM set_config('row_security', prev_row_security, true);
  PERFORM set_config('lock_timeout', prev_lock_timeout, true);
END $$;
