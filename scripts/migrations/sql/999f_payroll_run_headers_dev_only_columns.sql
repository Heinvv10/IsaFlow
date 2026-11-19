-- 999f: the two payroll_run_headers columns production never got (incident, 19 Nov 2026).
--
-- INCIDENT. The 01:32 SAST auto-release applied 999n to production, then failed on 999w with 42703
-- `column "cancelled_by" does not exist` (999w converts payroll_run_headers.cancelled_by to TEXT). The live code stayed
-- on eacd09d5a1 but 999n's triggers stayed on prod, and payroll_run_headers_final_frozen compares
-- NEW/OLD.posted_journal_entry_id: approving a pay run 500s there with `record "new" has no field
-- "posted_journal_entry_id"` (the journal-link UPDATE on the just-approved run reaches that comparison).
--
-- CAUSE. No migration on master creates either column. Both came from 385_payroll_run_lifecycle.sql (commit
-- 9537a5851f, branch feature/prd-02-payroll-phase3), which was applied to isaflow_dev and never merged: dev tracks
-- it, prod does not, and the CI schema baseline (a dump of dev) carries the columns, so CI and dev passed.
-- Every other column 999n, 999w, 999y and 1003 name is created by a migration on master.
--
-- WHAT. Exactly dev's shape for the two columns 999n and 999w need:
--   posted_journal_entry_id uuid, FK payroll_run_headers_posted_je_fkey -> gl_journal_entries(id) ON DELETE SET NULL,
--     and dev's partial index idx_payroll_run_headers_posted_je;
--   cancelled_by TEXT: dev's type today (385 made it uuid, 999w turned dev's into TEXT). TEXT here leaves the same
--     end state whichever runs first, this file or 999w (999w's TEXT -> TEXT is a no-op), and leaves no uuid actor
--     column for 999w's closing check.
-- No default, no backfill: both stay NULL, as on all of dev's rows. Nothing in src/ reads or writes either column on
-- this table (old colour eacd09d5a1 included), so both colours run unchanged. paid_at and cancelled_at came from the
-- same 385 and are absent on prod too; no migration and no code needs them, so they are not added here.
--
-- WHY IF NOT EXISTS. A no-op on dev, on the CI fixture (the baseline already has both) and on any database that has
-- them; it does the work only where they are missing (prod). The FK and index are guarded the same way.
--
-- ORDER. scripts/apply-migrations.ts applies every file not tracked in schema_migrations, in compareMigrations order
-- (999f < 999n < 999w); files already tracked (999n..999v on prod) are skipped, not a barrier. So on prod this runs
-- in the same deploy, before 999w. Letters s, t, x and z are taken by open PRs.
--
-- LOCKS. ADD COLUMN without a default is catalogue-only (ACCESS EXCLUSIVE on payroll_run_headers for an instant). The
-- FK takes SHARE ROW EXCLUSIVE on both tables while it checks payroll_run_headers (every value NULL: no lookups).
-- The index build scans payroll_run_headers (a small table). All bounded by lock_timeout.
--
-- Rollback (only while 999n's trigger is gone, which reads posted_journal_entry_id):
--   DROP INDEX IF EXISTS public.idx_payroll_run_headers_posted_je;
--   ALTER TABLE public.payroll_run_headers DROP CONSTRAINT IF EXISTS payroll_run_headers_posted_je_fkey;
--   ALTER TABLE public.payroll_run_headers DROP COLUMN IF EXISTS posted_journal_entry_id, DROP COLUMN IF EXISTS cancelled_by;

SET LOCAL lock_timeout = '5s';

ALTER TABLE public.payroll_run_headers
  ADD COLUMN IF NOT EXISTS posted_journal_entry_id uuid,
  ADD COLUMN IF NOT EXISTS cancelled_by TEXT;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint
                  WHERE conrelid = 'public.payroll_run_headers'::pg_catalog.regclass
                    AND conname = 'payroll_run_headers_posted_je_fkey') THEN
    ALTER TABLE public.payroll_run_headers
      ADD CONSTRAINT payroll_run_headers_posted_je_fkey
      FOREIGN KEY (posted_journal_entry_id) REFERENCES public.gl_journal_entries(id) ON DELETE SET NULL;
  END IF;
END
$$;

CREATE INDEX IF NOT EXISTS idx_payroll_run_headers_posted_je
  ON public.payroll_run_headers (posted_journal_entry_id)
  WHERE posted_journal_entry_id IS NOT NULL;
