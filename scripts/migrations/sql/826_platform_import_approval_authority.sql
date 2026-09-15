-- DEPLOY NOTE - renumbered 2026-09-14 from 675_platform_import_approval_authority.sql (see the
-- dated exception in scripts/migrations/README.md). This file was ALSO edited after it had been
-- applied, and an earlier version of this note told the deployer to clear a checksum conflict. That
-- instruction is now wrong and has been removed: apply-migrations.ts tracks migrations by FILENAME,
-- so a database that applied the OLD name has no row for this one. It raises no checksum conflict,
-- it applies this file IN FULL as a new migration, and
-- `bun scripts/migrations/resolve-checksum-conflicts.ts` would find nothing to resolve. Do not run
-- it here - a command that does nothing reads as a step that succeeded.
--
-- So the only question this note has to answer is whether that re-application is safe, and it is.
-- Measured, not assumed: all 41 renumbered files were applied twice, in prefix order, to a copy of
-- the synthetic fixture that already carried every one of them under its old name. 41 of 41
-- succeeded in both passes and the second pass changed no schema object.
--
-- The specific hazard this note used to guard is also gone. The edit REMOVED the definition of
-- control_session_impersonator() from here (see the comment where it used to be, below); 839 is now
-- its only definition, so re-applying this file cannot restore the sentinel-less reader body that
-- used to live here.
--
-- Persist platform-import requesters as their real global authority. They are
-- never represented as tenant administrators; tenant reviewers remain normal
-- company members and all authority is rechecked when approval is used.
ALTER TABLE control_historical_imports
  DROP CONSTRAINT IF EXISTS control_historical_imports_requester_auth_method_check;
ALTER TABLE control_historical_imports
  ADD CONSTRAINT control_historical_imports_requester_auth_method_check
  CHECK(requester_auth_method IN('cookie','pat','oauth','platform_import'));
-- The grant-shape check was created unnamed (813), so its generated name depends
-- on how many unnamed checks preceded it: dropping a guessed name can leave the
-- cookie-only original in place, silently refusing every platform requester.
-- Drop whatever constrains the grant columns, name the replacement explicitly,
-- and assert the resulting shape.
DO $$
DECLARE v_name text;
BEGIN
  FOR v_name IN SELECT conname FROM pg_constraint
    WHERE conrelid='public.control_historical_imports'::regclass AND contype='c'
      AND pg_get_constraintdef(oid) LIKE '%requester_grant_id%'
  LOOP EXECUTE format('ALTER TABLE public.control_historical_imports DROP CONSTRAINT %I',v_name); END LOOP;
END $$;
ALTER TABLE control_historical_imports
  ADD CONSTRAINT control_historical_imports_requester_grant_shape CHECK(
    (requester_auth_method IN('cookie','platform_import') AND requester_grant_id IS NULL AND requester_granted_scopes IS NULL)
    OR (requester_auth_method IN('pat','oauth') AND requester_grant_id IS NOT NULL AND requester_granted_scopes IS NOT NULL)
  );
DO $$
DECLARE v_shape text[];
  v_auth text[];
BEGIN
  -- Every surviving check on the grant columns must be the single named replacement.
  SELECT array_agg(conname ORDER BY conname) INTO v_shape FROM pg_constraint
    WHERE conrelid='public.control_historical_imports'::regclass AND contype='c'
      AND pg_get_constraintdef(oid) LIKE '%requester_grant_id%';
  IF v_shape IS DISTINCT FROM ARRAY['control_historical_imports_requester_grant_shape']
    OR NOT EXISTS(SELECT 1 FROM pg_constraint
      WHERE conrelid='public.control_historical_imports'::regclass
        AND conname='control_historical_imports_requester_grant_shape'
        AND pg_get_constraintdef(oid) LIKE '%platform_import%')
  THEN RAISE EXCEPTION 'control_historical_imports grant-shape constraints are not the platform-import replacement: %',v_shape;
  END IF;
  -- The auth-method check is dropped by its deterministic column-level name, which is
  -- only safe if what remains actually admits a platform requester. Assert it.
  SELECT array_agg(pg_get_constraintdef(oid) ORDER BY conname) INTO v_auth FROM pg_constraint
    WHERE conrelid='public.control_historical_imports'::regclass AND contype='c'
      AND pg_get_constraintdef(oid) LIKE '%requester_auth_method%'
      AND pg_get_constraintdef(oid) NOT LIKE '%requester_grant_id%';
  IF coalesce(array_length(v_auth,1),0)<>1 OR v_auth[1] NOT LIKE '%platform_import%'
  THEN RAISE EXCEPTION 'control_historical_imports does not admit a platform_import requester: %',v_auth;
  END IF;
END $$;

DROP POLICY IF EXISTS tenant_create ON control_historical_imports;
CREATE POLICY tenant_create ON control_historical_imports FOR INSERT TO app_user
  WITH CHECK(company_id=app.current_company_id() AND company_id IN(SELECT auth.user_companies())
    AND requester_person_id=auth.uid()::text AND requester_auth_method IN('cookie','pat','oauth'));

DROP FUNCTION IF EXISTS public.control_approval_authorities(uuid,uuid);
CREATE FUNCTION public.control_approval_authorities(p_company uuid,p_approval uuid)
RETURNS TABLE(person_id text,role text,authority_kind text,platform_role text,is_active boolean,status text,
  suspended_at timestamptz,company_status text,company_suspended_at timestamptz,permissions jsonb,
  grant_valid boolean,current_scopes text[])
-- pg_temp pinned LAST: unnamed it is searched FIRST, for types as well as relations, so a tenant temp
-- type can shadow a cast in this body and raise. Every relation here is already schema-qualified.
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app,auth,pg_temp AS $$
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
    AND v_request.operation='historical_import.post' AND v_request.entity_type='historical_import'
    AND EXISTS(SELECT 1 FROM public.users pu WHERE pu.id=v_request.requester_person_id AND pu.role='super_admin')
    AND EXISTS(SELECT 1 FROM public.control_historical_imports hi
      WHERE hi.company_id=p_company AND hi.id=v_request.entity_id::uuid
        AND hi.requester_person_id=v_request.requester_person_id
        AND hi.requester_auth_method='platform_import') INTO v_caller_platform;
  IF NOT v_caller_member AND NOT v_caller_platform THEN
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

-- control_session_impersonator() - which reads the impersonation_start row the impersonation
-- route wrote, so a tenant session can be told apart from the member it impersonates - used to
-- be defined here. It now lives ONLY in 839_impersonation_evidence_integrity.sql, and this
-- file must not define it again.
--
-- 839 put row-level security on admin_audit_log, and the reader only sees the evidence while
-- the role it executes as can. That made the difference between "looked, nobody is
-- impersonating" and "could not look" load-bearing, and 839's body answers the second with the
-- unverified sentinel so the review kernel fails closed. The body that used to be here answers
-- both with NULL, which reads as no impersonation - fail-open. Two definitions across two files
-- means the later apply wins, and re-running THIS file after 839 would silently reinstate the
-- fail-open reader: exactly what resolve-checksum-conflicts.ts does to an amended migration, a
-- rebuilt fixture does, and the pending renumbering against master invites. One definition, so
-- apply order cannot decide the answer. assertImpersonationReaderDeployed asserts the sentinel
-- is present in the deployed body on every deploy, which is what catches a reinstatement
-- however it arrives.
