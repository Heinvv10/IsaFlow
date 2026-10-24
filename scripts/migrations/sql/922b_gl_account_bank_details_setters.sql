-- Migration 922b: who set a bank account's CURRENT number / branch code.
--
-- Read by migration 923's approval_supplier_payment_authors: the editor of the account a payment is
-- paid from is an author of it, as a payee's bank_details_setters are (Hein, 2026-10-23). Written only
-- by the bank-accounts PUT (ap/payingAccountAuthors.recordPayingAccountEdit); a new number restarts it.
--
-- Its own migration, before 923: ADD COLUMN takes ACCESS EXCLUSIVE on gl_accounts, which here is
-- catalogue-only (nullable, no default) and released at COMMIT a moment later. Inside 923 it would be
-- held across 923's snapshot and block every read of gl_accounts (review / breaker, 2026-10-23).
-- No grant: app_user's table-level UPDATE on gl_accounts covers the new column.
SET LOCAL lock_timeout = '5s';

ALTER TABLE public.gl_accounts ADD COLUMN IF NOT EXISTS bank_details_setters UUID[];

COMMENT ON COLUMN public.gl_accounts.bank_details_setters IS
  'Who set this bank account''s CURRENT number / branch code (migration 922b): authors of every payment paid from it (923). Written by the bank-accounts PUT only.';
