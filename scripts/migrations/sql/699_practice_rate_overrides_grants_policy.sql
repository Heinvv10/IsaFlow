-- 699: grants and tenant policy for practice_client_rate_overrides (R-121).
--
-- The table's GRANTS and POLICY, like its siblings (practice_staff_rates, …).
-- On dev-shaped databases the table carried no grant for app_user,
-- platform_admin or migration_admin — every app read of it, resolveRate
-- included, and so every practice time entry, raised "permission denied".
-- And its policy (395) read a `company_id` JWT claim that only the MCP bearer
-- pipeline synthesises: withAuth passes the GoTrue token's own claims, which
-- carry none, so a web request saw zero rows and could insert none. The
-- standard tenant_isolation (348) keys on company_users and
-- app.current_company_id, which every pipeline sets.
GRANT SELECT, INSERT, UPDATE, DELETE ON practice_client_rate_overrides TO app_user, platform_admin;
GRANT ALL ON practice_client_rate_overrides TO migration_admin;

DROP POLICY IF EXISTS pcro_company_isolation ON practice_client_rate_overrides;
DROP POLICY IF EXISTS tenant_isolation ON practice_client_rate_overrides;
CREATE POLICY tenant_isolation ON practice_client_rate_overrides
  FOR ALL TO app_user
  USING (company_id IN (SELECT company_id FROM public.company_users WHERE user_id = auth.uid()))
  WITH CHECK (company_id = app.current_company_id());
