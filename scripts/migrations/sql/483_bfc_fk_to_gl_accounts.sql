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
-- Precheck: abort if any existing bank_account_id values are absent from
-- gl_accounts. Those rows would become orphaned after the FK swap, which is
-- unsafe. In practice there are 0 rows in dev and any prod rows share the
-- gl_accounts uuid (the selector always returned gl_accounts.id).

DO $$
DECLARE
  orphan_count INT;
BEGIN
  SELECT COUNT(*) INTO orphan_count
    FROM bank_feed_connections bfc
   WHERE bfc.bank_account_id IS NOT NULL
     AND NOT EXISTS (
       SELECT 1 FROM gl_accounts ga WHERE ga.id = bfc.bank_account_id
     );

  IF orphan_count > 0 THEN
    RAISE EXCEPTION
      'Migration 483 aborted: % bank_feed_connections row(s) have bank_account_id values '
      'that do not exist in gl_accounts. Resolve these rows before re-running.',
      orphan_count;
  END IF;
END $$;

ALTER TABLE bank_feed_connections
  DROP CONSTRAINT IF EXISTS fk_bfc_bank_account;

ALTER TABLE bank_feed_connections
  ADD CONSTRAINT fk_bfc_bank_account
  FOREIGN KEY (bank_account_id) REFERENCES gl_accounts(id) ON DELETE SET NULL;
