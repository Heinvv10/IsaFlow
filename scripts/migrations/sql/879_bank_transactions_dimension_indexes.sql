-- 879: Indexes for the CC1 / CC2 / BU columns on bank_transactions.
--
-- Migration 878 gave these columns RESTRICT FKs. Every cost-centre or
-- business-unit delete now makes the FK look up bank_transactions by the
-- deleted id; without an index that is a sequential scan of the whole table
-- per delete (gl_journal_lines has had idx_jl_cc1 / cc2 / bu since 285).
-- Partial: almost every row carries none of the three.
--
-- NOT CONCURRENTLY: scripts/apply-migrations.ts has no non-transactional mode
-- — it wraps every file in BEGIN / COMMIT, and CREATE INDEX CONCURRENTLY cannot
-- run in a transaction block. A plain CREATE INDEX holds SHARE on
-- bank_transactions for the build: reads continue, writes (imports,
-- allocations) wait until it commits. Split from 878 so that wait is not held
-- together with 878's FK locks on gl_journal_lines.
--
-- If lock_timeout trips (a writer held bank_transactions for more than 5 s),
-- the file rolls back and nothing is recorded: RERUN the migration. IF NOT
-- EXISTS makes it idempotent.
--
-- Rollback: DROP INDEX IF EXISTS idx_bank_tx_cc1, idx_bank_tx_cc2, idx_bank_tx_bu.
SET LOCAL lock_timeout = '5s';

CREATE INDEX IF NOT EXISTS idx_bank_tx_cc1 ON bank_transactions (cc1_id) WHERE cc1_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_bank_tx_cc2 ON bank_transactions (cc2_id) WHERE cc2_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_bank_tx_bu  ON bank_transactions (bu_id)  WHERE bu_id IS NOT NULL;
