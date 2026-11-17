-- Migration 999p: look a supplier / customer payment up by the journal it carries.
--
-- A bank line's settled-document evidence (bank/settledDocumentSql) walks bank line -> its bank-leg journal -> the
-- payment whose gl_journal_entry_id is that journal. Neither payments table had an index on that column, so the grid's
-- per-row count and list_unsupported_transactions would scan the payments table once per line. Partial, as the
-- invoice and credit-note tables' own gl_journal_entry_id indexes are. Index only: no data changes.
CREATE INDEX IF NOT EXISTS idx_supplier_payments_gl_journal_entry_id
  ON supplier_payments (gl_journal_entry_id) WHERE gl_journal_entry_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_customer_payments_gl_journal_entry_id
  ON customer_payments (gl_journal_entry_id) WHERE gl_journal_entry_id IS NOT NULL;
