-- 999n: the database refuses money changes the app never makes (wave 6 FZ).
--
-- WHY. PR #1524's breaker (BRK-3, D-1, E-1, E-2) showed app_user can move net pay on an approved run (even between
-- employees at the same total), move the header totals and drop its journal link, edit the posted payroll journal's
-- amounts, and insert a journal already 'posted' that trg_gl_je_balanced (BEFORE UPDATE only) never checks.
--
-- WHAT. Four rules, each a STATE rule binding every role (app_user, postgres, migration_admin, platform_admin), never
-- a rule on current_user: one that judges current_user is beaten by set_config('role', ...) (memory: runtime-role
-- guard). The one exemption is a SUPERUSER session (is_superuser): a superuser can DISABLE any trigger anyway, so
-- exempting one gives nothing away. Production's app, deploy and admin pools are not superusers (postgres there is
-- NOSUPERUSER; migration 872's lesson), so every production writer is bound; the integration fixtures' postgres is a
-- superuser and keeps seeding shapes the app never writes (one-sided posted journals, lines of approved runs).
-- All triggers ENABLE ALWAYS, so session_replication_role = replica does not skip them. No SECURITY DEFINER.
--   1. payroll_run_lines of a FINAL run (R-035 isPayRunFinal: status approved/paid AND approved_at or
--      approval_grandfathered_at set) take no INSERT, no DELETE, and no UPDATE except of payslip_snapshot
--      (PS3, 999k). A line moved INTO a final run is refused too. A line whose header is gone (a header delete's
--      cascade) is not judged. The header is read FOR SHARE, so a line write racing an approval waits for it.
--   2. payroll_run_headers of a final run keep their figures and identity (company, period, run date, frequency,
--      kind, totals, employee count, posted_journal_entry_id). While the run stays approved/paid its approval stamps
--      cannot be moved (approved_at may only go NULL -> set, as re-approving a grandfathered run does;
--      approval_grandfathered_at not at all), or the freeze would lapse. While it stays approved/paid,
--      journal_entry_id may only go
--        NULL -> a posted, unreversed auto_payroll journal of the same company (postPayrollRunJournal), or
--        X -> NULL when X is no longer in force (reversed, not posted, or gone: approval's `replaces` unlink).
--      Status itself is not frozen: reopen (approved -> calculated) is the app's way out, and it clears the stamps.
--   3. gl_journal_lines of a posted or reversed journal keep debit, credit, journal_entry_id and company_id.
--      gl_account_id and the dimensions stay writable: account merge and the VAT late-claim split move gl_account_id
--      on posted lines, and tagging moves cc1/cc2/bu (writer census, PR body). A posted or reversed journal cannot
--      go back to 'draft'.
--   4. A posted journal that gains or loses a line must balance at COMMIT (a constraint trigger on gl_journal_lines,
--      DEFERRABLE INITIALLY DEFERRED). That covers a journal INSERTed already posted: its lines arrive after it, and
--      the year-end and depreciation posters add them in the same transaction. No line count is required (a posted header with no lines is
--      0 = 0), unlike trg_gl_je_balanced on the draft -> posted UPDATE, which is unchanged.
--
-- BOUNDARY (stated, not oversold). These stop a bug, a mis-wired path or one injected statement. Someone running
-- arbitrary SQL as app_user can still reopen (status -> calculated, as the app does), edit, and re-approve; can delete
-- a whole run header; and can set app.current_company_id to another tenant before COMMIT so rule 4's RLS-scoped read
-- sees nothing. Rule 4 also admits a BALANCED pair of lines added to a posted journal. Only privileges close those.
--
-- OLD COLOUR (the release before this one, against this schema). Writer census in the PR body:
--   lines    calculate DELETEs and re-INSERTs lines only while the run is not approved/paid/cancelled
--            (saveCalculatedRunTotals' predicate under the header lock); nothing else writes a line. A pre-PS3 colour
--            writes no payslip_snapshot at all.
--   headers  approve writes status and stamps (approved_at kept when already set), links the journal it just posted
--            (NULL -> posted auto_payroll), and unlinks only a journal whose chain is out of the ledger; reopen moves
--            status to calculated with the stamps; the plan-hash writers touch approval_plan_hash only. All allowed.
--   GL       every poster inserts drafts and UPDATEs to posted (trg_gl_je_balanced), or inserts posted with balanced
--            lines in one transaction (year-end, depreciation); merge/late-claim/tagging write account and dimensions.
--            No app path updates a posted line's amount, deletes a posted line, or moves a journal back to draft.
--
-- LOCKS. CREATE TRIGGER takes SHARE ROW EXCLUSIVE on each table for an instant; bounded by lock_timeout. No scan,
-- no backfill: existing rows are judged only when next written.
--
-- Rollback:
--   DROP TRIGGER IF EXISTS trg_payroll_run_lines_final_frozen ON public.payroll_run_lines;
--   DROP TRIGGER IF EXISTS trg_payroll_run_headers_final_frozen ON public.payroll_run_headers;
--   DROP TRIGGER IF EXISTS trg_gl_jl_posted_frozen ON public.gl_journal_lines;
--   DROP TRIGGER IF EXISTS trg_gl_jl_posted_balanced ON public.gl_journal_lines;
--   DROP TRIGGER IF EXISTS trg_gl_je_posted_not_draft ON public.gl_journal_entries;
--   DROP FUNCTION IF EXISTS public.payroll_run_is_final(uuid), public.payroll_run_lines_final_frozen(),
--     public.payroll_run_headers_final_frozen(), public.gl_journal_is_posted(uuid), public.gl_jl_posted_frozen(),
--     public.gl_je_posted_not_draft(), public.gl_posted_journal_balanced();

SET LOCAL lock_timeout = '5s';

-- ── 1. payroll_run_lines ────────────────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.payroll_run_is_final(p_run uuid)
RETURNS boolean
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_final boolean;
BEGIN
  SELECT h.status IN ('approved', 'paid') AND COALESCE(h.approved_at, h.approval_grandfathered_at) IS NOT NULL
    INTO v_final
    FROM public.payroll_run_headers h
   WHERE h.id = p_run
     FOR SHARE;
  RETURN COALESCE(v_final, false);
END
$$;

CREATE OR REPLACE FUNCTION public.payroll_run_lines_final_frozen()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF current_setting('is_superuser') = 'on' THEN
    RETURN CASE TG_OP WHEN 'DELETE' THEN OLD ELSE NEW END;
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF public.payroll_run_is_final(NEW.run_id) THEN
      RAISE EXCEPTION 'payroll_run_lines: a final pay run takes no new line (reopen it first)' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    IF public.payroll_run_is_final(OLD.run_id) THEN
      RAISE EXCEPTION 'payroll_run_lines: a final pay run''s line cannot be deleted (reopen it first)' USING ERRCODE = '23514';
    END IF;
    RETURN OLD;
  END IF;
  IF (to_jsonb(NEW) - 'payslip_snapshot') IS DISTINCT FROM (to_jsonb(OLD) - 'payslip_snapshot')
     AND (public.payroll_run_is_final(OLD.run_id)
          OR (NEW.run_id IS DISTINCT FROM OLD.run_id AND public.payroll_run_is_final(NEW.run_id))) THEN
    RAISE EXCEPTION 'payroll_run_lines: a final pay run''s figures are frozen (reopen it first)' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS trg_payroll_run_lines_final_frozen ON public.payroll_run_lines;
CREATE TRIGGER trg_payroll_run_lines_final_frozen
  BEFORE INSERT OR UPDATE OR DELETE ON public.payroll_run_lines
  FOR EACH ROW EXECUTE FUNCTION public.payroll_run_lines_final_frozen();
ALTER TABLE public.payroll_run_lines ENABLE ALWAYS TRIGGER trg_payroll_run_lines_final_frozen;

-- ── 2. payroll_run_headers ──────────────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.payroll_run_headers_final_frozen()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF current_setting('is_superuser') = 'on' THEN
    RETURN NEW;
  END IF;
  IF NOT (OLD.status IN ('approved', 'paid') AND COALESCE(OLD.approved_at, OLD.approval_grandfathered_at) IS NOT NULL) THEN
    RETURN NEW;
  END IF;
  IF (NEW.company_id, NEW.period_year, NEW.period_month, NEW.run_date, NEW.pay_frequency, NEW.run_kind,
      NEW.period_start, NEW.period_end, NEW.total_gross, NEW.total_taxable, NEW.total_paye, NEW.total_uif,
      NEW.total_sdl, NEW.total_eti, NEW.total_net, NEW.employee_count, NEW.posted_journal_entry_id)
     IS DISTINCT FROM
     (OLD.company_id, OLD.period_year, OLD.period_month, OLD.run_date, OLD.pay_frequency, OLD.run_kind,
      OLD.period_start, OLD.period_end, OLD.total_gross, OLD.total_taxable, OLD.total_paye, OLD.total_uif,
      OLD.total_sdl, OLD.total_eti, OLD.total_net, OLD.employee_count, OLD.posted_journal_entry_id) THEN
    RAISE EXCEPTION 'payroll_run_headers: a final pay run''s figures are frozen (reopen it first)' USING ERRCODE = '23514';
  END IF;
  IF NEW.status IN ('approved', 'paid')
     AND ((OLD.approved_at IS NOT NULL AND NEW.approved_at IS DISTINCT FROM OLD.approved_at)
          OR NEW.approval_grandfathered_at IS DISTINCT FROM OLD.approval_grandfathered_at) THEN
    RAISE EXCEPTION 'payroll_run_headers: a final pay run''s approval stamps are frozen while it stays approved'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.status IN ('approved', 'paid') AND NEW.journal_entry_id IS DISTINCT FROM OLD.journal_entry_id THEN
    IF OLD.journal_entry_id IS NOT NULL AND NEW.journal_entry_id IS NOT NULL THEN
      RAISE EXCEPTION 'payroll_run_headers: a final pay run''s journal cannot be swapped' USING ERRCODE = '23514';
    END IF;
    IF NEW.journal_entry_id IS NOT NULL AND NOT EXISTS (
         SELECT 1 FROM public.gl_journal_entries e
          WHERE e.id = NEW.journal_entry_id AND e.company_id = NEW.company_id AND e.source = 'auto_payroll'
            AND e.status = 'posted' AND e.reversed_at IS NULL) THEN
      RAISE EXCEPTION 'payroll_run_headers: a final pay run links only its own posted payroll journal' USING ERRCODE = '23514';
    END IF;
    IF NEW.journal_entry_id IS NULL AND EXISTS (
         SELECT 1 FROM public.gl_journal_entries e
          WHERE e.id = OLD.journal_entry_id AND e.status = 'posted' AND e.reversed_at IS NULL) THEN
      RAISE EXCEPTION 'payroll_run_headers: a final pay run''s journal in force cannot be unlinked (reopen and reverse it first)'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS trg_payroll_run_headers_final_frozen ON public.payroll_run_headers;
CREATE TRIGGER trg_payroll_run_headers_final_frozen
  BEFORE UPDATE ON public.payroll_run_headers
  FOR EACH ROW EXECUTE FUNCTION public.payroll_run_headers_final_frozen();
ALTER TABLE public.payroll_run_headers ENABLE ALWAYS TRIGGER trg_payroll_run_headers_final_frozen;

-- ── 3. gl_journal_lines / gl_journal_entries: posted amounts frozen ─────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.gl_journal_is_posted(p_entry uuid)
RETURNS boolean
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  RETURN EXISTS (SELECT 1 FROM public.gl_journal_entries e WHERE e.id = p_entry AND e.status IN ('posted', 'reversed'));
END
$$;

CREATE OR REPLACE FUNCTION public.gl_jl_posted_frozen()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF current_setting('is_superuser') = 'on' THEN
    RETURN NEW;
  END IF;
  IF public.gl_journal_is_posted(OLD.journal_entry_id)
     OR (NEW.journal_entry_id IS DISTINCT FROM OLD.journal_entry_id AND public.gl_journal_is_posted(NEW.journal_entry_id)) THEN
    RAISE EXCEPTION 'gl_journal_lines: a posted journal''s amounts are frozen (reverse it instead)' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS trg_gl_jl_posted_frozen ON public.gl_journal_lines;
CREATE TRIGGER trg_gl_jl_posted_frozen
  BEFORE UPDATE ON public.gl_journal_lines
  FOR EACH ROW
  WHEN (NEW.debit IS DISTINCT FROM OLD.debit OR NEW.credit IS DISTINCT FROM OLD.credit
        OR NEW.journal_entry_id IS DISTINCT FROM OLD.journal_entry_id OR NEW.company_id IS DISTINCT FROM OLD.company_id)
  EXECUTE FUNCTION public.gl_jl_posted_frozen();
ALTER TABLE public.gl_journal_lines ENABLE ALWAYS TRIGGER trg_gl_jl_posted_frozen;

CREATE OR REPLACE FUNCTION public.gl_je_posted_not_draft()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF current_setting('is_superuser') = 'on' THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'gl_journal_entries: a posted journal cannot go back to draft (reverse it instead)' USING ERRCODE = '23514';
END
$$;

DROP TRIGGER IF EXISTS trg_gl_je_posted_not_draft ON public.gl_journal_entries;
CREATE TRIGGER trg_gl_je_posted_not_draft
  BEFORE UPDATE OF status ON public.gl_journal_entries
  FOR EACH ROW
  WHEN (OLD.status IN ('posted', 'reversed') AND NEW.status = 'draft')
  EXECUTE FUNCTION public.gl_je_posted_not_draft();
ALTER TABLE public.gl_journal_entries ENABLE ALWAYS TRIGGER trg_gl_je_posted_not_draft;

-- ── 4. a journal born posted, or a posted journal's line set changed, balances at COMMIT ───────────────────────

CREATE OR REPLACE FUNCTION public.gl_posted_journal_balanced()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_entry uuid;
  v_debit numeric;
  v_credit numeric;
BEGIN
  IF current_setting('is_superuser') = 'on' THEN
    RETURN NULL;
  END IF;
  IF TG_OP = 'DELETE' THEN
    v_entry := OLD.journal_entry_id;
  ELSE
    v_entry := NEW.journal_entry_id;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.gl_journal_entries e WHERE e.id = v_entry AND e.status = 'posted') THEN
    RETURN NULL;
  END IF;
  SELECT COALESCE(SUM(l.debit), 0), COALESCE(SUM(l.credit), 0) INTO v_debit, v_credit
    FROM public.gl_journal_lines l WHERE l.journal_entry_id = v_entry;
  IF v_debit <> v_credit THEN
    RAISE EXCEPTION 'gl_journal_entries: posted journal % does not balance: debit=% credit=%', v_entry, v_debit, v_credit
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END
$$;

DROP TRIGGER IF EXISTS trg_gl_jl_posted_balanced ON public.gl_journal_lines;
CREATE CONSTRAINT TRIGGER trg_gl_jl_posted_balanced
  AFTER INSERT OR DELETE ON public.gl_journal_lines
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  EXECUTE FUNCTION public.gl_posted_journal_balanced();
ALTER TABLE public.gl_journal_lines ENABLE ALWAYS TRIGGER trg_gl_jl_posted_balanced;
