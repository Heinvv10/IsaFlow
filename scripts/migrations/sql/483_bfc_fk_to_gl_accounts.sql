-- Migration 483: Repoint bank_feed_connections.bank_account_id to gl_accounts(id)
--
-- Across the rest of the codebase, "bankAccountId" consistently means
-- gl_accounts.id where account_subtype='bank' — that's what the bank-account
-- selector returns, what bulk-commit accepts, and what bank_transactions.
-- bank_account_id FKs to. The FK on bank_feed_connections.bank_account_id
-- was pointing at the bank_accounts metadata table instead, which would
-- have rejected every connection that didn't have a hand-paired
-- bank_accounts row sharing the same uuid.
--
-- Safe to swap: bank_feed_connections currently has 0 rows in the dev DB,
-- and any prod rows that had a real bank_account_id were likely sharing
-- the same uuid as the matching gl_account anyway (because the legacy
-- AddConnectionModal already sent the gl_accounts.id from the dropdown).

ALTER TABLE bank_feed_connections
  DROP CONSTRAINT IF EXISTS fk_bfc_bank_account;

ALTER TABLE bank_feed_connections
  ADD CONSTRAINT fk_bfc_bank_account
  FOREIGN KEY (bank_account_id) REFERENCES gl_accounts(id);
