-- 886: R-035 N1b (C) — 883's member and invitation guards, tightened after the
-- adversarial review of PR #691, round 5. Same two functions, same triggers,
-- same grants (883 owns those); two changes in the rules they apply to
-- app_user:
--
--  1. Only at READ COMMITTED. 883 judges the last owner under a per-company
--   advisory lock, and the next writer re-reads the members after waiting for
--   it — which only a READ COMMITTED statement does. A REPEATABLE READ or
--   SERIALIZABLE transaction re-reads nothing: its snapshot is the one it
--   began with. Two REPEATABLE READ sessions each demoting one of two owners
--   both saw the other owner still there and both passed (0 owners), and an
--   owner demoted after another session's snapshot was taken could still
--   grant `owner` from it. SERIALIZABLE does not save it: SSI only sees
--   conflicts between two SERIALIZABLE transactions, and the app writes at
--   READ COMMITTED, so a SERIALIZABLE demotion after an app one commits still
--   judges from the stale snapshot. So the rule is an allow-list, failing
--   closed: every app_user write that grants `owner`, demotes or removes an
--   owner, or creates or re-shapes an owner invitation is refused with 40001
--   (serialization_failure — retry at READ COMMITTED, the app's level; no app
--   route writes these tables at any other) unless `transaction_isolation` is
--   'read committed' or 'read uncommitted' (Postgres runs the latter as READ
--   COMMITTED: a fresh snapshot per statement). The refusal follows the rule
--   checks, so a write those refuse still gets their code. The admin portal
--   (platform_admin) is not refused: it judges nothing from its snapshot (no
--   last-owner rule, it never grants owner) and only takes the lock for
--   app_user's sake. (Security review of round 5: the first cut refused only
--   'repeatable read', which let SERIALIZABLE through.)
--
--  2. Owner-ness compared trimmed and lower-cased. 883 asked `role = 'owner'`
--   to decide whether a row or invitation IS an owner's, so a legacy
--   invitation stored as `Owner ` (before the allow-list) was not one: an
--   admin could re-open it (expires_at, accepted_at, token — role unchanged,
--   so the allow-list never ran) and the accept routes copy the role verbatim.
--   Now `lower(btrim(role)) = 'owner'` decides it, for NEW and OLD alike: such
--   an invitation is an owner's to re-shape (RC003 otherwise), and such a
--   membership is an owner's for the last-owner rule (its demotion or removal
--   takes the lock and the count). What a write may SET stays exact — the
--   INSERT/role-change allow-lists still admit only canonical values — and so
--   does the count of the OTHER owners: a legacy `Owner ` row protects itself
--   but is not counted as the owner left behind (fails closed both ways). The
--   portal's lock stays on canonical owners: that count is all it guards.
--
-- The route half of round 5 (an admin re-inviting the last owner's own address
-- at `viewer`, which the accept routes' ON CONFLICT DO UPDATE then applied) is
-- fixed in the routes: an acceptance never overwrites an owner's role.
--
-- Refusal codes as 883 (RC001–RC009), plus 40001 above.

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
    IF pg_catalog.lower(pg_catalog.btrim(NEW.role)) = 'owner' THEN
      IF v_actor_role <> 'owner' THEN
        RAISE EXCEPTION 'Only an owner can grant the owner role.' USING ERRCODE = 'RC003';
      END IF;
      -- The actor's own role was read from this transaction's snapshot.
      IF NOT v_fresh THEN
        RAISE EXCEPTION 'Granting the owner role needs READ COMMITTED (this transaction is %); retry at READ COMMITTED', v_isolation
          USING ERRCODE = '40001';
      END IF;
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
  -- the first only at READ COMMITTED, so any other level is refused (886).
  IF pg_catalog.lower(pg_catalog.btrim(OLD.role)) = 'owner'
     AND (TG_OP = 'DELETE' OR pg_catalog.lower(pg_catalog.btrim(NEW.role)) IS DISTINCT FROM 'owner') THEN
    IF NOT v_fresh THEN
      RAISE EXCEPTION 'Demoting or removing an owner needs READ COMMITTED (this transaction is %); retry at READ COMMITTED', v_isolation
        USING ERRCODE = '40001';
    END IF;
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
  v_isolation pg_catalog.text := pg_catalog.current_setting('transaction_isolation');
  v_fresh pg_catalog.bool := v_isolation IN ('read committed', 'read uncommitted');
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
    IF pg_catalog.lower(pg_catalog.btrim(NEW.role)) = 'owner' THEN
      IF v_actor_role <> 'owner' THEN
        RAISE EXCEPTION 'Only an owner can grant the owner role.' USING ERRCODE = 'RC003';
      END IF;
      IF NOT v_fresh THEN
        RAISE EXCEPTION 'Writing an owner invitation needs READ COMMITTED (this transaction is %); retry at READ COMMITTED', v_isolation
          USING ERRCODE = '40001';
      END IF;
    END IF;
  END IF;
  -- A live owner invitation is an owner's to shape. Re-pointing one that stays
  -- `owner` — its email, token or GoTrue user — or re-opening it (accepted_at,
  -- expires_at) is how a non-owner would take it over and accept it as owner
  -- (blind H1 / adversarial REPRO 1–2 on PR #691), so it takes an owner. The
  -- send-status columns stay writable; turning it into a lesser invitation
  -- (a re-invite at another role) does not need an owner. `Owner ` is an owner
  -- invitation too: the accept routes copy the role verbatim (886).
  IF TG_OP = 'UPDATE' AND pg_catalog.lower(pg_catalog.btrim(NEW.role)) = 'owner'
     AND (NEW.email, NEW.token, NEW.gotrue_user_id, NEW.accepted_at, NEW.expires_at, NEW.invited_by)
         IS DISTINCT FROM (OLD.email, OLD.token, OLD.gotrue_user_id, OLD.accepted_at, OLD.expires_at, OLD.invited_by) THEN
    IF v_actor_role <> 'owner' THEN
      RAISE EXCEPTION 'Only an owner can grant the owner role.' USING ERRCODE = 'RC003';
    END IF;
    IF NOT v_fresh THEN
      RAISE EXCEPTION 'Writing an owner invitation needs READ COMMITTED (this transaction is %); retry at READ COMMITTED', v_isolation
        USING ERRCODE = '40001';
    END IF;
  END IF;
  IF (TG_OP = 'INSERT' OR NEW.invited_by IS DISTINCT FROM OLD.invited_by)
     AND pg_catalog.lower(NEW.invited_by::pg_catalog.text) IS DISTINCT FROM pg_catalog.lower(auth.uid()) THEN
    RAISE EXCEPTION 'An invitation records the person who sent it' USING ERRCODE = 'RC009';
  END IF;
  RETURN NEW;
END
$$;

REVOKE ALL ON FUNCTION public.company_users_role_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.company_invitations_role_guard() FROM PUBLIC;

-- The triggers 883 created still call these, enabled, on every row write.
DO $$
DECLARE
  v_table pg_catalog.text;
BEGIN
  FOREACH v_table IN ARRAY ARRAY['company_users', 'company_invitations'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_trigger t
                   WHERE t.tgrelid = ('public.' || v_table)::pg_catalog.regclass AND t.tgname = v_table || '_role_guard'
                     AND t.tgfoid = ('public.' || v_table || '_role_guard()')::pg_catalog.regprocedure
                     AND t.tgenabled = 'O' AND t.tgtype = 31) THEN
      RAISE EXCEPTION 'migration 886: % has no enabled BEFORE INSERT OR UPDATE OR DELETE row guard (apply 883 first)', v_table;
    END IF;
    IF EXISTS (SELECT 1 FROM pg_catalog.pg_proc p
               WHERE p.oid = ('public.' || v_table || '_role_guard()')::pg_catalog.regprocedure AND p.prosecdef) THEN
      RAISE EXCEPTION 'migration 886: %_role_guard() must be SECURITY INVOKER', v_table;
    END IF;
  END LOOP;
END $$;
