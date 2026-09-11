-- 675_bank_feed_canonical_ingestion.sql
-- Bank sync v1 Release 1: feed identity + lifecycle on bank_transactions, a
-- database backstop that keeps non-posted feed rows out of every accounting
-- mutation, protected-conflict storage, and richer sync-log counts.
-- No DML on existing rows: feed_state's constant DEFAULT is a catalog-only
-- change (PG11+), and every new column is NULL or defaulted.

-- 1. Tenant-composite key on connections so child FKs carry ownership.
CREATE UNIQUE INDEX IF NOT EXISTS uq_bank_feed_connections_id_company
  ON bank_feed_connections (id, company_id);

ALTER TABLE bank_feed_connections
  ADD COLUMN IF NOT EXISTS last_success_at TIMESTAMPTZ;

-- 2. Feed columns on bank_transactions.
ALTER TABLE bank_transactions
  ADD COLUMN IF NOT EXISTS bank_feed_connection_id UUID,
  ADD COLUMN IF NOT EXISTS provider_transaction_id TEXT,
  ADD COLUMN IF NOT EXISTS feed_state TEXT NOT NULL DEFAULT 'posted',
  ADD COLUMN IF NOT EXISTS provider_updated_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS feed_last_seen_at TIMESTAMPTZ;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'bank_tx_feed_state_check' AND conrelid = 'bank_transactions'::regclass) THEN
    ALTER TABLE bank_transactions ADD CONSTRAINT bank_tx_feed_state_check
      CHECK (feed_state IN ('pending', 'posted', 'removed')) NOT VALID;
    ALTER TABLE bank_transactions VALIDATE CONSTRAINT bank_tx_feed_state_check;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'bank_tx_feed_identity_required' AND conrelid = 'bank_transactions'::regclass) THEN
    ALTER TABLE bank_transactions ADD CONSTRAINT bank_tx_feed_identity_required
      CHECK (feed_state = 'posted'
             OR (bank_feed_connection_id IS NOT NULL AND provider_transaction_id IS NOT NULL)) NOT VALID;
    ALTER TABLE bank_transactions VALIDATE CONSTRAINT bank_tx_feed_identity_required;
  END IF;
  -- A provider id always names its connection. The reverse is not required:
  -- content-hash-identified extension rows carry a connection with a NULL
  -- provider_transaction_id (decision 1, context.md).
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'bank_tx_feed_identity_paired' AND conrelid = 'bank_transactions'::regclass) THEN
    ALTER TABLE bank_transactions ADD CONSTRAINT bank_tx_feed_identity_paired
      CHECK (provider_transaction_id IS NULL OR bank_feed_connection_id IS NOT NULL) NOT VALID;
    ALTER TABLE bank_transactions VALIDATE CONSTRAINT bank_tx_feed_identity_paired;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_bank_tx_feed_connection' AND conrelid = 'bank_transactions'::regclass) THEN
    ALTER TABLE bank_transactions ADD CONSTRAINT fk_bank_tx_feed_connection
      FOREIGN KEY (bank_feed_connection_id, company_id)
      REFERENCES bank_feed_connections (id, company_id) ON DELETE RESTRICT NOT VALID;
    ALTER TABLE bank_transactions VALIDATE CONSTRAINT fk_bank_tx_feed_connection;
  END IF;
END
$$;

-- Tenant-composite key so the conflicts table's FK to bank_transactions can
-- carry company_id (finding 4, fix round 1).
CREATE UNIQUE INDEX IF NOT EXISTS uq_bank_transactions_id_company
  ON bank_transactions (id, company_id);

CREATE UNIQUE INDEX IF NOT EXISTS uq_bank_tx_feed_identity
  ON bank_transactions (company_id, bank_feed_connection_id, provider_transaction_id)
  WHERE provider_transaction_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_bank_tx_feed_state_nonposted
  ON bank_transactions (company_id, bank_account_id)
  WHERE feed_state <> 'posted';

-- 3. Backstop trigger. Columns are the accounting-workflow columns created by
--    migrations (203, 253/282, 414, 492, 514, 520). The drift columns
--    (transfer_journal_entry_id etc.) are deliberately absent: every writer of
--    them also writes status, which is guarded.
--    cc1_id/cc2_id/bu_id are intentionally NOT guarded on pending rows: they
--    are pre-allocation metadata (like the suggested_* columns), and
--    allocation re-validates them once the row leaves 'pending' (finding 5,
--    fix round 1, controller ruling: keep behaviour).
CREATE OR REPLACE FUNCTION bank_tx_feed_state_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.feed_state IS DISTINCT FROM OLD.feed_state
     AND NOT (OLD.feed_state = 'pending' AND NEW.feed_state IN ('posted', 'removed')) THEN
    RAISE EXCEPTION 'BANK_TX_FEED_GUARD: bank transaction % cannot move from % to %',
      OLD.id, OLD.feed_state, NEW.feed_state USING ERRCODE = '23514';
  END IF;

  IF OLD.feed_state <> 'posted' AND (
       NEW.status, NEW.matched_journal_line_id, NEW.reconciliation_id, NEW.allocation_type,
       NEW.provisional_je_id, NEW.auto_post_run_id, NEW.allocation_batch_id, NEW.allocation_rule_id
     ) IS DISTINCT FROM (
       OLD.status, OLD.matched_journal_line_id, OLD.reconciliation_id, OLD.allocation_type,
       OLD.provisional_je_id, OLD.auto_post_run_id, OLD.allocation_batch_id, OLD.allocation_rule_id
     ) THEN
    RAISE EXCEPTION 'BANK_TX_FEED_GUARD: bank transaction % is % at the bank and cannot be processed',
      OLD.id, OLD.feed_state USING ERRCODE = '23514';
  END IF;

  IF OLD.bank_feed_connection_id IS NOT NULL
     AND (OLD.status IS DISTINCT FROM 'imported' OR OLD.matched_journal_line_id IS NOT NULL
          OR OLD.provisional_je_id IS NOT NULL)
     AND (NEW.transaction_date, NEW.value_date, NEW.amount, NEW.description, NEW.reference)
         IS DISTINCT FROM
         (OLD.transaction_date, OLD.value_date, OLD.amount, OLD.description, OLD.reference) THEN
    RAISE EXCEPTION 'BANK_TX_FEED_GUARD: processed feed transaction % source fields are immutable',
      OLD.id USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS trg_bank_tx_feed_state_guard ON bank_transactions;
CREATE TRIGGER trg_bank_tx_feed_state_guard
  BEFORE UPDATE ON bank_transactions
  FOR EACH ROW EXECUTE FUNCTION bank_tx_feed_state_guard();

-- 4. Protected conflicts.
CREATE TABLE IF NOT EXISTS bank_feed_transaction_conflicts (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id              UUID NOT NULL REFERENCES companies(id),
  connection_id           UUID NOT NULL,
  bank_transaction_id     UUID NOT NULL,
  provider_transaction_id TEXT NOT NULL,
  reason                  TEXT NOT NULL CHECK (reason IN (
                            'processed_row_changed', 'posted_row_removed',
                            'posted_row_reverted_to_pending', 'removed_row_reappeared',
                            'unordered_change')),
  proposed                JSONB NOT NULL,
  first_seen_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at             TIMESTAMPTZ,
  CONSTRAINT fk_bfc_conflict_connection FOREIGN KEY (connection_id, company_id)
    REFERENCES bank_feed_connections (id, company_id) ON DELETE RESTRICT,
  -- CASCADE (not RESTRICT): archiveExecutionService.ts:167,
  -- bankTransactionQueryService.ts:204 deleteTransactions, and
  -- scripts/qa-seed/reset.ts:60 all delete bank_transactions rows and must
  -- not 23503 once a conflict exists (finding 1, fix round 1).
  CONSTRAINT fk_bfc_conflict_bank_transaction FOREIGN KEY (bank_transaction_id, company_id)
    REFERENCES bank_transactions (id, company_id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_bank_feed_conflict_open
  ON bank_feed_transaction_conflicts (company_id, connection_id, provider_transaction_id)
  WHERE resolved_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_bank_feed_conflict_company_open
  ON bank_feed_transaction_conflicts (company_id, connection_id) WHERE resolved_at IS NULL;

ALTER TABLE bank_feed_transaction_conflicts ENABLE ROW LEVEL SECURITY;
ALTER TABLE bank_feed_transaction_conflicts FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON bank_feed_transaction_conflicts;
CREATE POLICY tenant_isolation ON bank_feed_transaction_conflicts
  FOR ALL
  TO app_user
  USING (company_id IN (SELECT auth.user_companies()))
  WITH CHECK (company_id = app.current_company_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON bank_feed_transaction_conflicts TO app_user;

-- 5. Sync-log counts.
ALTER TABLE bank_feed_sync_logs
  ADD COLUMN IF NOT EXISTS transactions_updated  INT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS transactions_pending  INT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS transactions_removed  INT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS transactions_conflict INT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS transactions_ignored  INT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS error_code TEXT;
