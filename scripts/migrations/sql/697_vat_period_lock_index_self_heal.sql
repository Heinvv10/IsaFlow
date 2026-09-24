-- 697: the one-active-lock-per-period index ends right whatever order 570,
-- 695 and 696 were (re-)run in.
--
-- The target state: exactly one unique index on (company_id, period_start,
-- period_end), the PARTIAL one (WHERE unlocked_at IS NULL), named
-- uq_vat_period_locks_company_period — 570's name, so a re-run of 570's
-- CREATE UNIQUE INDEX IF NOT EXISTS finds it and does nothing.
--
-- Why a new file rather than guarding 695/696: both are already recorded in
-- schema_migrations with their checksums on isaflow_dev, and
-- scripts/apply-migrations.ts treats an edited, applied file as a checksum
-- CONFLICT and exits 2 before applying ANYTHING — one edited file would block
-- every later migration on that database. Applied files stay as they are; this
-- one repairs any state they can leave:
--
--   - 570 re-run with no index of its name present → the FULL index under
--     570's name. Dropped here, and only when it is the full one (pg_index
--     .indpred IS NULL): the partial index of the same name is never dropped.
--   - 695 re-run after 696 → 695's DROP INDEX IF EXISTS removes the partial
--     index by name and its CREATE leaves a partial under the _active name.
--     The partial is recreated under 570's name and the _active duplicate
--     dropped.
--
-- Idempotent: on the target state every statement is a no-op.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_index i
    JOIN pg_class ic ON ic.oid = i.indexrelid
    WHERE i.indrelid = 'vat_period_locks'::regclass
      AND ic.relname = 'uq_vat_period_locks_company_period'
      AND i.indpred IS NULL
  ) THEN
    DROP INDEX uq_vat_period_locks_company_period;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS uq_vat_period_locks_company_period
  ON vat_period_locks (company_id, period_start, period_end)
  WHERE unlocked_at IS NULL;

DROP INDEX IF EXISTS uq_vat_period_locks_company_period_active;
