-- 714: R-147 — the approvals list showed "Requested by Unknown" for a real
-- requester because the fix reaches further than the reported symptom.
--
-- Two independent defects in listRequests' name lookup (approvalService.ts):
--   1. `u1.first_name || ' ' || u1.last_name` is NULL the instant either half
--      is NULL (Postgres string concatenation, not COALESCE) — a user with
--      only one name field set resolved to no name at all, not a partial one.
--   2. withAuth runs as app_user, and `users_self_read` (a FORCE RLS policy)
--      lets app_user see only ITS OWN row (`id = auth.uid()`) — exactly the
--      constraint migration 708 already worked around for the self-approval
--      roster. The plain LEFT JOIN in listRequests never hit that roster path,
--      so an approver listing a request raised by anyone else always got a
--      blocked join: NULL name, "Unknown", regardless of whether the
--      requester had a real name on file.
--
-- Same pattern as approval_company_other_members (708): SECURITY DEFINER to
-- read past RLS, but bound to exactly what the approvals list already
-- implies — the caller's own active company, and a target who is ALSO a
-- member of it. Never a general users-table name oracle for an arbitrary id.
CREATE OR REPLACE FUNCTION public.approval_company_member_name(
  p_company_id pg_catalog.uuid, p_user_id pg_catalog.text
) RETURNS pg_catalog.text
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_name pg_catalog.text;
BEGIN
  IF auth.uid() IS NULL THEN
    RETURN NULL;
  END IF;
  IF app.current_company_id() IS NULL OR app.current_company_id() IS DISTINCT FROM p_company_id THEN
    RAISE EXCEPTION 'approval_company_member_name: answers only for the caller''s own company'
      USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.company_users cu WHERE cu.company_id = p_company_id AND cu.user_id = auth.uid()
  ) THEN
    RAISE EXCEPTION 'approval_company_member_name: caller is not a member of this company'
      USING ERRCODE = '42501';
  END IF;
  IF p_user_id IS NULL THEN
    RETURN NULL;
  END IF;

  -- The target must ALSO be a member of p_company_id: bounds the lookup to
  -- exactly what an approval_requests row already implies (requested_by and
  -- decided_by are always this company's members), not an arbitrary id.
  SELECT NULLIF(TRIM(BOTH ' ' FROM COALESCE(u.first_name, '') || ' ' || COALESCE(u.last_name, '')), '')
    INTO v_name
  FROM public.users u
  JOIN public.company_users cu ON cu.user_id = u.id AND cu.company_id = p_company_id
  WHERE u.id = p_user_id;

  IF v_name IS NOT NULL THEN
    RETURN v_name;
  END IF;

  -- No name on file (GoTrue user with an email but no profile name yet): the
  -- email is still an honest, resolvable identifier — closer to the truth
  -- than "Unknown", which reads as "nobody knows who raised this".
  RETURN (
    SELECT u.email FROM public.users u
    JOIN public.company_users cu ON cu.user_id = u.id AND cu.company_id = p_company_id
    WHERE u.id = p_user_id
  );
END
$$;

REVOKE ALL ON FUNCTION public.approval_company_member_name(UUID, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.approval_company_member_name(UUID, TEXT) TO app_user;

DO $$
BEGIN
  IF has_function_privilege('public', 'public.approval_company_member_name(uuid, text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'migration 714: PUBLIC can still execute approval_company_member_name';
  END IF;
  IF NOT has_function_privilege('app_user', 'public.approval_company_member_name(uuid, text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'migration 714: app_user cannot execute approval_company_member_name';
  END IF;
  -- Same FORCE RLS hazard as 708: a definer owner without BYPASSRLS would see
  -- nothing and the function would fail closed but silently wrong (every
  -- lookup NULL). Refuse to ship it that way.
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_roles r ON r.oid = p.proowner
    WHERE p.oid = 'public.approval_company_member_name(uuid, text)'::pg_catalog.regprocedure
      AND (r.rolbypassrls OR r.rolsuper)
  ) THEN
    RAISE EXCEPTION 'migration 714: the owner of approval_company_member_name must bypass RLS';
  END IF;
END $$;
