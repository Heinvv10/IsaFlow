-- Migration 911: the member guards bind app_service as they bind app_user.
--
-- Audit 2026-10-18 S-07b, after 910. company_users_role_guard and
-- company_invitations_role_guard (883, 886) apply their rules only when
-- current_user = 'app_user' and let every other role through. 910's
-- isaflow_service pool runs as itself (inheriting app_service, which inherits
-- app_user), so it was let through: with no claims at all it could add a
-- super_admin member, move a membership, remove a company's last owner, or
-- write an invitation at any role (S-07b breaker, F1), none of which
-- app_user can do even with forged claims. The functions below are 886's,
-- byte for byte, except that exemption line.
--
-- The one service-pool path that wrote either table, POST /api/invite/[token],
-- now writes on the migration_admin pool, as /api/invitations/[token]/accept
-- already did.
--
-- Also: app_user (and so both app pools) held INSERT/UPDATE/DELETE on
-- schema_migrations, through 348's default privileges. A deleted row
-- re-applies a migration on the next deploy; an inserted one skips it.
-- Nothing in the app writes it; the deploy's migration runner runs as the
-- owner. Revoked (S-07b breaker, F3).

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
BEGIN
  IF current_user = 'platform_admin' THEN
    -- The portal keeps its power to demote or remove an owner (no last-owner
    -- rule there today), but takes the same per-company lock app_user's
    -- last-owner check takes: a portal demotion and an app demotion of the
    -- other owner are then judged one after the other, and the app's is
    -- refused rather than both passing (adversarial review of PR #691, F2).
    IF TG_OP <> 'INSERT' AND OLD.role = 'owner' AND (TG_OP = 'DELETE' OR NEW.role IS DISTINCT FROM 'owner') THEN
      PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('company_owners:' || OLD.company_id::pg_catalog.text, 0));
    END IF;
    IF TG_OP = 'UPDATE' AND (NEW.company_id IS DISTINCT FROM OLD.company_id OR NEW.user_id IS DISTINCT FROM OLD.user_id) THEN
      RAISE EXCEPTION 'A company membership cannot be moved to another company or user' USING ERRCODE = 'RC004';
    END IF;
    IF TG_OP <> 'DELETE' AND (TG_OP = 'INSERT' OR NEW.role IS DISTINCT FROM OLD.role)
       AND COALESCE(NEW.role <> ALL (ARRAY['admin', 'accountant', 'bookkeeper', 'viewer']::pg_catalog.text[]), true) THEN
      RAISE EXCEPTION 'The admin portal may only grant the admin, accountant, bookkeeper or viewer role (got %)', NEW.role
        USING ERRCODE = 'RC007';
    END IF;
    RETURN CASE TG_OP WHEN 'DELETE' THEN OLD ELSE NEW END;
  END IF;
  -- app_service (S-07b, 910) holds app_user's privileges and policies, so a
  -- role holding it takes app_user's rules too. pg_has_role is true for every
  -- superuser, so the roles that bypass RLS (the owners, migration_admin, the
  -- deploy role, superusers) are still let through, as before.
  IF current_user <> 'app_user'
     AND NOT (pg_catalog.pg_has_role(current_user, 'app_service', 'USAGE')
              AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles r
                              WHERE r.rolname = current_user AND (r.rolsuper OR r.rolbypassrls))) THEN
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

  -- The last owner: never demoted, never removed. Counted by PERSON, not by
  -- row (a second row for the same user in another case is still that user),
  -- under a per-company lock so two owners demoting each other at once are
  -- judged one after the other — the second sees the first's demotion and is
  -- refused (adversarial review of PR #691, REPRO 3 and 4). An advisory lock,
  -- not FOR UPDATE on the owner rows: each UPDATE already holds its own row,
  -- so row locks taken in id order would deadlock the pair. The second sees
  -- the first only at READ COMMITTED, so any other level is refused below.
  IF public.company_member_role_is_owner(OLD.role)
     AND (TG_OP = 'DELETE' OR public.company_member_role_is_owner(NEW.role) IS NOT TRUE) THEN
    PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('company_owners:' || OLD.company_id::pg_catalog.text, 0));
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

CREATE OR REPLACE FUNCTION public.company_invitations_role_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_company pg_catalog.uuid := CASE TG_OP WHEN 'DELETE' THEN OLD.company_id ELSE NEW.company_id END;
  v_actor_role pg_catalog.text;
  v_isolation pg_catalog.text := pg_catalog.current_setting('transaction_isolation');
  v_fresh pg_catalog.bool := v_isolation IN ('read committed', 'read uncommitted');
BEGIN
  IF current_user = 'platform_admin' THEN
    RAISE EXCEPTION 'The admin portal does not write invitations' USING ERRCODE = 'RC008';
  END IF;
  -- app_service (S-07b, 910) holds app_user's privileges and policies, so a
  -- role holding it takes app_user's rules too. pg_has_role is true for every
  -- superuser, so the roles that bypass RLS (the owners, migration_admin, the
  -- deploy role, superusers) are still let through, as before.
  IF current_user <> 'app_user'
     AND NOT (pg_catalog.pg_has_role(current_user, 'app_service', 'USAGE')
              AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles r
                              WHERE r.rolname = current_user AND (r.rolsuper OR r.rolbypassrls))) THEN
    RETURN CASE TG_OP WHEN 'DELETE' THEN OLD ELSE NEW END;
  END IF;

  v_actor_role := public.company_member_actor_role(v_company);
  IF v_actor_role IS DISTINCT FROM 'owner' AND v_actor_role IS DISTINCT FROM 'admin' THEN
    RAISE EXCEPTION 'Only owners and admins can invite users.' USING ERRCODE = 'RC001';
  END IF;
  IF TG_OP = 'DELETE' THEN
    IF NOT v_fresh THEN
      RAISE EXCEPTION 'Members and invitations are written only at READ COMMITTED (this transaction is %); retry at READ COMMITTED', v_isolation
        USING ERRCODE = '40001';
    END IF;
    RETURN OLD;
  END IF;

  IF TG_OP = 'UPDATE' AND NEW.company_id IS DISTINCT FROM OLD.company_id THEN
    RAISE EXCEPTION 'An invitation cannot be moved to another company' USING ERRCODE = 'RC004';
  END IF;
  IF TG_OP = 'INSERT' OR NEW.role IS DISTINCT FROM OLD.role THEN
    IF COALESCE(NEW.role <> ALL (ARRAY['owner', 'admin', 'manager', 'viewer', 'storeman', 'technician']::pg_catalog.text[]), true) THEN
      RAISE EXCEPTION 'Invalid role. Must be one of: owner, admin, manager, viewer, storeman, technician' USING ERRCODE = 'RC002';
    END IF;
    IF public.company_member_role_is_owner(NEW.role) AND v_actor_role <> 'owner' THEN
      RAISE EXCEPTION 'Only an owner can grant the owner role.' USING ERRCODE = 'RC003';
    END IF;
  END IF;
  -- A live owner invitation is an owner's to shape. Re-pointing one that stays
  -- `owner` — its email, token or GoTrue user — or re-opening it (accepted_at,
  -- expires_at) is how a non-owner would take it over and accept it as owner
  -- (blind H1 / adversarial REPRO 1–2 on PR #691), so it takes an owner. The
  -- send-status columns stay writable; turning it into a lesser invitation
  -- (a re-invite at another role) does not need an owner. `Owner ` is an owner
  -- invitation too: the accept routes copy the role verbatim (886).
  IF TG_OP = 'UPDATE' AND public.company_member_role_is_owner(NEW.role) AND v_actor_role <> 'owner'
     AND (NEW.email, NEW.token, NEW.gotrue_user_id, NEW.accepted_at, NEW.expires_at, NEW.invited_by)
         IS DISTINCT FROM (OLD.email, OLD.token, OLD.gotrue_user_id, OLD.accepted_at, OLD.expires_at, OLD.invited_by) THEN
    RAISE EXCEPTION 'Only an owner can grant the owner role.' USING ERRCODE = 'RC003';
  END IF;
  IF (TG_OP = 'INSERT' OR NEW.invited_by IS DISTINCT FROM OLD.invited_by)
     AND pg_catalog.lower(NEW.invited_by::pg_catalog.text) IS DISTINCT FROM pg_catalog.lower(auth.uid()) THEN
    RAISE EXCEPTION 'An invitation records the person who sent it' USING ERRCODE = 'RC009';
  END IF;
  -- Last, after every rule, as in company_users_role_guard().
  IF NOT v_fresh THEN
    RAISE EXCEPTION 'Members and invitations are written only at READ COMMITTED (this transaction is %); retry at READ COMMITTED', v_isolation
      USING ERRCODE = '40001';
  END IF;
  RETURN NEW;
END
$$;

REVOKE ALL ON FUNCTION public.company_users_role_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.company_invitations_role_guard() FROM PUBLIC;

REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.schema_migrations FROM app_user, PUBLIC;

-- Refuse the migration if any function in this database still exempts every
-- role but app_user, the shape that let isaflow_service through, or if a role
-- either app pool can reach may still write schema_migrations.
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN SELECT p.oid::regprocedure AS f FROM pg_catalog.pg_proc p
            WHERE p.prosrc ~* $re$current_user\s*<>\s*'app_user'\s*then$re$ LOOP
    RAISE EXCEPTION '911: % exempts every role but app_user; app_service must take the same rules', r.f;
  END LOOP;
  FOR r IN SELECT rolname FROM pg_catalog.pg_roles
            WHERE pg_catalog.pg_has_role('isaflow_app', oid, 'MEMBER')
               OR pg_catalog.pg_has_role('isaflow_service', oid, 'MEMBER') LOOP
    IF pg_catalog.has_table_privilege(r.rolname, 'public.schema_migrations', 'INSERT, UPDATE, DELETE, TRUNCATE') THEN
      RAISE EXCEPTION '911: % (reachable from an app pool) can still write schema_migrations', r.rolname;
    END IF;
  END LOOP;
END $$;
