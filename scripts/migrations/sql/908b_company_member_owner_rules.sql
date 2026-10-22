-- 908b: Audit S-04/S-08 follow-ups A and B — two owner rules move into
-- company_users_role_guard() (886). Same trigger, same grants, same lock order
-- (the row, which a BEFORE ROW trigger on UPDATE/DELETE already holds, then
-- the per-company advisory lock `company_owners:<company>`).
--
--  A. No company is left without an owner by any writer but app_user. 886 let
--   platform_admin (the admin site) demote or remove the last owner, and every
--   other non-app_user writer skipped the guard entirely: the admin site's
--   delete-user and reset-onboarding (DELETE FROM company_users WHERE user_id
--   = …) removed a user's owner rows in every company at once. Now, when an
--   owner row is removed or demoted by platform_admin or by any other role
--   that is not a superuser, the other owners are counted (by person, as 886
--   counts them) under the advisory lock, and none left is refused with RC011
--   "This user is the company's only owner. Make someone else owner first."
--   app_user keeps its own rule (RC005).
--   Exempt: a company that no longer exists. A hard DELETE of the company
--   removes its members through the FK cascade (company_users_company_id_fkey
--   ON DELETE CASCADE), which runs as the table's owner after the company row
--   is gone; the company and its members go together, so there is no
--   ownerless company to protect. The app only soft-deletes companies.
--   Exempt: superusers. On dev and every CI fixture `postgres` is a superuser
--   and test cleanups and seed scripts clear members company by company; on
--   production no request or deploy path logs in as a superuser (`postgres`
--   and `migration_admin` are not), so they are bound.
--   At an isolation level above READ COMMITTED the count reads a stale
--   snapshot (886's reasoning), so the check refuses there with 40001, as 886
--   does for app_user; it runs only when an owner row leaves.
--   Outside app_user an owner row whose role is rewritten to anything but
--   the exact 'owner' (e.g. 'OWNER') is leaving: the counts and RLS read the
--   exact value. The reverse (an owner stored as 'OWNER' is not counted as an
--   owner left behind) can refuse a removal 886's precondition makes moot.
--   Not covered: TRUNCATE (no row trigger fires; only the table owner holds
--   it) and DISABLE TRIGGER (the owner) — the owner role is the boundary.
--   NOT exempt: a soft-deleted company (status 'deleted'). It can be restored,
--   and would come back with no owner; the admin site's delete-user and
--   reset-onboarding refuse its only owner too (409 naming the company).
--   Scripts that clear members company by company (large-scale-seed,
--   stress-test, the sandbox and acceptance seeds) rely on running as a
--   superuser; as any other role they meet RC011.
--   A statement that removes one person from several companies takes each
--   company's owner lock in row order; two such statements at once can
--   deadlock (40P01), which rolls one back whole.
--
--  B. S-04: an app_user write that changes the role of, or removes, an owner
--   row needs the acting user to be an owner of that company. 886 let an admin
--   demote or remove an owner (subject only to the last-owner rule); the
--   service (userAccessService, OwnerProtectedError) refused it, the database
--   did not. The actor's role is read again after the advisory lock, as the
--   service does, so an owner demoted by a concurrent owner write in flight is
--   judged by their new role. Refused with RC010 "Only an owner can change or
--   remove another owner." Self-removal stays RC006 (checked first).
--
-- What B does NOT bind (S-07 lessons, PR #761): the app pool logs in as the
-- owner role, so app_user SQL can `set_config('role', 'none', true)` and write
-- as that role (current_user is then not app_user and B is not reached; A
-- still applies on production, where that role is not a superuser), and
-- `auth.uid()` follows `request.jwt.claims`, which app_user SQL can forge, so
-- the actor B judges is only as good as that claim. B is a backstop for the
-- service, not a boundary against injected SQL; the pool's login role is the
-- S-07b fix.
--
-- Refusal codes: 883/886's RC001–RC009 and 40001, plus RC010 (B) and RC011 (A).
-- (B runs after RC004, so an app_user move of an owner row is still RC004.)

CREATE OR REPLACE FUNCTION public.company_users_role_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_company pg_catalog.uuid := CASE TG_OP WHEN 'DELETE' THEN OLD.company_id ELSE NEW.company_id END;
  v_actor_role pg_catalog.text;
  v_others pg_catalog.int8;
  v_isolation pg_catalog.text := pg_catalog.current_setting('transaction_isolation');
  v_fresh pg_catalog.bool := v_isolation IN ('read committed', 'read uncommitted');
  -- An owner row is removed, its role changes to one that is not owner, or it
  -- is moved to another company or person (app_user and platform_admin are
  -- refused that move, RC004; any other role is judged as removing the owner).
  v_owner_leaves pg_catalog.bool := false;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    v_owner_leaves := public.company_member_role_is_owner(OLD.role)
      AND (TG_OP = 'DELETE' OR public.company_member_role_is_owner(NEW.role) IS NOT TRUE
           OR NEW.company_id IS DISTINCT FROM OLD.company_id
           OR pg_catalog.lower(NEW.user_id::pg_catalog.text) IS DISTINCT FROM pg_catalog.lower(OLD.user_id::pg_catalog.text));
  END IF;

  IF current_user <> 'app_user' THEN
    IF current_user = 'platform_admin' THEN
      IF TG_OP = 'UPDATE' AND (NEW.company_id IS DISTINCT FROM OLD.company_id OR NEW.user_id IS DISTINCT FROM OLD.user_id) THEN
        RAISE EXCEPTION 'A company membership cannot be moved to another company or user' USING ERRCODE = 'RC004';
      END IF;
      IF TG_OP <> 'DELETE' AND (TG_OP = 'INSERT' OR NEW.role IS DISTINCT FROM OLD.role)
         AND COALESCE(NEW.role <> ALL (ARRAY['admin', 'accountant', 'bookkeeper', 'viewer']::pg_catalog.text[]), true) THEN
        RAISE EXCEPTION 'The admin portal may only grant the admin, accountant, bookkeeper or viewer role (got %)', NEW.role
          USING ERRCODE = 'RC007';
      END IF;
    END IF;
    -- A (908b): the last owner, outside app_user. platform_admin always; any
    -- other role unless it is a superuser (see the header). Leaving is judged
    -- against the exact 'owner' here: these roles have no role allow-list, and
    -- an owner rewritten as 'OWNER' is no owner to the exact counts and to RLS
    -- (auth.user_admin_companies) — policy-breaker REPRO 2.
    IF TG_OP = 'UPDATE' AND public.company_member_role_is_owner(OLD.role) AND NEW.role IS DISTINCT FROM 'owner' THEN
      v_owner_leaves := true;
    END IF;
    IF v_owner_leaves AND (current_user = 'platform_admin'
        OR NOT COALESCE((SELECT r.rolsuper FROM pg_catalog.pg_roles r WHERE r.rolname = current_user), false)) THEN
      -- The lock app_user's last-owner check takes: a portal demotion and an
      -- app demotion of the other owner are judged one after the other.
      PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('company_owners:' || OLD.company_id::pg_catalog.text, 0));
      -- A company already deleted (its FK cascade is removing the members) has
      -- no owner to keep.
      IF EXISTS (SELECT 1 FROM public.companies c WHERE c.id = OLD.company_id) THEN
        SELECT pg_catalog.count(DISTINCT pg_catalog.lower(cu.user_id::pg_catalog.text)) INTO v_others FROM public.company_users cu
        WHERE cu.company_id = OLD.company_id AND cu.role = 'owner'
          AND pg_catalog.lower(cu.user_id::pg_catalog.text) <> pg_catalog.lower(OLD.user_id::pg_catalog.text);
        IF v_others = 0 THEN
          RAISE EXCEPTION 'This user is the company''s only owner. Make someone else owner first.'
            USING ERRCODE = 'RC011', DETAIL = 'company ' || OLD.company_id::pg_catalog.text;
        END IF;
        IF NOT v_fresh THEN
          RAISE EXCEPTION 'An owner is removed or demoted only at READ COMMITTED (this transaction is %); retry at READ COMMITTED', v_isolation
            USING ERRCODE = '40001';
        END IF;
      END IF;
    END IF;
    RETURN CASE TG_OP WHEN 'DELETE' THEN OLD ELSE NEW END;
  END IF;

  v_actor_role := public.company_member_actor_role(v_company);
  IF v_actor_role IS DISTINCT FROM 'owner' AND v_actor_role IS DISTINCT FROM 'admin' THEN
    RAISE EXCEPTION 'Only owners and admins can change the members of a company' USING ERRCODE = 'RC001';
  END IF;

  IF TG_OP = 'UPDATE' AND (NEW.id IS DISTINCT FROM OLD.id OR NEW.company_id IS DISTINCT FROM OLD.company_id
       OR NEW.user_id IS DISTINCT FROM OLD.user_id OR NEW.is_default IS DISTINCT FROM OLD.is_default
       OR NEW.created_at IS DISTINCT FROM OLD.created_at) THEN
    RAISE EXCEPTION 'Only a member''s role can be changed' USING ERRCODE = 'RC004';
  END IF;

  IF TG_OP = 'INSERT' OR (TG_OP = 'UPDATE' AND NEW.role IS DISTINCT FROM OLD.role) THEN
    IF COALESCE(NEW.role <> ALL (ARRAY['owner', 'admin', 'manager', 'viewer']::pg_catalog.text[]), true) THEN
      RAISE EXCEPTION 'Invalid role. Must be one of: owner, admin, manager, viewer' USING ERRCODE = 'RC002';
    END IF;
    IF public.company_member_role_is_owner(NEW.role) AND v_actor_role <> 'owner' THEN
      RAISE EXCEPTION 'Only an owner can grant the owner role.' USING ERRCODE = 'RC003';
    END IF;
  END IF;

  IF TG_OP = 'DELETE' AND pg_catalog.lower(OLD.user_id::pg_catalog.text) = pg_catalog.lower(auth.uid()) THEN
    RAISE EXCEPTION 'You cannot remove yourself from the company.' USING ERRCODE = 'RC006';
  END IF;

  IF v_owner_leaves THEN
    -- Counted by PERSON, under a per-company lock so two owners demoting each
    -- other at once are judged one after the other (886). An advisory lock,
    -- not FOR UPDATE on the owner rows: each UPDATE already holds its own row,
    -- so row locks taken in id order would deadlock the pair.
    PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('company_owners:' || OLD.company_id::pg_catalog.text, 0));
    -- B (908b): only an owner changes or removes an owner, judged by the role
    -- read after the lock (an owner write that demoted the actor has committed).
    IF public.company_member_actor_role(v_company) IS DISTINCT FROM 'owner' THEN
      RAISE EXCEPTION 'Only an owner can change or remove another owner.' USING ERRCODE = 'RC010';
    END IF;
    -- The last owner: never demoted, never removed.
    SELECT pg_catalog.count(DISTINCT pg_catalog.lower(cu.user_id::pg_catalog.text)) INTO v_others FROM public.company_users cu
    WHERE cu.company_id = OLD.company_id AND cu.role = 'owner'
      AND pg_catalog.lower(cu.user_id::pg_catalog.text) <> pg_catalog.lower(OLD.user_id::pg_catalog.text);
    IF v_others = 0 THEN
      RAISE EXCEPTION '%', CASE TG_OP WHEN 'DELETE' THEN 'Cannot remove the last owner of the company.'
                               ELSE 'Cannot change role: this is the last owner of the company.' END
        USING ERRCODE = 'RC005';
    END IF;
  END IF;
  -- Last, after every rule (a write a rule refuses gets the rule's code): the
  -- checks above read the snapshot, which only READ COMMITTED re-takes.
  IF NOT v_fresh THEN
    RAISE EXCEPTION 'Members and invitations are written only at READ COMMITTED (this transaction is %); retry at READ COMMITTED', v_isolation
      USING ERRCODE = '40001';
  END IF;
  RETURN CASE TG_OP WHEN 'DELETE' THEN OLD ELSE NEW END;
END
$$;

REVOKE ALL ON FUNCTION public.company_users_role_guard() FROM PUBLIC;

-- Fail the deploy rather than ship a guard without the new rules, or one the
-- trigger no longer calls.
DO $$
DECLARE
  v_src pg_catalog.text;
BEGIN
  SELECT p.prosrc INTO v_src FROM pg_catalog.pg_proc p
  WHERE p.oid = 'public.company_users_role_guard()'::pg_catalog.regprocedure AND NOT p.prosecdef;
  IF v_src IS NULL THEN
    RAISE EXCEPTION 'migration 908b: company_users_role_guard() is missing or SECURITY DEFINER';
  END IF;
  IF pg_catalog.strpos(v_src, '''RC010''') = 0 OR pg_catalog.strpos(v_src, '''RC011''') = 0 THEN
    RAISE EXCEPTION 'migration 908b: company_users_role_guard() lacks the RC010 (owner-only) or RC011 (last owner outside app_user) rule';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_trigger t
                 WHERE t.tgrelid = 'public.company_users'::pg_catalog.regclass AND t.tgname = 'company_users_role_guard'
                   AND t.tgfoid = 'public.company_users_role_guard()'::pg_catalog.regprocedure
                   AND t.tgenabled = 'O' AND t.tgtype = 31) THEN
    RAISE EXCEPTION 'migration 908b: company_users has no enabled BEFORE INSERT OR UPDATE OR DELETE row guard (apply 883 first)';
  END IF;
END $$;
