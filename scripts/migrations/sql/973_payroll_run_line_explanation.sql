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
-- Additive only: a nullable column, no default, no backfill. A line costed before it is NULL: a draft run reads
-- "Recalculate the run to see how this was calculated"; a final one "Not recorded for runs costed before <date>",
-- the date being the company's earliest costed line that HAS an explanation (read from the data, so it is what the
-- running code wrote, whatever the deploy's build window or a rollback did; payrollLineExplanation.ts).
--
-- Rollback:
--   DROP INDEX IF EXISTS idx_payroll_run_lines_explained;
--   ALTER TABLE payroll_run_lines DROP COLUMN IF EXISTS explanation;
SET LOCAL lock_timeout = '5s';

ALTER TABLE public.payroll_run_lines ADD COLUMN IF NOT EXISTS explanation JSONB;

-- "Recorded from" reads MIN(created_at) of a company's lines that have an explanation, on every read of a line that
-- has none. Lines are reached through their company's runs (idx_payroll_run_lines_run); this partial index holds only
-- explained lines, keyed by run then time, so that MIN is one index probe per run, not a scan of every line.
CREATE INDEX IF NOT EXISTS idx_payroll_run_lines_explained
  ON public.payroll_run_lines (run_id, created_at) WHERE explanation IS NOT NULL;
