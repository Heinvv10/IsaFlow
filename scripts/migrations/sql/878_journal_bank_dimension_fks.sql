-- 878: Foreign keys for the CC1 / CC2 / BU columns on journal and bank lines.
--
-- gl_journal_lines.cc1_id / cc2_id / bu_id (migration 285) and
-- bank_transactions.cc1_id / cc2_id / bu_id carry no FK, so the only thing
-- protecting them from a master delete is the usage guard's count — and a line
-- written between that count and the DELETE is left pointing at a deleted id
-- (#678 review M2). The document and default columns got RESTRICT FKs in
-- migration 870; these six get the same. deleteCostCentre / deleteBusinessUnit
-- run the DELETE in its own savepoint and answer the 23503 as the normal
-- "in use" refusal.
--
-- NOT VALID: existing rows are not checked here, so an orphan already in the
-- data cannot fail the deploy, and no table is scanned. New and updated rows
-- are checked from now on. VALIDATE CONSTRAINT is a separate, later step once
-- the orphan counts are 0:
--   SELECT count(*) FROM gl_journal_lines t WHERE t.cc1_id IS NOT NULL
--     AND NOT EXISTS (SELECT 1 FROM cost_centres c WHERE c.id = t.cc1_id);   -- per column
--
-- LOCKS. ADD FOREIGN KEY ... NOT VALID takes SHARE ROW EXCLUSIVE on the table
-- and on the master it references (it blocks writes, not reads, and does no
-- scan), held to COMMIT because apply-migrations.ts runs each file in one
-- transaction. Nothing is dropped, so nothing takes ACCESS EXCLUSIVE. Each
-- constraint is added only when pg_constraint does not already hold it, so a
-- rerun touches nothing it already did.
-- ORDER: bank_transactions before gl_journal_lines — the order a bank
-- allocation takes them at runtime (the bank row, then the journal lines it
-- posts). The reverse order would let this file hold gl_journal_lines while
-- waiting on an allocation that holds its bank row and next writes a journal
-- line: a deadlock that kills one side.
--
-- If lock_timeout trips (a long writer held one of these tables for more than
-- 5 s), the whole file rolls back and nothing is recorded: RERUN the migration.
-- It is idempotent.
--
-- The indexes the bank FKs' delete-time lookups want are migration 879.
--
-- Rollback: ALTER TABLE ... DROP CONSTRAINT IF EXISTS for each of the six.
SET LOCAL lock_timeout = '5s';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'bank_transactions_cc1_id_fkey' AND conrelid = 'bank_transactions'::regclass) THEN
    ALTER TABLE bank_transactions ADD CONSTRAINT bank_transactions_cc1_id_fkey
      FOREIGN KEY (cc1_id) REFERENCES cost_centres(id) ON DELETE RESTRICT NOT VALID;
  END IF;
END $$;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'bank_transactions_cc2_id_fkey' AND conrelid = 'bank_transactions'::regclass) THEN
    ALTER TABLE bank_transactions ADD CONSTRAINT bank_transactions_cc2_id_fkey
      FOREIGN KEY (cc2_id) REFERENCES cost_centres(id) ON DELETE RESTRICT NOT VALID;
  END IF;
END $$;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'bank_transactions_bu_id_fkey' AND conrelid = 'bank_transactions'::regclass) THEN
    ALTER TABLE bank_transactions ADD CONSTRAINT bank_transactions_bu_id_fkey
      FOREIGN KEY (bu_id) REFERENCES business_units(id) ON DELETE RESTRICT NOT VALID;
  END IF;
END $$;
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
