-- Migration 1010c: a former accountant / bookkeeper's withheld Approve lives on the membership (#1656, round 3, H1).
--
-- 1010 turned accountant / bookkeeper memberships into managers WITHOUT approve and without Payroll, but only as
-- company_user_permissions rows. "Reset to defaults" (resetUserPermissions, the admin DELETE /api/admin/users/[id]/permissions)
-- deletes those rows, and a permission module added later has no row for them: either returned the full manager default
-- (approve on, Payroll on). The restriction now also sits on the membership, where neither reaches it:
--
--   company_users.approve_withheld  boolean NOT NULL DEFAULT false
--
-- Backfill: true for every membership 1010 promoted from accountant / bookkeeper (role_values_1656_backup, source_table
-- 'company_users', old_role accountant / bookkeeper; the row is a manager now). checkPermission and roleDefaultPermission read
-- it: a manager with it set has Approve false on every module and Payroll read / write false WHEN NO ROW says otherwise.
-- An owner or admin who ticks Approve for them writes a row, which overrides the default, as before. Cleared by an owner / admin
-- in User Access or by the admin portal (company_users RLS: cu_admin_write; platform_admin).
--
-- Additive and idempotent: IF NOT EXISTS; the backfill touches only rows not already true.
-- Old code (blue/green overlap, a code rollback) ignores the column.
-- ROLLBACK: ALTER TABLE public.company_users DROP COLUMN IF EXISTS approve_withheld;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

ALTER TABLE public.company_users ADD COLUMN IF NOT EXISTS approve_withheld boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.company_users.approve_withheld IS
  'The membership holds no Approve (and no Payroll) by role default: a former accountant / bookkeeper (#1656). A company_user_permissions row overrides.';

UPDATE public.company_users cu
SET approve_withheld = true
FROM public.role_values_1656_backup b
WHERE b.source_table = 'company_users'
  AND b.row_id = cu.id::text
  AND b.old_role IN ('accountant', 'bookkeeper')
  AND cu.role = 'manager'
  AND cu.approve_withheld IS DISTINCT FROM true;

-- A legacy value that shows up AFTER this migration (old code writing during a deploy window, the old admin link form, a direct
-- INSERT, a pending legacy invitation accepted) is normalised on its way in, fail closed: accountant / bookkeeper become a manager
-- WITH approve_withheld, storeman / technician / user a viewer. BEFORE INSERT OR UPDATE OF role; named so it fires ahead of
-- company_users_role_guard, which then judges the normalised value. The app also withholds approval from a stored legacy name
-- (roleDefaultPermission, LEGACY_ROLES_WITHOUT_APPROVE) in case one is ever read.
CREATE OR REPLACE FUNCTION public.company_users_legacy_role_normalise() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF NEW.role IN ('accountant', 'bookkeeper') THEN
    NEW.role := 'manager';
    NEW.approve_withheld := true;
  ELSIF NEW.role IN ('storeman', 'technician', 'user') THEN
    NEW.role := 'viewer';
  END IF;
  RETURN NEW;
END
$$;

REVOKE ALL ON FUNCTION public.company_users_legacy_role_normalise() FROM PUBLIC;
ALTER FUNCTION public.company_users_legacy_role_normalise() OWNER TO migration_admin;

CREATE OR REPLACE TRIGGER company_users_legacy_role_normalise
  BEFORE INSERT OR UPDATE OF role ON public.company_users
  FOR EACH ROW EXECUTE FUNCTION public.company_users_legacy_role_normalise();
