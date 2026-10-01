-- 716: R-152 — Manage Users (/accounting/user-access) and the practice users
-- list showed each viewer only themselves. Both listCompanyUsers
-- (userAccessService, practiceUsersService) INNER JOINed `users` under
-- withAuth (app_user), and `users_self_read` (FORCE RLS, `id = auth.uid()`)
-- hides every other member's users row, so the join dropped those members.
-- company_users' own policy was never the cause: cu_select (mig 459) already
-- shows an owner/admin every member row of their company.
--
-- Same pattern as 714/715: SECURITY DEFINER to read past users_self_read,
-- bound to the caller's own active company and a caller who is a member of
-- it. This one returns a LIST, so it must not widen what company_users RLS
-- allows: the row filter below is cu_select verbatim (own row, or every row
-- of a company the caller administers via auth.user_admin_companies()). A
-- viewer/manager still gets only their own row. Only the columns the two
-- services select are returned — nothing else from `users`.
CREATE OR REPLACE FUNCTION public.company_member_directory(p_company_id pg_catalog.uuid)
RETURNS TABLE (
  user_id pg_catalog.text, email pg_catalog.text, first_name pg_catalog.text, last_name pg_catalog.text,
  is_active pg_catalog.bool, role pg_catalog.text, created_at pg_catalog.timestamptz
)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF app.current_company_id() IS NULL OR app.current_company_id() IS DISTINCT FROM p_company_id THEN
    RAISE EXCEPTION 'company_member_directory: answers only for the caller''s own company'
      USING ERRCODE = '42501';
  END IF;
  -- Also refuses a principal-less caller (auth.uid() NULL matches no row):
  -- an empty list would read as "this company has no members".
  IF NOT EXISTS (
    SELECT 1 FROM public.company_users cu WHERE cu.company_id = p_company_id AND cu.user_id = auth.uid()
  ) THEN
    RAISE EXCEPTION 'company_member_directory: caller is not a member of this company'
      USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  SELECT cu.user_id::pg_catalog.text, u.email::pg_catalog.text, u.first_name::pg_catalog.text,
         u.last_name::pg_catalog.text, u.is_active, cu.role::pg_catalog.text, cu.created_at
  FROM public.company_users cu
  JOIN public.users u ON u.id = cu.user_id
  WHERE cu.company_id = p_company_id
    AND (cu.user_id = auth.uid() OR cu.company_id IN (SELECT auth.user_admin_companies()));
END
$$;

REVOKE ALL ON FUNCTION public.company_member_directory(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.company_member_directory(UUID) TO app_user;

DO $$
BEGIN
  IF has_function_privilege('public', 'public.company_member_directory(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'migration 716: PUBLIC can still execute company_member_directory';
  END IF;
  IF NOT has_function_privilege('app_user', 'public.company_member_directory(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'migration 716: app_user cannot execute company_member_directory';
  END IF;
  -- FORCE RLS on company_users/users binds the definer's owner too: an owner
  -- without BYPASSRLS would list nobody (fails closed, but silently wrong).
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_roles r ON r.oid = p.proowner
    WHERE p.oid = 'public.company_member_directory(uuid)'::pg_catalog.regprocedure
      AND (r.rolbypassrls OR r.rolsuper)
  ) THEN
    RAISE EXCEPTION 'migration 716: the owner of company_member_directory must bypass RLS';
  END IF;
END $$;
