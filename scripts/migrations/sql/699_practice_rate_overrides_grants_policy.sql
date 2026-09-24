-- 699: grants and tenant policy for practice_client_rate_overrides (R-121).
--
-- The table's GRANTS and POLICY, like its siblings (practice_staff_rates, …).
-- On dev-shaped databases the table carried no grant for app_user,
-- platform_admin or migration_admin — every app read of it, resolveRate
-- included, and so every practice time entry, raised "permission denied".
-- And its policy (395) read a `company_id` JWT claim that only the MCP bearer
-- pipeline synthesises: withAuth passes the GoTrue token's own claims, which
-- carry none, so a web request saw zero rows and could insert none. The
-- replacement keys on auth.user_companies() (351, membership via `sub`) and
-- app.current_company_id, which every pipeline sets.
--
-- RLS is enabled and forced BEFORE the grant: on a table without it, the new
-- grant would expose every tenant's rows. 395's claim-based policy is dropped,
-- and any tenant_isolation is REPLACED: every form a migration or draft has
-- written (348, 351, 498, the draft 698) is no stricter than this one, and
-- keeping an existing one by name kept a weaker WITH CHECK (active company
-- only) where one had been applied by hand. The new policy's WITH CHECK requires membership
-- AND the active company, like the sibling tables (membership) plus 348's
-- active-company rule, so a non-member cannot write into a company even when
-- the GUC names it.
ALTER TABLE practice_client_rate_overrides ENABLE ROW LEVEL SECURITY;
ALTER TABLE practice_client_rate_overrides FORCE ROW LEVEL SECURITY;

GRANT SELECT, INSERT, UPDATE, DELETE ON practice_client_rate_overrides TO app_user, platform_admin;
GRANT ALL ON practice_client_rate_overrides TO migration_admin;

DROP POLICY IF EXISTS pcro_company_isolation ON practice_client_rate_overrides;
DROP POLICY IF EXISTS tenant_isolation ON practice_client_rate_overrides;
CREATE POLICY tenant_isolation ON practice_client_rate_overrides
  FOR ALL TO app_user
  USING (company_id IN (SELECT auth.user_companies()))
  WITH CHECK (company_id IN (SELECT auth.user_companies()) AND company_id = app.current_company_id());
