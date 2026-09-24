-- 696: make the one-active-lock-per-period index survive a re-run of 570.
--
-- 695 replaced 570's full unique index (company_id, period_start, period_end)
-- with a PARTIAL one (WHERE unlocked_at IS NULL) under a new name, so a period
-- can be re-locked after an unlock. But 570 is not recorded in
-- schema_migrations on every database (isaflow_dev lacks it), so the next
-- `db:migrate` re-runs 570 and its CREATE UNIQUE INDEX IF NOT EXISTS
-- recreates the FULL index beside the partial one — and a period can then
-- never be re-locked. Observed on isaflow_dev on 2026-09-24.
--
-- Fix: the partial index takes 570's name. 570's IF NOT EXISTS then finds an
-- index of that name and does nothing, whenever it re-runs. ON CONFLICT infers
-- its arbiter by columns and predicate, not by name, so no code changes.

DROP INDEX IF EXISTS uq_vat_period_locks_company_period;

CREATE UNIQUE INDEX IF NOT EXISTS uq_vat_period_locks_company_period
  ON vat_period_locks (company_id, period_start, period_end)
  WHERE unlocked_at IS NULL;

DROP INDEX IF EXISTS uq_vat_period_locks_company_period_active;
