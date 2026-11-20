-- 1018: the database refuses ledger facts the app never writes that way (wave 6, ledger column immutability).
--
-- WHY. The adversarial reviews of PR #1681 showed app_user (the request role, RLS by company_id) can, inside its own
-- company: INSERT a gl_journal_entries row with any reversal_of_id; UPDATE reversal_of_id (re-point a chain) and
-- source / description / entry_date on a POSTED journal; clear reversed_at on a journal a contra already reverses; and
-- UPDATE customer_invoices / supplier_invoices / credit_notes gl_journal_entry_id and status directly, bypassing the
-- approve and cancel services. A posted journal's reversal chain and a document's journal link are ledger facts.
--
-- WHAT. State rules, never a rule on current_user and never an app.* flag: a role test is beaten by
-- set_config('role', ...) and a flag is set by the same login that forges (memory: runtime-role guard beaten). Each rule
-- judges the rows, so it binds every non-superuser session (app_user, migration_admin, platform_admin, the table owner
-- when it is not a superuser). The exemption is a SUPERUSER session (is_superuser), which can disable any trigger
-- anyway; production's app, deploy and admin pools have none, and the integration fixtures' postgres is one (it seeds
-- the shapes the app never writes). All triggers ENABLE ALWAYS, so session_replication_role = replica skips none.
-- No SECURITY DEFINER function, so no app_definer_reviews row. Every function reads as the caller and fails closed: a
-- row the caller cannot see (another tenant, under RLS) never satisfies a condition.
--   1. gl_journal_entries.reversal_of_id. No INSERT carries one (the reversal service links the contra AFTER it
--      posted it: journalEntryPostingService, the one writer). An UPDATE may set it once, NULL -> X, only on a POSTED
--      journal that no document holds, and only when X is a posted journal of the same company, is not itself, has no
--      cycle through its own chain, and the two journals' lines are exact negations (same account, debit and credit
--      swapped, none left over on either side; at least one line). The check takes the same per-journal advisory lock
--      as rule 4, so a link racing a document's link of that journal waits for it. It is never changed or cleared
--      once set. A forged "reversal" that is not a real contra therefore cannot revive, hide or re-point a chain.
--      reversed_at / reversed_by are a STAMP the caller may write (the claim sets it before the contra exists), so no
--      rule below trusts them: "in force" is decided by the ledger alone (see gl_journal_in_force).
--   2. gl_journal_entries of a POSTED or reversed journal keep source, description and entry_date. No application path
--      writes them after posting (census: docs/plans/2026-11-20-ledger-column-immutability-census.md). 999n already
--      freezes status, company_id, created_at, amounts and the line set.
--   3. A journal moves to status 'reversed' only when a posted contra already links to it (no application path writes
--      it: reversal is metadata). reversed_at / reversed_by are cleared only while no journal reverses it (the release
--      of a failed claim runs before any contra exists); that is consistency for the readers of the stamp, not a rule
--      the others lean on.
--   4. customer_invoices / supplier_invoices / credit_notes gl_journal_entry_id. No INSERT carries one. An UPDATE sets
--      it NULL -> X only when X is a posted, unreversed journal of the document's own company, itself no reversal
--      contra and linked by no other document (the check holds a per-journal advisory lock so two sessions cannot both
--      take it). It is not swapped X -> Y, and cleared X -> NULL only when X is no longer in force (a posted contra links
--      to it): exactly what approve, the take-on imports and cancel do.
--   5. A document moves to 'cancelled' only when the journal it still links is no longer in force: cancel reverses the
--      chain head first, and the credit-note cancel keeps its link.
--
-- BOUNDARY (stated, not oversold). A state rule cannot know WHO wrote a row. Still open, and logged for the planner
-- tier because only a privilege split (a posting role distinct from the request role) closes them: an INSERT of a
-- journal with an arbitrary source / description (createJournalEntry serves ~60 callers as the same login); a draft or
-- pending document set to 'approved' without a link (AR approve writes status before it posts and links; AP can approve
-- with a NULL link: provisional bank-first, legacy rows); an approved document linked to a journal the caller posted
-- itself with the right source; a cancelled document set back to an open status. The reversal and the link rules above
-- are what a consumer of the chain or the link should trust, not source. Rows already in the database are judged when
-- next written (no scan, no backfill).
--
-- OLD COLOUR (the release before this one, against this schema). Every writer above is unchanged: reverseJournalEntry
-- claims (reversed_at), creates and posts the contra, then links it; approve posts then links; cancel reverses then
-- clears. A legacy document whose linked journal has a posted contra but whose own link was never cleared still clears.
--
-- LOCKS. No DROP TRIGGER: CREATE OR REPLACE TRIGGER (PG14+) and ENABLE ALWAYS each take SHARE ROW EXCLUSIVE on the four
-- tables for an instant, bounded by lock_timeout.
--
-- Rollback:
--   DROP TRIGGER IF EXISTS trg_gl_je_reversal_no_insert ON public.gl_journal_entries;
--   DROP TRIGGER IF EXISTS trg_gl_je_reversal_link ON public.gl_journal_entries;
--   DROP TRIGGER IF EXISTS trg_gl_je_posted_header_frozen ON public.gl_journal_entries;
--   DROP TRIGGER IF EXISTS trg_gl_je_reversed_at_release ON public.gl_journal_entries;
--   DROP TRIGGER IF EXISTS trg_gl_je_reversed_status ON public.gl_journal_entries;
--   and, on each of public.customer_invoices, public.supplier_invoices, public.credit_notes:
--   DROP TRIGGER IF EXISTS trg_doc_journal_link_ins ON public.<table>;
--   DROP TRIGGER IF EXISTS trg_doc_journal_link_upd ON public.<table>;
--   DROP TRIGGER IF EXISTS trg_doc_cancel_in_force ON public.<table>;
--   DROP FUNCTION IF EXISTS public.gl_je_reversal_no_insert(), public.gl_je_reversal_link(),
--     public.gl_je_posted_header_frozen(), public.gl_je_reversed_status(), public.gl_je_reversed_at_release(), public.doc_journal_link_guard(),
--     public.doc_cancel_in_force(), public.gl_journal_in_force(uuid), public.gl_lines_are_negation(uuid, uuid);

SET LOCAL lock_timeout = '5s';

-- ── helpers ─────────────────────────────────────────────────────────────────────────────────────────────────

-- A journal is in force while it is posted (or legacy 'reversed') and no posted journal of its company reverses it: the
-- LEDGER decides, never the reversed_at stamp (writable by the caller) and never a status flip (guarded below).
-- Read as the caller: a journal the caller cannot see is not in force for it (fails towards "no longer holds a
-- document"; the link and cancel rules below are about the caller's own company, which it sees whole).
CREATE OR REPLACE FUNCTION public.gl_journal_in_force(p_entry uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.gl_journal_entries e
     WHERE e.id = p_entry AND e.status IN ('posted', 'reversed')
       AND NOT EXISTS (SELECT 1 FROM public.gl_journal_entries c
                        WHERE c.company_id = e.company_id AND c.reversal_of_id = e.id AND c.status IN ('posted', 'reversed')));
$$;

-- The two journals' lines are exact negations: one multiset of (account, debit, credit) equals the other with debit and
-- credit swapped, none left over on either side, and the first has a line. Both sides read as the caller.
CREATE OR REPLACE FUNCTION public.gl_lines_are_negation(p_contra uuid, p_original uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT EXISTS (SELECT 1 FROM public.gl_journal_lines WHERE journal_entry_id = p_contra)
     AND NOT EXISTS (
       (SELECT gl_account_id, COALESCE(debit, 0), COALESCE(credit, 0) FROM public.gl_journal_lines WHERE journal_entry_id = p_contra
        EXCEPT ALL
        SELECT gl_account_id, COALESCE(credit, 0), COALESCE(debit, 0) FROM public.gl_journal_lines WHERE journal_entry_id = p_original))
     AND NOT EXISTS (
       (SELECT gl_account_id, COALESCE(credit, 0), COALESCE(debit, 0) FROM public.gl_journal_lines WHERE journal_entry_id = p_original
        EXCEPT ALL
        SELECT gl_account_id, COALESCE(debit, 0), COALESCE(credit, 0) FROM public.gl_journal_lines WHERE journal_entry_id = p_contra));
$$;

-- ── 1. reversal_of_id ───────────────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.gl_je_reversal_no_insert()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF current_setting('is_superuser') = 'on' THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'gl_journal_entries: a journal is linked as a reversal only by the reversal of a posted journal, never on insert'
    USING ERRCODE = '23514';
END
$$;

CREATE OR REPLACE TRIGGER trg_gl_je_reversal_no_insert
  BEFORE INSERT ON public.gl_journal_entries
  FOR EACH ROW
  WHEN (NEW.reversal_of_id IS NOT NULL)
  EXECUTE FUNCTION public.gl_je_reversal_no_insert();
ALTER TABLE public.gl_journal_entries ENABLE ALWAYS TRIGGER trg_gl_je_reversal_no_insert;

CREATE OR REPLACE FUNCTION public.gl_je_reversal_link()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_company uuid;
  v_status text;
BEGIN
  IF current_setting('is_superuser') = 'on' THEN
    RETURN NEW;
  END IF;
  IF OLD.reversal_of_id IS NOT NULL THEN
    RAISE EXCEPTION 'gl_journal_entries: a journal''s reversal link is fixed once set' USING ERRCODE = '23514';
  END IF;
  IF NEW.status IS DISTINCT FROM 'posted' THEN
    RAISE EXCEPTION 'gl_journal_entries: only a posted journal can be linked as a reversal' USING ERRCODE = '23514';
  END IF;
  IF NEW.reversal_of_id = NEW.id THEN
    RAISE EXCEPTION 'gl_journal_entries: a journal cannot reverse itself' USING ERRCODE = '23514';
  END IF;
  -- Serialised with a document linking this journal (doc_journal_link_guard takes the same lock), so a document's journal
  -- cannot become a contra while a document is linking it, nor be linked as it becomes one.
  PERFORM pg_advisory_xact_lock(pg_catalog.hashtextextended('doc_journal_link:' || NEW.id::text, 0));
  IF EXISTS (SELECT 1 FROM public.customer_invoices d WHERE d.gl_journal_entry_id = NEW.id)
     OR EXISTS (SELECT 1 FROM public.supplier_invoices d WHERE d.gl_journal_entry_id = NEW.id)
     OR EXISTS (SELECT 1 FROM public.credit_notes d WHERE d.gl_journal_entry_id = NEW.id) THEN
    RAISE EXCEPTION 'gl_journal_entries: a journal a document holds is not itself linked as a reversal' USING ERRCODE = '23514';
  END IF;
  SELECT p.company_id, p.status INTO v_company, v_status
    FROM public.gl_journal_entries p WHERE p.id = NEW.reversal_of_id;
  IF NOT FOUND OR v_company IS DISTINCT FROM NEW.company_id OR v_status IS DISTINCT FROM 'posted' THEN
    RAISE EXCEPTION 'gl_journal_entries: a reversal links a posted journal of its own company'
      USING ERRCODE = '23514';
  END IF;
  -- No cycle: the reversed journal's own chain upwards never reaches this one (depth-capped).
  IF EXISTS (WITH RECURSIVE up(id, rid, d) AS (
               SELECT e.id, e.reversal_of_id, 1 FROM public.gl_journal_entries e WHERE e.id = NEW.reversal_of_id
               UNION ALL
               SELECT e.id, e.reversal_of_id, up.d + 1 FROM public.gl_journal_entries e JOIN up ON e.id = up.rid WHERE up.d < 1000)
             SELECT 1 FROM up WHERE up.id = NEW.id OR up.rid = NEW.id) THEN
    RAISE EXCEPTION 'gl_journal_entries: a reversal chain cannot loop' USING ERRCODE = '23514';
  END IF;
  IF NOT public.gl_lines_are_negation(NEW.id, NEW.reversal_of_id) THEN
    RAISE EXCEPTION 'gl_journal_entries: a reversal''s lines must be the exact negation of the journal it reverses'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;

CREATE OR REPLACE TRIGGER trg_gl_je_reversal_link
  BEFORE UPDATE OF reversal_of_id ON public.gl_journal_entries
  FOR EACH ROW
  WHEN (NEW.reversal_of_id IS DISTINCT FROM OLD.reversal_of_id)
  EXECUTE FUNCTION public.gl_je_reversal_link();
ALTER TABLE public.gl_journal_entries ENABLE ALWAYS TRIGGER trg_gl_je_reversal_link;

-- ── 2. a posted journal's header ────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.gl_je_posted_header_frozen()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF current_setting('is_superuser') = 'on' THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'gl_journal_entries: a posted journal keeps its source, description and date (reverse it instead)'
    USING ERRCODE = '23514';
END
$$;

CREATE OR REPLACE TRIGGER trg_gl_je_posted_header_frozen
  BEFORE UPDATE OF source, description, entry_date ON public.gl_journal_entries
  FOR EACH ROW
  WHEN (OLD.status IN ('posted', 'reversed')
        AND (NEW.source, NEW.description, NEW.entry_date) IS DISTINCT FROM (OLD.source, OLD.description, OLD.entry_date))
  EXECUTE FUNCTION public.gl_je_posted_header_frozen();
ALTER TABLE public.gl_journal_entries ENABLE ALWAYS TRIGGER trg_gl_je_posted_header_frozen;

-- ── 3. the reversal claim ───────────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.gl_je_reversed_status()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF current_setting('is_superuser') = 'on' THEN
    RETURN NEW;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.gl_journal_entries c
                  WHERE c.company_id = OLD.company_id AND c.reversal_of_id = OLD.id AND c.status IN ('posted', 'reversed')) THEN
    RAISE EXCEPTION 'gl_journal_entries: a journal is marked reversed only when a posted reversal links to it' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;

CREATE OR REPLACE TRIGGER trg_gl_je_reversed_status
  BEFORE UPDATE OF status ON public.gl_journal_entries
  FOR EACH ROW
  WHEN (NEW.status = 'reversed' AND OLD.status IS DISTINCT FROM 'reversed')
  EXECUTE FUNCTION public.gl_je_reversed_status();
ALTER TABLE public.gl_journal_entries ENABLE ALWAYS TRIGGER trg_gl_je_reversed_status;

CREATE OR REPLACE FUNCTION public.gl_je_reversed_at_release()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF current_setting('is_superuser') = 'on' THEN
    RETURN NEW;
  END IF;
  IF EXISTS (SELECT 1 FROM public.gl_journal_entries c WHERE c.company_id = OLD.company_id AND c.reversal_of_id = OLD.id) THEN
    RAISE EXCEPTION 'gl_journal_entries: a journal that a reversal links to stays reversed' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;

CREATE OR REPLACE TRIGGER trg_gl_je_reversed_at_release
  BEFORE UPDATE OF reversed_at ON public.gl_journal_entries
  FOR EACH ROW
  WHEN (OLD.reversed_at IS NOT NULL AND NEW.reversed_at IS NULL)
  EXECUTE FUNCTION public.gl_je_reversed_at_release();
ALTER TABLE public.gl_journal_entries ENABLE ALWAYS TRIGGER trg_gl_je_reversed_at_release;

-- ── 4. a document's journal link ────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.doc_journal_link_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_company uuid;
  v_contra uuid;
BEGIN
  IF current_setting('is_superuser') = 'on' THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'INSERT' THEN
    RAISE EXCEPTION '%: a document is created unlinked; its journal is linked when it is approved', TG_TABLE_NAME
      USING ERRCODE = '23514';
  END IF;
  IF OLD.gl_journal_entry_id IS NOT NULL THEN
    IF NEW.gl_journal_entry_id IS NOT NULL THEN
      RAISE EXCEPTION '%: a document''s journal cannot be swapped', TG_TABLE_NAME USING ERRCODE = '23514';
    END IF;
    IF public.gl_journal_in_force(OLD.gl_journal_entry_id) THEN
      RAISE EXCEPTION '%: a document''s journal in force cannot be unlinked (reverse it first)', TG_TABLE_NAME
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  -- NULL -> X. One session at a time per journal, so two cannot both pass the "linked by no other document" test.
  PERFORM pg_advisory_xact_lock(pg_catalog.hashtextextended('doc_journal_link:' || NEW.gl_journal_entry_id::text, 0));
  SELECT e.company_id, e.reversal_of_id INTO v_company, v_contra
    FROM public.gl_journal_entries e WHERE e.id = NEW.gl_journal_entry_id;
  -- In force = posted, not stamped reversed and no posted contra (gl_journal_in_force); a contra itself is refused here.
  IF NOT FOUND OR v_company IS DISTINCT FROM NEW.company_id OR v_contra IS NOT NULL
     OR NOT public.gl_journal_in_force(NEW.gl_journal_entry_id) THEN
    RAISE EXCEPTION '%: a document links only a posted, unreversed journal of its own company', TG_TABLE_NAME
      USING ERRCODE = '23514';
  END IF;
  IF EXISTS (SELECT 1 FROM public.customer_invoices d WHERE d.gl_journal_entry_id = NEW.gl_journal_entry_id
                AND NOT (TG_TABLE_NAME = 'customer_invoices' AND d.id = NEW.id))
     OR EXISTS (SELECT 1 FROM public.supplier_invoices d WHERE d.gl_journal_entry_id = NEW.gl_journal_entry_id
                AND NOT (TG_TABLE_NAME = 'supplier_invoices' AND d.id = NEW.id))
     OR EXISTS (SELECT 1 FROM public.credit_notes d WHERE d.gl_journal_entry_id = NEW.gl_journal_entry_id
                AND NOT (TG_TABLE_NAME = 'credit_notes' AND d.id = NEW.id)) THEN
    RAISE EXCEPTION '%: that journal already belongs to another document', TG_TABLE_NAME USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;

-- ── 5. a document cancelled while its journal stands ────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.doc_cancel_in_force()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF current_setting('is_superuser') = 'on' THEN
    RETURN NEW;
  END IF;
  IF public.gl_journal_in_force(NEW.gl_journal_entry_id) THEN
    RAISE EXCEPTION '%: a document whose journal is in force is not cancelled (reverse the journal first)', TG_TABLE_NAME
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;

CREATE OR REPLACE TRIGGER trg_doc_journal_link_ins
  BEFORE INSERT ON public.customer_invoices
  FOR EACH ROW
  WHEN (NEW.gl_journal_entry_id IS NOT NULL)
  EXECUTE FUNCTION public.doc_journal_link_guard();
CREATE OR REPLACE TRIGGER trg_doc_journal_link_upd
  BEFORE UPDATE OF gl_journal_entry_id ON public.customer_invoices
  FOR EACH ROW
  WHEN (NEW.gl_journal_entry_id IS DISTINCT FROM OLD.gl_journal_entry_id)
  EXECUTE FUNCTION public.doc_journal_link_guard();
CREATE OR REPLACE TRIGGER trg_doc_cancel_in_force
  BEFORE UPDATE OF status ON public.customer_invoices
  FOR EACH ROW
  WHEN (NEW.status = 'cancelled' AND OLD.status IS DISTINCT FROM 'cancelled' AND NEW.gl_journal_entry_id IS NOT NULL)
  EXECUTE FUNCTION public.doc_cancel_in_force();
ALTER TABLE public.customer_invoices ENABLE ALWAYS TRIGGER trg_doc_journal_link_ins;
ALTER TABLE public.customer_invoices ENABLE ALWAYS TRIGGER trg_doc_journal_link_upd;
ALTER TABLE public.customer_invoices ENABLE ALWAYS TRIGGER trg_doc_cancel_in_force;

CREATE OR REPLACE TRIGGER trg_doc_journal_link_ins
  BEFORE INSERT ON public.supplier_invoices
  FOR EACH ROW
  WHEN (NEW.gl_journal_entry_id IS NOT NULL)
  EXECUTE FUNCTION public.doc_journal_link_guard();
CREATE OR REPLACE TRIGGER trg_doc_journal_link_upd
  BEFORE UPDATE OF gl_journal_entry_id ON public.supplier_invoices
  FOR EACH ROW
  WHEN (NEW.gl_journal_entry_id IS DISTINCT FROM OLD.gl_journal_entry_id)
  EXECUTE FUNCTION public.doc_journal_link_guard();
CREATE OR REPLACE TRIGGER trg_doc_cancel_in_force
  BEFORE UPDATE OF status ON public.supplier_invoices
  FOR EACH ROW
  WHEN (NEW.status = 'cancelled' AND OLD.status IS DISTINCT FROM 'cancelled' AND NEW.gl_journal_entry_id IS NOT NULL)
  EXECUTE FUNCTION public.doc_cancel_in_force();
ALTER TABLE public.supplier_invoices ENABLE ALWAYS TRIGGER trg_doc_journal_link_ins;
ALTER TABLE public.supplier_invoices ENABLE ALWAYS TRIGGER trg_doc_journal_link_upd;
ALTER TABLE public.supplier_invoices ENABLE ALWAYS TRIGGER trg_doc_cancel_in_force;

CREATE OR REPLACE TRIGGER trg_doc_journal_link_ins
  BEFORE INSERT ON public.credit_notes
  FOR EACH ROW
  WHEN (NEW.gl_journal_entry_id IS NOT NULL)
  EXECUTE FUNCTION public.doc_journal_link_guard();
CREATE OR REPLACE TRIGGER trg_doc_journal_link_upd
  BEFORE UPDATE OF gl_journal_entry_id ON public.credit_notes
  FOR EACH ROW
  WHEN (NEW.gl_journal_entry_id IS DISTINCT FROM OLD.gl_journal_entry_id)
  EXECUTE FUNCTION public.doc_journal_link_guard();
CREATE OR REPLACE TRIGGER trg_doc_cancel_in_force
  BEFORE UPDATE OF status ON public.credit_notes
  FOR EACH ROW
  WHEN (NEW.status = 'cancelled' AND OLD.status IS DISTINCT FROM 'cancelled' AND NEW.gl_journal_entry_id IS NOT NULL)
  EXECUTE FUNCTION public.doc_cancel_in_force();
ALTER TABLE public.credit_notes ENABLE ALWAYS TRIGGER trg_doc_journal_link_ins;
ALTER TABLE public.credit_notes ENABLE ALWAYS TRIGGER trg_doc_journal_link_upd;
ALTER TABLE public.credit_notes ENABLE ALWAYS TRIGGER trg_doc_cancel_in_force;
