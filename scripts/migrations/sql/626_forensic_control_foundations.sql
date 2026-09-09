-- Shared forensic control foundations. No historical financial data is changed.
CREATE OR REPLACE FUNCTION public.control_lock_permission_principal(p_company uuid, p_person text)
RETURNS TABLE(role text, account_user_id text, is_active boolean, status text,
  suspended_at timestamptz, company_status text, company_suspended_at timestamptz)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, app, auth AS $$
BEGIN
  IF p_company IS DISTINCT FROM app.current_company_id()
    OR p_person IS DISTINCT FROM auth.uid()::text THEN
    RAISE EXCEPTION 'Control principal unavailable' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
    SELECT cu.role::text, u.id::text, u.is_active, u.status::text, u.suspended_at,
      c.status::text, c.suspended_at
    FROM public.company_users cu
    JOIN public.users u ON u.id = cu.user_id
    JOIN public.companies c ON c.id = cu.company_id
    WHERE cu.company_id = p_company AND cu.user_id = p_person
    FOR UPDATE OF cu, u FOR SHARE OF c;
END;
$$;
ALTER FUNCTION public.control_lock_permission_principal(uuid,text) OWNER TO migration_admin;
REVOKE ALL ON FUNCTION public.control_lock_permission_principal(uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.control_lock_permission_principal(uuid,text) TO app_user;

CREATE TABLE IF NOT EXISTS control_entity_versions (
  company_id uuid NOT NULL REFERENCES companies(id),
  entity_type text NOT NULL,
  entity_id text NOT NULL,
  version bigint NOT NULL CHECK (version > 0),
  material_hash text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(company_id,entity_type,entity_id)
);
CREATE TABLE IF NOT EXISTS control_protected_evidence (
  company_id uuid NOT NULL REFERENCES companies(id),
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  entity_type text NOT NULL,
  entity_id text NOT NULL,
  key_id text NOT NULL,
  envelope_version integer NOT NULL CHECK (envelope_version = 1),
  ciphertext text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(company_id,id)
);
CREATE TABLE IF NOT EXISTS control_change_events (
  company_id uuid NOT NULL REFERENCES companies(id),
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  person_id text NOT NULL,
  connection_id text,
  grant_id text,
  acting_firm_id text,
  request_id uuid NOT NULL,
  operation_id uuid NOT NULL,
  provenance text NOT NULL CHECK (provenance IN ('human','agent','job')),
  entity_type text NOT NULL,
  entity_id text NOT NULL,
  previous_version bigint,
  new_version bigint NOT NULL CHECK (new_version > 0),
  action text NOT NULL,
  accounting_date date,
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  before_values jsonb,
  after_values jsonb,
  binding_hash text,
  protected_evidence_id uuid NOT NULL,
  outcome text NOT NULL DEFAULT 'committed' CHECK (outcome = 'committed'),
  PRIMARY KEY(company_id,id),
  UNIQUE(company_id,entity_type,entity_id,new_version),
  FOREIGN KEY(company_id,protected_evidence_id) REFERENCES control_protected_evidence(company_id,id),
  CHECK ((previous_version IS NULL AND new_version = 1)
    OR (previous_version > 0 AND new_version = previous_version + 1))
);
CREATE INDEX IF NOT EXISTS control_change_events_entity_idx
  ON control_change_events(company_id,entity_type,entity_id,occurred_at DESC,id);
CREATE INDEX IF NOT EXISTS control_change_events_operation_idx
  ON control_change_events(company_id,operation_id);

ALTER TABLE control_entity_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE control_entity_versions FORCE ROW LEVEL SECURITY;
ALTER TABLE control_protected_evidence ENABLE ROW LEVEL SECURITY;
ALTER TABLE control_protected_evidence FORCE ROW LEVEL SECURITY;
ALTER TABLE control_change_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE control_change_events FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON control_entity_versions;
CREATE POLICY tenant_isolation ON control_entity_versions TO app_user
  USING(company_id = app.current_company_id() AND company_id IN (SELECT auth.user_companies()))
  WITH CHECK(company_id = app.current_company_id() AND company_id IN (SELECT auth.user_companies()));
DROP POLICY IF EXISTS tenant_isolation ON control_protected_evidence;
CREATE POLICY tenant_isolation ON control_protected_evidence TO app_user
  USING(company_id = app.current_company_id() AND company_id IN (SELECT auth.user_companies()))
  WITH CHECK(company_id = app.current_company_id() AND company_id IN (SELECT auth.user_companies()));
DROP POLICY IF EXISTS tenant_isolation ON control_change_events;
CREATE POLICY tenant_isolation ON control_change_events TO app_user
  USING(company_id = app.current_company_id() AND company_id IN (SELECT auth.user_companies()))
  WITH CHECK(company_id = app.current_company_id() AND company_id IN (SELECT auth.user_companies()));
GRANT SELECT,INSERT,UPDATE ON control_entity_versions TO app_user;
GRANT SELECT,INSERT ON control_protected_evidence,control_change_events TO app_user;
GRANT ALL ON control_entity_versions,control_protected_evidence,control_change_events TO migration_admin;

INSERT INTO permission_modules(module_key,module_name,description,display_order) VALUES
  ('approvals','Operation approvals','Independent version-bound operation approval',201),
  ('beneficiaries','Beneficiary maintenance','Propose and independently verify bank details',202),
  ('access','Access review','Review current tenant grants without credentials',203),
  ('audit','Forensic evidence','Read and capture restricted control evidence',204),
  ('controls','Control exceptions','Assign and resolve findings after recheck',205),
  ('payroll_sensitive','Sensitive payroll evidence','Explicit payroll identity and banking access',206)
ON CONFLICT(module_key) DO NOTHING;
