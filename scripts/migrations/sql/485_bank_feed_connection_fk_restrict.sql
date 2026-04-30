-- Migration 485: Make bank feed connection account FK compatible with NOT NULL
--
-- Migration 483 repointed bank_feed_connections.bank_account_id to gl_accounts(id)
-- but used ON DELETE SET NULL. The column is NOT NULL, so deleting a referenced
-- bank GL account raises a NOT NULL violation instead of a clear FK restriction.
--
-- Keep the required bank_account_id and make the dependency explicit: remove or
-- deactivate/delete the feed connection before deleting the bank account.

ALTER TABLE bank_feed_connections
  DROP CONSTRAINT IF EXISTS fk_bfc_bank_account;

ALTER TABLE bank_feed_connections
  ADD CONSTRAINT fk_bfc_bank_account
  FOREIGN KEY (bank_account_id) REFERENCES gl_accounts(id) ON DELETE RESTRICT;
