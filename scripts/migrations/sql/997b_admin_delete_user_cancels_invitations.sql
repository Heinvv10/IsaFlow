-- 997b: an admin deleting a user cancels the invitations still pending for them
-- (admin follow-up A, 2026-11-16; Hein's decision 2a.1).
--
-- Why a function. deleteUser runs in the admin portal's request transaction as platform_admin,
-- and company_invitations_role_guard (883/886) refuses every portal write to the table (RC008).
-- The cancel must commit or roll back with the delete, so it cannot move to another pool's
-- transaction. This SECURITY DEFINER function, owned by migration_admin (the role every
-- invitation write already runs as, and one the guard does not judge), is the one thing the
-- portal may do to invitations: delete the PENDING ones (accepted_at IS NULL, expired included)
-- that belong to the deleted user. Deletion is how an invitation is cancelled today
-- (userInvitationService.cancelInvitation, /api/invitations/revoke/[id]); both accept routes then
-- give their not-found answer. An accepted invitation stays, as the record of who joined.
--
-- Which rows (breaker #1468): the accept routes match the GoTrue identity, not users.email, and
-- the two drift (POPIA erasure rewrites users.email and leaves GoTrue alone; change-email's
-- documented partial failures). So a row goes when EITHER
--   gotrue_user_id is the deleted user's id (an invitation pinned to that GoTrue account), OR
--   lower(btrim(email)) is one of p_emails: the caller passes the deleted users row's email AND
--   the GoTrue account's current login email (looked up before any row lock is taken).
--
-- Safety. It deletes only pending invitations: it can insert, update, re-open, re-point or
-- accept none, and touches no company_users row, so it only removes a not-yet-used way into a
-- company (930's rule: DELETE stays where it only removes access). It refuses (RC012) while a
-- users row with p_user_id exists, so it cannot be pointed at a live user's GoTrue-pinned
-- invitations; the one caller, deleteUser, calls it after its `DELETE FROM users`, in the same
-- transaction. The email arm takes any address: the portal can already delete the user, every
-- membership and a whole company, and a re-invite restores what it cancels.
--
-- Caller: src/modules/admin/services/deletedUserInvitations.ts (from deleteUser), LAST: the
-- invitation rows are the last lock of every writer of a user's rows (company_users -> users ->
-- invitation), as both accept routes take them. Census: src/modules/admin/.claude.md ("Lock order
-- for a user's rows").
--
-- Only platform_admin may execute it. The definer registry (930) lists it with its body hash.
-- Idempotent: CREATE OR REPLACE, and the registry row is upserted.
SET LOCAL lock_timeout = '5s';

CREATE OR REPLACE FUNCTION public.admin_cancel_user_invitations(p_user_id text, p_emails text[])
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_cancelled integer;
BEGIN
  IF p_user_id IS NULL OR pg_catalog.btrim(p_user_id) = '' THEN
    RAISE EXCEPTION 'admin_cancel_user_invitations: a user id is required' USING ERRCODE = 'RC012';
  END IF;
  IF EXISTS (SELECT 1 FROM public.users u WHERE u.id = p_user_id) THEN
    RAISE EXCEPTION 'admin_cancel_user_invitations: user % still exists; cancel only after deleting it', p_user_id
      USING ERRCODE = 'RC012';
  END IF;
  DELETE FROM public.company_invitations ci
   WHERE ci.accepted_at IS NULL
     AND (ci.gotrue_user_id::text = pg_catalog.lower(p_user_id)
          OR pg_catalog.lower(pg_catalog.btrim(ci.email)) IN (
               SELECT pg_catalog.lower(pg_catalog.btrim(e))
                 FROM pg_catalog.unnest(COALESCE(p_emails, '{}'::text[])) AS e
                WHERE pg_catalog.btrim(e) <> ''));
  GET DIAGNOSTICS v_cancelled = ROW_COUNT;
  RETURN v_cancelled;
END
$$;

ALTER FUNCTION public.admin_cancel_user_invitations(text, text[]) OWNER TO migration_admin;
REVOKE ALL ON FUNCTION public.admin_cancel_user_invitations(text, text[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.admin_cancel_user_invitations(text, text[]) TO platform_admin;

INSERT INTO public.app_definer_reviews (signature, writes, body_md5)
SELECT 'admin_cancel_user_invitations(text,text[])',
       'company_invitations: DELETE of pending (accepted_at IS NULL) rows pinned to a deleted user''s GoTrue id or addressed (lower(btrim())) to its emails; refuses while the users row exists; platform_admin only (admin deleteUser)',
       public.app_definer_hash('public.admin_cancel_user_invitations(text, text[])'::regprocedure)
ON CONFLICT (signature) DO UPDATE SET writes = EXCLUDED.writes, body_md5 = EXCLUDED.body_md5;

DO $$
BEGIN
  IF pg_catalog.has_function_privilege('public', 'public.admin_cancel_user_invitations(text, text[])', 'EXECUTE')
     OR pg_catalog.has_function_privilege('app_user', 'public.admin_cancel_user_invitations(text, text[])', 'EXECUTE') THEN
    RAISE EXCEPTION '997b: an app role can execute admin_cancel_user_invitations(text, text[])';
  END IF;
END $$;
