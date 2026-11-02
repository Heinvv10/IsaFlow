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
-- same day. Existing rows stay NULL.
--
-- payroll_run_headers.calculated_at / calculation_version: written by every
-- calculation (payrollRunLock.saveCalculatedRunTotals). The approval gate
-- refuses a run calculated by older code (NULL or a lower version) and a run
-- whose employees' component dates changed (audit_log) after calculated_at.
--
-- Additive, nullable, no default, no rewrite; safe to re-run.

ALTER TABLE payroll_employee_components
  ADD COLUMN IF NOT EXISTS superseded_at TIMESTAMPTZ NULL;

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
