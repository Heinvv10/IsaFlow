-- BL-11: Composite covering index for bank_transactions list query.
-- Replaces reliance on cross-tenant idx_bt_date (which filtered ~82% of rows).
-- INCLUDE columns let index-only scans answer the list without heap fetches.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_bt_company_date
  ON bank_transactions (company_id, transaction_date DESC, amount DESC)
  INCLUDE (bank_account_id, status);
