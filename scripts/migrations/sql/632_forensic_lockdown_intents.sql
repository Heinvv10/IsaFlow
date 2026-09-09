-- Immutable target intent lets independent approval bind a future lockdown change.
CREATE TABLE IF NOT EXISTS control_lockdown_intents (
  company_id uuid NOT NULL REFERENCES companies(id),
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  requester_person_id text NOT NULL REFERENCES users(id),
  target_enabled boolean NOT NULL,
  target_date date,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(company_id,id),
  CHECK(NOT target_enabled OR target_date IS NOT NULL)
);
ALTER TABLE control_lockdown_intents ENABLE ROW LEVEL SECURITY;
ALTER TABLE control_lockdown_intents FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_read ON control_lockdown_intents;
CREATE POLICY tenant_read ON control_lockdown_intents FOR SELECT
  USING(company_id=app.current_company_id() AND company_id IN(SELECT auth.user_companies()));
DROP POLICY IF EXISTS tenant_create ON control_lockdown_intents;
CREATE POLICY tenant_create ON control_lockdown_intents FOR INSERT
  WITH CHECK(company_id=app.current_company_id() AND company_id IN(SELECT auth.user_companies())
    AND requester_person_id=auth.uid()::text);
REVOKE ALL ON control_lockdown_intents FROM PUBLIC,app_user;
GRANT SELECT,INSERT ON control_lockdown_intents TO app_user;
INSERT INTO permission_modules(module_key,module_name,description,display_order)
VALUES('locks','Accounting locks','Close, lock and reopen periods or change company lockdown',207)
ON CONFLICT(module_key) DO NOTHING;
