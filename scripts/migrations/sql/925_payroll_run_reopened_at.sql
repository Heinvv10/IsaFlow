-- 925: when a payroll run was reopened, and the approval periods its reopens
-- ended (PAYE 4a follow-ups round 2, R1).
--
-- The stale year-to-date gate (payrollYearToDate#judgeYearToDateStale) asks,
-- for another month of the tax year: was it approved, as it now stands, when
-- this run was calculated? A reopen clears approved_at, so before this the
-- headers kept no trace of an earlier approval, and an unchanged re-approval
-- of an earlier month refused the later month (once; a recalculation cleared it).
--
-- reopened_at: the last reopen, clock_timestamp(). Writer: reopenPayrollRun.
-- approval_history: every approval a reopen ended, [approved_at, reopened_at).
--   The last reopen alone is not enough: a month reopened, re-approved and
--   reopened again has a gap BEFORE its last reopen, and a run calculated in
--   that gap left it out (tests/integration/p4fu-r2-exact-gate.int.test.ts,
--   first case). A range whose approved_at was NULL (approved before 718) is
--   unbounded below: approved since before anything the gate compares.
--   Reader: judgeYearToDateStale.
--
-- Additive only: two nullable columns. Existing rows stay NULL: a run reopened
-- before this has no recorded history, and the gate treats it as never
-- approved before its current approval (conservative: one recalculation of
-- the later month clears a refusal, as before).
--
-- Rollback:
--   ALTER TABLE payroll_run_headers DROP COLUMN IF EXISTS approval_history;
--   ALTER TABLE payroll_run_headers DROP COLUMN IF EXISTS reopened_at;
SET LOCAL lock_timeout = '5s';

ALTER TABLE payroll_run_headers
  ADD COLUMN IF NOT EXISTS reopened_at TIMESTAMPTZ NULL,
  ADD COLUMN IF NOT EXISTS approval_history TSTZMULTIRANGE NULL;
