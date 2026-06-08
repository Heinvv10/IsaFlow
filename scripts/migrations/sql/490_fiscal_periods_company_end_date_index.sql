-- 490_fiscal_periods_company_end_date_index.sql
-- Composite index for the bureau cockpit's month-end progress query
-- (DISTINCT ON (company_id) ... ORDER BY company_id, end_date DESC).
CREATE INDEX IF NOT EXISTS idx_fiscal_periods_company_end_date
  ON fiscal_periods (company_id, end_date DESC);
