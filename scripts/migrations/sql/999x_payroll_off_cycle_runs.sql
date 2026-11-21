-- 999x: off-cycle bonus and termination runs (wave 6 OC). Expand-only.
--
-- WHAT.
--   payroll_off_cycle_employees  who an off-cycle run pays, written when the run is created; only a bonus row's amount
--     changes after that (review #1620 final breaker M: correcting an amount keyed in error, on a draft or calculated
--     bonus run, including one reopened before its month's EMP201 is filed):
--     bonus        one row per employee, with the annual-payment earning (a 3605 component of the company) and the
--                  amount; the line pays that alone (no salary, recurring component, loan or deduction);
--     termination  one row per employee, with neither: the line pays the leaver's termination pay-outs.
--     Off-cycle inputs live here and NOT as once-off payroll_employee_components: the run reader pays a once-off
--     dated in its month whatever its end (payrollComponentService), so a bonus written there would be paid again by
--     the month's regular run when that run is reopened and recalculated.
--     payroll_off_cycle_employees_guard  a BEFORE INSERT trigger (INVOKER, under the caller's RLS): the run is this
--     company's, an off-cycle run, still a draft; the employee is this company's; a bonus row names one of this
--     company's 3605 earnings and a termination row names none. A trusted ops identity (payroll_run_trusted_restore) inserts
--     onto a run past draft and keeps the row's created_at, so a data-only restore works (review #1679 codex 5); every
--     other role gets created_at from the clock. On UPDATE (app_user may update the amount column
--     only): the run is this company's DRAFT bonus run (the service sends a calculated run back to draft and clears its
--     lines first); company, run, employee and earning stay as they were; the amount is more than R0 in whole cents.
--     app_user may INSERT, SELECT and UPDATE (amount).
--   payroll_run_headers.off_cycle_paid_gross  each employee's gross on an off-cycle run as last approved, as JSONB
--     {employee_id: gross}: taken by payroll_off_cycle_paid_snapshot (BEFORE INSERT OR UPDATE, ENABLE ALWAYS, INVOKER)
--     from the run's lines at the status transition out of 'approved' (a reopen), on the row that transition writes.
--     For every role but a trusted ops identity (payroll_run_trusted_restore, fail closed; that one writes it as given, so a restore keeps it, #1679
--     ops M), every other INSERT or UPDATE keeps it as it was (NULL on insert), whatever the statement says, so no app_user
--     write can set or move it (review #1679 L1: approved_amount, stamped from a reopened_at app_user may UPDATE, could
--     be forged). It is the gross approved for payment as of payday (review #1679 codex M5): a reopen on or before
--     payday, or the first reopen after it of an approval given on or before it, takes the lines as they are (replacing
--     an earlier snapshot); a reopen after payday of an approval given after it never rises (review #1679b: a status
--     flip by app_user over raised lines): each employee keeps the LEAST of the old snapshot and the lines, nil when
--     absent from it. Those roles never write an off-cycle run's approved_at (the trigger stamps the clock) or
--     off_cycle_payday_at (frozen at the first approval from run_date), so neither can be moved across payday. After a run's pay date its gross may not rise above the snapshot
--     (payrollOffCycleCorrection: bonus and termination runs alike, review #1679 M).
--   approval_request_document_facts  (951:183, called by the 872 SECURITY DEFINER writers) names an off-cycle run in
--     its reference: '11/2026 bonus run, paid 2026-11-28' (its kind and pay date: a month may hold several); a regular
--     run's reference is unchanged
--     ('11/2026'). approvalDocuments.ts builds the same string (the REST raise compares nothing with it; it is the
--     reference an approver reads). The function stays plpgsql STABLE SECURITY INVOKER: 930's registry
--     (app_definer_reviews) hashes SECURITY DEFINER functions only, and no definer changes here, so no row is
--     needed. It runs inside those definers with their owner's rights, so its body is reviewed here: it reads
--     payroll_run_headers only, by the caller's company and document id, as before.
--
--   payroll_run_headers.cancelled_at  cancelOffCycleRun stamps it (cancelled_by came with 999f). Dev has the column
--     from 385; production does not (999f: "paid_at and cancelled_at ... are absent on prod too"), so the cancel
--     route would fail there with 42703. ADD COLUMN IF NOT EXISTS, no default: a no-op where the column exists (dev,
--     the CI baseline), catalogue-only where it is missing (prod). TIMESTAMPTZ is dev's type. Nothing reads it as
--     NOT NULL (getPayrollRun/mapRunRow tolerate NULL), and the old colour never names it.
--
-- OLD COLOUR (the previous release against this schema):
--   payroll_run_headers_history_guard  the old colour never deletes a header and inserts them as draft without
--     history, so it is never refused.
--   payroll_run_headers.off_cycle_paid_gross  it never names the column; its header writes pass through
--     payroll_off_cycle_paid_snapshot, which keeps the column as it was and snapshots only an off-cycle run leaving
--     'approved' (which the old colour never reopens).
--   insert/update/read  it never names payroll_off_cycle_employees; it creates no off-cycle run (insertMonthlyRun
--     writes run_kind 'regular' only), and its run-kind guard refuses to calculate, approve, post, reopen or print an
--     off-cycle run created by this release, so it never costs one without its inputs.
--   approval_request_document_facts  a regular run's reference is the same string as before; an off-cycle run's is
--     longer, which the old code only displays.
--
-- Rollback (down SQL; roll the code back first):
--   DROP TABLE IF EXISTS public.payroll_off_cycle_employees;
--   ALTER TABLE public.payroll_run_headers DROP COLUMN IF EXISTS cancelled_at;  (only where this file added it: prod)
--   DROP FUNCTION IF EXISTS public.payroll_off_cycle_employees_guard();
--   DROP TRIGGER IF EXISTS payroll_off_cycle_paid_snapshot ON public.payroll_run_headers;
--   DROP TRIGGER IF EXISTS payroll_run_headers_history_guard ON public.payroll_run_headers;
--   DROP FUNCTION IF EXISTS public.payroll_run_headers_history_guard();
--   DROP FUNCTION IF EXISTS public.payroll_run_trusted_restore(regclass);
--   DROP FUNCTION IF EXISTS public.payroll_run_app_role();  (an earlier draft's; a no-op where it never existed)
--   DROP FUNCTION IF EXISTS public.payroll_off_cycle_paid_snapshot();
--   ALTER TABLE public.payroll_run_headers DROP COLUMN IF EXISTS off_cycle_paid_gross;
--   ALTER TABLE public.payroll_run_headers DROP COLUMN IF EXISTS off_cycle_payday_at;
--   and re-run 951's approval_request_document_facts definition.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

ALTER TABLE public.payroll_run_headers
  ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS public.payroll_off_cycle_employees (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES public.companies(id),
  run_id UUID NOT NULL REFERENCES public.payroll_run_headers(id) ON DELETE CASCADE,
  employee_id UUID NOT NULL REFERENCES public.payroll_employees(id),
  component_id UUID NULL REFERENCES public.payroll_components(id),
  amount NUMERIC(14, 2) NULL CHECK (amount IS NULL OR amount > 0),
  created_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT payroll_off_cycle_employees_bonus_input CHECK ((component_id IS NULL) = (amount IS NULL)),
  CONSTRAINT payroll_off_cycle_employees_one_per_run UNIQUE (run_id, employee_id)
);

COMMENT ON TABLE public.payroll_off_cycle_employees IS
  'Who an off-cycle pay run pays (999x, wave 6 OC): a bonus row carries its 3605 earning and amount; a termination row neither. Written at run creation; a bonus amount may be corrected while the run is a draft.';

CREATE INDEX IF NOT EXISTS payroll_off_cycle_employees_company_run ON public.payroll_off_cycle_employees (company_id, run_id);

-- The trusted ops identities a restore, a restore drill or a dev clone runs as (review #1679 ops M; fail closed, security
-- review of #1679 codex 5): a superuser; migration_admin; or the owner of the table the trigger fires on (`rel`,
-- TG_RELID). Production's deploy and restore connect as postgres, NOSUPERUSER on Supabase and the tables' owner (the
-- migration runner creates them as it), and CI's postgres migrates the same way before it is made a superuser. Exact
-- identities, not membership: postgres is a member of app_user (to SET ROLE), and inside SET ROLE app_user current_user
-- is app_user, and a member of the owner is not the owner. EVERY other role is bound on its own statements: the app's
-- (app_user, app_service, isaflow_app, isaflow_service), platform_admin, supabase_read_only_user and any role added
-- later. A foreign-key cascade is not the caller's statement: it runs as the referencing table's owner (see the
-- cascade limit at the history guard below).
CREATE OR REPLACE FUNCTION public.payroll_run_trusted_restore(rel regclass) RETURNS boolean
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT EXISTS (
    SELECT 1 FROM pg_catalog.pg_roles r
     WHERE r.rolname = current_user
       AND (r.rolsuper OR r.rolname = 'migration_admin'
            OR r.oid = (SELECT c.relowner FROM pg_catalog.pg_class c WHERE c.oid = rel))
  )
$$;

-- The deny-list it replaces (an earlier draft of this file; never on production or dev): gone, so nothing calls it.
DROP FUNCTION IF EXISTS public.payroll_run_app_role();

CREATE OR REPLACE FUNCTION public.payroll_off_cycle_employees_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  h record;
BEGIN
  SELECT run_kind, off_cycle_reason, status INTO h
    FROM public.payroll_run_headers WHERE id = NEW.run_id AND company_id = NEW.company_id;
  IF TG_OP = 'UPDATE' THEN
    IF NEW.company_id IS DISTINCT FROM OLD.company_id OR NEW.run_id IS DISTINCT FROM OLD.run_id
       OR NEW.employee_id IS DISTINCT FROM OLD.employee_id OR NEW.component_id IS DISTINCT FROM OLD.component_id THEN
      RAISE EXCEPTION 'payroll_off_cycle_employees: only the amount changes (same company, run, employee and earning)'
        USING ERRCODE = 'check_violation';
    END IF;
    -- Also held by the CHECK (amount > 0) and the NUMERIC(14, 2) column; stated here so the rule reads in one place.
    IF NEW.amount IS NULL OR NEW.amount <= 0 OR NEW.amount <> pg_catalog.round(NEW.amount, 2) THEN
      RAISE EXCEPTION 'payroll_off_cycle_employees: a bonus amount is more than R0, in whole cents' USING ERRCODE = 'check_violation';
    END IF;
    -- A draft only (delta L1): a calculated run's lines were costed on the old amount; the service sends the run back
    -- to draft and clears its lines before it changes an amount.
    IF NOT FOUND OR h.run_kind <> 'off_cycle' OR h.off_cycle_reason IS DISTINCT FROM 'bonus' OR h.status <> 'draft' THEN
      RAISE EXCEPTION 'payroll_off_cycle_employees: only a draft bonus run''s amount changes'
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  -- A trusted ops identity (review #1679 codex 5; payroll_run_trusted_restore, above) restores an input as written: a
  -- data-only restore (COPY fires this ALWAYS trigger, even in replica mode) brings back a run's inputs after its header
  -- has left draft, with their created_at. The run must still be this company's off-cycle run; every other role needs a draft.
  IF NOT FOUND OR h.run_kind <> 'off_cycle' OR (h.status <> 'draft' AND NOT public.payroll_run_trusted_restore(TG_RELID)) THEN
    RAISE EXCEPTION 'payroll_off_cycle_employees: the run is not a draft off-cycle run of this company'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.payroll_employees e WHERE e.id = NEW.employee_id AND e.company_id = NEW.company_id) THEN
    RAISE EXCEPTION 'payroll_off_cycle_employees: the employee is not this company''s' USING ERRCODE = 'foreign_key_violation';
  END IF;
  IF h.off_cycle_reason = 'bonus' THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.payroll_components c
       WHERE c.id = NEW.component_id AND c.company_id = NEW.company_id AND c.component_type = 'earning'
         AND pg_catalog.btrim(c.sars_source_code) = '3605'
    ) THEN
      RAISE EXCEPTION 'payroll_off_cycle_employees: a bonus row names one of this company''s 3605 earnings'
        USING ERRCODE = 'check_violation';
    END IF;
  ELSIF NEW.component_id IS NOT NULL THEN
    RAISE EXCEPTION 'payroll_off_cycle_employees: a termination row names no component' USING ERRCODE = 'check_violation';
  END IF;
  IF NOT public.payroll_run_trusted_restore(TG_RELID) THEN
    NEW.created_at := pg_catalog.clock_timestamp();
  END IF;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS payroll_off_cycle_employees_guard ON public.payroll_off_cycle_employees;
CREATE TRIGGER payroll_off_cycle_employees_guard BEFORE INSERT OR UPDATE ON public.payroll_off_cycle_employees
  FOR EACH ROW EXECUTE FUNCTION public.payroll_off_cycle_employees_guard();
ALTER TABLE public.payroll_off_cycle_employees ENABLE ALWAYS TRIGGER payroll_off_cycle_employees_guard;

-- What an off-cycle run paid each employee, as last approved (review #1679 M and L1): see WHAT above.
ALTER TABLE public.payroll_run_headers ADD COLUMN IF NOT EXISTS off_cycle_paid_gross JSONB NULL;
COMMENT ON COLUMN public.payroll_run_headers.off_cycle_paid_gross IS
  'Off-cycle runs (999x): each employee''s gross as last approved, {employee_id: gross}, taken by payroll_off_cycle_paid_snapshot when the run leaves approved (a reopen). Written by that trigger only.';
-- When an off-cycle run is paid, frozen at its first approval (review #1679 M5 security S1): app_user may write run_date,
-- so the snapshot never reads it. Written by payroll_off_cycle_paid_snapshot only (a trusted restore keeps it).
ALTER TABLE public.payroll_run_headers ADD COLUMN IF NOT EXISTS off_cycle_payday_at TIMESTAMPTZ NULL;
COMMENT ON COLUMN public.payroll_run_headers.off_cycle_payday_at IS
  'Off-cycle runs (999x): the end of payday (the start of the day after run_date, SAST) as at the run''s first approval. Written by payroll_off_cycle_paid_snapshot only.';
-- An off-cycle run approved before this column existed (an earlier apply of this file on a dev clone; production has
-- none): its payday from its pay date, so the fail-closed rule below does not refuse it. Run as the migration role, a
-- trusted identity, so the snapshot trigger keeps what is written.
UPDATE public.payroll_run_headers
   SET off_cycle_payday_at = ((run_date + 1)::timestamp AT TIME ZONE 'Africa/Johannesburg')
 WHERE run_kind = 'off_cycle' AND off_cycle_payday_at IS NULL AND run_date IS NOT NULL
   AND (status IN ('approved', 'paid') OR (approval_history IS NOT NULL AND NOT isempty(approval_history)));

CREATE OR REPLACE FUNCTION public.payroll_off_cycle_paid_snapshot() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  trusted boolean := public.payroll_run_trusted_restore(TG_RELID);
BEGIN
  -- Every role but a trusted ops identity (payroll_run_trusted_restore, review #1679 ops M, fail closed): that one
  -- restores or edits the columns as written; only a reopen (approved -> not approved) still snapshots for it.
  IF trusted
     AND NOT (TG_OP = 'UPDATE' AND OLD.run_kind = 'off_cycle' AND OLD.status = 'approved' AND NEW.status IS DISTINCT FROM 'approved'
              AND NEW.off_cycle_paid_gross IS NOT DISTINCT FROM OLD.off_cycle_paid_gross) THEN
    RETURN NEW;
  END IF;
  -- For every role but a trusted identity (a restore keeps what it writes), the facts the snapshot below reads are the
  -- trigger's own, never the statement's (review #1679 M5 security S1, S2; blind review H1, M1):
  --  * run_kind and off_cycle_reason are fixed at INSERT (a flip to 'regular' would step around these rules);
  --  * off_cycle_payday_at is never written by the statement (any run kind): NULL at INSERT, then frozen at an
  --    off-cycle run's first approval from its pay date BEFORE that statement (OLD.run_date; the start of the next day,
  --    SAST), and kept as it was after;
  --  * an off-cycle run's pay date is fixed from its first approval on: no change while or once approved (a frozen payday
  --    or an approval history), nor in the statement that approves it;
  --  * approved_at is the clock (clock_timestamp()) when an off-cycle run moves into approved or paid, or when an
  --    approved run with none is approved again (approvePayrollRun's stranded case); otherwise it stays as it was while
  --    approved, and is nil while not approved;
  --  * fail closed: an off-cycle run approved before (an approval history) with no frozen payday is neither approved nor
  --    reopened (its payday was lost below the service; restore it as a trusted identity), and one with no pay date is
  --    not approved at all.
  IF NOT trusted THEN
    IF TG_OP = 'UPDATE' AND (NEW.run_kind IS DISTINCT FROM OLD.run_kind OR NEW.off_cycle_reason IS DISTINCT FROM OLD.off_cycle_reason) THEN
      RAISE EXCEPTION 'payroll_run_headers: a pay run''s kind and off-cycle reason are fixed when it is created'
        USING ERRCODE = 'check_violation';
    END IF;
    NEW.off_cycle_payday_at := CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE OLD.off_cycle_payday_at END;
    IF NEW.run_kind = 'off_cycle' THEN
      IF TG_OP = 'INSERT' THEN
        NEW.approved_at := NULL;
      ELSE
        IF NEW.run_date IS DISTINCT FROM OLD.run_date
           AND (OLD.off_cycle_payday_at IS NOT NULL OR OLD.status IN ('approved', 'paid') OR NEW.status IN ('approved', 'paid')
                OR (OLD.approval_history IS NOT NULL AND NOT pg_catalog.isempty(OLD.approval_history))) THEN
          RAISE EXCEPTION 'payroll_run_headers: an off-cycle run''s pay date is fixed once it is approved'
            USING ERRCODE = 'check_violation';
        END IF;
        IF OLD.off_cycle_payday_at IS NULL AND OLD.approval_history IS NOT NULL AND NOT pg_catalog.isempty(OLD.approval_history)
           AND (OLD.status IN ('approved', 'paid')) IS DISTINCT FROM (NEW.status IN ('approved', 'paid')) THEN
          RAISE EXCEPTION 'payroll_run_headers: this off-cycle run was approved before but has no recorded payday, so it is not approved or reopened'
            USING ERRCODE = 'check_violation';
        END IF;
        -- No pay date, no payday to freeze: such a run is never approved (re-review L2: it would reopen uncapped).
        IF NEW.status IN ('approved', 'paid') AND OLD.status NOT IN ('approved', 'paid') AND (OLD.run_date IS NULL OR NEW.run_date IS NULL) THEN
          RAISE EXCEPTION 'payroll_run_headers: an off-cycle run with no pay date is not approved' USING ERRCODE = 'check_violation';
        END IF;
        IF NEW.status IN ('approved', 'paid') THEN
          NEW.approved_at := CASE WHEN OLD.status NOT IN ('approved', 'paid') OR OLD.approved_at IS NULL
                                  THEN pg_catalog.clock_timestamp() ELSE OLD.approved_at END;
          IF OLD.off_cycle_payday_at IS NULL AND OLD.status NOT IN ('approved', 'paid') THEN
            NEW.off_cycle_payday_at := ((OLD.run_date + 1)::timestamp AT TIME ZONE 'Africa/Johannesburg');
          END IF;
        ELSE
          NEW.approved_at := NULL;
        END IF;
      END IF;
    END IF;
  END IF;
  IF TG_OP = 'INSERT' THEN
    NEW.off_cycle_paid_gross := NULL;
    RETURN NEW;
  END IF;
  IF OLD.run_kind = 'off_cycle' AND OLD.status = 'approved' AND NEW.status IS DISTINCT FROM 'approved' THEN
    -- The gross approved for PAYMENT as of payday (review #1679 codex M5). payday ends at off_cycle_payday_at: the start
    -- of the day after the pay date, South African time, as at the first approval (a run is paid once its pay date has
    -- passed, payrollOffCycleCorrection).
    --  * Reopened from an approval given on or before payday (so every reopen before payday, and the first one after it:
    --    the lines that were paid): the snapshot is the lines now, replacing any earlier one (a pre-payday correction
    --    stands). Both times are the trigger's own (above): approved_at the clock's, payday frozen at the first approval.
    --  * Reopened after payday from an approval given after it (a correction of a paid run): never rises (review
    --    #1679b): per employee the LEAST of the snapshot and the lines; an employee absent from it stays nil. With no
    --    snapshot but an approval history it was lost below the service (review #1679d): every employee at nil, as
    --    payrollOffCycleCorrection.paidCaps fails closed.
    SELECT pg_catalog.jsonb_object_agg(s.employee_id::text,
             CASE WHEN OLD.approved_at <= OLD.off_cycle_payday_at THEN s.gross
                  WHEN OLD.off_cycle_paid_gross IS NULL
                       AND OLD.approval_history IS NOT NULL AND NOT pg_catalog.isempty(OLD.approval_history) THEN 0
                  WHEN OLD.off_cycle_paid_gross IS NULL THEN s.gross
                  ELSE LEAST(s.gross, COALESCE((OLD.off_cycle_paid_gross ->> s.employee_id::text)::numeric, 0)) END)
      INTO NEW.off_cycle_paid_gross
      FROM (SELECT l.employee_id, pg_catalog.sum(l.gross_pay) AS gross
              FROM public.payroll_run_lines l WHERE l.run_id = OLD.id GROUP BY l.employee_id) s;
    -- No frozen payday or no approval time (NULL): the replacing branch is false (fail closed).
    -- No lines (a run reopened with none): the existing snapshot stands.
    NEW.off_cycle_paid_gross := COALESCE(NEW.off_cycle_paid_gross, OLD.off_cycle_paid_gross);
  ELSE
    NEW.off_cycle_paid_gross := OLD.off_cycle_paid_gross;
  END IF;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS payroll_off_cycle_paid_snapshot ON public.payroll_run_headers;
CREATE TRIGGER payroll_off_cycle_paid_snapshot BEFORE INSERT OR UPDATE ON public.payroll_run_headers
  FOR EACH ROW EXECUTE FUNCTION public.payroll_off_cycle_paid_snapshot();
ALTER TABLE public.payroll_run_headers ENABLE ALWAYS TRIGGER payroll_off_cycle_paid_snapshot;

-- A run's approval history is never removed, invented or grown outside a reopen (reviews #1679d-f). For EVERY role but
-- the trusted ops identities (payroll_run_trusted_restore: a superuser such as supabase_admin, migration_admin, or the
-- table's owner, which is postgres, NOSUPERUSER on Supabase, the role the deploy migrates and restores as); fail closed,
-- so platform_admin's and any later role's own statements on payroll_run_headers are bound (security review of #1679).
-- Those identities are not bound, so a restore (COPY fires ALWAYS row triggers, and pg_restore --disable-triggers needs
-- a superuser), a restore drill or a dev clone still works (#1679 ops M).
-- CASCADE LIMIT (accepted, coordinator ruling on the 999x breaker of 5600db089c): payroll_run_headers.company_id is ON
-- DELETE CASCADE, and a cascade runs as the table's owner, a trusted identity. So deleting a COMPANY (platform_admin
-- holds DELETE on companies: a tenant or QA company delete) removes its approved headers with their history. That is
-- by design: deleting a tenant removes its whole history, as 999n's freeze exempts the same cascade (p_cascade_delete).
-- A direct DELETE of such a header by platform_admin is still refused (w6-oc-forge pins both).
--   DELETE  a header approved once (non-empty approval_history) is not deleted: cancel or reverse it instead.
--   INSERT  a new header carries no approval history and is not final (approved, paid).
--   UPDATE OF approval_history  append-only (the new value contains the old, #1679e), and it changes only in the
--     UPDATE that moves the run out of approved or paid, which is what reopenPayrollRun (its one writer) does (#1679f).
-- The Demo company stays exempt: scripts/lib/demoReseed reopens and wipes its runs, and may run under the app's role
-- (runOwnedContext); its money is not real.
-- ACCEPTED LIMITS (coordinator rulings 2026-11-19, wave 7):
--   * app_user can forge the approval path below the service: the real approve and reopen also run as app_user, so no
--     row trigger can tell them from a forged app_user statement (set status 'approved' and approved_at, then
--     "reopen" in one UPDATE that appends [approved_at, now)). Closed in wave 7 by moving approve and reopen into a
--     reviewed SECURITY DEFINER (930 registry) and revoking app_user's direct UPDATE of status and approval_history.
--     Tightened here: null-safe status comparisons, and the appended range must start at OLD.approved_at (or be
--     unbounded below for a grandfathered run).
--     The same path makes a REGULAR run "final" below the service (status approved with an approved_at or
--     approval_grandfathered_at, payRunFinalSql): every payRunFinalSql reader trusts it, the owner cash forecast too
--     (review #1679 M3: a final run past its pay date counts as paid). An off-cycle run's approved_at is the trigger's
--     own (payroll_off_cycle_paid_snapshot); a regular run's is not, until wave 7.
--   * The payday is the pay date at the first approval (off_cycle_payday_at): a run first approved with a far-future
--     pay date may be raised until that date, by the TS cap (paidCaps) and the snapshot alike. Closing it needs evidence
--     of payment (the bank file), not the pay date (re-review L1).
--   * A run approved once and never reopened has an empty history, so app_user may DELETE it and INSERT it again with
--     the same id, which resets its snapshot and payday (predates this file; re-review L3). Wave 7's "dual-member
--     payroll_run_headers DELETE" item closes it.
--   * Binding on current_user: inside SET LOCAL ROLE app_user, set_config('role', 'none', true) mid-statement shows
--     the trigger the pool's login role. With the pool on isaflow_app or isaflow_service that role is bound too (it is
--     not a trusted identity, and holds no header grant); with the pool still on postgres (the table owner) it is not,
--     but the owner can switch any trigger off anyway, so this is no weaker than 999n's freeze today. The same holds for
--     any code that connects as the owner without SET ROLE: the owner is trusted by design, as the restore identity.
CREATE OR REPLACE FUNCTION public.payroll_run_headers_history_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  co uuid := CASE WHEN TG_OP = 'INSERT' THEN NEW.company_id ELSE OLD.company_id END;
  added tstzmultirange;
BEGIN
  IF public.payroll_run_trusted_restore(TG_RELID) OR co = '00000000-0000-0000-0000-000000000001'::uuid THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW.approval_history IS DISTINCT FROM OLD.approval_history THEN
      IF OLD.approval_history IS NOT NULL AND NOT COALESCE(NEW.approval_history @> OLD.approval_history, false) THEN
        RAISE EXCEPTION 'payroll_run_headers: a pay run''s approval history is only added to, never rewritten or cleared'
          USING ERRCODE = 'check_violation';
      END IF;
      -- Null-safe: a NULL status never passes for a transition.
      IF NOT (COALESCE(OLD.status, '') IN ('approved', 'paid') AND COALESCE(NEW.status, '') NOT IN ('approved', 'paid')) THEN
        RAISE EXCEPTION 'payroll_run_headers: a pay run''s approval history grows only when the run is reopened'
          USING ERRCODE = 'check_violation';
      END IF;
      -- The range a reopen adds is the approval it ends: from OLD.approved_at, or unbounded below for a grandfathered
      -- run (no approved_at, approval_grandfathered_at set), as reopenPayrollRun writes it.
      added := NEW.approval_history - COALESCE(OLD.approval_history, '{}'::tstzmultirange);
      IF NOT pg_catalog.isempty(added) AND NOT (
           (OLD.approved_at IS NOT NULL AND NOT pg_catalog.lower_inf(added) AND pg_catalog.lower(added) = OLD.approved_at)
        OR (OLD.approved_at IS NULL AND OLD.approval_grandfathered_at IS NOT NULL AND pg_catalog.lower_inf(added))) THEN
        RAISE EXCEPTION 'payroll_run_headers: a reopen adds the approval it ends, from the run''s approved_at'
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    IF OLD.approval_history IS NOT NULL AND NOT pg_catalog.isempty(OLD.approval_history) THEN
      RAISE EXCEPTION 'payroll_run_headers: a pay run that was approved before is not deleted; cancel it instead'
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN OLD;
  END IF;
  IF (NEW.approval_history IS NOT NULL AND NOT pg_catalog.isempty(NEW.approval_history)) OR NEW.status IN ('approved', 'paid') THEN
    RAISE EXCEPTION 'payroll_run_headers: a new pay run starts without an approval history and is not final'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS payroll_run_headers_history_guard ON public.payroll_run_headers;
CREATE TRIGGER payroll_run_headers_history_guard BEFORE INSERT OR DELETE OR UPDATE OF approval_history ON public.payroll_run_headers
  FOR EACH ROW EXECUTE FUNCTION public.payroll_run_headers_history_guard();
ALTER TABLE public.payroll_run_headers ENABLE ALWAYS TRIGGER payroll_run_headers_history_guard;

ALTER TABLE public.payroll_off_cycle_employees ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payroll_off_cycle_employees FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON public.payroll_off_cycle_employees;
CREATE POLICY tenant_isolation ON public.payroll_off_cycle_employees FOR ALL TO app_user
  USING (company_id = app.current_company_id() AND company_id IN (SELECT auth.user_companies()))
  WITH CHECK (company_id = app.current_company_id() AND company_id IN (SELECT auth.user_companies()));
REVOKE ALL ON public.payroll_off_cycle_employees FROM app_user;
GRANT SELECT ON public.payroll_off_cycle_employees TO app_user;
GRANT INSERT (company_id, run_id, employee_id, component_id, amount, created_by) ON public.payroll_off_cycle_employees TO app_user;
GRANT UPDATE (amount) ON public.payroll_off_cycle_employees TO app_user;

CREATE OR REPLACE FUNCTION public.approval_request_document_facts(
  p_company_id pg_catalog.uuid, p_document_type pg_catalog.text, p_document_id pg_catalog.uuid
) RETURNS TABLE (amount pg_catalog.numeric, reference pg_catalog.text, digest pg_catalog.text)
LANGUAGE plpgsql STABLE
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF p_document_type = 'pay_run' THEN
    RETURN QUERY SELECT h.total_gross,
      pg_catalog.lpad(h.period_month::pg_catalog.text, 2, '0') || '/' || h.period_year::pg_catalog.text
        || CASE WHEN h.run_kind = 'off_cycle' THEN ' ' || COALESCE(h.off_cycle_reason, 'off-cycle') || ' run, paid '
             || pg_catalog.to_char(COALESCE(h.run_date, h.period_end), 'YYYY-MM-DD') ELSE '' END,
      h.approval_plan_hash
    FROM public.payroll_run_headers h
    WHERE h.id = p_document_id AND h.company_id = p_company_id
      AND h.prepared_by IS NOT NULL AND h.approval_plan_hash IS NOT NULL;
  ELSE
    RETURN QUERY SELECT f.amount, f.reference, f.digest
    FROM public.approval_request_document_facts_pre_payroll_951(
      p_company_id, p_document_type, p_document_id
    ) f;
  END IF;
END
$$;

REVOKE ALL ON FUNCTION public.approval_request_document_facts(
  pg_catalog.uuid, pg_catalog.text, pg_catalog.uuid) FROM PUBLIC;

SELECT public.app_service_sync_policies();
