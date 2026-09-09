-- Proposals do not replace approved banking. Verification retains exact encrypted versions.
CREATE TABLE IF NOT EXISTS control_beneficiary_proposals (
  company_id uuid NOT NULL REFERENCES companies(id), id uuid NOT NULL DEFAULT gen_random_uuid(),
  entity_type text NOT NULL CHECK(entity_type IN ('supplier','employee')), entity_id uuid NOT NULL,
  requester_person_id text NOT NULL, requester_auth_method text NOT NULL CHECK(requester_auth_method IN ('cookie','pat','oauth')),
  requester_grant_id uuid, requester_granted_scopes text[],
  details_envelope jsonb NOT NULL, details_fingerprint text NOT NULL, base_bank_fingerprint text NOT NULL,
  base_verified_version bigint, evidence_refs jsonb NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','verified','rejected','cancelled')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(), verified_by_person_id text, verified_at timestamptz,
  PRIMARY KEY(company_id,id),
  CHECK(requester_auth_method='cookie' OR (requester_grant_id IS NOT NULL AND requester_granted_scopes IS NOT NULL)),
  CHECK(status <> 'verified' OR (verified_by_person_id IS NOT NULL AND verified_at IS NOT NULL
    AND verified_by_person_id <> requester_person_id))
);
ALTER TABLE control_beneficiary_proposals DROP CONSTRAINT IF EXISTS control_beneficiary_proposals_status_check;
ALTER TABLE control_beneficiary_proposals ADD CONSTRAINT control_beneficiary_proposals_status_check
  CHECK(status IN ('pending','verified','rejected','cancelled'));
CREATE UNIQUE INDEX IF NOT EXISTS control_beneficiary_pending_idx ON control_beneficiary_proposals(company_id,entity_type,entity_id)
  WHERE status='pending';
CREATE TABLE IF NOT EXISTS control_beneficiary_versions (
  company_id uuid NOT NULL REFERENCES companies(id), id uuid NOT NULL DEFAULT gen_random_uuid(),
  entity_type text NOT NULL CHECK(entity_type IN ('supplier','employee')), entity_id uuid NOT NULL,
  version bigint NOT NULL CHECK(version > 0), proposal_id uuid NOT NULL, details_envelope jsonb NOT NULL,
  fingerprint text NOT NULL, verified_by_person_id text NOT NULL, verified_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(company_id,id), UNIQUE(company_id,entity_type,entity_id,version), UNIQUE(company_id,proposal_id),
  FOREIGN KEY(company_id,proposal_id) REFERENCES control_beneficiary_proposals(company_id,id)
);
ALTER TABLE control_beneficiary_proposals ENABLE ROW LEVEL SECURITY;
ALTER TABLE control_beneficiary_proposals FORCE ROW LEVEL SECURITY;
ALTER TABLE control_beneficiary_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE control_beneficiary_versions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON control_beneficiary_proposals;
CREATE POLICY tenant_isolation ON control_beneficiary_proposals TO app_user
  USING(company_id=app.current_company_id() AND company_id IN (SELECT auth.user_companies()))
  WITH CHECK(company_id=app.current_company_id() AND company_id IN (SELECT auth.user_companies()));
DROP POLICY IF EXISTS tenant_isolation ON control_beneficiary_versions;
CREATE POLICY tenant_isolation ON control_beneficiary_versions TO app_user
  USING(company_id=app.current_company_id() AND company_id IN (SELECT auth.user_companies()))
  WITH CHECK(company_id=app.current_company_id() AND company_id IN (SELECT auth.user_companies()));
REVOKE ALL ON control_beneficiary_proposals,control_beneficiary_versions FROM app_user,PUBLIC;
GRANT SELECT,INSERT ON control_beneficiary_proposals,control_beneficiary_versions TO app_user;
GRANT UPDATE(status,verified_by_person_id,verified_at) ON control_beneficiary_proposals TO app_user;
GRANT ALL ON control_beneficiary_proposals,control_beneficiary_versions TO migration_admin;

DROP FUNCTION IF EXISTS public.control_beneficiary_authorities(uuid,uuid);
CREATE OR REPLACE FUNCTION public.control_beneficiary_authorities(p_company uuid,p_approval uuid)
RETURNS TABLE(person_id text,role text,is_active boolean,status text,suspended_at timestamptz,
  company_status text,company_suspended_at timestamptz,permissions jsonb,grant_valid boolean,current_scopes text[])
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, app, auth AS $$
DECLARE v_person text; v_request record; v_grant_valid boolean := false; v_current_scopes text[];
BEGIN
  IF p_company IS DISTINCT FROM app.current_company_id() OR NOT EXISTS(
    SELECT 1 FROM public.company_users cu WHERE cu.company_id=p_company AND cu.user_id=auth.uid()::text
  ) OR NOT EXISTS(SELECT 1 FROM public.control_beneficiary_proposals a WHERE a.company_id=p_company AND a.id=p_approval) THEN
    RAISE EXCEPTION 'Approval authorities unavailable' USING ERRCODE='42501';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('control-authority:' || p_company::text,0));
  -- Lock the complete participant population only after the authority serialization lock.
  FOR v_person IN SELECT DISTINCT ids.id FROM (
    SELECT auth.uid()::text AS id UNION ALL
    SELECT a.requester_person_id FROM public.control_beneficiary_proposals a WHERE a.company_id=p_company AND a.id=p_approval
  ) ids ORDER BY ids.id LOOP
    PERFORM 1 FROM public.users u WHERE u.id=v_person FOR UPDATE;
    PERFORM 1 FROM public.company_users cu WHERE cu.company_id=p_company AND cu.user_id=v_person FOR UPDATE;
    PERFORM 1 FROM public.company_user_permissions cp WHERE cp.company_id=p_company AND cp.user_id=v_person
      ORDER BY cp.module_key FOR SHARE;
  END LOOP;
  PERFORM 1 FROM public.companies c WHERE c.id=p_company FOR SHARE;
  SELECT a.* INTO v_request FROM public.control_beneficiary_proposals a WHERE a.company_id=p_company AND a.id=p_approval;
  IF v_request.requester_auth_method='cookie' THEN v_grant_valid := true;
  ELSIF v_request.requester_auth_method='pat' THEN
    SELECT g.revoked_at IS NULL AND g.expires_at > clock_timestamp(),g.scopes INTO v_grant_valid,v_current_scopes
      FROM public.personal_access_tokens g WHERE g.company_id=p_company AND g.user_id=v_request.requester_person_id
        AND g.id=v_request.requester_grant_id FOR SHARE;
  ELSIF v_request.requester_auth_method='oauth' THEN
    SELECT g.revoked_at IS NULL AND g.access_token_expires_at > clock_timestamp(),g.scopes INTO v_grant_valid,v_current_scopes
      FROM public.oauth_authorisations g WHERE g.company_id=p_company AND g.user_id=v_request.requester_person_id
        AND g.id=v_request.requester_grant_id FOR SHARE;
  END IF;
  IF v_request.requester_auth_method <> 'cookie' THEN
    SELECT COALESCE(array_agg(scope),ARRAY[]::text[]) INTO v_current_scopes FROM unnest(v_current_scopes) scope
      WHERE scope=ANY(v_request.requester_granted_scopes);
  END IF;

  RETURN QUERY SELECT DISTINCT u.id::text,cu.role::text,u.is_active,u.status::text,u.suspended_at,
    c.status::text,c.suspended_at,COALESCE((SELECT jsonb_agg(to_jsonb(cp) ORDER BY cp.module_key)
      FROM public.company_user_permissions cp WHERE cp.company_id=p_company AND cp.user_id=u.id),'[]'::jsonb),
    CASE WHEN u.id=v_request.requester_person_id THEN COALESCE(v_grant_valid,false) ELSE true END,
    CASE WHEN u.id=v_request.requester_person_id THEN v_current_scopes ELSE NULL::text[] END
    FROM (
      SELECT auth.uid()::text AS person_id UNION
      SELECT a.requester_person_id FROM public.control_beneficiary_proposals a WHERE a.company_id=p_company AND a.id=p_approval
    ) bound
    JOIN public.users u ON u.id=bound.person_id
    JOIN public.company_users cu ON cu.user_id=u.id AND cu.company_id=p_company
    JOIN public.companies c ON c.id=cu.company_id
    WHERE cu.company_id=p_company;
END;
$$;
ALTER FUNCTION public.control_beneficiary_authorities(uuid,uuid) OWNER TO migration_admin;
REVOKE ALL ON FUNCTION public.control_beneficiary_authorities(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.control_beneficiary_authorities(uuid,uuid) TO app_user;
