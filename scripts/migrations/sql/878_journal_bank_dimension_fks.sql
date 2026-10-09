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
-- data cannot fail the deploy. New and updated rows are checked from now on.
-- VALIDATE CONSTRAINT is a separate, later step once the orphan counts are 0:
--   SELECT count(*) FROM gl_journal_lines t WHERE t.cc1_id IS NOT NULL
--     AND NOT EXISTS (SELECT 1 FROM cost_centres c WHERE c.id = t.cc1_id);   -- per column
--
-- The partial indexes on bank_transactions serve the FK's own lookup on every
-- master delete (gl_journal_lines has them since 285: idx_jl_cc1/cc2/bu).
--
-- Rollback: ALTER TABLE ... DROP CONSTRAINT IF EXISTS for each of the six;
-- DROP INDEX IF EXISTS for the three indexes.
SET LOCAL lock_timeout = '5s';

ALTER TABLE gl_journal_lines DROP CONSTRAINT IF EXISTS gl_journal_lines_cc1_id_fkey;
ALTER TABLE gl_journal_lines ADD CONSTRAINT gl_journal_lines_cc1_id_fkey
  FOREIGN KEY (cc1_id) REFERENCES cost_centres(id) ON DELETE RESTRICT NOT VALID;

ALTER TABLE gl_journal_lines DROP CONSTRAINT IF EXISTS gl_journal_lines_cc2_id_fkey;
ALTER TABLE gl_journal_lines ADD CONSTRAINT gl_journal_lines_cc2_id_fkey
  FOREIGN KEY (cc2_id) REFERENCES cost_centres(id) ON DELETE RESTRICT NOT VALID;

ALTER TABLE gl_journal_lines DROP CONSTRAINT IF EXISTS gl_journal_lines_bu_id_fkey;
ALTER TABLE gl_journal_lines ADD CONSTRAINT gl_journal_lines_bu_id_fkey
  FOREIGN KEY (bu_id) REFERENCES business_units(id) ON DELETE RESTRICT NOT VALID;

ALTER TABLE bank_transactions DROP CONSTRAINT IF EXISTS bank_transactions_cc1_id_fkey;
ALTER TABLE bank_transactions ADD CONSTRAINT bank_transactions_cc1_id_fkey
  FOREIGN KEY (cc1_id) REFERENCES cost_centres(id) ON DELETE RESTRICT NOT VALID;

ALTER TABLE bank_transactions DROP CONSTRAINT IF EXISTS bank_transactions_cc2_id_fkey;
ALTER TABLE bank_transactions ADD CONSTRAINT bank_transactions_cc2_id_fkey
  FOREIGN KEY (cc2_id) REFERENCES cost_centres(id) ON DELETE RESTRICT NOT VALID;

ALTER TABLE bank_transactions DROP CONSTRAINT IF EXISTS bank_transactions_bu_id_fkey;
ALTER TABLE bank_transactions ADD CONSTRAINT bank_transactions_bu_id_fkey
  FOREIGN KEY (bu_id) REFERENCES business_units(id) ON DELETE RESTRICT NOT VALID;

CREATE INDEX IF NOT EXISTS idx_bank_tx_cc1 ON bank_transactions (cc1_id) WHERE cc1_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_bank_tx_cc2 ON bank_transactions (cc2_id) WHERE cc2_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_bank_tx_bu  ON bank_transactions (bu_id)  WHERE bu_id IS NOT NULL;
