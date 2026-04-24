-- 440_app_settings_view.sql
-- Restore app_settings as a view over accounting_settings.
--
-- The Supabase cutover renamed the table without updating call sites. Six
-- code paths still query app_settings (pdfShared fallback, drcVatService,
-- yearEndService, default-accounts, year-end, budget-vs-actual-export).
-- Each one 500s or falls through a swallowed try/catch on the current DB.
--
-- A simple one-table SELECT VIEW is automatically updatable in PostgreSQL,
-- so SELECT / INSERT / UPDATE / DELETE / ON CONFLICT all route through to
-- accounting_settings without code changes. The underlying RLS policy
-- (tenant_isolation) still applies to every row access.

CREATE OR REPLACE VIEW app_settings AS
SELECT
  id,
  company_id,
  key,
  value,
  created_at,
  updated_at
FROM accounting_settings;

COMMENT ON VIEW app_settings IS
  'Backward-compatibility alias for accounting_settings (renamed in Supabase cutover). Remove once all callers migrate to accounting_settings directly.';

GRANT SELECT, INSERT, UPDATE, DELETE ON app_settings TO app_user;
