-- Migration 399: Link payroll run headers to GL journal entries
-- Adds journal_entry_id so each approved run tracks its posted GL entry (idempotency guard).

ALTER TABLE payroll_run_headers
  ADD COLUMN IF NOT EXISTS journal_entry_id UUID REFERENCES gl_journal_entries(id);

CREATE INDEX IF NOT EXISTS idx_payroll_run_headers_journal
  ON payroll_run_headers(journal_entry_id);
