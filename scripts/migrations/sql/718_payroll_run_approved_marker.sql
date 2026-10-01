-- 718: W3-01 — the approval columns payroll_run_headers lacked in migrations, and the
-- "lines confirmed" marker.
--
-- approved_by / approved_at: approvePayrollRun writes both and reopenPayrollRun clears
-- them. They existed on databases cloned from dev but no migration created them, so a
-- database built from the migrations alone (production among them) lacked them and
-- every approve failed. Same definition as dev — plain UUID and TIMESTAMPTZ, nullable,
-- no foreign key — so on dev this part is a no-op.
--
-- lines_confirmed_at: new. Approval stamps it with clock_timestamp() under the run's
-- header lock, once its gate has confirmed the run's lines against the journal; the
-- gate reads it as "recalculated since?" (payrollJournalChain#runRecalculatedSince).
-- It is NOT approved_at: a reopen clears the approval, but the lines were still last
-- confirmed then, and a reopened run is exactly the one the gate judges. Cleared, the
-- gate fell back to the journal's created_at — the approving transaction's START —
-- and an approval that had waited behind a calculation read as "recalculated" for good.
--
-- No backfill: a run approved before this has NULL and the gate falls back to its
-- journal's created_at, as before.
--
-- ADD COLUMN on a nullable column with no default is catalog-only, but it still takes
-- an ACCESS EXCLUSIVE lock; queued behind a long transaction it would block every
-- payroll read, so fail instead (as 660, 717).
SET LOCAL lock_timeout = '5s';

ALTER TABLE payroll_run_headers
  ADD COLUMN IF NOT EXISTS approved_by UUID,
  ADD COLUMN IF NOT EXISTS approved_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS lines_confirmed_at TIMESTAMPTZ;
