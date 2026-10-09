-- 883: R-035 N1b (C) — company_users and company_invitations enforce, in the
-- database, the role rules the app enforces.
--
-- The approval definers (872, 881) rank people by company_users.role, and
-- RLS (`cu_admin_write`) let an owner OR admin write any row of their company
-- with any role string: an admin could `UPDATE company_users SET role =
-- 'owner'` on themselves by raw SQL, or forge an `owner` invitation and accept
-- it. The app refuses both (pentest H5). These BEFORE triggers make the
-- database refuse them too, judging the two roles the app and the admin
-- portal connect as, by `current_user` at the time of the write:
--
--  app_user (withAuth requests; the actor is auth.uid()) — exactly the app's
--  rules (census in PR C):
--   company_users   the actor is an owner or admin of the company;
--                   a role in [owner, admin, manager, viewer] (VALID_ROLES);
--                   only an owner grants `owner`; the last owner is never
--                   demoted or removed; nobody removes themselves; only
--                   `role` ever changes (a membership is never moved to
--                   another user or company — that would hand over a role).
--   company_invitations  the actor is an owner or admin of the company;
--                   a role in [owner, admin, manager, viewer, storeman,
--                   technician] (both invitation routes' lists); only an
--                   owner creates, upgrades, re-points or re-opens an `owner`
--                   invitation (Hein, 2026-10-09: the app route now refuses
--                   an admin's owner invite too); the inviter recorded is the
--                   actor; the company never changes.
--  platform_admin (the admin portal) — the portal's rules: a membership role
--   in ALLOWED_COMPANY_ROLES [admin, accountant, bookkeeper, viewer] (never
--   `owner`), removals as before; no invitation writes (the portal makes none).
--
-- Every other role is NOT judged: the table owners and whoever inherits them
-- (migrations, the deploy/login role on production), superusers, the
-- SECURITY DEFINER functions that write as their owner (create_company_with_owner
-- grants the creator `owner`; set_default_company), the two invite-accept
-- routes (/api/invitations/[token]/accept on the migration_admin pool,
-- /api/invite/[token] on the login role; both grant the invitation's role,
-- which was judged when the invitation was written or last re-shaped), tenant
-- provisioning (migration_admin pool) and the seed scripts. Those
-- write without a user JWT, and raw SQL that can RESET ROLE to them is the N1
-- boundary (N3). Any OTHER role that holds a write privilege on either table
-- loses it here (enumerated from the ACL) and the migration asserts none does.
--
-- Unchanged on purpose (the app allows them today; §8): an admin changing
-- their own role below owner, and an admin demoting or removing a non-last
-- owner. The last-owner count is taken under a per-company lock and by
-- person (stricter than the app's unlocked row count only in a race or for a
-- duplicate row of one user). The admin portal (platform_admin) has no
-- last-owner rule today, and keeps none here (it takes the lock, so an app
-- demotion racing it is still judged after it). LIMIT: a transaction that
-- demotes two owners while another demotes them in the other order can
-- deadlock (40P01) — the row lock is taken before the trigger; no app path
-- edits two members in one transaction.
--
-- Precondition (section 0): owner invitations an admin sent or rewrote
-- BEFORE this migration — the route and RLS allowed it until now — would
-- stay live, their token the admin's, and `invited_by` cannot tell them
-- apart (it was writable too). 883 refuses to apply while ANY unaccepted,
-- unexpired owner invitation exists: cancel them first, and an owner
-- re-issues them afterwards (the query is in the R-035 N1b handoff).
--
-- Refusals (SQLSTATE): RC001 not an owner/admin of the company · RC002 role
-- outside the allow-list · RC003 only an owner grants owner · RC004 a column
-- other than role changed, or the company/user moved · RC005 last owner ·
-- RC006 removing yourself · RC007 the portal may not grant this role ·
-- RC008 the portal writes no invitations · RC009 inviter is not the actor.

-- ── 0. Precondition: no live owner invitation a non-owner sent ────────────
DO $$
DECLARE
  v_n pg_catalog.int8;
BEGIN
  -- Every live one, whoever it names as sender: before 883 an admin could
  -- write any `invited_by` by raw SQL, so the column proves nothing.
  SELECT pg_catalog.count(*) INTO v_n FROM public.company_invitations ci
  WHERE ci.role = 'owner' AND ci.accepted_at IS NULL AND ci.expires_at > pg_catalog.now();
  IF v_n > 0 THEN
    RAISE EXCEPTION 'migration 883: % pending owner invitation(s) exist and may have been sent or rewritten by a non-owner — cancel them before applying; an owner re-issues them afterwards', v_n;
  END IF;
END $$;

-- ── 1. The guards ─────────────────────────────────────────────────────────
-- SECURITY INVOKER on purpose: `current_user` must be the role that wrote.
-- Its reads run as that role: app_user sees its own membership (cu_select)
-- and, as an owner or admin, every member of the company.

CREATE OR REPLACE FUNCTION public.company_member_actor_role(p_company_id pg_catalog.uuid)
RETURNS pg_catalog.text
LANGUAGE sql STABLE
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT cu.role::pg_catalog.text FROM public.company_users cu
  WHERE cu.company_id = p_company_id AND cu.user_id = auth.uid()
$$;

CREATE OR REPLACE FUNCTION public.company_users_role_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_company pg_catalog.uuid := CASE TG_OP WHEN 'DELETE' THEN OLD.company_id ELSE NEW.company_id END;
  v_actor_role pg_catalog.text;
  v_others pg_catalog.int8;
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
  IF current_user <> 'app_user' THEN
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
    IF NEW.role = 'owner' AND v_actor_role <> 'owner' THEN
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
  -- so row locks taken in id order would deadlock the pair.
  IF OLD.role = 'owner' AND (TG_OP = 'DELETE' OR NEW.role IS DISTINCT FROM 'owner') THEN
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
BEGIN
  IF current_user = 'platform_admin' THEN
    RAISE EXCEPTION 'The admin portal does not write invitations' USING ERRCODE = 'RC008';
  END IF;
  IF current_user <> 'app_user' THEN
    RETURN CASE TG_OP WHEN 'DELETE' THEN OLD ELSE NEW END;
  END IF;

  v_actor_role := public.company_member_actor_role(v_company);
  IF v_actor_role IS DISTINCT FROM 'owner' AND v_actor_role IS DISTINCT FROM 'admin' THEN
    RAISE EXCEPTION 'Only owners and admins can invite users.' USING ERRCODE = 'RC001';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;

  IF TG_OP = 'UPDATE' AND NEW.company_id IS DISTINCT FROM OLD.company_id THEN
    RAISE EXCEPTION 'An invitation cannot be moved to another company' USING ERRCODE = 'RC004';
  END IF;
  IF TG_OP = 'INSERT' OR NEW.role IS DISTINCT FROM OLD.role THEN
    IF COALESCE(NEW.role <> ALL (ARRAY['owner', 'admin', 'manager', 'viewer', 'storeman', 'technician']::pg_catalog.text[]), true) THEN
      RAISE EXCEPTION 'Invalid role. Must be one of: owner, admin, manager, viewer, storeman, technician' USING ERRCODE = 'RC002';
    END IF;
    IF NEW.role = 'owner' AND v_actor_role <> 'owner' THEN
      RAISE EXCEPTION 'Only an owner can grant the owner role.' USING ERRCODE = 'RC003';
    END IF;
  END IF;
  -- A live owner invitation is an owner's to shape. Re-pointing one that stays
  -- `owner` — its email, token or GoTrue user — or re-opening it (accepted_at,
  -- expires_at) is how a non-owner would take it over and accept it as owner
  -- (blind H1 / adversarial REPRO 1–2 on PR #691), so it takes an owner. The
  -- send-status columns stay writable; turning it into a lesser invitation
  -- (a re-invite at another role) does not need an owner.
  IF TG_OP = 'UPDATE' AND NEW.role = 'owner' AND v_actor_role <> 'owner'
     AND (NEW.email, NEW.token, NEW.gotrue_user_id, NEW.accepted_at, NEW.expires_at, NEW.invited_by)
         IS DISTINCT FROM (OLD.email, OLD.token, OLD.gotrue_user_id, OLD.accepted_at, OLD.expires_at, OLD.invited_by) THEN
    RAISE EXCEPTION 'Only an owner can grant the owner role.' USING ERRCODE = 'RC003';
  END IF;
  IF (TG_OP = 'INSERT' OR NEW.invited_by IS DISTINCT FROM OLD.invited_by)
     AND pg_catalog.lower(NEW.invited_by::pg_catalog.text) IS DISTINCT FROM pg_catalog.lower(auth.uid()) THEN
    RAISE EXCEPTION 'An invitation records the person who sent it' USING ERRCODE = 'RC009';
  END IF;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS company_users_role_guard ON public.company_users;
CREATE TRIGGER company_users_role_guard
  BEFORE INSERT OR UPDATE OR DELETE ON public.company_users
  FOR EACH ROW EXECUTE FUNCTION public.company_users_role_guard();

DROP TRIGGER IF EXISTS company_invitations_role_guard ON public.company_invitations;
CREATE TRIGGER company_invitations_role_guard
  BEFORE INSERT OR UPDATE OR DELETE ON public.company_invitations
  FOR EACH ROW EXECUTE FUNCTION public.company_invitations_role_guard();

-- The guards are called by the trigger mechanism, never directly; the helper
-- runs as whoever writes (app_user, platform_admin) and reads only what RLS
-- shows that role.
REVOKE ALL ON FUNCTION public.company_users_role_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.company_invitations_role_guard() FROM PUBLIC;

-- ── 2. TRUNCATE skips row triggers: nobody but the owners may. And no other
-- role may write either table at all (the guards judge only app_user and
-- platform_admin): revoke every other non-owner write grant, from the ACL.
DO $$
DECLARE
  v_table pg_catalog.text;
  v_grantee pg_catalog.text;
  v_col pg_catalog.text;
BEGIN
  FOREACH v_table IN ARRAY ARRAY['company_users', 'company_invitations'] LOOP
    FOR v_grantee IN
      SELECT DISTINCT CASE a.grantee WHEN 0 THEN 'PUBLIC' ELSE pg_catalog.quote_ident(r.rolname) END
      FROM pg_catalog.pg_class c, pg_catalog.aclexplode(c.relacl) a
      LEFT JOIN pg_catalog.pg_roles r ON r.oid = a.grantee
      WHERE c.oid = ('public.' || v_table)::pg_catalog.regclass AND a.grantee <> c.relowner
        AND a.privilege_type IN ('TRUNCATE', 'TRIGGER')
    LOOP
      EXECUTE pg_catalog.format('REVOKE TRUNCATE, TRIGGER ON public.%I FROM %s CASCADE', v_table, v_grantee);
    END LOOP;
    FOR v_grantee IN
      SELECT DISTINCT CASE a.grantee WHEN 0 THEN 'PUBLIC' ELSE pg_catalog.quote_ident(r.rolname) END
      FROM pg_catalog.pg_class c, pg_catalog.aclexplode(c.relacl) a
      LEFT JOIN pg_catalog.pg_roles r ON r.oid = a.grantee
      WHERE c.oid = ('public.' || v_table)::pg_catalog.regclass AND a.grantee <> c.relowner
        AND a.privilege_type IN ('INSERT', 'UPDATE', 'DELETE')
        AND (a.grantee = 0 OR r.rolname NOT IN ('app_user', 'platform_admin', 'migration_admin'))
    LOOP
      EXECUTE pg_catalog.format('REVOKE INSERT, UPDATE, DELETE ON public.%I FROM %s CASCADE', v_table, v_grantee);
    END LOOP;
    FOR v_grantee, v_col IN
      SELECT DISTINCT CASE a.grantee WHEN 0 THEN 'PUBLIC' ELSE pg_catalog.quote_ident(r.rolname) END,
             pg_catalog.quote_ident(att.attname)
      FROM pg_catalog.pg_attribute att, pg_catalog.aclexplode(att.attacl) a
      LEFT JOIN pg_catalog.pg_roles r ON r.oid = a.grantee
      WHERE att.attrelid = ('public.' || v_table)::pg_catalog.regclass AND att.attacl IS NOT NULL
        AND a.privilege_type IN ('INSERT', 'UPDATE')
        AND (a.grantee = 0 OR r.rolname NOT IN ('app_user', 'platform_admin', 'migration_admin'))
    LOOP
      EXECUTE pg_catalog.format('REVOKE INSERT (%s), UPDATE (%s) ON public.%I FROM %s CASCADE', v_col, v_col, v_table, v_grantee);
    END LOOP;
  END LOOP;
END $$;

-- ── 3. Assertions ─────────────────────────────────────────────────────────
-- Exemptions as 872/#680: superusers, the owner, and the role RUNNING this
-- migration when it inherits the owner. app_user and platform_admin may write
-- (the guards judge them); migration_admin may (it owns the tables on
-- production, and is the invite-accept and provisioning pools' role
-- elsewhere). Nobody else.
DO $$
DECLARE
  v_table pg_catalog.text;
  v_owner pg_catalog.oid;
  v_role pg_catalog.text;
  v_priv pg_catalog.text;
BEGIN
  FOREACH v_table IN ARRAY ARRAY['company_users', 'company_invitations'] LOOP
    v_owner := (SELECT c.relowner FROM pg_catalog.pg_class c WHERE c.oid = ('public.' || v_table)::pg_catalog.regclass);
    IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_trigger t
                   WHERE t.tgrelid = ('public.' || v_table)::pg_catalog.regclass AND t.tgname = v_table || '_role_guard'
                     AND t.tgenabled = 'O' AND t.tgtype = 31) THEN
      RAISE EXCEPTION 'migration 883: % has no enabled BEFORE INSERT OR UPDATE OR DELETE row guard', v_table;
    END IF;
    FOR v_role IN
      SELECT r.rolname FROM pg_catalog.pg_roles r
      WHERE NOT r.rolsuper AND r.oid <> v_owner AND r.rolname !~ '^pg_'
        AND NOT (r.rolname = session_user AND pg_catalog.pg_has_role(r.oid, v_owner, 'USAGE'))
      UNION ALL SELECT 'public'
    LOOP
      FOREACH v_priv IN ARRAY ARRAY['TRUNCATE', 'TRIGGER'] LOOP
        IF v_role <> 'migration_admin' AND pg_catalog.has_table_privilege(v_role, 'public.' || v_table, v_priv) THEN
          RAISE EXCEPTION 'migration 883: % still holds % on %', v_role, v_priv, v_table;
        END IF;
      END LOOP;
      CONTINUE WHEN v_role IN ('app_user', 'platform_admin', 'migration_admin');
      FOREACH v_priv IN ARRAY ARRAY['INSERT', 'UPDATE', 'DELETE'] LOOP
        IF pg_catalog.has_table_privilege(v_role, 'public.' || v_table, v_priv)
           OR (v_priv <> 'DELETE' AND pg_catalog.has_any_column_privilege(v_role, 'public.' || v_table, v_priv)) THEN
          RAISE EXCEPTION 'migration 883: % still holds % on %', v_role, v_priv, v_table;
        END IF;
      END LOOP;
    END LOOP;
  END LOOP;
END $$;
