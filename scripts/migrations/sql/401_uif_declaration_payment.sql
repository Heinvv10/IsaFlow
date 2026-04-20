-- Migration 401: UIF Declaration Payment columns
-- Adds journal_entry_id, payment_date, and 'paid' status to uif_declarations

ALTER TABLE uif_declarations
  ADD COLUMN IF NOT EXISTS journal_entry_id UUID REFERENCES gl_journal_entries(id),
  ADD COLUMN IF NOT EXISTS payment_date DATE;

-- Widen the status check constraint to allow 'paid'
-- Drop the old constraint if it exists (was implicit via VARCHAR; no explicit CHECK was added in 398).
-- Status is stored as VARCHAR(20) with no CHECK constraint in migration 398, so no constraint to drop.
-- Add an explicit CHECK now that covers all valid values.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'uif_declarations'::regclass
      AND conname = 'uif_declarations_status_check'
  ) THEN
    ALTER TABLE uif_declarations
      ADD CONSTRAINT uif_declarations_status_check
        CHECK (status IN ('draft', 'submitted', 'accepted', 'paid'));
  END IF;
END;
$$;

CREATE INDEX IF NOT EXISTS uif_declarations_journal_entry_idx
  ON uif_declarations(journal_entry_id)
  WHERE journal_entry_id IS NOT NULL;
