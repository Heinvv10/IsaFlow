-- 997b: an admin deleting a user cancels the invitations still pending for their address
-- (admin follow-up A, 2026-11-16; Hein's decision 2a.1).
--
-- Why a function. deleteUser runs in the admin portal's request transaction as platform_admin,
-- and company_invitations_role_guard (883/886) refuses every portal write to the table (RC008).
-- The cancel must commit or roll back with the delete, so it cannot move to another pool's
-- transaction. This SECURITY DEFINER function, owned by migration_admin (the role every
-- invitation write already runs as, and one the guard does not judge), is the one thing the
-- portal may do to invitations: delete the PENDING ones (accepted_at IS NULL, expired included)
-- addressed to one email, compared as lower(btrim()). It only removes access (930's rule: DELETE
-- stays where it only removes access); it can create, re-open or re-point no invitation, and an
-- accepted invitation stays, as the record of who joined. Deletion is how an invitation is
-- cancelled today (userInvitationService.cancelInvitation, /api/invitations/revoke/[id]); both
-- accept routes then give their not-found answer.
--
-- Caller: src/modules/admin/services/adminUserActionsService.deleteUser, LAST, after the
-- `DELETE FROM users` and the membership sweep: the invitation rows are the last lock of every
-- writer of a user's rows (company_users -> users -> invitation), as both accept routes take
-- them. Census: src/modules/admin/.claude.md ("Lock order for a user's rows").
--
-- Only platform_admin may execute it. The definer registry (930) lists it with its body hash.
-- Idempotent: CREATE OR REPLACE, and the registry row is upserted.
SET LOCAL lock_timeout = '5s';

CREATE OR REPLACE FUNCTION public.admin_cancel_user_invitations(p_email text)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_cancelled integer;
BEGIN
  IF p_email IS NULL OR pg_catalog.btrim(p_email) = '' THEN
    RETURN 0;
  END IF;
  DELETE FROM public.company_invitations ci
   WHERE pg_catalog.lower(pg_catalog.btrim(ci.email)) = pg_catalog.lower(pg_catalog.btrim(p_email))
     AND ci.accepted_at IS NULL;
  GET DIAGNOSTICS v_cancelled = ROW_COUNT;
  RETURN v_cancelled;
END
$$;

ALTER FUNCTION public.admin_cancel_user_invitations(text) OWNER TO migration_admin;
REVOKE ALL ON FUNCTION public.admin_cancel_user_invitations(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.admin_cancel_user_invitations(text) TO platform_admin;

INSERT INTO public.app_definer_reviews (signature, writes, body_md5)
SELECT 'admin_cancel_user_invitations(text)',
       'company_invitations: DELETE of pending (accepted_at IS NULL) rows for one address, lower(btrim()); platform_admin only (admin deleteUser)',
       public.app_definer_hash('public.admin_cancel_user_invitations(text)'::regprocedure)
ON CONFLICT (signature) DO UPDATE SET writes = EXCLUDED.writes, body_md5 = EXCLUDED.body_md5;

DO $$
BEGIN
  IF pg_catalog.has_function_privilege('public', 'public.admin_cancel_user_invitations(text)', 'EXECUTE')
     OR pg_catalog.has_function_privilege('app_user', 'public.admin_cancel_user_invitations(text)', 'EXECUTE') THEN
    RAISE EXCEPTION '997b: an app role can execute admin_cancel_user_invitations(text)';
  END IF;
END $$;
