-- 955: Budget-holder slices in the database (budgets programme P5, PR P5-6;
-- spec docs/plans/budgets/P5-controls-spec.md §2 "DB-level rule", §3f,
-- decision 9a; tables from 954).
--
-- WHAT (no table or column is added; three trigger functions and one helper).
--   1. budget_month_amounts_slice_guard (trigger on budget_month_amounts, beside
--      947's lock trigger), for every row an INSERT, UPDATE or DELETE touches
--      (OLD and NEW), only while the version is a DRAFT:
--      a. A slice whose budget_slice_reviews row is 'submitted' or 'approved' is
--         locked: the write is refused (BV003) unless the session is on the
--         reviewer path, i.e. it called budget_slice_review_begin(company,
--         version) in this transaction AND its user is an owner or admin of the
--         company (both are checked here, per row).
--      b. A budget holder (a session user with a budget_holders row in the
--         version who is not an owner or admin) writes only inside the slices
--         assigned to them (same CC1/CC2/BU, and an account of the row's list
--         when it names accounts), and only while the version is a draft
--         (BV004).
--      The slice review row is taken FOR SHARE, so a write and a submit of the
--      same slice serialise: the later one sees the other's outcome.
--   2. budget_holders_rules: only an owner or admin assigns or removes a holder,
--      a holder is an owner, admin or manager of the company (decision 9a), and
--      a new assignment is on a draft version (BV004 / BV005).
--   3. budget_slice_reviews_rules: the slice workflow's moves and who may make
--      them, the backstop of sliceReviewState.ts:
--        open|returned -> submitted   a holder of that slice
--        submitted -> approved        an owner or admin
--        submitted -> returned        an owner or admin, with a non-blank note
--      any other status move is BV005; a move needs a draft version (taken FOR
--      SHARE: a move and the version's approve serialise). Creating, deleting
--      (a version delete's cascade included) or re-dating a slice review is an
--      owner's or admin's act. Fires before 954's stamp trigger (name order).
--   With no session user (the service pool's cron, a migration) rules 1b, 2 and
--   3's role checks do not apply (the server code decides, as 954's stamps);
--   rule 1a still does (there is no reviewer), and 954's stamp trigger refuses
--   a status move without a session user.
--
-- WHY NO SECURITY DEFINER (spec §2 assumed one). budget_slice_review_begin only
--   checks the caller and sets a transaction-local GUC; any session can also set
--   that GUC with set_config, so the GUC alone can never be the proof. The guard
--   therefore re-checks, per row, that the session's user is an owner or admin,
--   from the caller's OWN company_users row, which RLS always shows the caller
--   (cu_self_or_admin, 351). A definer would add a reviewed privilege path and
--   prove nothing more: forging the reviewer needs forged claims, which every
--   app_user policy already assumes possible (915). Every function here is
--   SECURITY INVOKER: no app_definer_reviews row (930).
--
-- Error codes: BV003 slice locked (409), BV004 holder/role refusal (403), BV005
-- slice move not allowed (409); mapped by budgetVersionTypes.budgetDbRefusal.

SET LOCAL lock_timeout = '5s';

-- ── The reviewer path ───────────────────────────────────────────────────────
-- Marks this transaction as an owner's or admin's review of one version's slices.
-- Refused (BV004) for anyone else, and outside the session's active company.
CREATE OR REPLACE FUNCTION public.budget_slice_review_begin(p_company uuid, p_version uuid)
RETURNS void
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF auth.uid() IS NULL OR app.current_company_id() IS DISTINCT FROM p_company
     OR NOT EXISTS (SELECT 1 FROM company_users cu
                     WHERE cu.company_id = p_company AND cu.user_id = auth.uid() AND cu.role IN ('owner', 'admin')) THEN
    RAISE EXCEPTION 'only an owner or admin of company % may review budget slices', p_company USING ERRCODE = 'BV004';
  END IF;
  PERFORM set_config('budgets.slice_reviewer', p_company::text || ':' || p_version::text, true);
END;
$$;

-- ── 1. budget_month_amounts: locked slices and holder slices ────────────────
-- Checks OLD and NEW (each once; an UPDATE that keeps the row's slice, once). A
-- version gone (a version delete's cascade) or not a draft has no slice workflow;
-- a holder still may not write it. Everything is inline: a trigger function needs
-- no EXECUTE grant, so any role's write (a platform admin's company delete
-- cascading here) reaches it.
CREATE OR REPLACE FUNCTION public.budget_month_amounts_slice_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  rows_ jsonb[] := ARRAY[]::jsonb[];
  r jsonb;
  co uuid; ver uuid; acct uuid; c1 uuid; c2 uuid; b uuid;
  uid text := auth.uid();
  srole text;
  reviewer boolean;
  vstatus text;
  review text;
BEGIN
  IF TG_OP IN ('INSERT', 'UPDATE') AND NEW.version_id IS NOT NULL THEN
    rows_ := rows_ || to_jsonb(NEW);
  END IF;
  IF TG_OP = 'DELETE' AND OLD.version_id IS NOT NULL
     OR TG_OP = 'UPDATE' AND OLD.version_id IS NOT NULL
        AND (OLD.company_id, OLD.version_id, OLD.gl_account_id, OLD.cc1_id, OLD.cc2_id, OLD.bu_id)
            IS DISTINCT FROM (NEW.company_id, NEW.version_id, NEW.gl_account_id, NEW.cc1_id, NEW.cc2_id, NEW.bu_id) THEN
    rows_ := rows_ || to_jsonb(OLD);
  END IF;

  FOREACH r IN ARRAY rows_ LOOP
    co := (r ->> 'company_id')::uuid; ver := (r ->> 'version_id')::uuid; acct := (r ->> 'gl_account_id')::uuid;
    c1 := (r ->> 'cc1_id')::uuid; c2 := (r ->> 'cc2_id')::uuid; b := (r ->> 'bu_id')::uuid;
    -- Most versions have no holders and no reviews: two index probes and on.
    CONTINUE WHEN NOT EXISTS (SELECT 1 FROM budget_slice_reviews x WHERE x.company_id = co AND x.version_id = ver)
              AND NOT EXISTS (SELECT 1 FROM budget_holders x WHERE x.company_id = co AND x.version_id = ver);
    vstatus := NULL; srole := NULL; review := NULL;
    SELECT v.status INTO vstatus FROM budget_versions v WHERE v.id = ver AND v.company_id = co;
    IF uid IS NOT NULL THEN
      SELECT cu.role INTO srole FROM company_users cu WHERE cu.company_id = co AND cu.user_id = uid LIMIT 1;
    END IF;
    reviewer := COALESCE(srole IN ('owner', 'admin'), false);

    -- b. A holder: their slices only, a draft only.
    IF uid IS NOT NULL AND NOT reviewer
       AND EXISTS (SELECT 1 FROM budget_holders h WHERE h.company_id = co AND h.version_id = ver AND h.user_id = uid) THEN
      IF vstatus IS DISTINCT FROM 'draft' THEN
        RAISE EXCEPTION 'a budget holder edits only a draft version (version % is %)', ver, COALESCE(vstatus, 'gone')
          USING ERRCODE = 'BV004';
      END IF;
      IF NOT EXISTS (SELECT 1 FROM budget_holders h
                      WHERE h.company_id = co AND h.version_id = ver AND h.user_id = uid
                        AND h.cc1_id IS NOT DISTINCT FROM c1 AND h.cc2_id IS NOT DISTINCT FROM c2 AND h.bu_id IS NOT DISTINCT FROM b
                        AND (h.gl_account_ids IS NULL OR acct = ANY (h.gl_account_ids))) THEN
        RAISE EXCEPTION 'account % (cc1 %, cc2 %, bu %) is outside your budget slices of version %', acct, c1, c2, b, ver
          USING ERRCODE = 'BV004';
      END IF;
    END IF;

    -- a. A submitted or approved slice of a draft: the reviewer path only. FOR SHARE: a write
    --    and a status move of the slice serialise (the move's UPDATE waits, or this re-reads it).
    IF vstatus = 'draft' THEN
      SELECT x.status INTO review FROM budget_slice_reviews x
       WHERE x.company_id = co AND x.version_id = ver
         AND x.cc1_id IS NOT DISTINCT FROM c1 AND x.cc2_id IS NOT DISTINCT FROM c2 AND x.bu_id IS NOT DISTINCT FROM b
         FOR SHARE;
      IF review IN ('submitted', 'approved')
         AND NOT (reviewer AND current_setting('budgets.slice_reviewer', true) IS NOT DISTINCT FROM co::text || ':' || ver::text) THEN
        RAISE EXCEPTION 'this budget slice is % for review; only the reviewer may change it', review USING ERRCODE = 'BV003';
      END IF;
    END IF;
  END LOOP;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_budget_month_amounts_slice_guard ON budget_month_amounts;
CREATE TRIGGER trg_budget_month_amounts_slice_guard
  BEFORE INSERT OR UPDATE OR DELETE ON budget_month_amounts
  FOR EACH ROW EXECUTE FUNCTION public.budget_month_amounts_slice_guard();
ALTER TABLE budget_month_amounts ENABLE ALWAYS TRIGGER trg_budget_month_amounts_slice_guard;

-- ── 2. budget_holders: who assigns, who may hold ────────────────────────────
CREATE OR REPLACE FUNCTION public.budget_holders_rules()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  co uuid := CASE WHEN TG_OP = 'DELETE' THEN OLD.company_id ELSE NEW.company_id END;
  vstatus text;
BEGIN
  IF auth.uid() IS NOT NULL AND NOT EXISTS (SELECT 1 FROM company_users cu
                                              WHERE cu.company_id = co AND cu.user_id = auth.uid() AND cu.role IN ('owner', 'admin')) THEN
    RAISE EXCEPTION 'only an owner or admin assigns budget holders' USING ERRCODE = 'BV004';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  IF NOT EXISTS (SELECT 1 FROM company_users cu
                  WHERE cu.company_id = NEW.company_id AND cu.user_id = NEW.user_id AND cu.role IN ('owner', 'admin', 'manager')) THEN
    RAISE EXCEPTION 'a budget holder must be an owner, admin or manager of the company (user %)', NEW.user_id USING ERRCODE = 'BV004';
  END IF;
  IF TG_OP = 'INSERT' THEN
    SELECT v.status INTO vstatus FROM budget_versions v WHERE v.id = NEW.version_id AND v.company_id = NEW.company_id;
    IF vstatus IS DISTINCT FROM 'draft' THEN
      RAISE EXCEPTION 'budget holders are assigned on a draft version only (version % is %)', NEW.version_id, COALESCE(vstatus, 'not found')
        USING ERRCODE = 'BV005';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_budget_holders_rules ON budget_holders;
CREATE TRIGGER trg_budget_holders_rules BEFORE INSERT OR UPDATE OR DELETE ON budget_holders
  FOR EACH ROW EXECUTE FUNCTION public.budget_holders_rules();
ALTER TABLE budget_holders ENABLE ALWAYS TRIGGER trg_budget_holders_rules;

-- ── 3. budget_slice_reviews: the workflow's moves ───────────────────────────
CREATE OR REPLACE FUNCTION public.budget_slice_reviews_rules()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  co uuid := CASE WHEN TG_OP = 'DELETE' THEN OLD.company_id ELSE NEW.company_id END;
  reviewer boolean := EXISTS (SELECT 1 FROM company_users cu
                               WHERE cu.company_id = co AND cu.user_id = auth.uid() AND cu.role IN ('owner', 'admin'));
  vstatus text;
BEGIN
  IF TG_OP <> 'UPDATE' OR NEW.status IS NOT DISTINCT FROM OLD.status THEN
    -- Create, delete (a version delete's cascade too), re-date: the reviewer's acts.
    IF auth.uid() IS NOT NULL AND NOT reviewer THEN
      RAISE EXCEPTION 'only an owner or admin creates, removes or re-dates a budget slice review' USING ERRCODE = 'BV004';
    END IF;
    IF TG_OP = 'INSERT' THEN
      SELECT v.status INTO vstatus FROM budget_versions v WHERE v.id = NEW.version_id AND v.company_id = NEW.company_id;
      IF vstatus IS DISTINCT FROM 'draft' THEN
        RAISE EXCEPTION 'budget slices are reviewed on a draft version only (version % is %)', NEW.version_id, COALESCE(vstatus, 'not found')
          USING ERRCODE = 'BV005';
      END IF;
    END IF;
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;

  -- A status move: on a draft version, held FOR SHARE so the version's approve waits for it (or it for the approve).
  SELECT v.status INTO vstatus FROM budget_versions v WHERE v.id = NEW.version_id AND v.company_id = NEW.company_id FOR SHARE;
  IF vstatus IS DISTINCT FROM 'draft' THEN
    RAISE EXCEPTION 'budget slices move only on a draft version (version % is %)', NEW.version_id, COALESCE(vstatus, 'not found')
      USING ERRCODE = 'BV005';
  END IF;
  IF NEW.status = 'submitted' AND OLD.status IN ('open', 'returned') THEN
    IF auth.uid() IS NOT NULL AND NOT EXISTS (
         SELECT 1 FROM budget_holders h
          WHERE h.company_id = NEW.company_id AND h.version_id = NEW.version_id AND h.user_id = auth.uid()
            AND h.cc1_id IS NOT DISTINCT FROM NEW.cc1_id AND h.cc2_id IS NOT DISTINCT FROM NEW.cc2_id
            AND h.bu_id IS NOT DISTINCT FROM NEW.bu_id) THEN
      RAISE EXCEPTION 'only a holder of this budget slice submits it' USING ERRCODE = 'BV004';
    END IF;
  ELSIF NEW.status IN ('approved', 'returned') AND OLD.status = 'submitted' THEN
    IF auth.uid() IS NOT NULL AND NOT reviewer THEN
      RAISE EXCEPTION 'only an owner or admin approves or returns a budget slice' USING ERRCODE = 'BV004';
    END IF;
    IF NEW.status = 'returned' AND btrim(COALESCE(NEW.decision_note, '')) = '' THEN
      RAISE EXCEPTION 'returning a budget slice needs a note' USING ERRCODE = 'BV005';
    END IF;
  ELSE
    RAISE EXCEPTION 'a budget slice cannot move from % to %', OLD.status, NEW.status USING ERRCODE = 'BV005';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_budget_slice_reviews_rules ON budget_slice_reviews;
CREATE TRIGGER trg_budget_slice_reviews_rules BEFORE INSERT OR UPDATE OR DELETE ON budget_slice_reviews
  FOR EACH ROW EXECUTE FUNCTION public.budget_slice_reviews_rules();
ALTER TABLE budget_slice_reviews ENABLE ALWAYS TRIGGER trg_budget_slice_reviews_rules;

REVOKE ALL ON FUNCTION public.budget_month_amounts_slice_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.budget_holders_rules() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.budget_slice_reviews_rules() FROM PUBLIC;
-- The app's reviewer path (gridSave.ts) calls it in the request, as app_user.
REVOKE ALL ON FUNCTION public.budget_slice_review_begin(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.budget_slice_review_begin(uuid, uuid) TO app_user;
