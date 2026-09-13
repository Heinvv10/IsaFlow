-- A provisional bank entry posted BEFORE the controlled bank allocation existed has no allocation intent and no
-- receipt, so a controlled reversal had nothing to name as its original — and a direct reverse of it is refused,
-- because its journal carries a generated source. Production holds such entries: without this they can never be
-- dismissed or undone.
--
-- A reversal intent may therefore name EXACTLY ONE of the two provenances: the original controlled intent, or the
-- legacy journal whose provenance was proven from the data (the bank row still names it as its provisional entry, and
-- the journal still carries the single bank line for that amount). Both cases execute the same
-- bank_allocation.reverse operation under the same approval policy; only what they prove the original by differs.
--
-- original_intent_id becomes nullable. Its composite FK stays exactly as it was: MATCH SIMPLE, so it is enforced for
-- every row that names an intent and not enforced for a row that names none.
ALTER TABLE control_bank_allocation_reversal_intents
  ALTER COLUMN original_intent_id DROP NOT NULL;
ALTER TABLE control_bank_allocation_reversal_intents
  ADD COLUMN IF NOT EXISTS legacy_journal_entry_id uuid;
-- The journal a legacy row names must exist in the same company. gl_journal_entries has no (company_id,id) unique
-- index of its own, so one is created for the composite reference.
CREATE UNIQUE INDEX IF NOT EXISTS control_gl_journal_entries_company_id
  ON gl_journal_entries(company_id,id);
DO $$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conname='control_bank_reversal_legacy_journal_fk') THEN
    ALTER TABLE control_bank_allocation_reversal_intents
      ADD CONSTRAINT control_bank_reversal_legacy_journal_fk
      FOREIGN KEY(company_id,legacy_journal_entry_id) REFERENCES gl_journal_entries(company_id,id);
  END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conname='control_bank_reversal_one_provenance') THEN
    ALTER TABLE control_bank_allocation_reversal_intents
      ADD CONSTRAINT control_bank_reversal_one_provenance
      CHECK((original_intent_id IS NULL) <> (legacy_journal_entry_id IS NULL));
  END IF;
END $$;
