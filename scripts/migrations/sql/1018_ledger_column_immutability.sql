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
-- judges the rows, so it binds every non-superuser session: app_user, migration_admin, platform_admin and the app's
-- login roles. The exemption is a SUPERUSER session (is_superuser), which can disable any trigger anyway; production's
-- app, deploy and admin pools have none, and the integration fixtures' postgres is one (it seeds the shapes the app
-- never writes). It does NOT bind the table OWNER, who can switch a trigger off (as 999n says): production's
-- app login isaflow_app is not the owner, so only the deploy/owner login could switch these off. All triggers ENABLE
-- ALWAYS, so session_replication_role = replica skips none.
-- No SECURITY DEFINER function, so no app_definer_reviews row. Every function reads as the caller and fails closed: a
-- row the caller cannot see (another tenant, under RLS) never satisfies a condition.
--   1. gl_journal_entries.reversal_of_id. No INSERT carries one (the reversal service links the contra AFTER it
--      posted it: journalEntryPostingService, the one writer). An UPDATE may set it once, NULL -> X, only on a POSTED
--      journal that no document holds, and only when X is a posted journal of the same company, is not itself, has no
--      cycle through its own chain, and the two journals' lines are exact negations (same account, debit and credit
--      swapped, none left over on either side; at least one line), and X has no other contra (the trigger refuses a
--      second one itself; ux_gl_je_reversal_of is not relied on, dev lacks it). The check takes the per-journal advisory
--      lock of X (the journal reversed) and of the contra, in sorted order, and a document linking a journal takes the
--      lock of that journal: a document linking X and a contra being linked to X wait for one another (L1). It is never
--      changed or cleared once set. Once linked, a journal's line set is closed (rule 6). A forged "reversal" that is not a real contra therefore cannot revive, hide or re-point a chain.
--      The chain stays one line of fewer than 64 journals: a link onto a branched chain (legacy duplicates), or one that
--      would make it 64 long, is refused (fail closed; gl_journal_in_force counts such a chain as in force).
--      A link never puts back in force (odd parity, see gl_journal_in_force) a journal of the chain whose document was
--      cancelled: one a cancelled document still links (the credit-note cancel keeps its link), or one a document let go
--      of (document_released_at, set when the invoice and bill cancels clear their link, rule 4). Only a document cancel
--      clears a link, and a cleared journal is never linked again (rule 4 wants it in force), so the narrow rule closes
--      cancel -> re-reverse without touching the soft-delete undo, which re-instates the journal of a document that is
--      restored, not cancelled. The link takes the chain root's lock too (sorted with the two above), the lock a
--      document's cancel and unlink take, so a cancel and a re-instating link wait for one another.
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
--      to it): exactly what approve, the take-on imports and cancel do. The clear stamps X.document_released_at (a
--      new, nullable column, set once and never changed or cleared again); X's chain is linear and under 64 when linked.
--   5. A document moves to 'cancelled', or from an approved-side status back to 'draft' / 'pending_approval' (the same
--      effect on the AR/AP population), only when the journal it still links is no longer in force: cancel reverses the
--      chain head first, and the credit-note cancel keeps its link. A draft with a journal ("Post to GL") may still
--      become pending_approval. "In force" is the parity of the reversal chain (gl_journal_in_force), so a chain
--      re-instated by O <- R <- R2 still holds its document. The check holds the journal's lock (rule 1). A cancelled
--      document that still links a journal (a credit note) does not leave 'cancelled': cancelling is final.
--   6. A journal that is linked as a reversal, or that a reversal links, has a closed line set: no line is added to it or
--      removed from it, and a line's account may move only if the two journals are still exact negations at COMMIT
--      (an account merge moves both sides in one transaction; one side alone is refused). The Demo company's wipe and
--      the cascade of an entry delete are exempt as in 999n; a superuser is exempt as everywhere.
--
-- BOUNDARY (stated, not oversold). A state rule cannot know WHO wrote a row. Still open, and logged for the planner
-- tier because only a privilege split (a posting role distinct from the request role) closes them: an INSERT of a
-- journal with an arbitrary source / description (createJournalEntry serves ~60 callers as the same login); a draft or
-- pending document set to 'approved' without a link (AR approve writes status before it posts and links; AP can approve
-- with a NULL link: provisional bank-first, legacy rows); an approved document linked to a journal the caller posted
-- itself with the right source; a cancelled invoice or bill (its link already cleared) set back to an open status; a
-- legacy invoice or bill cancelled before this migration (its link cleared, no document_released_at) whose chain is
-- re-reversed. The reversal and the link rules above
-- are what a consumer of the chain or the link should trust, not source. Rows already in the database are judged when
-- next written (no scan, no backfill).
--
-- OLD COLOUR (the release before this one, against this schema). Every writer above is unchanged: reverseJournalEntry
-- claims (reversed_at), creates and posts the contra, then links it; approve posts then links; cancel reverses then
-- clears. A legacy document whose linked journal has a posted contra but whose own link was never cleared still clears.
--
-- LOCKS. No DROP TRIGGER: CREATE OR REPLACE TRIGGER (PG14+) and ENABLE ALWAYS each take SHARE ROW EXCLUSIVE on the
-- tables for an instant, bounded by lock_timeout. ADD COLUMN document_released_at (nullable, no default: no rewrite)
-- takes ACCESS EXCLUSIVE on gl_journal_entries for an instant, bounded the same way.
--
-- Rollback:
--   DROP TRIGGER IF EXISTS trg_gl_je_reversal_no_insert ON public.gl_journal_entries;
--   DROP TRIGGER IF EXISTS trg_gl_je_reversal_link ON public.gl_journal_entries;
--   DROP TRIGGER IF EXISTS trg_gl_je_posted_header_frozen ON public.gl_journal_entries;
--   DROP TRIGGER IF EXISTS trg_gl_je_reversed_at_release ON public.gl_journal_entries;
--   DROP TRIGGER IF EXISTS trg_gl_je_reversed_status ON public.gl_journal_entries;
--   DROP TRIGGER IF EXISTS trg_gl_je_document_release_kept ON public.gl_journal_entries;
--   DROP TRIGGER IF EXISTS trg_gl_jl_linked_set_frozen ON public.gl_journal_lines;
--   DROP TRIGGER IF EXISTS trg_gl_jl_linked_account_check ON public.gl_journal_lines;
--   DROP INDEX IF EXISTS public.ix_gl_je_reversal_of_lookup;
--   and, on each of public.customer_invoices, public.supplier_invoices, public.credit_notes:
--   DROP TRIGGER IF EXISTS trg_doc_journal_link_ins ON public.<table>;
--   DROP TRIGGER IF EXISTS trg_doc_journal_link_upd ON public.<table>;
--   DROP TRIGGER IF EXISTS trg_doc_cancel_in_force ON public.<table>;
--   DROP FUNCTION IF EXISTS public.gl_je_reversal_no_insert(), public.gl_je_reversal_link(),
--     public.gl_je_posted_header_frozen(), public.gl_je_reversed_status(), public.gl_je_reversed_at_release(), public.doc_journal_link_guard(),
--     public.doc_cancel_in_force(), public.gl_journal_in_force(uuid), public.gl_lines_are_negation(uuid, uuid),
--     public.gl_journal_is_linked(uuid), public.gl_jl_linked_set_frozen(), public.gl_jl_linked_account_check(),
--     public.gl_journal_chain_sound(uuid), public.gl_journal_ancestors(uuid), public.gl_je_document_release_kept();
--   ALTER TABLE public.gl_journal_entries DROP COLUMN IF EXISTS document_released_at;

SET LOCAL lock_timeout = '5s';

-- The journal a document's cancel let go of (rule 4 sets it, rule 1 reads it). Not frozen in audit snapshots
-- (tests/helpers/auditSnapshotColumns.ts): the cancel's reversal, which is frozen, is the ledger fact.
ALTER TABLE public.gl_journal_entries ADD COLUMN IF NOT EXISTS document_released_at timestamptz;

-- ── helpers ─────────────────────────────────────────────────────────────────────────────────────────────────

-- A journal is in force when it stands in the ledger: posted (or legacy 'reversed'), and its reversal chain O <- R <- R2
-- ... (walked down reversal_of_id over posted journals of its company) has an ODD number of journals, O being 1: after
-- O <- R the document is out, after O <- R <- R2 it is back in (shared/journalChainHead). The LEDGER decides, never the
-- reversed_at stamp (writable by the caller) and never a status flip (guarded below). A chain that branches (legacy
-- duplicates) or runs past 64 journals is treated as in force, the side that refuses an unlink or a cancel. Read as the
-- caller: a journal the caller cannot see is not in force for it (the link and cancel rules are about the caller's own
-- company, which it sees whole).
CREATE OR REPLACE FUNCTION public.gl_journal_in_force(p_entry uuid)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_depth integer;
  v_nodes bigint;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.gl_journal_entries e WHERE e.id = p_entry AND e.status IN ('posted', 'reversed')) THEN
    RETURN false;
  END IF;
  WITH RECURSIVE chain(id, company_id, depth, path) AS (
    SELECT e.id, e.company_id, 1, ARRAY[e.id] FROM public.gl_journal_entries e WHERE e.id = p_entry
    UNION ALL
    SELECT c.id, c.company_id, chain.depth + 1, chain.path || c.id
      FROM public.gl_journal_entries c JOIN chain ON c.company_id = chain.company_id AND c.reversal_of_id = chain.id
     WHERE c.status IN ('posted', 'reversed') AND NOT c.id = ANY(chain.path) AND chain.depth < 64)
  SELECT max(depth), count(*) INTO v_depth, v_nodes FROM chain;
  RETURN v_nodes <> v_depth OR v_depth >= 64 OR v_depth % 2 = 1;
END
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

-- The chain from the journal down is one line (no journal has two contras) of fewer than 64 journals: the shape a new
-- link (rules 1 and 4) is allowed onto. The walk is gl_journal_in_force's.
CREATE OR REPLACE FUNCTION public.gl_journal_chain_sound(p_entry uuid)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_depth integer;
  v_nodes bigint;
BEGIN
  WITH RECURSIVE chain(id, company_id, depth, path) AS (
    SELECT e.id, e.company_id, 1, ARRAY[e.id] FROM public.gl_journal_entries e WHERE e.id = p_entry
    UNION ALL
    SELECT c.id, c.company_id, chain.depth + 1, chain.path || c.id
      FROM public.gl_journal_entries c JOIN chain ON c.company_id = chain.company_id AND c.reversal_of_id = chain.id
     WHERE c.status IN ('posted', 'reversed') AND NOT c.id = ANY(chain.path) AND chain.depth < 64)
  SELECT max(depth), count(*) INTO v_depth, v_nodes FROM chain;
  RETURN v_nodes = v_depth AND v_depth < 64;
END
$$;

-- The journal and the journals it reverses, walked UP reversal_of_id inside its company: dist 1 is the journal itself,
-- is_root marks the top (no reversal_of_id). Path-guarded and capped at 64, so a loop or a longer chain has no root.
CREATE OR REPLACE FUNCTION public.gl_journal_ancestors(p_entry uuid)
RETURNS TABLE (id uuid, dist integer, is_root boolean)
LANGUAGE sql
STABLE
SET search_path = pg_catalog, public, pg_temp
AS $$
  WITH RECURSIVE up(id, company_id, rid, dist, path) AS (
    SELECT e.id, e.company_id, e.reversal_of_id, 1, ARRAY[e.id] FROM public.gl_journal_entries e WHERE e.id = p_entry
    UNION ALL
    SELECT p.id, p.company_id, p.reversal_of_id, up.dist + 1, up.path || p.id
      FROM public.gl_journal_entries p JOIN up ON p.id = up.rid AND p.company_id = up.company_id
     WHERE NOT p.id = ANY(up.path) AND up.dist < 64)
  SELECT up.id, up.dist, up.rid IS NULL FROM up;
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
  v_root uuid;
  v_root_now uuid;
  v_root_dist integer;
  v_below integer;
  v_below_nodes bigint;
  v_key text;
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
  -- Serialised with a document linking either journal (doc_journal_link_guard takes the lock of the journal it links): a
  -- document's journal cannot become a contra while a document is linking it, a document cannot link the journal being
  -- reversed while its contra is linked (L1), nor can two contras of one journal both pass the test below. The chain's
  -- ROOT too: a document holds only a root (it never links a contra, and a held journal is never made one), and its
  -- cancel and unlink take that root's lock (doc_cancel_in_force, doc_journal_link_guard), so a cancel and a link that
  -- re-instates the chain wait for one another. Every key in sorted order, so two sessions cannot deadlock. The root is
  -- read before the locks and checked again under them.
  SELECT a.id INTO v_root FROM public.gl_journal_ancestors(NEW.reversal_of_id) a WHERE a.is_root;
  FOR v_key IN SELECT DISTINCT k FROM unnest(ARRAY[NEW.id::text, NEW.reversal_of_id::text, v_root::text]) k
                WHERE k IS NOT NULL ORDER BY k LOOP
    PERFORM pg_advisory_xact_lock(pg_catalog.hashtextextended('doc_journal_link:' || v_key, 0));
  END LOOP;
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
  -- One contra per journal, judged here (the unique index is not relied on). 23505 and its name keep the service's
  -- "Journal entry already reversed" mapping.
  IF EXISTS (SELECT 1 FROM public.gl_journal_entries c
              WHERE c.company_id = NEW.company_id AND c.reversal_of_id = NEW.reversal_of_id AND c.id <> NEW.id) THEN
    RAISE EXCEPTION 'gl_journal_entries: that journal already has a reversal' USING ERRCODE = '23505', CONSTRAINT = 'ux_gl_je_reversal_of';
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
  -- The chain stays one line of fewer than 64 journals (fail closed: gl_journal_in_force counts a branched or full
  -- chain as in force). The root (dist v_root_dist above the contra's place) under the locks, and the contra's own
  -- chain below it (v_below journals, itself included: 1 unless it was reversed before it was linked).
  SELECT a.id, a.dist INTO v_root_now, v_root_dist FROM public.gl_journal_ancestors(NEW.reversal_of_id) a WHERE a.is_root;
  IF v_root_now IS NULL THEN
    RAISE EXCEPTION 'gl_journal_entries: that reversal chain is full (64 journals) and takes no further reversal' USING ERRCODE = '23514';
  END IF;
  IF v_root_now IS DISTINCT FROM v_root THEN
    RAISE EXCEPTION 'gl_journal_entries: the reversal chain changed while it was being linked (retry)' USING ERRCODE = '23514';
  END IF;
  WITH RECURSIVE down(id, depth, path) AS (
    SELECT NEW.id, 1, ARRAY[NEW.id]
    UNION ALL
    SELECT c.id, down.depth + 1, down.path || c.id
      FROM public.gl_journal_entries c JOIN down ON c.reversal_of_id = down.id
     WHERE c.company_id = NEW.company_id AND c.status IN ('posted', 'reversed') AND NOT c.id = ANY(down.path) AND down.depth < 64)
  SELECT max(depth), count(*) INTO v_below, v_below_nodes FROM down;
  IF v_below_nodes <> v_below OR v_root_dist + v_below >= 64 OR NOT public.gl_journal_chain_sound(v_root_now) THEN
    RAISE EXCEPTION 'gl_journal_entries: a reversal chain stays one line of fewer than 64 journals (that one is branched or full)'
      USING ERRCODE = '23514';
  END IF;
  -- After the link, a journal dist journals above the contra's place heads a chain of dist + v_below journals: in force
  -- when that is odd. None whose document was cancelled comes back in force.
  IF EXISTS (SELECT 1 FROM public.gl_journal_ancestors(NEW.reversal_of_id) a
               JOIN public.gl_journal_entries j ON j.id = a.id
              WHERE (a.dist + v_below) % 2 = 1
                AND (j.document_released_at IS NOT NULL
                     OR EXISTS (SELECT 1 FROM public.customer_invoices d WHERE d.gl_journal_entry_id = a.id AND d.status = 'cancelled')
                     OR EXISTS (SELECT 1 FROM public.supplier_invoices d WHERE d.gl_journal_entry_id = a.id AND d.status = 'cancelled')
                     OR EXISTS (SELECT 1 FROM public.credit_notes d WHERE d.gl_journal_entry_id = a.id AND d.status = 'cancelled'))) THEN
    RAISE EXCEPTION 'gl_journal_entries: this reversal would put the journal of a cancelled document back in force'
      USING ERRCODE = '23514', CONSTRAINT = 'gl_je_reinstates_cancelled_document';
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

-- document_released_at is set once (rule 4's unlink) and kept: clearing it would let rule 1 re-instate the chain. A
-- caller setting it on a journal of its own only refuses that journal's re-instatement (fail closed), so NULL -> value
-- is left open.
CREATE OR REPLACE FUNCTION public.gl_je_document_release_kept()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF current_setting('is_superuser') = 'on' THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'gl_journal_entries: a journal a cancelled document let go of stays released' USING ERRCODE = '23514';
END
$$;

CREATE OR REPLACE TRIGGER trg_gl_je_document_release_kept
  BEFORE UPDATE OF document_released_at ON public.gl_journal_entries
  FOR EACH ROW
  WHEN (OLD.document_released_at IS NOT NULL AND NEW.document_released_at IS DISTINCT FROM OLD.document_released_at)
  EXECUTE FUNCTION public.gl_je_document_release_kept();
ALTER TABLE public.gl_journal_entries ENABLE ALWAYS TRIGGER trg_gl_je_document_release_kept;

-- ── 6. the line set of a linked journal ────────────────────────────────────────────────────────────────────────

-- Linked = it carries a reversal_of_id, or a journal of its company carries its id in one.
CREATE OR REPLACE FUNCTION public.gl_journal_is_linked(p_entry uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.gl_journal_entries e
     WHERE e.id = p_entry
       AND (e.reversal_of_id IS NOT NULL
            OR EXISTS (SELECT 1 FROM public.gl_journal_entries c WHERE c.company_id = e.company_id AND c.reversal_of_id = e.id)));
$$;

-- No line is added to or removed from a linked journal. The service links AFTER it inserted every line of the contra,
-- and the original was posted long before, so no writer meets this. As in 999n a DELETE of a line of a Demo company
-- journal (the reseed's wipe) and the cascade of an entry delete pass; a line whose journal the caller cannot see is
-- left to 999n's own rule.
CREATE OR REPLACE FUNCTION public.gl_jl_linked_set_frozen()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_entry uuid;
  v_company uuid;
  v_status text;
BEGIN
  IF current_setting('is_superuser') = 'on' THEN
    RETURN CASE TG_OP WHEN 'DELETE' THEN OLD ELSE NEW END;
  END IF;
  v_entry := CASE TG_OP WHEN 'DELETE' THEN OLD.journal_entry_id ELSE NEW.journal_entry_id END;
  SELECT e.company_id, e.status INTO v_company, v_status FROM public.gl_journal_entries e WHERE e.id = v_entry;
  IF NOT FOUND OR v_status = 'draft'
     OR (TG_OP = 'DELETE' AND v_company = '00000000-0000-0000-0000-000000000001'::uuid) THEN
    RETURN CASE TG_OP WHEN 'DELETE' THEN OLD ELSE NEW END;
  END IF;
  IF public.gl_journal_is_linked(v_entry) THEN
    RAISE EXCEPTION 'gl_journal_lines: the lines of a journal that is linked as a reversal are closed (no line is added or removed)'
      USING ERRCODE = '23514';
  END IF;
  RETURN CASE TG_OP WHEN 'DELETE' THEN OLD ELSE NEW END;
END
$$;

CREATE OR REPLACE TRIGGER trg_gl_jl_linked_set_frozen
  BEFORE INSERT OR DELETE ON public.gl_journal_lines
  FOR EACH ROW EXECUTE FUNCTION public.gl_jl_linked_set_frozen();
ALTER TABLE public.gl_journal_lines ENABLE ALWAYS TRIGGER trg_gl_jl_linked_set_frozen;

-- A line's account may move on a linked journal only while the pair is still an exact negation at COMMIT: an account
-- merge moves both sides in one transaction and passes, one side alone is refused. Deferred, once per changed line.
-- Both neighbours of the line's journal: the journal it reverses and every contra reversing it (in R of O <- R <- R2,
-- R against O and R2 against R), so moving O and R together leaves R2 refused.
CREATE OR REPLACE FUNCTION public.gl_jl_linked_account_check()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_original uuid;
BEGIN
  IF current_setting('is_superuser') = 'on' THEN
    RETURN NULL;
  END IF;
  SELECT e.reversal_of_id INTO v_original FROM public.gl_journal_entries e WHERE e.id = NEW.journal_entry_id;
  IF (v_original IS NOT NULL AND NOT public.gl_lines_are_negation(NEW.journal_entry_id, v_original))
     OR EXISTS (SELECT 1 FROM public.gl_journal_entries c
                 WHERE c.reversal_of_id = NEW.journal_entry_id AND c.company_id = NEW.company_id
                   AND NOT public.gl_lines_are_negation(c.id, NEW.journal_entry_id)) THEN
    RAISE EXCEPTION 'gl_journal_lines: a reversal''s lines must stay the exact negation of the journal it reverses'
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_trigger
                  WHERE tgrelid = 'public.gl_journal_lines'::regclass AND tgname = 'trg_gl_jl_linked_account_check') THEN
    CREATE CONSTRAINT TRIGGER trg_gl_jl_linked_account_check
      AFTER UPDATE OF gl_account_id ON public.gl_journal_lines
      DEFERRABLE INITIALLY DEFERRED
      FOR EACH ROW
      WHEN (OLD.gl_account_id IS DISTINCT FROM NEW.gl_account_id)
      EXECUTE FUNCTION public.gl_jl_linked_account_check();
  END IF;
END
$$;
ALTER TABLE public.gl_journal_lines ENABLE ALWAYS TRIGGER trg_gl_jl_linked_account_check;

-- Lookups by reversal_of_id (the chain walk, the one-contra test, the linked test): production has ux_gl_je_reversal_of
-- (619); a database without it (dev's drift) gets a plain index, made only when no index of the table leads with
-- reversal_of_id or with (company_id, reversal_of_id) — whatever its name (pg_index, not a list of names).
DO $$
DECLARE
  v_rev smallint;
  v_co smallint;
BEGIN
  SELECT attnum INTO v_rev FROM pg_catalog.pg_attribute
   WHERE attrelid = 'public.gl_journal_entries'::regclass AND attname = 'reversal_of_id' AND NOT attisdropped;
  SELECT attnum INTO v_co FROM pg_catalog.pg_attribute
   WHERE attrelid = 'public.gl_journal_entries'::regclass AND attname = 'company_id' AND NOT attisdropped;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_index i
                  WHERE i.indrelid = 'public.gl_journal_entries'::regclass
                    AND (i.indkey[0] = v_rev OR (i.indkey[0] = v_co AND i.indnkeyatts > 1 AND i.indkey[1] = v_rev))) THEN
    CREATE INDEX IF NOT EXISTS ix_gl_je_reversal_of_lookup ON public.gl_journal_entries (company_id, reversal_of_id)
      WHERE reversal_of_id IS NOT NULL;
  END IF;
END
$$;

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
    -- The journal's lock (rule 1's root lock): a link re-instating its chain waits for this unlink, or this for it.
    PERFORM pg_advisory_xact_lock(pg_catalog.hashtextextended('doc_journal_link:' || OLD.gl_journal_entry_id::text, 0));
    IF public.gl_journal_in_force(OLD.gl_journal_entry_id) THEN
      RAISE EXCEPTION '%: a document''s journal in force cannot be unlinked (reverse it first)', TG_TABLE_NAME
        USING ERRCODE = '23514';
    END IF;
    -- Only a cancel clears a link (rule 4): the journal it lets go of is never put back in force (rule 1 reads this).
    UPDATE public.gl_journal_entries SET document_released_at = now()
     WHERE id = OLD.gl_journal_entry_id AND company_id = NEW.company_id AND document_released_at IS NULL;
    RETURN NEW;
  END IF;
  -- NULL -> X. One session at a time per journal, so two cannot both pass the "linked by no other document" test.
  PERFORM pg_advisory_xact_lock(pg_catalog.hashtextextended('doc_journal_link:' || NEW.gl_journal_entry_id::text, 0));
  SELECT e.company_id, e.reversal_of_id INTO v_company, v_contra
    FROM public.gl_journal_entries e WHERE e.id = NEW.gl_journal_entry_id;
  -- In force = posted, not stamped reversed and no posted contra (gl_journal_in_force); a contra itself is refused here.
  IF NOT FOUND OR v_company IS DISTINCT FROM NEW.company_id OR v_contra IS NOT NULL
     OR NOT public.gl_journal_in_force(NEW.gl_journal_entry_id) OR NOT public.gl_journal_chain_sound(NEW.gl_journal_entry_id) THEN
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
  -- The journal's lock (rule 1's root lock): a link re-instating its chain waits for this cancel, or this for it.
  PERFORM pg_advisory_xact_lock(pg_catalog.hashtextextended('doc_journal_link:' || NEW.gl_journal_entry_id::text, 0));
  IF OLD.status = 'cancelled' THEN
    RAISE EXCEPTION '%: a cancelled document that links a journal stays cancelled', TG_TABLE_NAME USING ERRCODE = '23514';
  END IF;
  IF public.gl_journal_in_force(NEW.gl_journal_entry_id) THEN
    RAISE EXCEPTION '%: a document whose journal is in force is not cancelled or sent back to draft (reverse the journal first)', TG_TABLE_NAME
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
  WHEN (NEW.gl_journal_entry_id IS NOT NULL AND NEW.status IS DISTINCT FROM OLD.status
        AND (NEW.status = 'cancelled' OR OLD.status = 'cancelled'
             OR (NEW.status IN ('draft', 'pending_approval') AND OLD.status NOT IN ('draft', 'pending_approval'))))
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
  WHEN (NEW.gl_journal_entry_id IS NOT NULL AND NEW.status IS DISTINCT FROM OLD.status
        AND (NEW.status = 'cancelled' OR OLD.status = 'cancelled'
             OR (NEW.status IN ('draft', 'pending_approval') AND OLD.status NOT IN ('draft', 'pending_approval'))))
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
  WHEN (NEW.gl_journal_entry_id IS NOT NULL AND NEW.status IS DISTINCT FROM OLD.status
        AND (NEW.status = 'cancelled' OR OLD.status = 'cancelled'
             OR (NEW.status IN ('draft', 'pending_approval') AND OLD.status NOT IN ('draft', 'pending_approval'))))
  EXECUTE FUNCTION public.doc_cancel_in_force();
ALTER TABLE public.credit_notes ENABLE ALWAYS TRIGGER trg_doc_journal_link_ins;
ALTER TABLE public.credit_notes ENABLE ALWAYS TRIGGER trg_doc_journal_link_upd;
ALTER TABLE public.credit_notes ENABLE ALWAYS TRIGGER trg_doc_cancel_in_force;
