-- 882: Foreign keys for the CC1 / CC2 / BU columns on gl_journal_lines.
--
-- The journal half of 878 (see there for why): gl_journal_lines.cc1_id / cc2_id
-- / bu_id (migration 285) carry no FK, so a line written between the usage
-- guard's count and a master DELETE was left pointing at a deleted id. These
-- get RESTRICT FKs, NOT VALID. The lookups they make on a master delete use
-- idx_jl_cc1 / idx_jl_cc2 / idx_jl_bu (285).
--
-- NOT VALID: existing rows are not checked here, so an orphan already in the
-- data cannot fail the deploy, and no table is scanned. VALIDATE CONSTRAINT is
-- a separate, later step once the orphan counts are 0:
--   SELECT count(*) FROM gl_journal_lines t WHERE t.cc1_id IS NOT NULL
--     AND NOT EXISTS (SELECT 1 FROM cost_centres c WHERE c.id = t.cc1_id);   -- per column
--
-- LOCKS. ADD FOREIGN KEY ... NOT VALID takes SHARE ROW EXCLUSIVE on the table
-- and on the master it references (it blocks writes, not reads, and does no
-- scan), held to COMMIT because apply-migrations.ts runs each file in one
-- transaction. Nothing is dropped, so nothing takes ACCESS EXCLUSIVE. Each
-- constraint is added only when pg_constraint does not already hold it, so a
-- rerun touches nothing it already did.
-- ONE BIG TABLE PER FILE. A bank allocation takes ROW SHARE on bank_transactions
-- (lockBankTransactionForUpdate, the row FOR UPDATE), then ROW EXCLUSIVE on
-- gl_journal_lines (createJournalEntry inserts the lines), then ROW EXCLUSIVE on
-- bank_transactions (the UPDATE that marks the row allocated). A single
-- transaction holding SHARE ROW EXCLUSIVE on one of the two tables while it
-- waits for the other can deadlock with such an allocation in either order, so
-- the bank FKs (878) and the journal FKs (882) are separate files —
-- separate transactions — and neither holds one while waiting for the other.
--
-- If lock_timeout trips (a writer held the table for more than 5 s), the whole
-- file rolls back and nothing is recorded: RERUN the migration. It is idempotent.
--
-- Rollback: ALTER TABLE gl_journal_lines DROP CONSTRAINT IF EXISTS for each of the three.
SET LOCAL lock_timeout = '5s';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'gl_journal_lines_cc1_id_fkey' AND conrelid = 'gl_journal_lines'::regclass) THEN
    ALTER TABLE gl_journal_lines ADD CONSTRAINT gl_journal_lines_cc1_id_fkey
      FOREIGN KEY (cc1_id) REFERENCES cost_centres(id) ON DELETE RESTRICT NOT VALID;
  END IF;
END $$;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'gl_journal_lines_cc2_id_fkey' AND conrelid = 'gl_journal_lines'::regclass) THEN
    ALTER TABLE gl_journal_lines ADD CONSTRAINT gl_journal_lines_cc2_id_fkey
      FOREIGN KEY (cc2_id) REFERENCES cost_centres(id) ON DELETE RESTRICT NOT VALID;
  END IF;
END $$;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'gl_journal_lines_bu_id_fkey' AND conrelid = 'gl_journal_lines'::regclass) THEN
    ALTER TABLE gl_journal_lines ADD CONSTRAINT gl_journal_lines_bu_id_fkey
      FOREIGN KEY (bu_id) REFERENCES business_units(id) ON DELETE RESTRICT NOT VALID;
  END IF;
END $$;
