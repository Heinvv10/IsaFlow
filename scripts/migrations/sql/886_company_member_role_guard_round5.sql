-- 886: R-035 N1b (C) — 883's member and invitation guards, tightened after the
-- adversarial review of PR #691, round 5, and the reviews of PR #693. Same
-- two guards, same triggers, same grants (883 owns those); three changes:
--
--  1. Owner-ness has one definition: public.company_member_role_is_owner(role)
--   — lower-cased, with every whitespace character removed. 883 asked
--   `role = 'owner'`, so a legacy invitation stored as `Owner ` (before the
--   allow-lists) was not an owner's: an admin could re-open it (role
--   unchanged, so the allow-list never ran) and the accept routes copy the
--   role verbatim. The guards decide with it whether a row or invitation IS
--   an owner's (NEW and OLD), and both invite-accept routes with it whether
--   an acceptance may overwrite a member's role (never an owner's). Whitespace
--   is an explicit class, not `\s`: what `\s` matches depends on the
--   collation (under "C" only ASCII; under en_US.utf8 not U+00A0, U+2007,
--   U+202F, U+200B or U+FEFF), and this must not; the whole test runs under
--   COLLATE "C", so lower() cannot depend on it either.
--
--  2. Precondition (section 0): no company_users or company_invitations row
--   may hold an owner-ish role that is not exactly 'owner' — 886 refuses to
--   apply, naming them; correct each by hand. It locks company_users, then
--   company_invitations — an invite acceptance's order, so a deploy waits for
--   one instead of deadlocking with it; no app route or service (pages/,
--   src/) writes invitations, then members. A company DELETE does — its FK
--   cascade reaches company_invitations before company_users — and can
--   deadlock with it: one side is cancelled (40P01) and, if it is the deploy,
--   the migration aborts with nothing applied and is re-run. Its callers are
--   scripts (qa-cleanup-run, large-scale-seed, stress-test) and test cleanups,
--   none in the app. Scripts, seeds and definer functions are outside the
--   claim (adversarial review of #693, round 3). After it, and with every
--   judged writer held to the exact allow-lists (the invitations the accept
--   routes copy from included), no such row exists, which is why what stays
--   exact is safe: the allow-lists, the count of the OTHER owners in the
--   last-owner rule, and the portal's lock condition (blind review of #693,
--   LOW 1–3).
--   Writers the guards do not judge are the N1 boundary, as in 883.
--
--  3. Only at READ COMMITTED. 883 judges under a per-company advisory lock,
--   and the next writer re-reads after waiting for it — which only a READ
--   COMMITTED statement does. At REPEATABLE READ or SERIALIZABLE every check
--   reads the snapshot the transaction began with: two sessions each demoting
--   one of two owners left none; an owner demoted after the snapshot still
--   granted owner; an admin removed after it still promoted an accomplice and
--   sent invitations (adversarial #693 REPRO 1). SSI does not help: it only
--   sees conflicts between two SERIALIZABLE transactions, and the app writes
--   at READ COMMITTED. So EVERY app_user write is refused with 40001
--   (serialization_failure — retry at READ COMMITTED, the app's level; no app
--   route writes these tables at any other) unless `transaction_isolation` is
--   'read committed' or 'read uncommitted' (Postgres runs the latter as READ
--   COMMITTED). The refusal comes after every rule check, so a write a rule
--   refuses still gets its code (RC001–RC009; #693 REPRO 2). The admin
--   portal (platform_admin) is not refused: it judges nothing from its
--   snapshot (no last-owner rule, never owner) and takes the lock only for
--   app_user's sake.
--
-- The route half of round 5 (an admin re-inviting the last owner's own address
-- at `viewer`, which the accept routes' ON CONFLICT DO UPDATE then applied) is
-- fixed in the routes.
--
-- Refusal codes as 883 (RC001–RC009), plus 40001 above.

-- ── 0. The owner predicate; precondition: no owner-ish role but 'owner' ─────
CREATE OR REPLACE FUNCTION public.company_member_role_is_owner(p_role pg_catalog.text)
RETURNS pg_catalog.bool
LANGUAGE sql IMMUTABLE
SET search_path = pg_catalog, public, pg_temp
AS $$
  -- COLLATE "C": neither [[:space:]] nor lower() may depend on the database's
  -- collation, so IMMUTABLE is true (blind review of #693, round 2). Under "C"
  -- [[:space:]] is ASCII only; the rest of the class is listed.
  SELECT pg_catalog.lower(pg_catalog.regexp_replace(p_role COLLATE pg_catalog."C",
    '[[:space:]\u0085\u00a0\u1680\u180e\u2000-\u200b\u2028\u2029\u202f\u205f\u2060\u3000\ufeff]', '', 'g')) = 'owner'
$$;

DO $$
DECLARE
  v_n pg_catalog.int8;
  v_ids pg_catalog.text;
BEGIN
  -- No write between this count and the guards below. Members first, then
  -- invitations: the order an invite acceptance writes them (INSERT into
  -- company_users, then UPDATE company_invitations), so a deploy waits for an
  -- acceptance in flight instead of deadlocking with it (883's order was the
  -- reverse; blind review of #693, round 2). No app route or service writes
  -- invitations, then members. A company DELETE does (its cascade reaches
  -- company_invitations first; callers are scripts and test cleanups, none in
  -- the app): it can deadlock with this, one side is cancelled, and a
  -- cancelled deploy aborts with nothing applied and is re-run. Scripts, seeds
  -- and definer functions are outside the claim.
  LOCK TABLE public.company_users IN SHARE ROW EXCLUSIVE MODE;
  LOCK TABLE public.company_invitations IN SHARE ROW EXCLUSIVE MODE;
  -- FORCE RLS applies to the owner: unless this role bypasses it, the count
  -- would see no rows and pass. With row_security off it raises instead.
  PERFORM pg_catalog.set_config('row_security', 'off', true);
  -- Counted and the first ten (by table and id) named in one read, so the
  -- refusal stays readable in a deploy log.
  SELECT pg_catalog.count(*),
         pg_catalog.string_agg(y.tbl || ' ' || y.id::pg_catalog.text || ' (company ' || y.company_id::pg_catalog.text || ')',
                               ', ' ORDER BY y.tbl, y.id) FILTER (WHERE y.rn <= 10)
  INTO v_n, v_ids
  FROM (SELECT x.*, pg_catalog.row_number() OVER (ORDER BY x.tbl, x.id) AS rn FROM (
          SELECT 'company_users'::pg_catalog.text AS tbl, cu.id, cu.company_id FROM public.company_users cu
          WHERE public.company_member_role_is_owner(cu.role) AND cu.role <> 'owner'
          UNION ALL
          SELECT 'company_invitations', ci.id, ci.company_id FROM public.company_invitations ci
          WHERE public.company_member_role_is_owner(ci.role) AND ci.role <> 'owner') x) y;
  PERFORM pg_catalog.set_config('row_security', 'on', true);
  IF v_n > 10 THEN
    v_ids := v_ids || ' (+' || (v_n - 10)::pg_catalog.text || ' more)';
  END IF;
  IF v_n > 0 THEN
    RAISE EXCEPTION 'migration 886: % row(s) hold an owner role that is not exactly ''owner'' — correct each role by hand before applying: %', v_n, v_ids
      USING HINT = 'Set each role, by id, to ''owner'' or to the role it was meant to be; run the same check on dev and prod before deploying.';
  END IF;
END $$;

-- ── 1. The guards ─────────────────────────────────────────────────────────
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
  IF current_user <> 'app_user' THEN
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
