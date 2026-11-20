-- Migration 1010c: a former accountant / bookkeeper's withheld Approve lives on the membership (#1656, round 3, H1).
--
-- 1010 turned accountant / bookkeeper memberships into managers WITHOUT approve and without Payroll, but only as
-- company_user_permissions rows. "Reset to defaults" (resetUserPermissions, the admin DELETE /api/admin/users/[id]/permissions)
-- deletes those rows, and a permission module added later has no row for them: either returned the full manager default
-- (approve on, Payroll on). The restriction now also sits on the membership, where neither reaches it:
--
--   company_users.approve_withheld  boolean NOT NULL DEFAULT false
--
-- Backfill: true for every membership that is (still) stored as accountant / bookkeeper: 1010 does NOT rewrite those roles
-- (round 4, B-M3: old code reads 'manager' as a full approver, so rewriting would unrestrict them on a code rollback); the app
-- reads the stored value as manager and this flag is what withholds the approval. A membership an earlier build already rewrote
-- to manager is caught through role_values_1656_backup. checkPermission and roleDefaultPermission read
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
WHERE cu.approve_withheld IS DISTINCT FROM true
  AND (cu.role IN ('accountant', 'bookkeeper')
       OR (cu.role = 'manager' AND EXISTS (SELECT 1 FROM public.role_values_1656_backup b
                                           WHERE b.source_table = 'company_users' AND b.row_id = cu.id::text
                                             AND b.old_role IN ('accountant', 'bookkeeper'))));
