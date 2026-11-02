-- 953: payroll component supersede marker and the run's calculation stamp
-- (fix/payroll-run-read-date, payroll breaker round, Hein 2026-11-02).
--
-- payroll_employee_components.superseded_at: set by payPackageService when a
-- package apply shortens or cancels an existing assignment. The pay-run reader
-- (payrollComponentService.getEmployeeComponents) pays a once-off whose window
-- starts in the run's month and ends before its last day, unless superseded_at
-- is set. Before this column the reader inferred a supersede from a neighbouring
-- row starting the day after, so contiguous once-offs (weekly overtime) were
-- not paid, and ending the neighbour made a replaced once-off payable again.
--
-- No backfill: a package supersede leaves no record of its own (no application
-- history; the old row's effective_to is the apply date minus one day), so a
-- superseded row cannot be told apart from an assignment ended by hand on the
-- same day. Existing rows keep superseded_at NULL. Instead every row that
-- exists when this migration first runs is marked supersede_inferred = TRUE,
-- and for those rows only the reader keeps the old rule: a once-off counts as
-- superseded when another such row of the same employee and component starts
-- the day after it ends. Rows created later default to FALSE and use
-- superseded_at alone. The marking runs only in the run that adds the column,
-- so a re-run never marks newer rows. It is deliberately across every tenant:
-- it records "existed before 953", not a decision about any company's data.
--
-- payroll_run_headers.calculated_at / calculation_version: written by every
-- calculation (payrollRunLock.saveCalculatedRunTotals). The approval gate
-- refuses a run calculated by older code (NULL or a lower version) and a run
-- whose employees' component dates changed (audit_log) after calculated_at.
--
-- Additive. One UPDATE of every payroll_employee_components row (the marker),
-- in the run that adds the column only; no trigger or policy on that table.
-- Safe to re-run.

ALTER TABLE payroll_employee_components
  ADD COLUMN IF NOT EXISTS superseded_at TIMESTAMPTZ NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'payroll_employee_components'
       AND column_name = 'supersede_inferred'
  ) THEN
    ALTER TABLE public.payroll_employee_components
      ADD COLUMN supersede_inferred BOOLEAN NOT NULL DEFAULT FALSE;
    UPDATE public.payroll_employee_components SET supersede_inferred = TRUE;
  END IF;
END $$;

COMMENT ON COLUMN payroll_employee_components.supersede_inferred IS
  'TRUE: the row existed before migration 953, and the reader infers a supersede from a neighbouring pre-953 row (the old rule). FALSE: superseded_at alone decides.';

COMMENT ON COLUMN payroll_employee_components.superseded_at IS
  'When a pay-package apply shortened or cancelled this assignment (payPackageService). A once-off ending before its month end is paid only while this is NULL.';

ALTER TABLE payroll_run_headers
  ADD COLUMN IF NOT EXISTS calculated_at TIMESTAMPTZ NULL;

ALTER TABLE payroll_run_headers
  ADD COLUMN IF NOT EXISTS calculation_version SMALLINT NULL;

COMMENT ON COLUMN payroll_run_headers.calculated_at IS
  'When calculatePayrollRun last wrote this run''s lines and totals. NULL: calculated before migration 953.';

COMMENT ON COLUMN payroll_run_headers.calculation_version IS
  'The payroll calculation version that wrote the lines (PAYROLL_CALCULATION_VERSION). Approval refuses a NULL or older one: recalculate.';
