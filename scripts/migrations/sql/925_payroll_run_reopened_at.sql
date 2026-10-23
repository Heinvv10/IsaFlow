-- 925: when a payroll run was reopened, and the approval periods its reopens
-- ended (PAYE 4a follow-ups round 2, R1).
--
-- The stale year-to-date gate (payrollYearToDateGate#judgeYearToDate) asks,
-- for another month of the tax year: was it approved, as it now stands, when
-- this run was calculated? A reopen clears approved_at, so before this the
-- headers kept no trace of an earlier approval, and an unchanged re-approval
-- of an earlier month refused the later month (once; a recalculation cleared it).
--
-- reopened_at: the last reopen, clock_timestamp(). Writer: reopenPayrollRun.
--   An AUDIT field only: no code reads it, and the gate does NOT use it (the
--   last reopen alone cannot answer its question, below; approval_history can).
-- approval_history: every approval a reopen ended, [approved_at, reopened_at).
--   The last reopen alone is not enough: a month reopened, re-approved and
--   reopened again has a gap BEFORE its last reopen, and a run calculated in
--   that gap left it out (tests/integration/p4fu-r2-exact-gate.int.test.ts,
--   first case). A range whose approved_at was NULL (approved before 718) is
--   unbounded below: approved since before anything the gate compares.
--   Reader: payrollYearToDateGate#judgeYearToDate.
-- approved_taxed_employees: every employee an approval a reopen ended taxed
--   from the tables (periodic or annual taxable > 0; before 913, taxable
--   income > 0), the UNION over all of them. The gate refuses this run for a
--   later month that read an earlier version of it only for someone in it
--   (breaker round 3, Hein 2026-10-23): a starter in the later month no longer
--   forces it to be reopened. A union, not a set per approval: it holds every
--   earlier version's employees, so it never misses; its cost is a refusal for
--   someone taxed only in a version the later month did not read. NULL with a
--   history = reopened before this column: unknown, conservative, and a later
--   reopen keeps it NULL. Writer: reopenPayrollRun.
--
-- Additive only: two nullable columns. Existing rows stay NULL: a run reopened
-- before this has no recorded history, and the gate treats it as never
-- approved before its current approval (conservative: one recalculation of
-- the later month clears a refusal, as before).
--
-- Rollback:
--   ALTER TABLE payroll_run_headers DROP COLUMN IF EXISTS approved_taxed_employees;
--   ALTER TABLE payroll_run_headers DROP COLUMN IF EXISTS approval_history;
--   ALTER TABLE payroll_run_headers DROP COLUMN IF EXISTS reopened_at;
SET LOCAL lock_timeout = '5s';

ALTER TABLE payroll_run_headers
  ADD COLUMN IF NOT EXISTS reopened_at TIMESTAMPTZ NULL,
  ADD COLUMN IF NOT EXISTS approval_history TSTZMULTIRANGE NULL;

-- Its own statement, so a database that already has the two above can take it alone.
ALTER TABLE payroll_run_headers ADD COLUMN IF NOT EXISTS approved_taxed_employees UUID[] NULL;
