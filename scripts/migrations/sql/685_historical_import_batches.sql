-- A batch of prepared historical imports approved as one unit. The manifest
-- lists every member import with its material fingerprint; the batch approval
-- binds all of them, so any change to any member voids it. Both tables are
-- append-only for every application role: a manifest is never edited, only
-- superseded by a new batch.
CREATE TABLE IF NOT EXISTS control_historical_import_batches (
 company_id uuid NOT NULL REFERENCES companies(id), id uuid NOT NULL DEFAULT gen_random_uuid(),
 requester_person_id text NOT NULL REFERENCES users(id),
 requester_auth_method text NOT NULL CHECK(requester_auth_method='platform_import'),
 manifest_envelope jsonb NOT NULL CHECK(jsonb_typeof(manifest_envelope)='object'),
 manifest_hash text NOT NULL CHECK(manifest_hash ~ '^[a-f0-9]{64}$'),
 member_count integer NOT NULL CHECK(member_count BETWEEN 1 AND 1000),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), PRIMARY KEY(company_id,id)
);
CREATE TABLE IF NOT EXISTS control_historical_import_batch_members (
 company_id uuid NOT NULL, batch_id uuid NOT NULL, import_id uuid NOT NULL,
 position integer NOT NULL CHECK(position BETWEEN 1 AND 1000),
 member_fingerprint text NOT NULL CHECK(member_fingerprint ~ '^[a-f0-9]{64}$'),
 PRIMARY KEY(company_id,batch_id,import_id), UNIQUE(company_id,batch_id,position),
 FOREIGN KEY(company_id,batch_id) REFERENCES control_historical_import_batches(company_id,id),
 FOREIGN KEY(company_id,import_id) REFERENCES control_historical_imports(company_id,id)
);
CREATE INDEX IF NOT EXISTS control_historical_import_batch_members_import_idx
 ON control_historical_import_batch_members(company_id,import_id);

-- A batch speaks for exactly one maker: every member must be that person's own
-- platform-prepared import, in the batch's tenant, at a position within the
-- declared size. Enforced here as well as in the kernel, because the approval
-- authority function below trusts the batch requester.
CREATE OR REPLACE FUNCTION control_historical_import_batch_member_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.control_historical_import_batches b
   JOIN public.control_historical_imports i ON i.company_id=b.company_id AND i.id=NEW.import_id
   WHERE b.company_id=NEW.company_id AND b.id=NEW.batch_id AND NEW.position<=b.member_count
     AND i.requester_person_id=b.requester_person_id AND i.requester_auth_method='platform_import') THEN
  RAISE EXCEPTION 'Historical import batch member must be the batch requester''s own platform import within the declared batch size' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION control_historical_import_batch_member_guard() FROM PUBLIC,app_user;
DROP TRIGGER IF EXISTS control_historical_import_batch_member_guard ON control_historical_import_batch_members;
CREATE TRIGGER control_historical_import_batch_member_guard BEFORE INSERT ON control_historical_import_batch_members
 FOR EACH ROW EXECUTE FUNCTION control_historical_import_batch_member_guard();

-- The member set is frozen at the creating commit: the batch must commit with
-- exactly member_count members, and with positions unique and bounded by that
-- count no later insert can fit.
CREATE OR REPLACE FUNCTION control_historical_import_batch_complete() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
 IF (SELECT count(*) FROM public.control_historical_import_batch_members m
   WHERE m.company_id=NEW.company_id AND m.batch_id=NEW.id)<>NEW.member_count THEN
  RAISE EXCEPTION 'Historical import batch must commit with exactly its declared members' USING ERRCODE='23514';
 END IF;
 RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION control_historical_import_batch_complete() FROM PUBLIC,app_user;
DROP TRIGGER IF EXISTS control_historical_import_batch_complete ON control_historical_import_batches;
CREATE CONSTRAINT TRIGGER control_historical_import_batch_complete AFTER INSERT ON control_historical_import_batches
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION control_historical_import_batch_complete();

ALTER TABLE control_historical_import_batches ENABLE ROW LEVEL SECURITY;
ALTER TABLE control_historical_import_batches FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_read ON control_historical_import_batches;
CREATE POLICY tenant_read ON control_historical_import_batches FOR SELECT
 USING(company_id=app.current_company_id() AND company_id IN(SELECT auth.user_companies()));
ALTER TABLE control_historical_import_batch_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE control_historical_import_batch_members FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_read ON control_historical_import_batch_members;
CREATE POLICY tenant_read ON control_historical_import_batch_members FOR SELECT
 USING(company_id=app.current_company_id() AND company_id IN(SELECT auth.user_companies()));
-- Tenant reviewers read the manifest; only the platform-import path (BYPASSRLS) writes it.
-- The schema's default privileges would also give platform_admin UPDATE/DELETE: taken back.
REVOKE ALL ON control_historical_import_batches,control_historical_import_batch_members FROM PUBLIC,app_user,platform_admin;
GRANT SELECT ON control_historical_import_batches,control_historical_import_batch_members TO app_user;
GRANT SELECT,INSERT ON control_historical_import_batches,control_historical_import_batch_members TO platform_admin;
-- The member imports and their sources are what a batch approval binds; the same
-- default privileges left platform_admin able to rewrite them (639 revoked only
-- app_user). Nothing in the application updates or deletes either table.
REVOKE UPDATE,DELETE,TRUNCATE ON control_historical_imports,control_historical_import_sources FROM platform_admin;

-- 675's authority function, extended by one arm: a platform requester may also
-- resolve authorities for an approval of its own batch. Two further changes to
-- 675's lines: the caller check is NULL-safe (a missing sub claim used to pass),
-- and entity ids compare as text, so a non-UUID entity refuses (42501) rather
-- than raising a cast error (22P02).
CREATE OR REPLACE FUNCTION public.control_approval_authorities(p_company uuid,p_approval uuid)
RETURNS TABLE(person_id text,role text,authority_kind text,platform_role text,is_active boolean,status text,
  suspended_at timestamptz,company_status text,company_suspended_at timestamptz,permissions jsonb,
  grant_valid boolean,current_scopes text[])
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app,auth AS $$
DECLARE
  v_person text;
  v_request record;
  v_grant_valid boolean := false;
  v_current_scopes text[];
  v_caller_member boolean;
  v_caller_platform boolean;
BEGIN
  IF p_company IS DISTINCT FROM app.current_company_id() THEN
    RAISE EXCEPTION 'Approval authorities unavailable' USING ERRCODE='42501';
  END IF;
  SELECT a.* INTO v_request FROM public.control_operation_approvals a
    WHERE a.company_id=p_company AND a.id=p_approval;
  IF NOT FOUND THEN RAISE EXCEPTION 'Approval authorities unavailable' USING ERRCODE='42501'; END IF;

  SELECT EXISTS(SELECT 1 FROM public.company_users cu
    WHERE cu.company_id=p_company AND cu.user_id=auth.uid()::text) INTO v_caller_member;
  SELECT v_request.requester_auth_method='platform_import'
    AND v_request.requester_person_id=auth.uid()::text
    AND EXISTS(SELECT 1 FROM public.users pu WHERE pu.id=v_request.requester_person_id AND pu.role='super_admin')
    AND ((v_request.operation='historical_import.post' AND v_request.entity_type='historical_import'
      AND EXISTS(SELECT 1 FROM public.control_historical_imports hi
        WHERE hi.company_id=p_company AND hi.id::text=v_request.entity_id_canonical
          AND hi.requester_person_id=v_request.requester_person_id
          AND hi.requester_auth_method='platform_import'))
     OR (v_request.operation='historical_import_batch.post' AND v_request.entity_type='historical_import_batch'
      AND EXISTS(SELECT 1 FROM public.control_historical_import_batches hb
        WHERE hb.company_id=p_company AND hb.id::text=v_request.entity_id_canonical
          AND hb.requester_person_id=v_request.requester_person_id
          AND hb.requester_auth_method='platform_import'))) INTO v_caller_platform;
  -- NULL-safe: with no sub claim auth.uid() is NULL, and NOT NULL is not true.
  IF NOT (COALESCE(v_caller_member,false) OR COALESCE(v_caller_platform,false)) THEN
    RAISE EXCEPTION 'Approval authorities unavailable' USING ERRCODE='42501';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('control-authority:' || p_company::text,0));
  FOR v_person IN SELECT DISTINCT ids.id FROM (
    SELECT auth.uid()::text AS id UNION ALL SELECT v_request.requester_person_id UNION ALL
    SELECT d.person_id FROM public.control_operation_decisions d
      WHERE d.company_id=p_company AND d.approval_id=p_approval
  ) ids WHERE ids.id IS NOT NULL ORDER BY ids.id LOOP
    PERFORM 1 FROM public.users u WHERE u.id=v_person FOR UPDATE;
    PERFORM 1 FROM public.company_users cu WHERE cu.company_id=p_company AND cu.user_id=v_person FOR UPDATE;
    PERFORM 1 FROM public.company_user_permissions cp
      WHERE cp.company_id=p_company AND cp.user_id=v_person ORDER BY cp.module_key FOR SHARE;
  END LOOP;
  PERFORM 1 FROM public.companies c WHERE c.id=p_company FOR SHARE;

  IF v_request.requester_auth_method='cookie' THEN v_grant_valid := true;
  ELSIF v_request.requester_auth_method='platform_import' THEN
    v_grant_valid := EXISTS(SELECT 1 FROM public.users u
      WHERE u.id=v_request.requester_person_id AND u.role='super_admin');
  ELSIF v_request.requester_auth_method='pat' THEN
    SELECT g.revoked_at IS NULL AND g.expires_at>clock_timestamp(),g.scopes INTO v_grant_valid,v_current_scopes
      FROM public.personal_access_tokens g WHERE g.company_id=p_company
        AND g.user_id=v_request.requester_person_id AND g.id=v_request.requester_grant_id FOR SHARE;
  ELSIF v_request.requester_auth_method='oauth' THEN
    SELECT g.revoked_at IS NULL AND g.access_token_expires_at>clock_timestamp(),g.scopes INTO v_grant_valid,v_current_scopes
      FROM public.oauth_authorisations g WHERE g.company_id=p_company
        AND g.user_id=v_request.requester_person_id AND g.id=v_request.requester_grant_id FOR SHARE;
  END IF;
  IF v_request.requester_auth_method IN('pat','oauth') THEN
    SELECT COALESCE(array_agg(scope),ARRAY[]::text[]) INTO v_current_scopes FROM unnest(v_current_scopes) scope
      WHERE scope=ANY(v_request.requester_granted_scopes);
  END IF;

  RETURN QUERY SELECT DISTINCT u.id::text,
    CASE WHEN v_request.requester_auth_method='platform_import' AND u.id=v_request.requester_person_id
      THEN NULL::text ELSE cu.role::text END,
    CASE WHEN v_request.requester_auth_method='platform_import' AND u.id=v_request.requester_person_id
      THEN 'platform_import'::text ELSE 'member'::text END,
    CASE WHEN v_request.requester_auth_method='platform_import' AND u.id=v_request.requester_person_id
      THEN u.role::text ELSE NULL::text END,
    u.is_active,u.status::text,u.suspended_at,c.status::text,c.suspended_at,
    CASE WHEN cu.user_id IS NULL THEN '[]'::jsonb ELSE COALESCE((SELECT jsonb_agg(to_jsonb(cp) ORDER BY cp.module_key)
      FROM public.company_user_permissions cp WHERE cp.company_id=p_company AND cp.user_id=u.id),'[]'::jsonb) END,
    CASE WHEN u.id=v_request.requester_person_id THEN COALESCE(v_grant_valid,false) ELSE cu.user_id IS NOT NULL END,
    CASE WHEN u.id=v_request.requester_person_id THEN v_current_scopes ELSE NULL::text[] END
  FROM (
    SELECT auth.uid()::text AS bound_id UNION SELECT v_request.requester_person_id UNION
    SELECT d.person_id FROM public.control_operation_decisions d
      WHERE d.company_id=p_company AND d.approval_id=p_approval
  ) bound
  JOIN public.users u ON u.id=bound.bound_id
  CROSS JOIN public.companies c
  LEFT JOIN public.company_users cu ON cu.user_id=u.id AND cu.company_id=p_company
  WHERE c.id=p_company AND (cu.user_id IS NOT NULL OR
    (v_request.requester_auth_method='platform_import' AND u.id=v_request.requester_person_id AND u.role='super_admin'));
END;
$$;
ALTER FUNCTION public.control_approval_authorities(uuid,uuid) OWNER TO migration_admin;
REVOKE ALL ON FUNCTION public.control_approval_authorities(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.control_approval_authorities(uuid,uuid) TO app_user,platform_admin;
