-- Persist platform-import requesters as their real global authority. They are
-- never represented as tenant administrators; tenant reviewers remain normal
-- company members and all authority is rechecked when approval is used.
ALTER TABLE control_historical_imports
  DROP CONSTRAINT IF EXISTS control_historical_imports_requester_auth_method_check;
ALTER TABLE control_historical_imports
  ADD CONSTRAINT control_historical_imports_requester_auth_method_check
  CHECK(requester_auth_method IN('cookie','pat','oauth','platform_import'));
-- The grant-shape check was created unnamed (639), so its generated name depends
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

-- An impersonated browser session presents the impersonated member's own JWT,
-- so nothing in the tenant schema can tell it apart from that member working.
-- The impersonation route records the target session it minted; this is the
-- durable side of that fact, readable by the tenant role for exactly the
-- current session and surviving a dropped delegation-proof cookie or a refresh.
DROP FUNCTION IF EXISTS public.control_session_impersonator();
CREATE FUNCTION public.control_session_impersonator()
RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,auth AS $$
  SELECT l.admin_user_id::text FROM public.admin_audit_log l
  WHERE l.action='impersonation_start' AND l.target_type='user'
    AND l.target_id::text=auth.uid()
    AND l.details->>'target_session_id'=
      (nullif(current_setting('request.jwt.claims',true),'')::jsonb->>'session_id')
  ORDER BY l.created_at DESC LIMIT 1
$$;
ALTER FUNCTION public.control_session_impersonator() OWNER TO migration_admin;
REVOKE ALL ON FUNCTION public.control_session_impersonator() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.control_session_impersonator() TO app_user,platform_admin;
