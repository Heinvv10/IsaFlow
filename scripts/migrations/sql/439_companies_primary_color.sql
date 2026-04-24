-- 439_companies_primary_color.sql
-- Restore companies.primary_color — lost in the Supabase cutover and
-- referenced by every PDF render path (pdfShared.getCompanyDetailsFromCompany).
-- Its absence triggered "column does not exist" inside a swallowed try/catch,
-- poisoning the surrounding withAuth request transaction so every follow-up
-- query in the same request returned "current transaction is aborted".
--
-- Default matches the fallback already hard-coded in pdfShared:
--   c.primary_color ? String(c.primary_color) : '#0d9488'
-- so existing tenants behave identically to before.

ALTER TABLE companies
  ADD COLUMN IF NOT EXISTS primary_color TEXT DEFAULT '#0d9488';
