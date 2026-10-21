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
--   updateUser (role), convertUserToBureauOwner -> createBureauForOwner
--   (account_type; its only caller is admin/users/[id]/convert-to-bureau).
-- No app_user path INSERTs into users, and none writes role, status,
-- is_active, suspended_*, permissions or account_type.
--
-- email is privilege-bearing too: createInvitation (userInvitationService)
-- adds an EXISTING users row to the inviting company, at the invited role,
-- when its email matches. A writable email let an injected request claim a
-- pending invitee's address and be added in their place. Its one app_user
-- writer, the POPIA erasure, only ever writes the row's own fixed placeholder
-- `anonymized_<first 8 of id>@deleted.invalid`, so app_user keeps UPDATE on
-- email and the trigger below refuses any other value. RLS (users_self_write)
-- still picks the row. Not a SECURITY DEFINER function: one would take its row
-- from auth.uid(), and an injected expression can set request.jwt.claims and
-- call it in the same statement, steering it onto any user's row; a plain
-- UPDATE's policy qual is evaluated before such a set_config can run.
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
-- an injected `set_config('role', 'none', true)` undoes `SET LOCAL ROLE
-- app_user` for the rest of the transaction (verified on a PG16 fixture,
-- non-superuser postgres). Within that one statement privileges are already
-- checked as app_user, so it buys a full READ of users as the owner, not a
-- write; any LATER statement in the same transaction runs as the owner, and
-- an injection that reaches two statements can set role = 'super_admin'.
-- Closing that means the app pool logging in as a role that cannot regain the
-- owner's privileges: a change to how the pools authenticate, outside this
-- migration.

REVOKE INSERT, UPDATE ON public.users FROM app_user;
REVOKE INSERT, UPDATE ON public.users FROM PUBLIC;
GRANT UPDATE (first_name, last_name, phone, mobile, email, updated_at, onboarding_completed)
  ON public.users TO app_user;

-- app_user may write email only as the erasure placeholder for that row.
-- current_user is app_user inside this (SECURITY INVOKER) trigger exactly
-- when the statement ran as app_user; every other writer (change-email as the
-- pool role, the admin and provisioning pools) passes untouched.
CREATE OR REPLACE FUNCTION public.users_app_user_email_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF current_user = 'app_user'
     AND NEW.email IS DISTINCT FROM OLD.email
     AND NEW.email IS DISTINCT FROM 'anonymized_' || pg_catalog.left(NEW.id::pg_catalog.text, 8) || '@deleted.invalid' THEN
    RAISE EXCEPTION 'users.email may be changed by app_user only to its erasure placeholder'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$$;
DROP TRIGGER IF EXISTS users_app_user_email_guard ON public.users;
CREATE TRIGGER users_app_user_email_guard
  BEFORE UPDATE OF email ON public.users
  FOR EACH ROW EXECUTE FUNCTION public.users_app_user_email_guard();

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
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.users'::regclass
                  AND tgname = 'users_app_user_email_guard' AND tgenabled <> 'D') THEN
    RAISE EXCEPTION '902: users_app_user_email_guard is missing or disabled';
  END IF;
END $$;
