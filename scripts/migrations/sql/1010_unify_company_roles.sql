-- Migration 1010: one role vocabulary for the admin portal and the app (#1656).
--
-- Hein, 2026-11-19: the app model wins. A company member holds owner, admin,
-- manager or viewer (src/lib/auth/companyRoles.ts, COMPANY_ROLES), with
-- per-module permissions in company_user_permissions. Before this the admin
-- portal granted accountant / bookkeeper, the legacy invitation route
-- storeman / technician, and company_users.role defaults to 'user'. The app
-- let none of them write (withWriteAccess admits owner, admin, manager), so a
-- user the portal linked as a bookkeeper got a 403 on every write.
--
--   old value                          new value
--   company_users.role accountant      STAYS 'accountant' in the table; the app reads it as manager WITHOUT approve (Hein, 2026-11-19)
--   company_users.role bookkeeper      STAYS 'bookkeeper'; read as manager WITHOUT approve (it was the link form's default)
--   company_users.role storeman        viewer   (read-only in the app before and after)
--   company_users.role technician      viewer
--   company_users.role user            viewer
--   company_invitations.role (pending, any of the five)   viewer (nothing is granted on accept)
--   users.role accountant / bookkeeper (platform role, grants nothing)   manager
--
-- ROLLBACK SAFETY (round 4, B-M3): the stored accountant / bookkeeper role is NOT rewritten here. Old code (a code rollback, or a
-- blue/green verification that fails after migrations apply) reads 'manager' as a full approver, so rewriting would hand every
-- former accountant / bookkeeper approval the moment old code serves again. Left as stored, old code keeps its old restriction
-- (it never let them write). New code normalises the value at read time (normalizeCompanyRole: manager) and withholds approval
-- through company_users.approve_withheld (1010c) and the rows below. The physical rewrite to 'manager' is a follow-up migration
-- once this has shipped and old code can no longer serve.
--
-- "Without approve": for each promoted membership, one company_user_permissions
-- row per module with the manager defaults (read, write, export) and
-- can_approve = false; a row it already had keeps its flags but loses approve.
-- Payroll gets nothing at all (read, write, export, approve false: Hein,
-- 2026-11-19, "gate everything"), so withPayrollDetailAccess refuses them.
--
-- A 'budgets' permission module is added (budget-version approve asks it).
--
-- Managers' saved rows (review of #1670, M1; round 3, 17): before #1656 the User Access grid
-- showed a manager every module all-off and approve was enforced nowhere, so a
-- manager's row with can_approve = false cannot be told from one the grid saved
-- by accident. Approve is enforced from this release with the manager default
-- ON (Hein, B), so every manager row that can WRITE the module gets can_approve =
-- true once (marker row 'marker' / 'manager_approve_backfill'), each recorded. A row
-- that cannot write (an all-off row the grid saved) keeps can_approve as it is:
-- approve follows write, not a blanket true.
--
-- company_users.role's column default becomes 'viewer' (it was 'user').
--
-- Additive and idempotent:
--   1. every company_users row's role (changed or not: the issue's "backup of
--      company_users roles before release"), and every invitation and users
--      row it changes, is copied first into role_values_1656_backup (table,
--      row id, old role, new role); a re-run copies nothing new and changes
--      nothing. Restore the memberships with
--        UPDATE company_users cu SET role = b.old_role FROM role_values_1656_backup b
--        WHERE b.source_table = 'company_users' AND cu.id::text = b.row_id AND b.old_role <> b.new_role;
--      The permission rows it writes or changes are recorded too
--      ('company_user_permissions' by row id, 'company_user_permissions_legacy'
--      by company:user:module with the old can_approve or 'no row').
--   2. company_users_role_guard (883/886/908b/916): the admin portal
--      (platform_admin) may grant admin, manager or viewer, the app's roles
--      but owner (it still never grants owner, RC007);
--   3. company_invitations_role_guard: an app invitation's role is one of
--      owner, admin, manager, viewer (storeman / technician are gone).
-- Both guards are patched in place, as 916 did, so rules added since stay;
-- a body that holds neither the old nor the new text stops the migration.
-- No DROP, no DELETE; users_role_check is left as it is.
--
-- ROLLBACK (review of #1670, N2). Code first: scripts/rollback-deploy.sh. Then,
-- only if the old values must come back, from role_values_1656_backup (b); accountant / bookkeeper were never rewritten, so only
-- storeman / technician / user have anything to restore:
--   memberships   UPDATE company_users cu SET role = b.old_role FROM role_values_1656_backup b
--                 WHERE b.source_table = 'company_users' AND cu.id::text = b.row_id AND b.old_role <> b.new_role;
--   invitations   UPDATE company_invitations ci SET role = b.old_role FROM role_values_1656_backup b
--                 WHERE b.source_table = 'company_invitations' AND ci.id::text = b.row_id;
--   users.role    UPDATE users u SET role = b.old_role FROM role_values_1656_backup b
--                 WHERE b.source_table = 'users' AND u.id = b.row_id;
--   legacy rows   rows 1010 inserted (old_role 'no row'): DELETE FROM company_user_permissions p USING role_values_1656_backup b
--                 WHERE b.source_table = 'company_user_permissions_legacy' AND b.old_role = 'no row'
--                   AND p.company_id::text || ':' || p.user_id || ':' || p.module_key = b.row_id;
--                 rows 1010 changed (old_role is the old row as JSON): UPDATE company_user_permissions p SET
--                   can_read = (b.old_role::json->>'can_read')::boolean, can_write = (b.old_role::json->>'can_write')::boolean,
--                   can_delete = (b.old_role::json->>'can_delete')::boolean, can_export = (b.old_role::json->>'can_export')::boolean,
--                   can_approve = (b.old_role::json->>'can_approve')::boolean
--                 FROM role_values_1656_backup b WHERE b.source_table = 'company_user_permissions_legacy' AND b.old_role <> 'no row'
--                   AND p.company_id::text || ':' || p.user_id || ':' || p.module_key = b.row_id;
--   M1 rows       UPDATE company_user_permissions p SET can_approve = CASE b.old_role WHEN 'can_approve=null' THEN NULL ELSE false END
--                 FROM role_values_1656_backup b WHERE b.source_table = 'company_user_permissions' AND p.id::text = b.row_id;
--   default       ALTER TABLE company_users ALTER COLUMN role SET DEFAULT 'user';
--   guards        re-run the DO block below with each old/new pair swapped, or restore them from the pre-release dump;
--   1010b         the table owner switches the trigger company_user_permissions_write_guard off with ALTER TABLE
--                 (its DISABLE form; not spelled out here, the entity-change census reads comments too).
--   'budgets'     the permission_modules row may stay (old code never reads it).
-- WARNING, old code on the new schema (rollback-deploy.sh alone, the usual case):
--   the old admin link form defaults to 'bookkeeper', which the patched guard refuses (RC007): pick admin or
--   viewer; the old legacy invite route still accepts storeman / technician (it writes as migration_admin, which
--   the guards do not bind); old code enforces no permission row, but former accountants / bookkeepers still STORE
--   their legacy role, which old code never let write (B-M3), so they stay restricted until new code is back; the 1010b trigger keeps refusing permission writes by anyone but
--   an owner or admin (old code's route already required that).

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

CREATE TABLE IF NOT EXISTS public.role_values_1656_backup (
  source_table text NOT NULL,
  row_id       text NOT NULL,
  old_role     text NOT NULL,
  new_role     text NOT NULL,
  backed_up_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (source_table, row_id)
);
INSERT INTO public.permission_modules (module_key, module_name, display_order)
VALUES ('budgets', 'Budgets', 125)
ON CONFLICT (module_key) DO NOTHING;

-- Not for the app pools: RLS on with no policy, so only BYPASSRLS roles
-- (migration_admin, platform_admin) and the owner read it.
ALTER TABLE public.role_values_1656_backup ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.role_values_1656_backup FORCE ROW LEVEL SECURITY;
REVOKE ALL ON public.role_values_1656_backup FROM PUBLIC;

-- The map (the same CASE in every statement below; no helper function, so nothing
-- needs TEMP or leaves an object behind).
INSERT INTO public.role_values_1656_backup (source_table, row_id, old_role, new_role)
SELECT 'company_users', cu.id::text, cu.role, CASE WHEN cu.role IN ('storeman', 'technician', 'user') THEN 'viewer' ELSE cu.role END
FROM public.company_users cu
ON CONFLICT (source_table, row_id) DO NOTHING;

INSERT INTO public.role_values_1656_backup (source_table, row_id, old_role, new_role)
SELECT 'company_invitations', ci.id::text, ci.role, 'viewer'
FROM public.company_invitations ci
WHERE ci.accepted_at IS NULL AND ci.role IN ('accountant', 'bookkeeper', 'storeman', 'technician', 'user')
ON CONFLICT (source_table, row_id) DO NOTHING;

INSERT INTO public.role_values_1656_backup (source_table, row_id, old_role, new_role)
SELECT 'users', u.id::text, u.role, CASE WHEN u.role IN ('accountant', 'bookkeeper') THEN 'manager' WHEN u.role IN ('storeman', 'technician', 'user') THEN 'viewer' ELSE u.role END
FROM public.users u
WHERE u.role IN ('accountant', 'bookkeeper')
ON CONFLICT (source_table, row_id) DO NOTHING;

-- Before any row is rewritten (review of #1670, N3): a membership inserted without a role from here on is a viewer.
ALTER TABLE public.company_users ALTER COLUMN role SET DEFAULT 'viewer';

-- M1: managers' existing rows get approve, once (see the header).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.role_values_1656_backup
                 WHERE source_table = 'marker' AND row_id = 'manager_approve_backfill') THEN
    INSERT INTO public.role_values_1656_backup (source_table, row_id, old_role, new_role)
    SELECT 'company_user_permissions', p.id::text, 'can_approve=' || COALESCE(p.can_approve::text, 'null'), 'can_approve=true'
    FROM public.company_user_permissions p
    JOIN public.company_users cu ON cu.company_id = p.company_id AND cu.user_id = p.user_id
    WHERE cu.role = 'manager' AND p.can_approve IS NOT TRUE AND p.can_write IS TRUE
    ON CONFLICT (source_table, row_id) DO NOTHING;
    UPDATE public.company_user_permissions p SET can_approve = true, updated_at = now()
    FROM public.company_users cu
    WHERE cu.company_id = p.company_id AND cu.user_id = p.user_id
      AND cu.role = 'manager' AND p.can_approve IS NOT TRUE AND p.can_write IS TRUE;
    INSERT INTO public.role_values_1656_backup (source_table, row_id, old_role, new_role)
    VALUES ('marker', 'manager_approve_backfill', '-', 'done');
  END IF;
END $$;

-- Accountant / bookkeeper memberships: manager without approve, written before the role changes.
INSERT INTO public.role_values_1656_backup (source_table, row_id, old_role, new_role)
SELECT 'company_user_permissions_legacy', cu.company_id::text || ':' || cu.user_id || ':' || pm.module_key,
       -- json_build_object of a missing row is an object of nulls, never NULL: test the row itself.
       CASE WHEN p.module_key IS NULL THEN 'no row'
            ELSE json_build_object('can_read', p.can_read, 'can_write', p.can_write, 'can_delete', p.can_delete,
                                   'can_export', p.can_export, 'can_approve', p.can_approve)::text END,
       CASE WHEN pm.module_key = 'payroll' THEN 'no access' ELSE 'can_approve=false' END
FROM public.company_users cu
CROSS JOIN public.permission_modules pm
LEFT JOIN public.company_user_permissions p
  ON p.company_id = cu.company_id AND p.user_id = cu.user_id AND p.module_key = pm.module_key
WHERE cu.role IN ('accountant', 'bookkeeper')
ON CONFLICT (source_table, row_id) DO NOTHING;

INSERT INTO public.company_user_permissions
  (company_id, user_id, module_key, can_read, can_write, can_delete, can_export, can_approve)
SELECT cu.company_id, cu.user_id, pm.module_key,
       pm.module_key <> 'payroll', pm.module_key <> 'payroll', false, pm.module_key <> 'payroll', false
FROM public.company_users cu
CROSS JOIN public.permission_modules pm
WHERE cu.role IN ('accountant', 'bookkeeper')
ON CONFLICT (company_id, user_id, module_key) DO UPDATE SET
  can_approve = false,
  can_read   = CASE WHEN EXCLUDED.module_key = 'payroll' THEN false ELSE company_user_permissions.can_read END,
  can_write  = CASE WHEN EXCLUDED.module_key = 'payroll' THEN false ELSE company_user_permissions.can_write END,
  can_delete = CASE WHEN EXCLUDED.module_key = 'payroll' THEN false ELSE company_user_permissions.can_delete END,
  can_export = CASE WHEN EXCLUDED.module_key = 'payroll' THEN false ELSE company_user_permissions.can_export END,
  updated_at = now();

-- accountant / bookkeeper stay as stored (see ROLLBACK SAFETY above); read-only legacy values become viewer.
UPDATE public.company_users SET role = 'viewer'
WHERE role IN ('storeman', 'technician', 'user');

UPDATE public.company_invitations SET role = 'viewer'
WHERE accepted_at IS NULL AND role IN ('accountant', 'bookkeeper', 'storeman', 'technician', 'user');

UPDATE public.users SET role = CASE WHEN role IN ('accountant', 'bookkeeper') THEN 'manager' WHEN role IN ('storeman', 'technician', 'user') THEN 'viewer' ELSE role END WHERE role IN ('accountant', 'bookkeeper');

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
             WHERE role IN ('storeman', 'technician', 'user')) THEN
    RAISE EXCEPTION '1010: company_users still holds a read-only legacy role';
  END IF;
END $$;
