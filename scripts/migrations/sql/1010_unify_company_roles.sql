-- Migration 1010: one role vocabulary for the admin portal and the app (#1656).
--
-- Hein, 2026-11-19: the app model wins. A company member holds owner, admin,
-- manager or viewer (src/lib/auth/companyRoles.ts, COMPANY_ROLES), with
-- per-module permissions in company_user_permissions. Before this the admin
-- portal granted accountant / bookkeeper, the legacy invitation route
-- storeman / technician, and company_users.role defaults to 'user'. None of
-- those could write (withWriteAccess admits owner, admin, manager), so each
-- maps to viewer: nobody gains or loses write access.
--
--   old value                          new value
--   company_users.role accountant      viewer
--   company_users.role bookkeeper      viewer
--   company_users.role storeman        viewer
--   company_users.role technician      viewer
--   company_users.role user            viewer
--   company_invitations.role (pending, same five)   viewer
--   users.role accountant / bookkeeper (platform role, grants nothing)   viewer
--
-- Additive and idempotent:
--   1. every company_users row's role (changed or not: the issue's "backup of
--      company_users roles before release"), and every invitation and users
--      row it changes, is copied first into role_values_1656_backup (table,
--      row id, old role, new role); a re-run copies nothing new and changes
--      nothing. Restore the memberships with
--        UPDATE company_users cu SET role = b.old_role FROM role_values_1656_backup b
--        WHERE b.source_table = 'company_users' AND cu.id::text = b.row_id AND b.old_role <> b.new_role;
--   2. company_users_role_guard (883/886/908b/916): the admin portal
--      (platform_admin) may grant admin, manager or viewer, the app's roles
--      but owner (it still never grants owner, RC007);
--   3. company_invitations_role_guard: an app invitation's role is one of
--      owner, admin, manager, viewer (storeman / technician are gone).
-- Both guards are patched in place, as 916 did, so rules added since stay;
-- a body that holds neither the old nor the new text stops the migration.
-- No DROP, no DELETE; users_role_check is left as it is.

CREATE TABLE IF NOT EXISTS public.role_values_1656_backup (
  source_table text NOT NULL,
  row_id       text NOT NULL,
  old_role     text NOT NULL,
  new_role     text NOT NULL,
  backed_up_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (source_table, row_id)
);
-- Not for the app pools: RLS on with no policy, so only BYPASSRLS roles
-- (migration_admin, platform_admin) and the owner read it.
ALTER TABLE public.role_values_1656_backup ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.role_values_1656_backup FORCE ROW LEVEL SECURITY;
REVOKE ALL ON public.role_values_1656_backup FROM PUBLIC;

INSERT INTO public.role_values_1656_backup (source_table, row_id, old_role, new_role)
SELECT 'company_users', cu.id::text, cu.role,
       CASE WHEN cu.role IN ('accountant', 'bookkeeper', 'storeman', 'technician', 'user') THEN 'viewer' ELSE cu.role END
FROM public.company_users cu
ON CONFLICT (source_table, row_id) DO NOTHING;

INSERT INTO public.role_values_1656_backup (source_table, row_id, old_role, new_role)
SELECT 'company_invitations', ci.id::text, ci.role, 'viewer'
FROM public.company_invitations ci
WHERE ci.accepted_at IS NULL AND ci.role IN ('accountant', 'bookkeeper', 'storeman', 'technician', 'user')
ON CONFLICT (source_table, row_id) DO NOTHING;

INSERT INTO public.role_values_1656_backup (source_table, row_id, old_role, new_role)
SELECT 'users', u.id::text, u.role, 'viewer'
FROM public.users u
WHERE u.role IN ('accountant', 'bookkeeper')
ON CONFLICT (source_table, row_id) DO NOTHING;

UPDATE public.company_users SET role = 'viewer'
WHERE role IN ('accountant', 'bookkeeper', 'storeman', 'technician', 'user');

UPDATE public.company_invitations SET role = 'viewer'
WHERE accepted_at IS NULL AND role IN ('accountant', 'bookkeeper', 'storeman', 'technician', 'user');

UPDATE public.users SET role = 'viewer' WHERE role IN ('accountant', 'bookkeeper');

-- 2 and 3: patch each guard's role list and its message in place.
DO $$
DECLARE
  r record;
  v_src pg_catalog.text;
  v_def pg_catalog.text;
BEGIN
  FOR r IN
    SELECT * FROM (VALUES
      ('public.company_users_role_guard()'::pg_catalog.regprocedure,
       $o1$ARRAY['admin', 'accountant', 'bookkeeper', 'viewer']::pg_catalog.text[]$o1$,
       $n1$ARRAY['admin', 'manager', 'viewer']::pg_catalog.text[]$n1$,
       $o2$'The admin portal may only grant the admin, accountant, bookkeeper or viewer role (got %)'$o2$,
       $n2$'The admin portal may only grant the admin, manager or viewer role (got %)'$n2$),
      ('public.company_invitations_role_guard()'::pg_catalog.regprocedure,
       $o3$ARRAY['owner', 'admin', 'manager', 'viewer', 'storeman', 'technician']::pg_catalog.text[]$o3$,
       $n3$ARRAY['owner', 'admin', 'manager', 'viewer']::pg_catalog.text[]$n3$,
       $o4$'Invalid role. Must be one of: owner, admin, manager, viewer, storeman, technician'$o4$,
       $n4$'Invalid role. Must be one of: owner, admin, manager, viewer'$n4$)
    ) AS t(fn, old_list, new_list, old_msg, new_msg)
  LOOP
    SELECT p.prosrc INTO v_src FROM pg_catalog.pg_proc p WHERE p.oid = r.fn;
    IF pg_catalog.strpos(v_src, r.new_list) > 0 AND pg_catalog.strpos(v_src, r.old_list) = 0 THEN
      CONTINUE; -- already applied
    END IF;
    IF (pg_catalog.length(v_src) - pg_catalog.length(pg_catalog.replace(v_src, r.old_list, ''))) / pg_catalog.length(r.old_list) <> 1
       OR (pg_catalog.length(v_src) - pg_catalog.length(pg_catalog.replace(v_src, r.old_msg, ''))) / pg_catalog.length(r.old_msg) <> 1 THEN
      RAISE EXCEPTION '1010: % does not hold its role list and message exactly once; merge #1656 by hand', r.fn;
    END IF;
    v_def := pg_catalog.replace(pg_catalog.replace(pg_catalog.pg_get_functiondef(r.fn), r.old_list, r.new_list), r.old_msg, r.new_msg);
    -- CREATE OR REPLACE keeps the owner, the grants and the triggers.
    EXECUTE v_def;
  END LOOP;
END $$;

REVOKE ALL ON FUNCTION public.company_users_role_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.company_invitations_role_guard() FROM PUBLIC;

-- Fail the deploy rather than ship a guard that still grants a legacy role.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_proc p
             WHERE p.oid IN ('public.company_users_role_guard()'::pg_catalog.regprocedure,
                             'public.company_invitations_role_guard()'::pg_catalog.regprocedure)
               AND p.prosrc ~ $re$'(accountant|bookkeeper|storeman|technician)'$re$) THEN
    RAISE EXCEPTION '1010: a member guard still names a legacy role';
  END IF;
  IF EXISTS (SELECT 1 FROM public.company_users
             WHERE role IN ('accountant', 'bookkeeper', 'storeman', 'technician', 'user')) THEN
    RAISE EXCEPTION '1010: company_users still holds a legacy role';
  END IF;
END $$;
