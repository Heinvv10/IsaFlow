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
--                                              (now through anonymize_own_user_profile, below)
--     pages/api/onboarding/complete.ts         onboarding_completed
--     onboardingSetupWriters.markOnboardingCompleted (complete-setup)  onboarding_completed
--   postgres, the pool's login role (withUserAuth issues no SET ROLE; owner, so
--   column privileges never apply): change-email (email, updated_at),
--   invite/[token] (onboarding_completed), scripts/sandbox.
--   migration_admin (own pools): verify-email -> tenantProvisioningService and
--   invitations/[token]/accept, the only INSERTs.
--   platform_admin (withPlatformAdmin): suspend / activate / resetOnboarding,
--   updateUser (role), convertUserToBureauOwner -> createBureauForOwner
--   (account_type; its only caller is admin/users/[id]/convert-to-bureau).
-- No app_user path INSERTs into users, and none writes role, status,
-- is_active, suspended_*, permissions or account_type.
--
-- email is privilege-bearing too: createInvitation (userInvitationService)
-- adds an EXISTING users row to the inviting company, at the invited role,
-- when its email matches. A writable email let an injected request claim a
-- pending invitee's address and be added in their place. Its one app_user
-- writer, the POPIA erasure, only ever writes a fixed placeholder, so it goes
-- through a SECURITY DEFINER function that takes no arguments.
--
-- A COLUMN-LEVEL REVOKE ALONE WOULD BE A NO-OP: Postgres keeps a table-level
-- privilege when a column one is revoked. So: revoke at table level, grant the
-- census columns back. A table-level REVOKE also removes the column grants of
-- the same privilege, which makes this re-runnable. updated_at is listed
-- because data-subject-rights names it; the trigger update_users_updated_at
-- needs no privilege of its own.
--
-- SCOPE, AND WHAT THIS DOES NOT CLOSE: this binds current_user = app_user.
-- The app pool logs in as `postgres`, which owns users and bypasses RLS, and
-- `SET LOCAL ROLE app_user` can be undone from inside a single injected
-- expression: `SELECT set_config('role', 'none', true)` returns the session to
-- `postgres` (verified on a PG16 fixture, non-superuser postgres). So S-07's
-- "one SQL injection is a platform takeover" stays true by that route until
-- the app pool logs in as a role that cannot regain the owner's privileges.
-- That is a change to how the pools authenticate, outside this migration.

REVOKE INSERT, UPDATE ON public.users FROM app_user;
REVOKE INSERT, UPDATE ON public.users FROM PUBLIC;
GRANT UPDATE (first_name, last_name, phone, mobile, updated_at, onboarding_completed)
  ON public.users TO app_user;

-- The caller's own row (auth.uid(), the same claim users_self_write admits),
-- fixed values only: nothing the caller passes can reach email.
CREATE OR REPLACE FUNCTION public.anonymize_own_user_profile()
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_uid pg_catalog.text := auth.uid();
  v_placeholder pg_catalog.text;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'anonymize_own_user_profile: no authenticated user' USING ERRCODE = '42501';
  END IF;
  v_placeholder := 'anonymized_' || pg_catalog.left(v_uid, 8);
  UPDATE public.users
     SET first_name = 'Anonymized',
         last_name  = v_placeholder,
         email      = v_placeholder || '@deleted.invalid',
         updated_at = pg_catalog.now()
   WHERE id = v_uid;
END
$$;
REVOKE ALL ON FUNCTION public.anonymize_own_user_profile() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.anonymize_own_user_profile() TO app_user;

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
                               'permissions', 'account_type', 'email', 'id'] LOOP
      IF has_column_privilege(r.oid, 'public.users', col, 'UPDATE')
         OR has_column_privilege(r.oid, 'public.users', col, 'INSERT') THEN
        RAISE EXCEPTION '902: % (reachable from app_user) can still write users.%', r.rolname, col;
      END IF;
    END LOOP;
  END LOOP;
END $$;
