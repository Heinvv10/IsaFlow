-- Finding identity is independent of reporting cutoff; immutable occurrences retain each observation.
CREATE TABLE IF NOT EXISTS control_exceptions (
 company_id uuid NOT NULL REFERENCES companies(id),id uuid NOT NULL DEFAULT gen_random_uuid(),
 check_id text NOT NULL CHECK(length(check_id) BETWEEN 1 AND 128),
 finding_key text NOT NULL CHECK(length(finding_key) BETWEEN 1 AND 256),cutoff date,
 check_version integer NOT NULL CHECK(check_version>0),
 finding jsonb NOT NULL CHECK(jsonb_typeof(finding)='object' AND octet_length(finding::text)<=1048576),
 severity text NOT NULL CHECK(severity IN('low','medium','high')),
 status text NOT NULL DEFAULT 'open' CHECK(status IN('open','fixed','accepted_risk')),
 version integer NOT NULL DEFAULT 1 CHECK(version>0),
 reporter_person_id text NOT NULL REFERENCES users(id),owner_person_id text REFERENCES users(id),due_at timestamptz,
 occurrence_count integer NOT NULL DEFAULT 1 CHECK(occurrence_count>0),
 first_seen_at timestamptz NOT NULL DEFAULT clock_timestamp(),last_seen_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 reviewer_person_id text REFERENCES users(id),resolution_reason text CHECK(length(resolution_reason)<=4000),
 risk_expires_at timestamptz,last_recheck jsonb CHECK(jsonb_typeof(last_recheck)='object' AND octet_length(last_recheck::text)<=1048576),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(company_id,id),
 UNIQUE(company_id,check_id,finding_key),
 CHECK(status<>'accepted_risk' OR risk_expires_at IS NOT NULL),
 CHECK(status='open' OR severity<>'high' OR (reviewer_person_id<>reporter_person_id AND reviewer_person_id IS DISTINCT FROM owner_person_id))
);
ALTER TABLE control_exceptions DROP CONSTRAINT IF EXISTS control_exceptions_resolution_evidence;
ALTER TABLE control_exceptions ADD CONSTRAINT control_exceptions_resolution_evidence
 CHECK(status='open' OR (reviewer_person_id IS NOT NULL AND resolution_reason IS NOT NULL AND length(btrim(resolution_reason))>0));
CREATE TABLE IF NOT EXISTS control_exception_occurrences (
 company_id uuid NOT NULL REFERENCES companies(id),id uuid NOT NULL DEFAULT gen_random_uuid(),exception_id uuid NOT NULL,
 exception_version integer NOT NULL CHECK(exception_version>0),
 check_result jsonb NOT NULL CHECK(jsonb_typeof(check_result)='object' AND octet_length(check_result::text)<=2097152),
 observed_at timestamptz NOT NULL DEFAULT clock_timestamp(),person_id text NOT NULL REFERENCES users(id),
 PRIMARY KEY(company_id,id),FOREIGN KEY(company_id,exception_id) REFERENCES control_exceptions(company_id,id),
 UNIQUE(company_id,exception_id,exception_version)
);
CREATE TABLE IF NOT EXISTS control_exception_decisions (
 company_id uuid NOT NULL REFERENCES companies(id),id uuid NOT NULL DEFAULT gen_random_uuid(),exception_id uuid NOT NULL,
 previous_version integer NOT NULL CHECK(previous_version>=0),new_version integer NOT NULL CHECK(new_version=previous_version+1),
 action text NOT NULL CHECK(action IN('observed','assigned','fixed','accepted_risk','recheck_blocked')),
 person_id text NOT NULL REFERENCES users(id),decided_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 decision jsonb NOT NULL CHECK(jsonb_typeof(decision)='object' AND octet_length(decision::text)<=2097152),
 PRIMARY KEY(company_id,id),FOREIGN KEY(company_id,exception_id) REFERENCES control_exceptions(company_id,id),
 UNIQUE(company_id,exception_id,new_version)
);
CREATE INDEX IF NOT EXISTS control_exceptions_queue ON control_exceptions(company_id,status,due_at,id);
CREATE INDEX IF NOT EXISTS control_exception_occurrences_history ON control_exception_occurrences(company_id,exception_id,exception_version);
ALTER TABLE control_exceptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE control_exceptions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_read ON control_exceptions;
CREATE POLICY tenant_read ON control_exceptions FOR SELECT
 USING(company_id=app.current_company_id() AND company_id IN(SELECT auth.user_companies()));
DROP POLICY IF EXISTS tenant_create ON control_exceptions;
CREATE POLICY tenant_create ON control_exceptions FOR INSERT
 WITH CHECK(company_id=app.current_company_id() AND company_id IN(SELECT auth.user_companies()) AND reporter_person_id=auth.uid()::text);
DROP POLICY IF EXISTS tenant_update ON control_exceptions;
CREATE POLICY tenant_update ON control_exceptions FOR UPDATE
 USING(company_id=app.current_company_id() AND company_id IN(SELECT auth.user_companies()))
 WITH CHECK(company_id=app.current_company_id() AND company_id IN(SELECT auth.user_companies()));
REVOKE ALL ON control_exceptions FROM PUBLIC,app_user;
GRANT SELECT,INSERT ON control_exceptions TO app_user;
GRANT UPDATE(cutoff,check_version,finding,severity,status,version,owner_person_id,due_at,occurrence_count,last_seen_at,
 reviewer_person_id,resolution_reason,risk_expires_at,last_recheck,updated_at) ON control_exceptions TO app_user;
ALTER TABLE control_exception_occurrences ENABLE ROW LEVEL SECURITY;
ALTER TABLE control_exception_occurrences FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_read ON control_exception_occurrences;
CREATE POLICY tenant_read ON control_exception_occurrences FOR SELECT
 USING(company_id=app.current_company_id() AND company_id IN(SELECT auth.user_companies()));
DROP POLICY IF EXISTS tenant_create ON control_exception_occurrences;
CREATE POLICY tenant_create ON control_exception_occurrences FOR INSERT
 WITH CHECK(company_id=app.current_company_id() AND company_id IN(SELECT auth.user_companies()) AND person_id=auth.uid()::text);
REVOKE ALL ON control_exception_occurrences FROM PUBLIC,app_user;
GRANT SELECT,INSERT ON control_exception_occurrences TO app_user;
ALTER TABLE control_exception_decisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE control_exception_decisions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_read ON control_exception_decisions;
CREATE POLICY tenant_read ON control_exception_decisions FOR SELECT
 USING(company_id=app.current_company_id() AND company_id IN(SELECT auth.user_companies()));
DROP POLICY IF EXISTS tenant_create ON control_exception_decisions;
CREATE POLICY tenant_create ON control_exception_decisions FOR INSERT
 WITH CHECK(company_id=app.current_company_id() AND company_id IN(SELECT auth.user_companies()) AND person_id=auth.uid()::text);
REVOKE ALL ON control_exception_decisions FROM PUBLIC,app_user;
GRANT SELECT,INSERT ON control_exception_decisions TO app_user;

-- Self-row user policies cannot validate another assignee. Return identity only, never profile fields.
CREATE OR REPLACE FUNCTION public.control_exception_owner(p_company uuid,p_owner text)
RETURNS TABLE(user_id text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app,auth AS $$
BEGIN
 IF p_company IS DISTINCT FROM app.current_company_id() OR auth.uid() IS NULL THEN
  RAISE EXCEPTION 'Exception owner unavailable' USING ERRCODE='42501';
 END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('control-authority:' || p_company::text,0));
 IF NOT EXISTS(
  SELECT 1 FROM public.company_users member JOIN public.users caller ON caller.id=member.user_id
  JOIN public.companies company ON company.id=member.company_id
  WHERE member.company_id=p_company AND member.user_id=auth.uid()::text
   AND caller.is_active=true AND caller.suspended_at IS NULL AND (caller.status IS NULL OR lower(caller.status)='active')
   AND company.suspended_at IS NULL AND (company.status IS NULL OR company.status NOT IN('suspended','deleted'))
 ) THEN RETURN; END IF;
 RETURN QUERY SELECT member.user_id::text FROM public.company_users member
  JOIN public.users owner_user ON owner_user.id=member.user_id
  WHERE member.company_id=p_company AND member.user_id=p_owner AND owner_user.is_active=true
   AND owner_user.suspended_at IS NULL AND (owner_user.status IS NULL OR lower(owner_user.status)='active')
  FOR SHARE OF member,owner_user;
END;
$$;
ALTER FUNCTION public.control_exception_owner(uuid,text) OWNER TO migration_admin;
REVOKE ALL ON FUNCTION public.control_exception_owner(uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.control_exception_owner(uuid,text) TO app_user;
