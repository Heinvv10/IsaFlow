-- 973: how a payroll run line's PAYE, UIF, SDL and ETI were calculated (wave 5 EX-core).
--
--   explanation  JSON (LineExplanations, payrollExplainTypes.ts): per figure, the engine's own intermediate
--                steps (the annual equivalent, the bracket, rebates, credits, the year to date; the UIF
--                ceiling; the SDL leviable amount to date and the threshold; the ETI table) with their SARS
--                sources. Built by calculatePayrollLine (payrollExplain.ts), never recomputed by a reader.
--
-- Writer: calculatePayrollRun (payrollRunService -> payrollRunLineWriter), the only writer of
-- payroll_run_lines. Reader: GET /api/payroll/runs/[id]/explanation (payroll-detail roles, no-store).
--
-- Additive only: a nullable column, no default, no backfill. A line costed before this migration is NULL: a
-- draft run reads "Recalculate the run to see how this was calculated"; a final one "Not recorded for runs
-- costed before <date>", the date this column was added, which the column's comment records (written once,
-- when the column is created, so a re-run keeps the first date).
--
-- Rollback:
--   ALTER TABLE payroll_run_lines DROP COLUMN IF EXISTS explanation;
SET LOCAL lock_timeout = '5s';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'payroll_run_lines' AND column_name = 'explanation'
  ) THEN
    ALTER TABLE public.payroll_run_lines ADD COLUMN IF NOT EXISTS explanation JSONB;
    EXECUTE format(
      'COMMENT ON COLUMN public.payroll_run_lines.explanation IS %L',
      'How the line was calculated (EX-core). Recorded from ' || to_char(now() AT TIME ZONE 'Africa/Johannesburg', 'YYYY-MM-DD') || '.'
    );
  END IF;
END
$$;
