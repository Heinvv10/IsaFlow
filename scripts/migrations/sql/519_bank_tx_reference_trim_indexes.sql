-- 519 — index the trimmed statement reference on both columns.
--
-- `findBankTransactionsByReference` matches
--   btrim(reference, E' \t\n\r\f') = ANY($refs)
--   OR btrim(bank_reference, E' \t\n\r\f') = ANY($refs)
-- and a function call over a column defeats `idx_bt_reference` (a plain btree
-- on `reference`). On isaflow_dev that plan reads the whole company: 9,132 rows
-- removed by filter, 3,872 shared buffers, ~3 ms per lookup. Bulk allocation
-- resolves up to 500 references in ONE request that already holds row locks, so
-- the scans compound directly into lock hold time.
--
-- The expressions below must stay CHARACTER-FOR-CHARACTER identical to the ones
-- in bankTransactionLookupService.ts — a different trim character set is a
-- different expression and the planner will not use the index. E' \t\n\r\f' is
-- exactly ASCII 32, 9, 10, 13, 12; \v is deliberately absent because PostgreSQL
-- does NOT recognise it as an escape and would trim a literal 'v' off the ends
-- of every reference.
--
-- LOCK: plain CREATE INDEX, not CONCURRENTLY — scripts/apply-migrations.ts runs
-- each file inside BEGIN … COMMIT and CONCURRENTLY cannot run in a transaction
-- block. It therefore takes a SHARE lock on bank_transactions, blocking writes
-- (not reads) for the build. Production has ~10k rows, so that is well under a
-- second; if the table ever grows a couple of orders of magnitude, build the
-- index by hand with CONCURRENTLY first and let this file no-op on IF NOT EXISTS.

CREATE INDEX IF NOT EXISTS idx_bt_company_reference_trim
  ON bank_transactions (company_id, btrim(reference, E' \t\n\r\f'));

CREATE INDEX IF NOT EXISTS idx_bt_company_bank_reference_trim
  ON bank_transactions (company_id, btrim(bank_reference, E' \t\n\r\f'));
