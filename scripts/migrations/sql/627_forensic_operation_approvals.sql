-- Version-bound operation approvals and immutable local execution receipts.
CREATE TABLE IF NOT EXISTS control_operation_approvals (
  id uuid NOT NULL DEFAULT gen_random_uuid(), company_id uuid NOT NULL REFERENCES companies(id),
  operation_id uuid NOT NULL, operation text NOT NULL, entity_type text NOT NULL, entity_id text NOT NULL,
  requester_person_id text NOT NULL, binding jsonb NOT NULL, binding_hash text NOT NULL,
  status text NOT NULL CHECK(status IN ('pending','approved','rejected','cancelled','consumed')),
  requested_at timestamptz NOT NULL DEFAULT clock_timestamp(), expires_at timestamptz NOT NULL,
  decided_at timestamptz, consumed_at timestamptz, consumed_effect_id uuid,
  PRIMARY KEY(company_id,id), CHECK(expires_at > requested_at)
);
CREATE TABLE IF NOT EXISTS control_operation_decisions (
  company_id uuid NOT NULL, approval_id uuid NOT NULL, policy_id text NOT NULL, person_id text NOT NULL,
  decision text NOT NULL CHECK(decision IN ('approved','rejected')), evidence_refs jsonb NOT NULL,
  decided_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(company_id,approval_id,policy_id),
  FOREIGN KEY(company_id,approval_id) REFERENCES control_operation_approvals(company_id,id)
);
CREATE TABLE IF NOT EXISTS control_policy_exposure (
  company_id uuid NOT NULL REFERENCES companies(id), policy_id text NOT NULL, beneficiary_key text NOT NULL,
  currency text NOT NULL, window_start date NOT NULL, operation text NOT NULL, entity_id text NOT NULL,
  amount numeric NOT NULL CHECK(amount >= 0), state text NOT NULL CHECK(state IN ('reserved','committed')),
  approval_id uuid, UNIQUE(company_id,policy_id,operation,entity_id),
  FOREIGN KEY(company_id,approval_id) REFERENCES control_operation_approvals(company_id,id)
);
CREATE INDEX IF NOT EXISTS control_policy_exposure_window_idx
  ON control_policy_exposure(company_id,policy_id,beneficiary_key,currency,window_start);
CREATE TABLE IF NOT EXISTS control_operation_effects (
  company_id uuid NOT NULL REFERENCES companies(id), id uuid NOT NULL DEFAULT gen_random_uuid(),
  operation_id uuid NOT NULL, operation text NOT NULL, entity_type text NOT NULL, entity_id text NOT NULL,
  binding_hash text NOT NULL, result jsonb NOT NULL, committed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(company_id,id), UNIQUE(company_id,operation,entity_id,binding_hash)
);
ALTER TABLE approval_rules ADD COLUMN IF NOT EXISTS control_version bigint NOT NULL DEFAULT 1;
ALTER TABLE approval_rules ADD COLUMN IF NOT EXISTS aggregate_window_days integer;
ALTER TABLE approval_rules ADD COLUMN IF NOT EXISTS aggregate_by text;
CREATE OR REPLACE FUNCTION public.control_version_approval_policy() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.company_id IS DISTINCT FROM OLD.company_id THEN
    RAISE EXCEPTION 'Approval policy tenant cannot change';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('control-policy:' ||
    CASE WHEN TG_OP = 'DELETE' THEN OLD.company_id ELSE NEW.company_id END::text, 0));
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  IF (NEW.aggregate_window_days IS NOT NULL AND NEW.aggregate_window_days <> 1)
    OR (NEW.aggregate_by IS NOT NULL AND NEW.aggregate_by <> 'supplier')
    OR ((NEW.aggregate_window_days IS NULL) <> (NEW.aggregate_by IS NULL)) THEN
    RAISE EXCEPTION 'Unsupported aggregate approval policy';
  END IF;
  IF TG_OP = 'INSERT' THEN NEW.control_version := 1;
  ELSIF (to_jsonb(NEW) - 'control_version' - 'updated_at') IS DISTINCT FROM
    (to_jsonb(OLD) - 'control_version' - 'updated_at') THEN NEW.control_version := OLD.control_version + 1;
  ELSE NEW.control_version := OLD.control_version;
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS control_version_approval_policy ON approval_rules;
CREATE TRIGGER control_version_approval_policy BEFORE INSERT OR UPDATE OR DELETE ON approval_rules
  FOR EACH ROW EXECUTE FUNCTION public.control_version_approval_policy();

CREATE OR REPLACE FUNCTION public.control_approval_authorities(p_company uuid,p_approval uuid)
RETURNS TABLE(person_id text,role text,is_active boolean,status text,suspended_at timestamptz,
  company_status text,company_suspended_at timestamptz,permissions jsonb)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, app, auth AS $$
DECLARE v_person text;
BEGIN
  IF p_company IS DISTINCT FROM app.current_company_id() OR NOT EXISTS(
    SELECT 1 FROM public.company_users cu WHERE cu.company_id=p_company AND cu.user_id=auth.uid()::text
  ) OR NOT EXISTS(SELECT 1 FROM public.control_operation_approvals a WHERE a.company_id=p_company AND a.id=p_approval) THEN
    RAISE EXCEPTION 'Approval authorities unavailable' USING ERRCODE='42501';
  END IF;
  -- Lock current caller and every bound decision person in the same stable order.
  FOR v_person IN SELECT DISTINCT ids.id FROM (
    SELECT auth.uid()::text AS id UNION ALL
    SELECT a.requester_person_id FROM public.control_operation_approvals a WHERE a.company_id=p_company AND a.id=p_approval UNION ALL
    SELECT d.person_id FROM public.control_operation_decisions d WHERE d.company_id=p_company AND d.approval_id=p_approval
  ) ids ORDER BY ids.id LOOP
    PERFORM 1 FROM public.users u WHERE u.id=v_person FOR UPDATE;
    PERFORM 1 FROM public.company_users cu WHERE cu.company_id=p_company AND cu.user_id=v_person FOR UPDATE;
    PERFORM 1 FROM public.company_user_permissions cp WHERE cp.company_id=p_company AND cp.user_id=v_person
      ORDER BY cp.module_key FOR SHARE;
  END LOOP;
  PERFORM 1 FROM public.companies c WHERE c.id=p_company FOR SHARE;
  RETURN QUERY SELECT DISTINCT u.id::text,cu.role::text,u.is_active,u.status::text,u.suspended_at,
    c.status::text,c.suspended_at,COALESCE((SELECT jsonb_agg(to_jsonb(cp) ORDER BY cp.module_key)
      FROM public.company_user_permissions cp WHERE cp.company_id=p_company AND cp.user_id=u.id),'[]'::jsonb)
    FROM (
      SELECT auth.uid()::text AS person_id UNION
      SELECT a.requester_person_id FROM public.control_operation_approvals a WHERE a.company_id=p_company AND a.id=p_approval UNION
      SELECT d.person_id FROM public.control_operation_decisions d WHERE d.company_id=p_company AND d.approval_id=p_approval
    ) bound
    JOIN public.users u ON u.id=bound.person_id
    JOIN public.company_users cu ON cu.user_id=u.id AND cu.company_id=p_company
    JOIN public.companies c ON c.id=cu.company_id
    WHERE cu.company_id=p_company;
END;
$$;
ALTER FUNCTION public.control_approval_authorities(uuid,uuid) OWNER TO migration_admin;
REVOKE ALL ON FUNCTION public.control_approval_authorities(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.control_approval_authorities(uuid,uuid) TO app_user;

ALTER TABLE control_operation_approvals ENABLE ROW LEVEL SECURITY;
ALTER TABLE control_operation_approvals FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON control_operation_approvals;
CREATE POLICY tenant_isolation ON control_operation_approvals TO app_user
  USING(company_id = app.current_company_id() AND company_id IN (SELECT auth.user_companies()))
  WITH CHECK(company_id = app.current_company_id() AND company_id IN (SELECT auth.user_companies()));
REVOKE ALL ON control_operation_approvals FROM app_user,PUBLIC;
GRANT SELECT,INSERT,UPDATE ON control_operation_approvals TO app_user;
GRANT ALL ON control_operation_approvals TO migration_admin;

ALTER TABLE control_operation_decisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE control_operation_decisions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON control_operation_decisions;
CREATE POLICY tenant_isolation ON control_operation_decisions TO app_user
  USING(company_id = app.current_company_id() AND company_id IN (SELECT auth.user_companies()))
  WITH CHECK(company_id = app.current_company_id() AND company_id IN (SELECT auth.user_companies()));
REVOKE ALL ON control_operation_decisions FROM app_user,PUBLIC;
GRANT SELECT,INSERT ON control_operation_decisions TO app_user;
GRANT ALL ON control_operation_decisions TO migration_admin;

ALTER TABLE control_policy_exposure ENABLE ROW LEVEL SECURITY;
ALTER TABLE control_policy_exposure FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON control_policy_exposure;
CREATE POLICY tenant_isolation ON control_policy_exposure TO app_user
  USING(company_id = app.current_company_id() AND company_id IN (SELECT auth.user_companies()))
  WITH CHECK(company_id = app.current_company_id() AND company_id IN (SELECT auth.user_companies()));
REVOKE ALL ON control_policy_exposure FROM app_user,PUBLIC;
GRANT SELECT,INSERT,UPDATE ON control_policy_exposure TO app_user;
GRANT ALL ON control_policy_exposure TO migration_admin;

ALTER TABLE control_operation_effects ENABLE ROW LEVEL SECURITY;
ALTER TABLE control_operation_effects FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON control_operation_effects;
CREATE POLICY tenant_isolation ON control_operation_effects TO app_user
  USING(company_id = app.current_company_id() AND company_id IN (SELECT auth.user_companies()))
  WITH CHECK(company_id = app.current_company_id() AND company_id IN (SELECT auth.user_companies()));
REVOKE ALL ON control_operation_effects FROM app_user,PUBLIC;
GRANT SELECT,INSERT ON control_operation_effects TO app_user;
GRANT ALL ON control_operation_effects TO migration_admin;
