-- Migration 517: tenant isolation for sars_efiling_events
--
-- Migration 504 created sars_efiling_events with a NOT NULL company_id but never
-- enabled row level security, so it was the single company_id table in the schema
-- with rowsecurity = false, forcerowsecurity = false and zero policies
-- (caught by tests/integration/rls-policy-coverage.test.ts). Any app_user
-- connection could read or write another tenant's SARS eFiling audit trail.
--
-- Mirrors the mig 442/498/507 idiom, using the auth helpers from mig 348, and
-- matches the policy already on the parent table sars_submissions.
--
-- Writers: insertEfilingEvent / applyPollResult / markSubmissionSubmitted in
-- src/modules/accounting/services/reports/sarsEfilingRepo.ts. Their only caller
-- chain is pages/api/accounting/sars/efiling-submit.ts, wrapped in withAuth, so
-- app.current_company_id() is always the GUC the row is written with. The
-- migration runner and platform_admin have BYPASSRLS and are unaffected.

ALTER TABLE sars_efiling_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE sars_efiling_events FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON sars_efiling_events;
CREATE POLICY tenant_isolation ON sars_efiling_events
  FOR ALL
  USING (company_id IN (SELECT auth.user_companies()))
  WITH CHECK (company_id = app.current_company_id());

-- Append-only audit trail from the app's point of view; SELECT + INSERT only.
GRANT SELECT, INSERT ON sars_efiling_events TO app_user;
