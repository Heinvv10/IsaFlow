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
-- does not skip them. Three SECURITY DEFINERs, owned by migration_admin, each with an app_definer_reviews row:
-- payroll_run_final_state (read only) and the two rule-4 queue trigger functions.
--   1. payroll_run_lines of a FINAL run (R-035 isPayRunFinal: status approved/paid AND approved_at or
--      approval_grandfathered_at set) take no INSERT, no DELETE, and no UPDATE except of payslip_snapshot
--      (PS3, 999k). A line moved INTO a final run is refused too. Finality is read past RLS by the definer (breaker
--      H4), FOR SHARE, so a line write racing an approval waits for it. Before any lock it applies the header's RLS
--      test to the caller (breaker D1): a header the caller's role could not see answers "final" unlocked, so another
--      tenant learns nothing, blocks nothing, and writes nothing. It fails closed: a run_id naming no header counts
--      as final, except the ON DELETE CASCADE of a header delete (a DELETE fired inside another trigger). EXECUTE
--      only for the line writers (app_user, platform_admin, postgres; migration_admin owns it).
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
--      depreciation insert theirs so); a line DELETE is judged by its ENTRY's company (X1). The entry leaves posted
--      only to reversed (no draft, no NULL, no reversed -> posted: breakers N1/N2, H3), is not deleted (B5), and
--      keeps created_at and company_id (X1); a posted auto_payroll journal keeps its entry_date (B6). No entry gets a
--      NULL status (trigger now; CHECK (status IS NOT NULL) NOT VALID, VALIDATE logged for wave 7 after a production
--      census, since production may hold NULL rows).
--   4. A posted or reversed journal whose line set changed must balance at COMMIT (a constraint trigger on
--      gl_journal_lines, DEFERRABLE INITIALLY DEFERRED), which covers a journal INSERTed already posted (E-1). No line
--      count is required (a posted header with no lines is 0 = 0), unlike trg_gl_je_balanced on NULL/draft ->
--      posted, unchanged. The check runs once per journal per firing, not once per line: an immediate per-row trigger
--      queues the journal in gl_journal_balance_queue (UNLOGGED, owned by migration_admin, keyed by txid_current();
--      no app role can touch it: breaker G1 cleared the earlier GUC list), and the check runs past RLS. Measured
--      (fixture PG16, box load ~100),
--      deferred check of one born-posted journal as a non-superuser at 500 / 2 000 / 5 000 lines: once per line
--      46 / 586 / 3 857 ms (O(n^2)); deduped 5 / 7 / 17 ms, with the 5 000-line INSERT itself 167 ms against 146 ms
--      for an exempt superuser (GUC list). With the queue, 8 000 lines (breaker L1: 11.2 s before, load ~110):
--      check 40 / 49 ms, INSERT 294 / 347 ms against 243 / 241 ms for an exempt superuser.
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
-- the account is not frozen); add or remove BALANCED lines on a journal it created in the same transaction. The
-- table owner (postgres, a member of migration_admin) can disable the triggers and write the rule-4 queue (above).
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
-- four tables for an instant, bounded by lock_timeout. The one stronger lock: ADD CONSTRAINT ... NOT VALID takes
-- ACCESS EXCLUSIVE on gl_journal_entries for an instant on the first run only (NOT VALID: no scan); a re-run skips
-- it. Measured in pg_locks in the PR body. No scan, no backfill: rows are judged when next written.
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
--   DROP TRIGGER IF EXISTS trg_gl_je_status_not_null ON public.gl_journal_entries;
--   ALTER TABLE public.gl_journal_entries DROP CONSTRAINT IF EXISTS gl_journal_entries_status_not_null;
--   DROP TABLE IF EXISTS public.gl_journal_balance_queue;
--   DROP FUNCTION IF EXISTS public.payroll_run_is_final(uuid, boolean), public.payroll_run_final_state(uuid),
--     public.payroll_run_lines_final_frozen(), public.payroll_run_headers_final_frozen(), public.gl_journal_is_posted(uuid),
--     public.gl_jl_posted_frozen(), public.gl_jl_posted_set_frozen(), public.gl_je_posted_frozen(),
--     public.gl_je_posted_no_delete(), public.gl_posted_journal_balanced(), public.gl_jl_mark_unchecked(),
--     public.gl_je_status_not_null();
--   DELETE FROM public.app_definer_reviews
--    WHERE signature IN ('payroll_run_final_state(uuid)', 'gl_posted_journal_balanced()', 'gl_jl_mark_unchecked()');

SET LOCAL lock_timeout = '5s';

-- ── 1. payroll_run_lines ────────────────────────────────────────────────────────────────────────────────────────

-- Finality is read past RLS (breaker H4): payroll_run_headers forces RLS, so an invoker-rights read made a header the
-- caller cannot see (no claims, another tenant) look "not final". SECURITY DEFINER owned by migration_admin
-- (BYPASSRLS), pinned search_path, writes nothing. Before any lock it applies the header's own RLS test to the
-- CALLER (breaker D1): the caller's role is the session's SET ROLE target (current_setting('role'), which a definer
-- does not change) or the login role; one that bypasses RLS sees every header, app_user only its users' companies
-- (tenant_isolation: company_users of auth.uid()). A header the caller could not see answers "final" and is not
-- locked, so another tenant learns nothing and blocks nothing. NULL when the header does not exist.
CREATE OR REPLACE FUNCTION public.payroll_run_final_state(p_run uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_company uuid;
  v_caller text := CASE current_setting('role') WHEN 'none' THEN session_user::text ELSE current_setting('role') END;
  v_final boolean;
BEGIN
  SELECT h.company_id INTO v_company FROM public.payroll_run_headers h WHERE h.id = p_run;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles r WHERE r.rolname = v_caller AND (r.rolbypassrls OR r.rolsuper))
     AND NOT EXISTS (SELECT 1 FROM public.company_users cu WHERE cu.company_id = v_company AND cu.user_id = auth.uid()) THEN
    RETURN true;
  END IF;
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
GRANT EXECUTE ON FUNCTION public.payroll_run_final_state(uuid) TO app_user, platform_admin, postgres;

INSERT INTO public.app_definer_reviews (signature, writes, body_md5)
SELECT 'payroll_run_final_state(uuid)',
       'none: reads one payroll_run_headers row (company_id; then FOR SHARE status, approved_at, approval_grandfathered_at) past RLS so the 999n line freeze judges finality; a header the caller''s role could not see under RLS answers true unlocked; NULL for a missing header; EXECUTE to the payroll_run_lines writers only',
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
-- how year-end and depreciation insert theirs. A line DELETE fired inside another trigger with its entry gone is the
-- ON DELETE CASCADE of an entry delete, judged by the entry rule; otherwise a line whose entry the caller cannot see
-- (another tenant's journal under RLS) is neither added nor removed: it fails closed.
-- Demo holds no real money and is wiped by the reseed (wipePlan.ts:193/204): a DELETE of a line whose ENTRY belongs
-- to the Demo company (00000000-0000-0000-0000-000000000001, a literal) passes (breaker X1: judged by the entry's company, which is frozen
-- once posted, never by the line's own).
CREATE OR REPLACE FUNCTION public.gl_jl_posted_set_frozen()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_entry uuid;
  v_status text;
  v_company uuid;
  v_created timestamptz;
BEGIN
  IF current_setting('is_superuser') = 'on' THEN
    RETURN CASE TG_OP WHEN 'DELETE' THEN OLD ELSE NEW END;
  END IF;
  v_entry := CASE TG_OP WHEN 'DELETE' THEN OLD.journal_entry_id ELSE NEW.journal_entry_id END;
  SELECT e.status, e.company_id, e.created_at INTO v_status, v_company, v_created
    FROM public.gl_journal_entries e WHERE e.id = v_entry;
  IF NOT FOUND THEN
    IF TG_OP = 'DELETE' AND pg_trigger_depth() > 1 THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'gl_journal_lines: a line whose journal the caller cannot see cannot be added or removed'
      USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'DELETE' AND v_company = '00000000-0000-0000-0000-000000000001'::uuid THEN
    RETURN OLD;
  END IF;
  IF v_status IN ('posted', 'reversed') AND v_created IS DISTINCT FROM now() THEN
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

-- A posted or reversed entry (breakers B6, H3, N1/N2, X1): it leaves posted only to reversed (no draft, no NULL, no
-- other value; reversed is final, which closes H3's reversed -> posted hop: trg_gl_je_balanced already balances
-- NULL/draft -> posted); it keeps created_at (the born-here test above reads it) and company_id (so no journal
-- reaches the Demo exemption by moving there); a payroll journal keeps its date.
CREATE OR REPLACE FUNCTION public.gl_je_posted_frozen()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF current_setting('is_superuser') = 'on' THEN
    RETURN NEW;
  END IF;
  IF OLD.status IN ('posted', 'reversed') THEN
    IF NEW.status IS DISTINCT FROM OLD.status AND NOT (OLD.status = 'posted' AND NEW.status = 'reversed') THEN
      RAISE EXCEPTION 'gl_journal_entries: a posted journal leaves posted only to reversed (reverse it instead)'
        USING ERRCODE = '23514';
    END IF;
    IF NEW.created_at IS DISTINCT FROM OLD.created_at THEN
      RAISE EXCEPTION 'gl_journal_entries: a posted journal''s created_at is frozen' USING ERRCODE = '23514';
    END IF;
    IF NEW.company_id IS DISTINCT FROM OLD.company_id THEN
      RAISE EXCEPTION 'gl_journal_entries: a posted journal keeps its company (reverse it instead)' USING ERRCODE = '23514';
    END IF;
    IF OLD.source = 'auto_payroll' AND (NEW.entry_date, NEW.source) IS DISTINCT FROM (OLD.entry_date, OLD.source) THEN
      RAISE EXCEPTION 'gl_journal_entries: a posted payroll journal keeps its date (reverse it instead)'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END
$$;

CREATE OR REPLACE TRIGGER trg_gl_je_posted_frozen
  BEFORE UPDATE ON public.gl_journal_entries
  FOR EACH ROW
  WHEN (OLD.status IN ('posted', 'reversed'))
  EXECUTE FUNCTION public.gl_je_posted_frozen();
ALTER TABLE public.gl_journal_entries ENABLE ALWAYS TRIGGER trg_gl_je_posted_frozen;

-- No entry gets a NULL status (breaker N1/N2: posted -> NULL took a journal out of every status rule). The trigger
-- covers new writes now; the CHECK is NOT VALID so existing rows are not scanned (production may hold NULL rows and
-- fail the deploy); VALIDATE is logged for wave 7, after a production census.
CREATE OR REPLACE FUNCTION public.gl_je_status_not_null()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  RAISE EXCEPTION 'gl_journal_entries: a journal''s status cannot be NULL' USING ERRCODE = '23514';
END
$$;

CREATE OR REPLACE TRIGGER trg_gl_je_status_not_null
  BEFORE INSERT OR UPDATE ON public.gl_journal_entries
  FOR EACH ROW
  WHEN (NEW.status IS NULL)
  EXECUTE FUNCTION public.gl_je_status_not_null();
ALTER TABLE public.gl_journal_entries ENABLE ALWAYS TRIGGER trg_gl_je_status_not_null;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint
                  WHERE conrelid = 'public.gl_journal_entries'::regclass AND conname = 'gl_journal_entries_status_not_null') THEN
    ALTER TABLE public.gl_journal_entries ADD CONSTRAINT gl_journal_entries_status_not_null CHECK (status IS NOT NULL) NOT VALID;
  END IF;
END
$$;

-- A posted or reversed entry is not deleted (breaker B5: its lines went with it by cascade). Demo is exempt: it holds
-- no real money and is wiped by the reseed (wipePlan.ts:193/204); an entry's company_id is frozen once posted (X1).
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

-- The unchecked queue (breaker G1: a GUC list was settable by any role, so clearing it skipped the check). An UNLOGGED
-- table owned by migration_admin, keyed by (txid_current(), entry), that no app role can read or write. Every line
-- INSERT or DELETE (immediate, per row) queues its journal; the deferred check takes the journal off the queue and
-- checks it once, the rest of that journal's events find nothing and skip; a line written after a check queues it
-- again. Both trigger functions are SECURITY DEFINER (the queue's owner) with no EXECUTE for anyone: a trigger needs
-- none to fire, and a trigger function cannot be called directly. They read the journal past RLS, so the check no
-- longer depends on the caller's company context. A savepoint rollback takes queued rows with the lines they cover.
CREATE UNLOGGED TABLE IF NOT EXISTS public.gl_journal_balance_queue (
  txid bigint NOT NULL,
  journal_entry_id uuid NOT NULL,
  PRIMARY KEY (txid, journal_entry_id)
);
ALTER TABLE public.gl_journal_balance_queue OWNER TO migration_admin;
REVOKE ALL ON TABLE public.gl_journal_balance_queue FROM PUBLIC, app_user, app_service, platform_admin;

CREATE OR REPLACE FUNCTION public.gl_posted_journal_balanced()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_entry uuid;
  v_company uuid;
  v_debit numeric;
  v_credit numeric;
  v_caller text := CASE current_setting('role') WHEN 'none' THEN session_user::text ELSE current_setting('role') END;
BEGIN
  IF current_setting('is_superuser') = 'on' THEN
    RETURN NULL;
  END IF;
  v_entry := CASE TG_OP WHEN 'DELETE' THEN OLD.journal_entry_id ELSE NEW.journal_entry_id END;
  DELETE FROM public.gl_journal_balance_queue q WHERE q.txid = txid_current() AND q.journal_entry_id = v_entry;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  SELECT e.company_id INTO v_company FROM public.gl_journal_entries e
   WHERE e.id = v_entry AND e.status IN ('posted', 'reversed');
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  SELECT COALESCE(SUM(l.debit), 0), COALESCE(SUM(l.credit), 0) INTO v_debit, v_credit
    FROM public.gl_journal_lines l WHERE l.journal_entry_id = v_entry;
  IF v_debit <> v_credit THEN
    -- Figures only for a caller who could see the journal under RLS (the payroll_run_final_state test): a definer's
    -- error must not hand another tenant a journal id and its totals (security review S2).
    IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles r WHERE r.rolname = v_caller AND (r.rolbypassrls OR r.rolsuper))
       AND NOT EXISTS (SELECT 1 FROM public.company_users cu WHERE cu.company_id = v_company AND cu.user_id = auth.uid()) THEN
      RAISE EXCEPTION 'gl_journal_entries: a posted journal does not balance' USING ERRCODE = '23514';
    END IF;
    RAISE EXCEPTION 'gl_journal_entries: posted journal % does not balance: debit=% credit=%', v_entry, v_debit, v_credit
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END
$$;
ALTER FUNCTION public.gl_posted_journal_balanced() OWNER TO migration_admin;
REVOKE ALL ON FUNCTION public.gl_posted_journal_balanced() FROM PUBLIC;

CREATE OR REPLACE FUNCTION public.gl_jl_mark_unchecked()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF current_setting('is_superuser') = 'on' THEN
    RETURN NULL;
  END IF;
  INSERT INTO public.gl_journal_balance_queue (txid, journal_entry_id)
  VALUES (txid_current(), CASE TG_OP WHEN 'DELETE' THEN OLD.journal_entry_id ELSE NEW.journal_entry_id END)
  ON CONFLICT DO NOTHING;
  RETURN NULL;
END
$$;
ALTER FUNCTION public.gl_jl_mark_unchecked() OWNER TO migration_admin;
REVOKE ALL ON FUNCTION public.gl_jl_mark_unchecked() FROM PUBLIC;

INSERT INTO public.app_definer_reviews (signature, writes, body_md5)
SELECT 'gl_posted_journal_balanced()',
       'gl_journal_balance_queue: DELETE of this transaction''s row for one journal (deferred line trigger, 999n rule 4); reads that journal''s entry and line sums past RLS; no EXECUTE grant (trigger only)',
       public.app_definer_hash('public.gl_posted_journal_balanced()'::regprocedure)
ON CONFLICT (signature) DO UPDATE SET writes = EXCLUDED.writes, body_md5 = EXCLUDED.body_md5;
INSERT INTO public.app_definer_reviews (signature, writes, body_md5)
SELECT 'gl_jl_mark_unchecked()',
       'gl_journal_balance_queue: INSERT (txid_current(), journal) ON CONFLICT DO NOTHING per line INSERT/DELETE (999n rule 4 queue); no EXECUTE grant (trigger only)',
       public.app_definer_hash('public.gl_jl_mark_unchecked()'::regprocedure)
ON CONFLICT (signature) DO UPDATE SET writes = EXCLUDED.writes, body_md5 = EXCLUDED.body_md5;

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
