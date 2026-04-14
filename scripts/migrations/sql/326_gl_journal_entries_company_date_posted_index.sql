-- BL-12: index supports cash-flow, P&L, GL reports that filter
-- gl_journal_entries by (company_id, entry_date) with status='posted'.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_gl_journal_entries_company_date_posted
  ON gl_journal_entries (company_id, entry_date)
  WHERE status = 'posted';
