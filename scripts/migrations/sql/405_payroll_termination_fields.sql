-- Migration 400: Termination details on payroll_employees
-- Supports auto-calculation of leave pay-out, notice pay, and severance when
-- the employee's end_date falls within a payroll run period.
-- Pure logic lives in src/modules/accounting/services/core/leaveService.ts
-- (calculateTerminationPayout); this migration just stores the per-employee
-- inputs.

ALTER TABLE payroll_employees
  ADD COLUMN IF NOT EXISTS termination_reason                   VARCHAR(30),
  ADD COLUMN IF NOT EXISTS termination_notice_period_days       INT,
  ADD COLUMN IF NOT EXISTS termination_served_notice_days       INT,
  ADD COLUMN IF NOT EXISTS termination_severance_weeks_per_year NUMERIC(4,2),
  ADD COLUMN IF NOT EXISTS termination_include_leave_payout     BOOLEAN NOT NULL DEFAULT TRUE;
