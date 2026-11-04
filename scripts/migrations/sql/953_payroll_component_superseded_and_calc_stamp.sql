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
-- same day. Existing rows keep superseded_at NULL. Instead they carry
-- supersede_inferred = TRUE, and for those rows only the reader keeps the old
-- rule: a once-off counts as superseded when another such row of the same
-- employee and component starts the day after it ends.
--
-- supersede_inferred is added NOT NULL DEFAULT TRUE: on PG11+ that stores the
-- default in the catalogue and rewrites no row, and every existing row reads
-- TRUE. The default STAYS TRUE: a row inserted by code from before this
-- release (during the deploy window, or after a code-only rollback) does not
-- name the column and so is read with the old rule too, and that code does
-- not set superseded_at, so the new rule would pay a once-off it replaced
-- twice. Every writer in this release names the column and writes FALSE
-- (assign, package apply, batch post; onboarding and MCP assign through
-- assign). Applies to every tenant by construction: it records "written by
-- code from before 953", not a decision about any company's data.
--
-- payroll_run_headers.calculated_at / calculation_version: written by every
-- calculation (payrollRunLock.saveCalculatedRunTotals). The approval gate
-- refuses a run calculated by older code (NULL or a lower version) and a run
-- whose employees' component dates changed (audit_log) after calculated_at.
--
-- Additive, catalogue-only (no row rewrite, no UPDATE); no trigger or policy on
-- either table. Safe to re-run. Waits at most 5s for each table's lock, as 718
-- and 925 do, so a busy payroll table fails the deploy instead of queueing
-- every request behind it.

SET LOCAL lock_timeout = '5s';

ALTER TABLE payroll_employee_components
  ADD COLUMN IF NOT EXISTS superseded_at TIMESTAMPTZ NULL;

ALTER TABLE payroll_employee_components
  ADD COLUMN IF NOT EXISTS supersede_inferred BOOLEAN NOT NULL DEFAULT TRUE;

COMMENT ON COLUMN payroll_employee_components.supersede_inferred IS
  'TRUE (the default): written by code from before migration 953, and the reader infers a supersede from a neighbouring such row (the old rule). FALSE (every writer since 953 writes it): superseded_at alone decides.';

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
