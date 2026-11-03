-- 955: Budget-holder slices in the database (budgets programme P5, PR P5-6;
-- spec docs/plans/budgets/P5-controls-spec.md §2 "DB-level rule", §3f,
-- decision 9a; tables from 954).
--
-- WRITE INTEGRITY is what these rules protect. The app's holder view (the grid
-- showing a holder only their slices) scopes their WORK; it is not access control:
-- managers read every budget (reports, other versions, drivers), by design.
--
-- WHAT (no table or column is added).
--   1. The slice write rule, `budget_slice_rows_check(rows jsonb)`, for the budget
--      cells a statement writes (budget_month_amounts: statement-level AFTER
--      triggers with transition tables, so the rows of one statement are checked
--      together, once per account and slice) and for a driver line's row
--      (budget_driver_lines, its OLD and NEW grain), only while the version is a
--      DRAFT:
--      a. A slice whose budget_slice_reviews row is 'submitted' or 'approved' is
--         locked: refused (BV003) unless the session is on the reviewer path: it
--         called budget_slice_review_begin(company, version) in this transaction
--         AND its user is an owner or admin of the company (both checked here).
--         The slice reviews are taken FOR SHARE first, so a write and a status
--         move of the same slice serialise.
--      b. A budget holder (a session user with a budget_holders row in the
--         version who is not an owner or admin) writes only inside the slices
--         assigned to them (same CC1/CC2/BU, and an account of the row's list when
--         it names accounts), and only while the version is a draft (BV004).
--      Planned hires (budget_planned_hires) follow the same rule by cost centre: a
--      hire on centre X belongs to the slice whose CC1 or CC2 is X; a hire with no
--      centre to the company-level slice.
--   2. budget_holders_rules: only an owner or admin assigns or removes a holder, a
--      holder is an owner, admin or manager of the company (decision 9a), a new
--      assignment is on a draft version (BV004 / BV005), and a submitted or
--      approved slice's holders and account lists do not change (BV003).
--   3. budget_slice_reviews_rules: the slice workflow's moves and who may make
--      them, the backstop of sliceReviewState.ts:
--        open|returned -> submitted   a holder of that slice
--        submitted -> approved        an owner or admin
--        submitted -> returned        an owner or admin, with a non-blank note
--      any other status move is BV005; a move changes nothing else (the slice, the
--      due date; the note only on an approve or a return); it needs a draft
--      version (taken FOR SHARE: a move and the version's approve serialise).
--      Creating, deleting (a version delete's cascade included) or re-dating a
--      slice review is an owner's or admin's act. Fires before 954's stamp
--      trigger (name order).
--   4. budget_versions_slice_gate: draft -> approved needs an owner or admin
--      session, and every slice review of the version approved unless the OWNER
--      forces it (budget_version_force_begin; the GUC re-checked by role here)
--      (BV004 / BV006). An owner or admin approving slices and then the version
--      themselves is allowed (self-approval is audited, not refused).
--   With no session user (the service pool's cron, a migration, a QA purge) the
--   role checks do not apply (the server code decides, as 954's stamps); the slice
--   lock (1a) still does (there is no reviewer). Rows of a company being deleted
--   (its row already gone in the cascade) are never refused.
--
-- WHY NO SECURITY DEFINER (spec §2 assumed one). The begin helpers only check the
--   caller and set a transaction-local GUC; any session can also set that GUC with
--   set_config, so the GUC alone is never the proof. The rules re-check the
--   session's role from the caller's OWN company_users row, which RLS always shows
--   the caller (cu_self_or_admin, 351). A definer would add a reviewed privilege
--   path and prove nothing more: forging the reviewer needs forged claims, which
--   every app_user policy already assumes possible (915). Every function here is
--   SECURITY INVOKER: no app_definer_reviews row (930; the guard at the end
--   refuses a definer). budget_session_is_reviewer, budget_guc_names and
--   budget_slice_rows_check stay executable by PUBLIC: the triggers call them as
--   the writing role (app_user, app_service, a platform admin's cascade); they
--   only read and refuse.
--
-- Error codes: BV003 slice locked (409), BV004 holder/role refusal (403), BV005
-- slice move not allowed (409), BV006 slices not approved (409); mapped by
-- budgetVersionTypes.budgetDbRefusal.

SET LOCAL lock_timeout = '5s';

-- ── The session's facts ─────────────────────────────────────────────────────
-- An owner or admin of the company, from the session's own company_users row.
CREATE OR REPLACE FUNCTION public.budget_session_is_reviewer(p_company uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT auth.uid() IS NOT NULL AND EXISTS (
    SELECT 1 FROM company_users cu WHERE cu.company_id = p_company AND cu.user_id = auth.uid() AND cu.role IN ('owner', 'admin'))
$$;

-- Whether a comma-separated `company:version` list GUC (the begin helpers append) names this version.
CREATE OR REPLACE FUNCTION public.budget_guc_names(p_guc text, p_company uuid, p_version uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT position(',' || p_company::text || ':' || p_version::text || ',' IN ',' || COALESCE(current_setting(p_guc, true), '') || ',') > 0
$$;

-- ── The reviewer path and the owner's forced approve ────────────────────────
-- Marks this transaction as an owner's or admin's review of the version's slices.
CREATE OR REPLACE FUNCTION public.budget_slice_review_begin(p_company uuid, p_version uuid)
RETURNS void
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF app.current_company_id() IS DISTINCT FROM p_company OR NOT public.budget_session_is_reviewer(p_company) THEN
    RAISE EXCEPTION 'only an owner or admin of company % may review budget slices', p_company USING ERRCODE = 'BV004';
  END IF;
  IF NOT public.budget_guc_names('budgets.slice_reviewer', p_company, p_version) THEN
    PERFORM set_config('budgets.slice_reviewer',
      concat_ws(',', NULLIF(current_setting('budgets.slice_reviewer', true), ''), p_company::text || ':' || p_version::text), true);
  END IF;
END;
$$;

-- Marks this transaction as the OWNER approving the version over slices not approved (the app audits it).
CREATE OR REPLACE FUNCTION public.budget_version_force_begin(p_company uuid, p_version uuid)
RETURNS void
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF auth.uid() IS NULL OR app.current_company_id() IS DISTINCT FROM p_company OR NOT EXISTS (
       SELECT 1 FROM company_users cu WHERE cu.company_id = p_company AND cu.user_id = auth.uid() AND cu.role = 'owner') THEN
    RAISE EXCEPTION 'only an owner of company % may approve a budget version over open slices', p_company USING ERRCODE = 'BV004';
  END IF;
  IF NOT public.budget_guc_names('budgets.version_force_approve', p_company, p_version) THEN
    PERFORM set_config('budgets.version_force_approve',
      concat_ws(',', NULLIF(current_setting('budgets.version_force_approve', true), ''), p_company::text || ':' || p_version::text), true);
  END IF;
END;
$$;

-- ── 1. The slice write rule ─────────────────────────────────────────────────
-- p_rows: [{c, v, a, c1, c2, b}] (company, version, account, CC1, CC2, BU). Refuses the first row that
-- breaks 1a or 1b. A version without slices or holders costs two index probes.
CREATE OR REPLACE FUNCTION public.budget_slice_rows_check(p_rows jsonb)
RETURNS void
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  uid text := auth.uid();
  bad record;
BEGIN
  -- The slice reviews of the rows' draft versions, FOR SHARE: a status move of one waits for this
  -- transaction, or this check (a new snapshot) sees the move it waited for.
  PERFORM 1
     FROM budget_slice_reviews x
     JOIN (SELECT DISTINCT r.c, r.v, r.c1, r.c2, r.b FROM jsonb_to_recordset(p_rows) AS r(c uuid, v uuid, a uuid, c1 uuid, c2 uuid, b uuid)) t
       ON x.company_id = t.c AND x.version_id = t.v
      AND x.cc1_id IS NOT DISTINCT FROM t.c1 AND x.cc2_id IS NOT DISTINCT FROM t.c2 AND x.bu_id IS NOT DISTINCT FROM t.b
     JOIN budget_versions ver ON ver.id = x.version_id AND ver.company_id = x.company_id AND ver.status = 'draft'
     FOR SHARE OF x;

  FOR bad IN
    WITH t AS (
      SELECT DISTINCT r.c, r.v, r.a, r.c1, r.c2, r.b FROM jsonb_to_recordset(p_rows) AS r(c uuid, v uuid, a uuid, c1 uuid, c2 uuid, b uuid)
    ), tv AS (
      SELECT t.*, ver.status AS vstatus, public.budget_session_is_reviewer(t.c) AS reviewer,
             (uid IS NOT NULL AND EXISTS (SELECT 1 FROM budget_holders h WHERE h.company_id = t.c AND h.version_id = t.v AND h.user_id = uid)) AS holds
        FROM t
        JOIN budget_versions ver ON ver.id = t.v AND ver.company_id = t.c   -- a version gone (its delete's cascade): no rule
       WHERE EXISTS (SELECT 1 FROM companies co WHERE co.id = t.c)          -- a company gone (its delete's cascade): no rule
         AND (EXISTS (SELECT 1 FROM budget_slice_reviews x WHERE x.company_id = t.c AND x.version_id = t.v)
              OR EXISTS (SELECT 1 FROM budget_holders x WHERE x.company_id = t.c AND x.version_id = t.v))
    )
    SELECT tv.*, CASE
        WHEN tv.holds AND NOT tv.reviewer AND tv.vstatus <> 'draft' THEN 'not_draft'
        WHEN tv.holds AND NOT tv.reviewer AND NOT EXISTS (
          SELECT 1 FROM budget_holders h
           WHERE h.company_id = tv.c AND h.version_id = tv.v AND h.user_id = uid
             AND h.cc1_id IS NOT DISTINCT FROM tv.c1 AND h.cc2_id IS NOT DISTINCT FROM tv.c2 AND h.bu_id IS NOT DISTINCT FROM tv.b
             AND (h.gl_account_ids IS NULL OR tv.a = ANY (h.gl_account_ids))) THEN 'outside'
        WHEN tv.vstatus = 'draft' AND NOT (tv.reviewer AND public.budget_guc_names('budgets.slice_reviewer', tv.c, tv.v))
             AND EXISTS (SELECT 1 FROM budget_slice_reviews x
                          WHERE x.company_id = tv.c AND x.version_id = tv.v AND x.status IN ('submitted', 'approved')
                            AND x.cc1_id IS NOT DISTINCT FROM tv.c1 AND x.cc2_id IS NOT DISTINCT FROM tv.c2 AND x.bu_id IS NOT DISTINCT FROM tv.b)
             THEN 'locked'
      END AS why
      FROM tv
  LOOP
    CONTINUE WHEN bad.why IS NULL;
    IF bad.why = 'not_draft' THEN
      RAISE EXCEPTION 'a budget holder edits only a draft version (version % is %)', bad.v, bad.vstatus USING ERRCODE = 'BV004';
    ELSIF bad.why = 'outside' THEN
      RAISE EXCEPTION 'account % (cc1 %, cc2 %, bu %) is outside your budget slices of version %', bad.a, bad.c1, bad.c2, bad.b, bad.v
        USING ERRCODE = 'BV004';
    ELSE
      RAISE EXCEPTION 'the budget slice (cc1 %, cc2 %, bu %) of version % is with its reviewer; only the reviewer may change it',
        bad.c1, bad.c2, bad.b, bad.v USING ERRCODE = 'BV003';
    END IF;
  END LOOP;
END;
$$;

-- budget_month_amounts: one check per statement over its rows (OLD and NEW), distinct by account and
-- slice. AFTER, so it sees what the statement wrote; a refusal undoes the statement.
CREATE OR REPLACE FUNCTION public.budget_month_amounts_slice_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  rows_ jsonb;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT jsonb_agg(DISTINCT jsonb_build_object('c', company_id, 'v', version_id, 'a', gl_account_id, 'c1', cc1_id, 'c2', cc2_id, 'b', bu_id))
      INTO rows_ FROM new_rows WHERE version_id IS NOT NULL;
  ELSIF TG_OP = 'DELETE' THEN
    SELECT jsonb_agg(DISTINCT jsonb_build_object('c', company_id, 'v', version_id, 'a', gl_account_id, 'c1', cc1_id, 'c2', cc2_id, 'b', bu_id))
      INTO rows_ FROM old_rows WHERE version_id IS NOT NULL;
  ELSE
    SELECT jsonb_agg(DISTINCT jsonb_build_object('c', company_id, 'v', version_id, 'a', gl_account_id, 'c1', cc1_id, 'c2', cc2_id, 'b', bu_id))
      INTO rows_
      FROM (SELECT company_id, version_id, gl_account_id, cc1_id, cc2_id, bu_id FROM new_rows
            UNION SELECT company_id, version_id, gl_account_id, cc1_id, cc2_id, bu_id FROM old_rows) u
     WHERE version_id IS NOT NULL;
  END IF;
  IF rows_ IS NOT NULL THEN PERFORM public.budget_slice_rows_check(rows_); END IF;
  RETURN NULL;
END;
$$;
DROP TRIGGER IF EXISTS trg_budget_month_amounts_slice_guard ON budget_month_amounts;
DROP TRIGGER IF EXISTS trg_budget_month_amounts_slice_guard_ins ON budget_month_amounts;
DROP TRIGGER IF EXISTS trg_budget_month_amounts_slice_guard_upd ON budget_month_amounts;
DROP TRIGGER IF EXISTS trg_budget_month_amounts_slice_guard_del ON budget_month_amounts;
CREATE TRIGGER trg_budget_month_amounts_slice_guard_ins AFTER INSERT ON budget_month_amounts
  REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION public.budget_month_amounts_slice_guard();
CREATE TRIGGER trg_budget_month_amounts_slice_guard_upd AFTER UPDATE ON budget_month_amounts
  REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION public.budget_month_amounts_slice_guard();
CREATE TRIGGER trg_budget_month_amounts_slice_guard_del AFTER DELETE ON budget_month_amounts
  REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION public.budget_month_amounts_slice_guard();
ALTER TABLE budget_month_amounts ENABLE ALWAYS TRIGGER trg_budget_month_amounts_slice_guard_ins;
ALTER TABLE budget_month_amounts ENABLE ALWAYS TRIGGER trg_budget_month_amounts_slice_guard_upd;
ALTER TABLE budget_month_amounts ENABLE ALWAYS TRIGGER trg_budget_month_amounts_slice_guard_del;

-- budget_driver_lines: the driver's own row (OLD and NEW grain) is a cell row of its slice.
CREATE OR REPLACE FUNCTION public.budget_driver_lines_slice_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  rows_ jsonb := '[]'::jsonb;
BEGIN
  IF TG_OP <> 'DELETE' THEN
    rows_ := rows_ || jsonb_build_object('c', NEW.company_id, 'v', NEW.version_id, 'a', NEW.gl_account_id, 'c1', NEW.cc1_id, 'c2', NEW.cc2_id, 'b', NEW.bu_id);
  END IF;
  IF TG_OP <> 'INSERT' THEN
    rows_ := rows_ || jsonb_build_object('c', OLD.company_id, 'v', OLD.version_id, 'a', OLD.gl_account_id, 'c1', OLD.cc1_id, 'c2', OLD.cc2_id, 'b', OLD.bu_id);
  END IF;
  PERFORM public.budget_slice_rows_check(rows_);
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_budget_driver_lines_slice_guard ON budget_driver_lines;
CREATE TRIGGER trg_budget_driver_lines_slice_guard BEFORE INSERT OR UPDATE OR DELETE ON budget_driver_lines
  FOR EACH ROW EXECUTE FUNCTION public.budget_driver_lines_slice_guard();
ALTER TABLE budget_driver_lines ENABLE ALWAYS TRIGGER trg_budget_driver_lines_slice_guard;

-- budget_planned_hires: by cost centre (OLD and NEW): the slice whose CC1 or CC2 is the centre; no
-- centre is the company-level slice. Rule 1a/1b, accounts aside (a hire names none).
CREATE OR REPLACE FUNCTION public.budget_planned_hires_slice_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  uid text := auth.uid();
  r record;
  vstatus text;
  reviewer boolean;
BEGIN
  FOR r IN SELECT * FROM (VALUES
      (CASE WHEN TG_OP <> 'DELETE' THEN NEW.company_id END, CASE WHEN TG_OP <> 'DELETE' THEN NEW.version_id END,
       CASE WHEN TG_OP <> 'DELETE' THEN NEW.cost_centre_id END),
      (CASE WHEN TG_OP <> 'INSERT' THEN OLD.company_id END, CASE WHEN TG_OP <> 'INSERT' THEN OLD.version_id END,
       CASE WHEN TG_OP <> 'INSERT' THEN OLD.cost_centre_id END)) AS x(c, v, cc)
    WHERE x.c IS NOT NULL LOOP
    vstatus := NULL;
    SELECT ver.status INTO vstatus FROM budget_versions ver WHERE ver.id = r.v AND ver.company_id = r.c;
    CONTINUE WHEN vstatus IS NULL OR NOT EXISTS (SELECT 1 FROM companies co WHERE co.id = r.c);
    CONTINUE WHEN NOT EXISTS (SELECT 1 FROM budget_slice_reviews x WHERE x.company_id = r.c AND x.version_id = r.v)
              AND NOT EXISTS (SELECT 1 FROM budget_holders x WHERE x.company_id = r.c AND x.version_id = r.v);
    reviewer := public.budget_session_is_reviewer(r.c);
    IF uid IS NOT NULL AND NOT reviewer
       AND EXISTS (SELECT 1 FROM budget_holders h WHERE h.company_id = r.c AND h.version_id = r.v AND h.user_id = uid)
       AND (vstatus <> 'draft' OR NOT EXISTS (
             SELECT 1 FROM budget_holders h WHERE h.company_id = r.c AND h.version_id = r.v AND h.user_id = uid
                AND (CASE WHEN r.cc IS NULL THEN h.cc1_id IS NULL AND h.cc2_id IS NULL AND h.bu_id IS NULL
                          ELSE r.cc IN (h.cc1_id, h.cc2_id) END))) THEN
      RAISE EXCEPTION 'a planned hire on cost centre % is outside your budget slices of version %', r.cc, r.v USING ERRCODE = 'BV004';
    END IF;
    IF vstatus = 'draft' AND NOT (reviewer AND public.budget_guc_names('budgets.slice_reviewer', r.c, r.v)) AND EXISTS (
         SELECT 1 FROM budget_slice_reviews x
          WHERE x.company_id = r.c AND x.version_id = r.v AND x.status IN ('submitted', 'approved')
            AND (CASE WHEN r.cc IS NULL THEN x.cc1_id IS NULL AND x.cc2_id IS NULL AND x.bu_id IS NULL ELSE r.cc IN (x.cc1_id, x.cc2_id) END)) THEN
      RAISE EXCEPTION 'the budget slice of cost centre % in version % is with its reviewer; only the reviewer may change its planned hires', r.cc, r.v
        USING ERRCODE = 'BV003';
    END IF;
  END LOOP;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_budget_planned_hires_slice_guard ON budget_planned_hires;
CREATE TRIGGER trg_budget_planned_hires_slice_guard BEFORE INSERT OR UPDATE OR DELETE ON budget_planned_hires
  FOR EACH ROW EXECUTE FUNCTION public.budget_planned_hires_slice_guard();
ALTER TABLE budget_planned_hires ENABLE ALWAYS TRIGGER trg_budget_planned_hires_slice_guard;

-- ── 2. budget_holders: who assigns, who may hold ────────────────────────────
CREATE OR REPLACE FUNCTION public.budget_holders_rules()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  co uuid := CASE WHEN TG_OP = 'DELETE' THEN OLD.company_id ELSE NEW.company_id END;
  ver uuid := CASE WHEN TG_OP = 'DELETE' THEN OLD.version_id ELSE NEW.version_id END;
  c1 uuid := CASE WHEN TG_OP = 'DELETE' THEN OLD.cc1_id ELSE NEW.cc1_id END;
  c2 uuid := CASE WHEN TG_OP = 'DELETE' THEN OLD.cc2_id ELSE NEW.cc2_id END;
  b uuid := CASE WHEN TG_OP = 'DELETE' THEN OLD.bu_id ELSE NEW.bu_id END;
  vstatus text;
BEGIN
  -- A company being deleted (its row already gone in the cascade): nothing to refuse.
  IF TG_OP = 'DELETE' AND NOT EXISTS (SELECT 1 FROM companies c WHERE c.id = OLD.company_id) THEN
    RETURN OLD;
  END IF;
  IF auth.uid() IS NOT NULL AND NOT public.budget_session_is_reviewer(co) THEN
    RAISE EXCEPTION 'only an owner or admin assigns budget holders' USING ERRCODE = 'BV004';
  END IF;
  SELECT v.status INTO vstatus FROM budget_versions v WHERE v.id = ver AND v.company_id = co;
  -- A submitted or approved slice keeps its holders and their accounts (a version delete's cascade aside: no version row).
  IF vstatus = 'draft' AND (TG_OP <> 'UPDATE' OR NEW.gl_account_ids IS DISTINCT FROM OLD.gl_account_ids) AND EXISTS (
       SELECT 1 FROM budget_slice_reviews x
        WHERE x.company_id = co AND x.version_id = ver AND x.status IN ('submitted', 'approved')
          AND x.cc1_id IS NOT DISTINCT FROM c1 AND x.cc2_id IS NOT DISTINCT FROM c2 AND x.bu_id IS NOT DISTINCT FROM b) THEN
    RAISE EXCEPTION 'this budget slice is with its reviewer: its holders and their accounts do not change' USING ERRCODE = 'BV003';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  IF NOT EXISTS (SELECT 1 FROM company_users cu
                  WHERE cu.company_id = NEW.company_id AND cu.user_id = NEW.user_id AND cu.role IN ('owner', 'admin', 'manager')) THEN
    RAISE EXCEPTION 'a budget holder must be an owner, admin or manager of the company (user %)', NEW.user_id USING ERRCODE = 'BV004';
  END IF;
  IF TG_OP = 'INSERT' AND vstatus IS DISTINCT FROM 'draft' THEN
    RAISE EXCEPTION 'budget holders are assigned on a draft version only (version % is %)', NEW.version_id, COALESCE(vstatus, 'not found')
      USING ERRCODE = 'BV005';
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
  reviewer boolean := public.budget_session_is_reviewer(co);
  vstatus text;
BEGIN
  -- A company being deleted (its row already gone in the cascade): nothing to refuse.
  IF TG_OP = 'DELETE' AND NOT EXISTS (SELECT 1 FROM companies c WHERE c.id = OLD.company_id) THEN
    RETURN OLD;
  END IF;
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

  -- A status move moves nothing else: not the slice, not its due date; the note only on an approve or a return.
  IF (NEW.company_id, NEW.version_id, NEW.cc1_id, NEW.cc2_id, NEW.bu_id, NEW.due_date, NEW.created_by, NEW.created_at)
       IS DISTINCT FROM (OLD.company_id, OLD.version_id, OLD.cc1_id, OLD.cc2_id, OLD.bu_id, OLD.due_date, OLD.created_by, OLD.created_at)
     OR (NEW.status = 'submitted' AND NEW.decision_note IS DISTINCT FROM OLD.decision_note) THEN
    RAISE EXCEPTION 'a budget slice status move changes nothing else (slice, due date, note)' USING ERRCODE = 'BV005';
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

-- ── 4. budget_versions: approve only with every slice approved ─────────────
CREATE OR REPLACE FUNCTION public.budget_versions_slice_gate()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  uid text := auth.uid();
BEGIN
  IF uid IS NULL THEN
    -- The app's requests always carry claims; a server process (a migration, a fixture) does not.
    IF current_user = 'app_user' THEN
      RAISE EXCEPTION 'approving a budget version needs a session user' USING ERRCODE = 'BV004';
    END IF;
    RETURN NEW;
  END IF;
  IF NOT public.budget_session_is_reviewer(NEW.company_id) THEN
    RAISE EXCEPTION 'only an owner or admin approves a budget version' USING ERRCODE = 'BV004';
  END IF;
  IF EXISTS (SELECT 1 FROM budget_slice_reviews x WHERE x.company_id = NEW.company_id AND x.version_id = NEW.id AND x.status <> 'approved')
     AND NOT (EXISTS (SELECT 1 FROM company_users cu WHERE cu.company_id = NEW.company_id AND cu.user_id = uid AND cu.role = 'owner')
              AND public.budget_guc_names('budgets.version_force_approve', NEW.company_id, NEW.id)) THEN
    RAISE EXCEPTION 'budget version % has budget slices not approved yet', NEW.id USING ERRCODE = 'BV006';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_budget_versions_slice_gate ON budget_versions;
CREATE TRIGGER trg_budget_versions_slice_gate BEFORE UPDATE OF status ON budget_versions
  FOR EACH ROW WHEN (OLD.status = 'draft' AND NEW.status = 'approved') EXECUTE FUNCTION public.budget_versions_slice_gate();
ALTER TABLE budget_versions ENABLE ALWAYS TRIGGER trg_budget_versions_slice_gate;

-- Trigger functions need no EXECUTE grant; the begin helpers are the app's (app_user) only.
REVOKE ALL ON FUNCTION public.budget_month_amounts_slice_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.budget_driver_lines_slice_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.budget_planned_hires_slice_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.budget_holders_rules() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.budget_slice_reviews_rules() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.budget_versions_slice_gate() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.budget_slice_review_begin(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.budget_version_force_begin(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.budget_slice_review_begin(uuid, uuid) TO app_user;
GRANT EXECUTE ON FUNCTION public.budget_version_force_begin(uuid, uuid) TO app_user;

-- The grants as intended (716/708's guard): the helpers are app_user's and not PUBLIC's, and no
-- function here is a definer (that would need an app_definer_reviews row, 930).
DO $$
DECLARE
  f text;
BEGIN
  FOREACH f IN ARRAY ARRAY['public.budget_slice_review_begin(uuid, uuid)', 'public.budget_version_force_begin(uuid, uuid)'] LOOP
    IF has_function_privilege('public', f, 'EXECUTE') THEN
      RAISE EXCEPTION 'migration 955: PUBLIC can still execute %', f;
    END IF;
    IF NOT has_function_privilege('app_user', f, 'EXECUTE') THEN
      RAISE EXCEPTION 'migration 955: app_user cannot execute %', f;
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
              WHERE n.nspname = 'public' AND p.prosecdef
                AND p.proname IN ('budget_session_is_reviewer', 'budget_guc_names', 'budget_slice_review_begin', 'budget_version_force_begin',
                                  'budget_slice_rows_check', 'budget_month_amounts_slice_guard', 'budget_driver_lines_slice_guard',
                                  'budget_planned_hires_slice_guard', 'budget_holders_rules', 'budget_slice_reviews_rules',
                                  'budget_versions_slice_gate')) THEN
    RAISE EXCEPTION 'migration 955: a function here became SECURITY DEFINER';
  END IF;
END;
$$;
