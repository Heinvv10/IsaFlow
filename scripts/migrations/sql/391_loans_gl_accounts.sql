-- Migration 391: Link loans to required GL accounts for journal generation
-- Adds FK columns to the loans table for double-entry posting.
-- Semantics: gl_account_id = loan liability account (principal balance).

ALTER TABLE loans ADD COLUMN IF NOT EXISTS interest_expense_account_id uuid;
ALTER TABLE loans ADD COLUMN IF NOT EXISTS interest_payable_account_id uuid;
ALTER TABLE loans ADD COLUMN IF NOT EXISTS bank_account_id             uuid;
ALTER TABLE loans ADD COLUMN IF NOT EXISTS current_portion_account_id  uuid;

CREATE INDEX IF NOT EXISTS loans_interest_expense_account_idx ON loans (interest_expense_account_id);
CREATE INDEX IF NOT EXISTS loans_interest_payable_account_idx ON loans (interest_payable_account_id);
CREATE INDEX IF NOT EXISTS loans_bank_account_idx             ON loans (bank_account_id);
CREATE INDEX IF NOT EXISTS loans_current_portion_account_idx  ON loans (current_portion_account_id);
