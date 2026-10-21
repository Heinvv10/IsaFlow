-- Migration 902: app_user cannot write the privilege or standing columns of users.
--
-- Audit 2026-10-18 S-07. Policy users_self_write (mig 348) lets a request
-- UPDATE the caller's own users row, and mig 348 granted app_user table-level
-- INSERT/UPDATE on every table in public. withPlatformAdmin admits a request
-- on users.role = 'super_admin', so `UPDATE users SET role = 'super_admin'
-- WHERE id = auth.uid()` from a SQL injection on any app_user route was a
-- platform takeover. The same held for is_active / status / suspended_at,
-- which decide whether a suspended account may sign in.
--
-- Census of every users writer (2026-10-21), by the role it runs as:
--   app_user (withAuth: SET LOCAL ROLE app_user)
--     pages/api/auth/profile.ts                first_name, last_name, phone, mobile
--     pages/api/accounting/data-subject-rights first_name, last_name, email, updated_at
--     pages/api/onboarding/complete.ts         onboarding_completed
--     onboardingSetupWriters.markOnboardingCompleted (complete-setup)  onboarding_completed
--   postgres, the pool's login role (withUserAuth issues no SET ROLE; owner, so
--   column privileges never apply): change-email (email, updated_at),
--   invite/[token] (onboarding_completed), scripts/sandbox.
--   migration_admin (own pools): verify-email -> tenantProvisioningService and
--   invitations/[token]/accept, the only INSERTs.
--   platform_admin (withPlatformAdmin): suspend / activate / resetOnboarding,
--   updateUser (role), convertUserToBureauOwner (account_type).
-- No app_user path INSERTs into users, and none writes role, status,
-- is_active, suspended_*, permissions or account_type.
--
-- A COLUMN-LEVEL REVOKE ALONE WOULD BE A NO-OP: Postgres keeps a table-level
-- privilege when a column one is revoked. So: revoke at table level, grant the
-- census columns back. A table-level REVOKE also removes the column grants of
-- the same privilege, which makes this re-runnable. updated_at is listed
-- because data-subject-rights names it; the trigger update_users_updated_at
-- needs no privilege of its own.
--
-- SCOPE: this binds current_user = app_user. It does not bind the pool's login
-- role, which owns users; see the S-07 PR for the role-switch caveat.

REVOKE INSERT, UPDATE ON public.users FROM app_user;
REVOKE INSERT, UPDATE ON public.users FROM PUBLIC;
GRANT UPDATE (first_name, last_name, phone, mobile, email, updated_at, onboarding_completed)
  ON public.users TO app_user;

-- Fail the deploy rather than ship a no-op: a grant issued by another grantor,
-- or one reaching app_user through a role it can SET ROLE to, survives the
-- REVOKEs above. has_*_privilege counts PUBLIC and inherited roles.
DO $$
DECLARE
  r record;
  col text;
BEGIN
  FOR r IN SELECT oid, rolname FROM pg_roles WHERE pg_has_role('app_user', oid, 'MEMBER') LOOP
    IF has_table_privilege(r.oid, 'public.users', 'INSERT')
       OR has_table_privilege(r.oid, 'public.users', 'UPDATE') THEN
      RAISE EXCEPTION '902: % (reachable from app_user) still holds table-level INSERT/UPDATE on users', r.rolname;
    END IF;
    FOREACH col IN ARRAY ARRAY['role', 'status', 'is_active', 'suspended_at', 'suspended_reason',
                               'permissions', 'account_type', 'id'] LOOP
      IF has_column_privilege(r.oid, 'public.users', col, 'UPDATE')
         OR has_column_privilege(r.oid, 'public.users', col, 'INSERT') THEN
        RAISE EXCEPTION '902: % (reachable from app_user) can still write users.%', r.rolname, col;
      END IF;
    END LOOP;
  END LOOP;
END $$;
