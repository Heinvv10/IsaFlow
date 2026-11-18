-- 999n: the database refuses money changes the app never makes (wave 6 FZ).
--
-- WHY. PR #1524's breaker (BRK-3, D-1, E-1, E-2) showed app_user can move net pay on an approved run (even between
-- employees at the same total), move the header totals and drop its journal link, edit the posted payroll journal's
-- amounts, and insert a journal already 'posted' that trg_gl_je_balanced (BEFORE UPDATE only) never checks.
--
-- WHAT. State rules, never a rule on current_user: one that judges current_user is beaten by set_config('role', ...)
-- (memory: runtime-role guard). WHO IT BINDS (breaker M3): every non-superuser session, so app_user, migration_admin
-- and platform_admin are refused. Production's postgres (NOSUPERUSER) is refused too, but it OWNS these tables, and
-- an owner can switch a trigger off with ALTER TABLE: the freeze does not bind the table owner. Moving ownership off the
-- pool's login role is logged for wave 7. The one exemption is a SUPERUSER session (is_superuser), which can disable
-- any trigger anyway; production has none on its app, deploy or admin pools, and the integration fixtures' postgres
-- is one (it seeds shapes the app never writes). All triggers ENABLE ALWAYS, so session_replication_role = replica
-- does not skip them. One SECURITY DEFINER: payroll_run_final_state (read only, app_definer_reviews row below).
--   1. payroll_run_lines of a FINAL run (R-035 isPayRunFinal: status approved/paid AND approved_at or
--      approval_grandfathered_at set) take no INSERT, no DELETE, and no UPDATE except of payslip_snapshot
--      (PS3, 999k). A line moved INTO a final run is refused too. Finality is read past RLS by the definer (breaker
--      H4: an invoker read made a header the caller cannot see look "not final"), FOR SHARE, so a line write racing
--      an approval waits for it. It fails closed: a run_id naming no header counts as final, except the ON DELETE
--      CASCADE of a header delete (a DELETE fired inside another trigger with the header gone).
--   2. payroll_run_headers of a final run keep their figures and identity (company, period, run date, frequency,
--      kind, totals, employee count, posted_journal_entry_id). While the run stays approved/paid its approval stamps
--      cannot be moved (approved_at may only go NULL -> set, as re-approving a grandfathered run does;
--      approval_grandfathered_at not at all), or the freeze would lapse. While it stays approved/paid,
--      journal_entry_id may only go
--        NULL -> a posted, unreversed auto_payroll journal of the same company (postPayrollRunJournal), or
--        X -> NULL when X is no longer in force (reversed, not posted, or gone: approval's `replaces` unlink).
--      It leaves approved/paid only with both stamps cleared, as reopen does (breaker M1: cancel -> edit ->
--      re-approve kept the old approved_at), and never to 'cancelled' while its payroll journal is in force.
--   3. gl_journal_lines of a posted or reversed journal keep debit, credit, journal_entry_id and company_id.
--      gl_account_id and the dimensions stay writable: account merge and the VAT late-claim split move gl_account_id
--      on posted lines, and tagging moves cc1/cc2/bu (writer census, PR body). A posted or reversed journal takes no
--      added or removed line (breaker H2) unless it was created in this transaction (created_at = now(); year-end and
--      depreciation insert theirs so), cannot go back to 'draft', is not deleted (breaker B5), keeps created_at, and
--      a posted auto_payroll journal keeps its entry_date and company_id (breaker B6).
--   4. A posted or reversed journal whose line set changed must balance at COMMIT (a constraint trigger on
--      gl_journal_lines, DEFERRABLE INITIALLY DEFERRED), which covers a journal INSERTed already posted (E-1), and
--      any move INTO posted (reversed -> posted too, breaker H3) balances when it happens. No line count is
--      required (a posted header with no lines is 0 = 0), unlike trg_gl_je_balanced on draft -> posted, unchanged.
--      The check runs once per journal per firing, not once per line: an immediate per-row trigger keeps a
--      transaction-local list of journals written since their last check. Measured (fixture PG16, box load ~100),
--      deferred check of one born-posted journal as a non-superuser at 500 / 2 000 / 5 000 lines: once per line
--      46 / 586 / 3 857 ms (O(n^2)); deduped 5 / 7 / 17 ms, with the 5 000-line INSERT itself 167 ms against 146 ms
--      for an exempt superuser. 8 000 lines (breaker L1: 11.2 s before): check 22 / 26 ms, INSERT 363 / 449 ms
--      against 246 / 243 ms exempt (the added per-row line-set and list triggers).
--
-- DEMO. Demo holds no real money and is wiped by the reseed (wipePlan.ts:193/204). The Demo company
-- (00000000-0000-0000-0000-000000000001, a literal: no GUC, no role check) is exempt from the GL DELETE rules only (a posted
-- entry's delete, a posted line's delete): the Demo reseed wipes and rebuilds its ledger, and the app pool can become
-- any role and set any GUC, so a role or GUC exemption could be forged where a fixed company id cannot. The payroll
-- freeze has no Demo exemption: the reseed reopens its final runs before the wipe and finalises the new ones after
-- their lines (scripts/lib/demoReseed/payrollFinal.ts).
--
-- BOUNDARY (stated, not oversold). These stop a bug, a mis-wired path or one injected statement. Someone running
-- arbitrary SQL as app_user can still: reopen (status -> calculated, as the app does), edit, and re-approve; delete a
-- whole run header (its lines cascade); move a posted line's gl_account_id (merge_gl_accounts moves posted lines, so
-- the account is not frozen); set app.current_company_id to another tenant before COMMIT so rule 4's RLS-scoped read
-- sees nothing, or clear isaflow.fz_unchecked_journals after its last line write so rule 4 skips the journal; add or
-- remove BALANCED lines on a journal it created in the same transaction. The owner can disable the triggers (above).
-- Children of a run are NOT frozen (breaker L2): payroll_loan_payments, payroll_run_directive_uses and
-- tax_directive_payments.payroll_run_id stay writable; freezing them is logged for wave 7. Only privileges close
-- these.
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
--            No app path updates a posted line's amount, adds or deletes a line of a journal posted in an earlier
--            transaction, deletes a posted journal, or moves a journal back to draft.
--   reseed   an older colour's Demo reseed inserts paid runs before their lines, so 999n refuses it: the reseed is one
--            transaction and rolls back whole, leaving the Demo as it was, until the new colour's reseed runs.
--
-- LOCKS. No DROP TRIGGER (which takes ACCESS EXCLUSIVE even when there is nothing to drop): CREATE OR REPLACE
-- TRIGGER (PG14+), the constraint trigger only when absent, and ENABLE ALWAYS each take SHARE ROW EXCLUSIVE on the
-- four tables for an instant, bounded by lock_timeout. Measured in pg_locks, first run and re-run alike: exactly
-- ShareRowExclusiveLock on each of the four, nothing stronger. No scan, no backfill: rows are judged when next written.
--
-- Rollback:
--   DROP TRIGGER IF EXISTS trg_payroll_run_lines_final_frozen ON public.payroll_run_lines;
--   DROP TRIGGER IF EXISTS trg_payroll_run_headers_final_frozen ON public.payroll_run_headers;
--   DROP TRIGGER IF EXISTS trg_gl_jl_posted_frozen ON public.gl_journal_lines;
--   DROP TRIGGER IF EXISTS trg_gl_jl_posted_balanced ON public.gl_journal_lines;
--   DROP TRIGGER IF EXISTS trg_gl_jl_mark_unchecked ON public.gl_journal_lines;
--   DROP TRIGGER IF EXISTS trg_gl_jl_posted_set_frozen ON public.gl_journal_lines;
--   DROP TRIGGER IF EXISTS trg_gl_je_posted_frozen ON public.gl_journal_entries;
--   DROP TRIGGER IF EXISTS trg_gl_je_posted_no_delete ON public.gl_journal_entries;
--   DROP FUNCTION IF EXISTS public.payroll_run_is_final(uuid, boolean), public.payroll_run_final_state(uuid),
--     public.payroll_run_lines_final_frozen(), public.payroll_run_headers_final_frozen(), public.gl_journal_is_posted(uuid),
--     public.gl_jl_posted_frozen(), public.gl_jl_posted_set_frozen(), public.gl_je_posted_frozen(),
--     public.gl_je_posted_no_delete(), public.gl_posted_journal_balanced(), public.gl_jl_mark_unchecked();
--   DELETE FROM public.app_definer_reviews WHERE signature = 'payroll_run_final_state(uuid)';

SET LOCAL lock_timeout = '5s';

-- ── 1. payroll_run_lines ────────────────────────────────────────────────────────────────────────────────────────

-- Finality is read past RLS (breaker H4): payroll_run_headers forces RLS, so an invoker-rights read made a header the
-- caller cannot see (no claims, another tenant) look "not final". SECURITY DEFINER owned by migration_admin
-- (BYPASSRLS), pinned search_path, reads one row, writes nothing. NULL when the header does not exist.
CREATE OR REPLACE FUNCTION public.payroll_run_final_state(p_run uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
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
  RETURN v_final;
END
$$;
ALTER FUNCTION public.payroll_run_final_state(uuid) OWNER TO migration_admin;
REVOKE ALL ON FUNCTION public.payroll_run_final_state(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.payroll_run_final_state(uuid) TO PUBLIC;

INSERT INTO public.app_definer_reviews (signature, writes, body_md5)
SELECT 'payroll_run_final_state(uuid)',
       'none: reads one payroll_run_headers row FOR SHARE (status, approved_at, approval_grandfathered_at) past RLS so the 999n line freeze judges finality for every caller; returns NULL for a missing header',
       public.app_definer_hash('public.payroll_run_final_state(uuid)'::regprocedure)
ON CONFLICT (signature) DO UPDATE SET writes = EXCLUDED.writes, body_md5 = EXCLUDED.body_md5;

-- Final, failing closed: a line with a run_id whose header is missing counts as final, except a DELETE fired from
-- inside another trigger with the header gone, which is the ON DELETE CASCADE of a header delete.
CREATE OR REPLACE FUNCTION public.payroll_run_is_final(p_run uuid, p_cascade_delete boolean DEFAULT false)
RETURNS boolean
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_final boolean;
BEGIN
  IF p_run IS NULL THEN
    RETURN false;
  END IF;
  v_final := public.payroll_run_final_state(p_run);
  IF v_final IS NULL THEN
    RETURN NOT p_cascade_delete;
  END IF;
  RETURN v_final;
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
    IF public.payroll_run_is_final(OLD.run_id, pg_trigger_depth() > 1) THEN
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

CREATE OR REPLACE TRIGGER trg_payroll_run_lines_final_frozen
  BEFORE INSERT OR UPDATE OR DELETE ON public.payroll_run_lines
  FOR EACH ROW EXECUTE FUNCTION public.payroll_run_lines_final_frozen();
ALTER TABLE public.payroll_run_lines ENABLE ALWAYS TRIGGER trg_payroll_run_lines_final_frozen;

-- ── 2. payroll_run_headers ──────────────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.payroll_run_headers_final_frozen()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_journal_in_force boolean;
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
  v_journal_in_force := EXISTS (SELECT 1 FROM public.gl_journal_entries e
                                 WHERE e.id = OLD.journal_entry_id AND e.status = 'posted' AND e.reversed_at IS NULL);
  -- Leaving final (breaker M1): the stamps go with it, as reopen clears them, so no later hop back to approved can
  -- reuse the old approval; and a run whose payroll journal is in force is not cancelled.
  IF NEW.status NOT IN ('approved', 'paid') THEN
    IF NEW.approved_at IS NOT NULL OR NEW.approval_grandfathered_at IS NOT NULL THEN
      RAISE EXCEPTION 'payroll_run_headers: a final pay run leaves approval only with its approval stamps cleared'
        USING ERRCODE = '23514';
    END IF;
    IF NEW.status = 'cancelled' AND v_journal_in_force THEN
      RAISE EXCEPTION 'payroll_run_headers: a final pay run with its payroll journal in force cannot be cancelled (reopen and reverse it first)'
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF (OLD.approved_at IS NOT NULL AND NEW.approved_at IS DISTINCT FROM OLD.approved_at)
     OR NEW.approval_grandfathered_at IS DISTINCT FROM OLD.approval_grandfathered_at THEN
    RAISE EXCEPTION 'payroll_run_headers: a final pay run''s approval stamps are frozen while it stays approved'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.journal_entry_id IS DISTINCT FROM OLD.journal_entry_id THEN
    IF OLD.journal_entry_id IS NOT NULL AND NEW.journal_entry_id IS NOT NULL THEN
      RAISE EXCEPTION 'payroll_run_headers: a final pay run''s journal cannot be swapped' USING ERRCODE = '23514';
    END IF;
    IF NEW.journal_entry_id IS NOT NULL AND NOT EXISTS (
         SELECT 1 FROM public.gl_journal_entries e
          WHERE e.id = NEW.journal_entry_id AND e.company_id = NEW.company_id AND e.source = 'auto_payroll'
            AND e.status = 'posted' AND e.reversed_at IS NULL) THEN
      RAISE EXCEPTION 'payroll_run_headers: a final pay run links only its own posted payroll journal' USING ERRCODE = '23514';
    END IF;
    IF NEW.journal_entry_id IS NULL AND v_journal_in_force THEN
      RAISE EXCEPTION 'payroll_run_headers: a final pay run''s journal in force cannot be unlinked (reopen and reverse it first)'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END
$$;

CREATE OR REPLACE TRIGGER trg_payroll_run_headers_final_frozen
  BEFORE UPDATE ON public.payroll_run_headers
  FOR EACH ROW EXECUTE FUNCTION public.payroll_run_headers_final_frozen();
ALTER TABLE public.payroll_run_headers ENABLE ALWAYS TRIGGER trg_payroll_run_headers_final_frozen;

-- ── 3. gl_journal_lines / gl_journal_entries: posted journals frozen ────────────────────────────────────────────

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

CREATE OR REPLACE TRIGGER trg_gl_jl_posted_frozen
  BEFORE UPDATE ON public.gl_journal_lines
  FOR EACH ROW
  WHEN (NEW.debit IS DISTINCT FROM OLD.debit OR NEW.credit IS DISTINCT FROM OLD.credit
        OR NEW.journal_entry_id IS DISTINCT FROM OLD.journal_entry_id OR NEW.company_id IS DISTINCT FROM OLD.company_id)
  EXECUTE FUNCTION public.gl_jl_posted_frozen();
ALTER TABLE public.gl_journal_lines ENABLE ALWAYS TRIGGER trg_gl_jl_posted_frozen;

-- A posted or reversed journal's line set (breaker H2): no line added or removed, unless the journal was created in
-- this transaction (created_at = now(), the transaction's start; created_at is frozen once posted, below), which is
-- how year-end and depreciation insert theirs. A line DELETE whose journal is gone is the ON DELETE CASCADE of an
-- entry delete, judged by the entry rule. The Demo company (00000000-0000-0000-0000-000000000001) is exempt from the DELETE half only: the
-- Demo reseed wipes and rebuilds its ledger.
CREATE OR REPLACE FUNCTION public.gl_jl_posted_set_frozen()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_entry uuid;
BEGIN
  IF current_setting('is_superuser') = 'on' THEN
    RETURN CASE TG_OP WHEN 'DELETE' THEN OLD ELSE NEW END;
  END IF;
  IF TG_OP = 'DELETE' THEN
    v_entry := OLD.journal_entry_id;
    IF OLD.company_id = '00000000-0000-0000-0000-000000000001'::uuid THEN
      RETURN OLD;
    END IF;
  ELSE
    v_entry := NEW.journal_entry_id;
  END IF;
  IF EXISTS (SELECT 1 FROM public.gl_journal_entries e
              WHERE e.id = v_entry AND e.status IN ('posted', 'reversed') AND e.created_at IS DISTINCT FROM now()) THEN
    RAISE EXCEPTION 'gl_journal_lines: a posted journal''s lines cannot be added or removed (reverse it instead)'
      USING ERRCODE = '23514';
  END IF;
  RETURN CASE TG_OP WHEN 'DELETE' THEN OLD ELSE NEW END;
END
$$;

CREATE OR REPLACE TRIGGER trg_gl_jl_posted_set_frozen
  BEFORE INSERT OR DELETE ON public.gl_journal_lines
  FOR EACH ROW EXECUTE FUNCTION public.gl_jl_posted_set_frozen();
ALTER TABLE public.gl_journal_lines ENABLE ALWAYS TRIGGER trg_gl_jl_posted_set_frozen;

-- A posted or reversed entry: never back to draft; created_at frozen (the born-here test above reads it); a payroll
-- journal keeps its date and company (breaker B6/M2); any move INTO posted balances its lines (breaker H3: a
-- reversed -> posted hop skipped trg_gl_je_balanced, which judges draft -> posted only).
CREATE OR REPLACE FUNCTION public.gl_je_posted_frozen()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_debit numeric;
  v_credit numeric;
BEGIN
  IF current_setting('is_superuser') = 'on' THEN
    RETURN NEW;
  END IF;
  IF OLD.status IN ('posted', 'reversed') THEN
    IF NEW.status = 'draft' THEN
      RAISE EXCEPTION 'gl_journal_entries: a posted journal cannot go back to draft (reverse it instead)' USING ERRCODE = '23514';
    END IF;
    IF NEW.created_at IS DISTINCT FROM OLD.created_at THEN
      RAISE EXCEPTION 'gl_journal_entries: a posted journal''s created_at is frozen' USING ERRCODE = '23514';
    END IF;
    IF OLD.source = 'auto_payroll'
       AND (NEW.entry_date, NEW.company_id, NEW.source) IS DISTINCT FROM (OLD.entry_date, OLD.company_id, OLD.source) THEN
      RAISE EXCEPTION 'gl_journal_entries: a posted payroll journal keeps its date and company (reverse it instead)'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  IF NEW.status = 'posted' AND OLD.status IS DISTINCT FROM 'posted' THEN
    SELECT COALESCE(SUM(l.debit), 0), COALESCE(SUM(l.credit), 0) INTO v_debit, v_credit
      FROM public.gl_journal_lines l WHERE l.journal_entry_id = NEW.id;
    IF v_debit <> v_credit THEN
      RAISE EXCEPTION 'gl_journal_entries: posted journal % does not balance: debit=% credit=%', NEW.id, v_debit, v_credit
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END
$$;

CREATE OR REPLACE TRIGGER trg_gl_je_posted_frozen
  BEFORE UPDATE ON public.gl_journal_entries
  FOR EACH ROW
  WHEN (OLD.status IN ('posted', 'reversed') OR NEW.status = 'posted')
  EXECUTE FUNCTION public.gl_je_posted_frozen();
ALTER TABLE public.gl_journal_entries ENABLE ALWAYS TRIGGER trg_gl_je_posted_frozen;

-- A posted or reversed entry is not deleted (breaker B5: its lines went with it by cascade). Demo is exempt (reseed).
CREATE OR REPLACE FUNCTION public.gl_je_posted_no_delete()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF current_setting('is_superuser') = 'on' OR OLD.company_id = '00000000-0000-0000-0000-000000000001'::uuid THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'gl_journal_entries: a posted journal cannot be deleted (reverse it instead)' USING ERRCODE = '23514';
END
$$;

CREATE OR REPLACE TRIGGER trg_gl_je_posted_no_delete
  BEFORE DELETE ON public.gl_journal_entries
  FOR EACH ROW
  WHEN (OLD.status IN ('posted', 'reversed'))
  EXECUTE FUNCTION public.gl_je_posted_no_delete();
ALTER TABLE public.gl_journal_entries ENABLE ALWAYS TRIGGER trg_gl_je_posted_no_delete;

-- ── 4. a posted or reversed journal whose line set changed balances at COMMIT ──────────────────────────────────

CREATE OR REPLACE FUNCTION public.gl_posted_journal_balanced()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_entry uuid;
  v_debit numeric;
  v_credit numeric;
  v_unchecked text;
BEGIN
  IF current_setting('is_superuser') = 'on' THEN
    RETURN NULL;
  END IF;
  IF TG_OP = 'DELETE' THEN
    v_entry := OLD.journal_entry_id;
  ELSE
    v_entry := NEW.journal_entry_id;
  END IF;
  -- One check per journal per firing: the first queued event checks it and takes it off the unchecked list, the
  -- rest of that journal's events skip. A line written after that check puts it back (gl_jl_mark_unchecked).
  v_unchecked := COALESCE(current_setting('isaflow.fz_unchecked_journals', true), '');
  IF strpos(v_unchecked, v_entry::text) = 0 THEN
    RETURN NULL;
  END IF;
  PERFORM set_config('isaflow.fz_unchecked_journals', replace(v_unchecked, v_entry::text || ',', ''), true);
  IF NOT EXISTS (SELECT 1 FROM public.gl_journal_entries e WHERE e.id = v_entry AND e.status IN ('posted', 'reversed')) THEN
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

-- The unchecked list: every line INSERT or DELETE (immediate, per row) puts its journal on a transaction-local
-- list, so the deferred check runs once per journal per firing instead of once per line (a 5 000-line journal
-- went from O(n^2) to O(n); timing in the header). A savepoint rollback reverts the list with the lines it covered.
CREATE OR REPLACE FUNCTION public.gl_jl_mark_unchecked()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_entry text;
  v_unchecked text;
BEGIN
  IF current_setting('is_superuser') = 'on' THEN
    RETURN NULL;
  END IF;
  IF TG_OP = 'DELETE' THEN
    v_entry := OLD.journal_entry_id::text;
  ELSE
    v_entry := NEW.journal_entry_id::text;
  END IF;
  v_unchecked := COALESCE(current_setting('isaflow.fz_unchecked_journals', true), '');
  IF strpos(v_unchecked, v_entry) = 0 THEN
    PERFORM set_config('isaflow.fz_unchecked_journals', v_unchecked || v_entry || ',', true);
  END IF;
  RETURN NULL;
END
$$;

CREATE OR REPLACE TRIGGER trg_gl_jl_mark_unchecked
  AFTER INSERT OR DELETE ON public.gl_journal_lines
  FOR EACH ROW
  EXECUTE FUNCTION public.gl_jl_mark_unchecked();
ALTER TABLE public.gl_journal_lines ENABLE ALWAYS TRIGGER trg_gl_jl_mark_unchecked;

-- PG has no CREATE OR REPLACE for a constraint trigger, and DROP TRIGGER IF EXISTS would take ACCESS EXCLUSIVE on
-- gl_journal_lines even when there is nothing to drop. So it is created only when absent (a static statement, no
-- dynamic SQL); a re-run keeps the existing one, whose definition is this one.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_trigger
                  WHERE tgrelid = 'public.gl_journal_lines'::regclass AND tgname = 'trg_gl_jl_posted_balanced') THEN
    CREATE CONSTRAINT TRIGGER trg_gl_jl_posted_balanced
      AFTER INSERT OR DELETE ON public.gl_journal_lines
      DEFERRABLE INITIALLY DEFERRED
      FOR EACH ROW
      EXECUTE FUNCTION public.gl_posted_journal_balanced();
  END IF;
END
$$;
ALTER TABLE public.gl_journal_lines ENABLE ALWAYS TRIGGER trg_gl_jl_posted_balanced;
