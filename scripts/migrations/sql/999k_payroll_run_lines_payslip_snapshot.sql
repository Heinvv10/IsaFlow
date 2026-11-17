-- 999k: payslip details frozen at approval (wave 6 PS3).
--
-- WHAT. payroll_run_lines.payslip_snapshot (jsonb, nullable): the employee's and the employer's details as they
-- were when the run was approved, written by approvePayrollRun (payslipSnapshot.freezePayslipDetails) in the
-- approval's own transaction, and cleared by reopenPayrollRun. It holds the header's approved_at, and a slip uses
-- it only while that equals the header's current approved_at (grill F8); otherwise the slip reads live details and
-- says "as at download". The bank account is stored as its last four digits and length only, never the number.
-- Not part of the approval plan hash (payrollApprovalHash reads the journal plan only).
--
-- OLD COLOUR (the release before this one, running against this schema while the deploy switches colours):
--   insert  calculate DELETEs and re-INSERTs a run's lines naming its columns: the new column is NULL.
--   update  no old-colour statement names the column; approve writes no snapshot, reopen clears none. A run that
--           the old colour reopens and re-approves keeps an older snapshot whose approved_at no longer equals the
--           header's, so the new colour reads live details for it (F8), as it does for any run without one.
--   read    the old colour never selects the column (no SELECT * on payroll_run_lines reaches a response).
--
-- LOCKS. ADD COLUMN with no default is catalogue-only; ACCESS EXCLUSIVE is held for that instant, bounded by
-- lock_timeout. No backfill: runs approved before this migration have no snapshot and read live ("as at download").
-- No new table, so no RLS change; payroll_run_lines keeps its grants (app_user already writes the table).

SET LOCAL lock_timeout = '5s';

ALTER TABLE payroll_run_lines ADD COLUMN IF NOT EXISTS payslip_snapshot jsonb;

COMMENT ON COLUMN payroll_run_lines.payslip_snapshot IS
  'Wave 6 PS3: employee and employer details at approval (approvedAt = the header''s approved_at then). Used only while it equals the header''s current approved_at.';
