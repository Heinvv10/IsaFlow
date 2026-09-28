-- 715: R-147 review round 1 — the same users_self_read defect as 714, in
-- siblings that need the caller/decider's email/first_name/last_name as
-- SEPARATE columns (customer/supplier activity feeds), not one combined
-- string. `approval_company_member_name` (714) only returns a single
-- COALESCEd name, so those two routes still plain-JOINed `users` directly
-- and got NULL for everyone but the viewer under `users_self_read` (FORCE
-- RLS: app_user may SELECT only its own row).
--
-- Same guard pattern as 714/708: SECURITY DEFINER, scoped to the caller's own
-- active company and a target who is ALSO a member of it — never a general
-- users-table oracle. Returns the raw parts (no COALESCE/fallback) so callers
-- keep their own display-fallback logic (ActivityTab.tsx already does
-- first/last/email-then-"Unknown" client-side).
CREATE OR REPLACE FUNCTION public.approval_company_member_profile(
  p_company_id pg_catalog.uuid, p_user_id pg_catalog.text
) RETURNS TABLE (email pg_catalog.text, first_name pg_catalog.text, last_name pg_catalog.text)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF auth.uid() IS NULL THEN
    RETURN;
  END IF;
  IF app.current_company_id() IS NULL OR app.current_company_id() IS DISTINCT FROM p_company_id THEN
    RAISE EXCEPTION 'approval_company_member_profile: answers only for the caller''s own company'
      USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.company_users cu WHERE cu.company_id = p_company_id AND cu.user_id = auth.uid()
  ) THEN
    RAISE EXCEPTION 'approval_company_member_profile: caller is not a member of this company'
      USING ERRCODE = '42501';
  END IF;
  IF p_user_id IS NULL THEN
    RETURN;
  END IF;

  RETURN QUERY
  SELECT u.email::pg_catalog.text, u.first_name::pg_catalog.text, u.last_name::pg_catalog.text
  FROM public.users u
  JOIN public.company_users cu ON cu.user_id = u.id AND cu.company_id = p_company_id
  WHERE u.id = p_user_id;
END
$$;

REVOKE ALL ON FUNCTION public.approval_company_member_profile(UUID, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.approval_company_member_profile(UUID, TEXT) TO app_user;

DO $$
BEGIN
  IF has_function_privilege('public', 'public.approval_company_member_profile(uuid, text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'migration 715: PUBLIC can still execute approval_company_member_profile';
  END IF;
  IF NOT has_function_privilege('app_user', 'public.approval_company_member_profile(uuid, text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'migration 715: app_user cannot execute approval_company_member_profile';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_roles r ON r.oid = p.proowner
    WHERE p.oid = 'public.approval_company_member_profile(uuid, text)'::pg_catalog.regprocedure
      AND (r.rolbypassrls OR r.rolsuper)
  ) THEN
    RAISE EXCEPTION 'migration 715: the owner of approval_company_member_profile must bypass RLS';
  END IF;
END $$;
