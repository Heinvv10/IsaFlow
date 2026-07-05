-- 500: widen gl_journal_entries.entry_number VARCHAR(20) → VARCHAR(50)
--
-- The depreciation hook generates entry numbers like
-- 'DEP-<asset_number>-YYYY-MM' (glCrossModuleHooks.postAssetDepreciationToGL).
-- With Demo asset numbers ASST-00NN that is 21 characters — one over the
-- column's VARCHAR(20) — so EVERY depreciation GL post failed with 22001
-- (value too long), was swallowed per-asset, and the poisoned request
-- transaction then 500'd the rest of the run (A–Z programme P1.5, found
-- 2026-07-05 via golden-path spec j).
--
-- trg_gl_je_entry_number's WHEN clause references entry_number, and Postgres
-- refuses to ALTER a column referenced by a trigger definition (0A000) — so
-- the trigger is dropped and recreated verbatim around the ALTER. Runs in one
-- transaction via the migration runner, so no INSERT can slip through the
-- trigger gap. Idempotent: re-running re-creates the same trigger and the
-- ALTER to the same type is a no-op.

DROP TRIGGER IF EXISTS trg_gl_je_entry_number ON gl_journal_entries;

ALTER TABLE gl_journal_entries ALTER COLUMN entry_number TYPE VARCHAR(50);

CREATE TRIGGER trg_gl_je_entry_number
  BEFORE INSERT ON gl_journal_entries
  FOR EACH ROW
  WHEN (NEW.entry_number IS NULL)
  EXECUTE FUNCTION generate_journal_entry_number();
