-- 1019: Intercompany P2 (invoice + credit-note mirror). Plan: docs/plans/2026-11-17-intercompany-mirror-posting.md (P2).
-- Applies on top of 1000 / 1002; idempotent (CREATE OR REPLACE, IF NOT EXISTS, DROP ... IF EXISTS). Adds columns and indexes and replaces
-- function bodies; drops only functions this migration's own earlier shapes defined (payload_problem, the one-argument queue / chain length).

-- THE RULE: the P2 feed does not trust what a writer can write, and stores no figure it can derive. app_user can set a document's status and
-- its journal link and can post a journal with any source and text (a wider class, fixed elsewhere), so a message, its group row and their
-- eliminations rest on the LEDGERS (journal lines by value, reversal chains by parity, dated) and on what the database itself recorded.

-- WHAT
--   1. The DATABASE writes a document message: intercompany_send_for_source(doc type, doc id) builds the payload and the sender's group row from
--      the session company's approved document and records on the message the journal it was sent with and the group row. The messages guard
--      refuses a session's own INSERT of a message that carries or names a document (it allow-lists migration_admin). The journal must be the
--      document's OWN posting (intercompany_own_posting_problem) and carry its figures by value (intercompany_sender_journal_value_problem).
--   2. THE ELIMINATIONS OF MIRRORED DOCUMENTS ARE DERIVED AT READ TIME, never stored: intercompany_mirror_eliminations(group, start, end) returns
--      the dated EVENTS of the mirrored rows of the group's current members: +E when the two ledgers start supporting a pair, -E when they stop
--      (each judged with the reversal links dated on or before it; the receiver's financial-year cut-off; both journals' figures by value), the
--      period being the sum of the events dated in it, so at any moment a range is the sum of its months. A later booking or reversal does not change
--      an earlier period; the reference data the judgement reads is not dated, so editing it can (see the limit at intercompany_mirror_eliminations).
--      No hook, lock or repair stands between a ledger and a figure.
--   3. Hooks maintain INBOX and DISPLAY state only: intercompany_withdraw_for_source / intercompany_journal_chain_changed withdraw or revive a
--      message by the ledger's parity, and intercompany_sync_group_row (best effort) binds a group row to the receiver's journal the first time it
--      matches (identity, supplier, period, figures) and shows its status and variance reason. A mirrored row's match columns are written by
--      migration_admin only (intercompany_transaction_parties_immutable).
--   4. The auto-accept worker's definer path (queue and exhausted list), the receiver's source-changed check, and the 6b backfill of what
--      older messages did not record.

-- DEFINER REGISTRY (930): the SECURITY DEFINER functions below are registered in app_definer_reviews (owner migration_admin, search_path
-- pinned, pg_temp last). The builder, the value / posting / chain checks and the withdraw / revive / release / sync-core helpers are SECURITY
-- INVOKER and executable by migration_admin only. OLD COLOUR: nothing in the previous release reads these columns or calls these functions.

-- Rollback (code first):
--   DROP FUNCTION IF EXISTS public.intercompany_auto_accept_queue(integer, boolean), public.intercompany_withdraw_for_source(text, uuid),
--     public.intercompany_sync_group_row(text, uuid), public.intercompany_send_for_source(text, uuid), public.intercompany_message_source_changed(uuid),
--     public.intercompany_journal_chain_changed(uuid), public.intercompany_mirror_eliminations(uuid, date, date), public.intercompany_mirror_unresolved(uuid, date, date), public.intercompany_is_mirrored_row(uuid),
--     public.intercompany_auto_accept_exhausted();

--   DROP FUNCTION IF EXISTS public.intercompany_sync_core(uuid, text, uuid, uuid), public.intercompany_withdraw_message(uuid), public.intercompany_revive_message(uuid),
--     public.intercompany_release_group_row(uuid), public.intercompany_build_payload(text, uuid, uuid), public.intercompany_clean_text(text, integer),
--     public.intercompany_journal_chain_length(uuid, uuid, date, date[]), public.intercompany_journal_chain_eff(uuid, uuid), public.intercompany_lines_negate(uuid, uuid), public.intercompany_document_live(text, uuid, uuid, uuid),
--     public.intercompany_group_row_ok(uuid, uuid, uuid, uuid), public.intercompany_own_posting_problem(text, uuid, uuid, uuid),
--     public.intercompany_sender_journal_value_problem(text, uuid, uuid, numeric, numeric), public.intercompany_fiscal_year(uuid, date), public.intercompany_receiver_je(uuid, date, date[], date[]), public.intercompany_receiver_journal_problem(uuid, uuid, text, uuid, uuid, date, date[]),
--     public.intercompany_message_source_out(uuid), public.intercompany_receiver_journal_value_problem(text, uuid, numeric, numeric, numeric),
--     public.intercompany_mirror_pair_at(uuid, date, date[], date[], date[]), public.intercompany_journal_bound_elsewhere(uuid, uuid),
--     public.intercompany_journal_claimed(uuid), public.intercompany_mirrored_duplicate(uuid, date), public.intercompany_mirror_stands(uuid, date),
--     public.intercompany_mirror_link(uuid, date), public.intercompany_mirror_link_holds(uuid, uuid, date), public.intercompany_mirror_candidates(uuid), public.intercompany_mirror_facts(uuid, date), public.intercompany_pair_cutovers(uuid), public.intercompany_auto_accept_release(uuid[], integer[]), public.intercompany_next_sa_midnight();

--   DROP TRIGGER IF EXISTS trg_intercompany_sides_auto_since ON intercompany_connection_sides; DROP FUNCTION IF EXISTS public.intercompany_sides_auto_since();
--   (the 1002 body of intercompany_messages_guard and the 999r body of intercompany_transaction_parties_immutable / recorded_fresh return by re-applying them)

--   ALTER TABLE intercompany_messages DROP COLUMN IF EXISTS source_cancelled_at, DROP COLUMN IF EXISTS manual_only, DROP COLUMN IF EXISTS auto_attempts,
--     DROP COLUMN IF EXISTS auto_next_attempt_at, DROP COLUMN IF EXISTS source_journal_entry_id, DROP COLUMN IF EXISTS group_transaction_id;
--   ALTER TABLE intercompany_transactions DROP COLUMN IF EXISTS variance_reason, DROP COLUMN IF EXISTS first_target_journal_entry_id;
--   ALTER TABLE intercompany_connection_sides DROP COLUMN IF EXISTS auto_accept_since, DROP COLUMN IF EXISTS mirroring_since;
--   ALTER TABLE consolidation_adjustments DROP COLUMN IF EXISTS manual_reason;
--   DROP INDEX IF EXISTS uq_consolidation_adjustments_standing_source;
--   DROP INDEX IF EXISTS idx_ic_transactions_target_journal;
--   (the indexes idx_ic_messages_group_transaction, idx_ic_messages_source_journal, uq_ic_transactions_first_journal drop with their columns)

--   DELETE FROM app_definer_reviews WHERE signature LIKE 'intercompany\_%' AND signature IN ('intercompany_auto_accept_queue(integer,boolean)',
--     'intercompany_withdraw_for_source(text,uuid)', 'intercompany_sync_group_row(text,uuid)', 'intercompany_send_for_source(text,uuid)',
--     'intercompany_message_source_changed(uuid)', 'intercompany_auto_accept_exhausted()', 'intercompany_is_mirrored_row(uuid)',
--     'intercompany_mirror_eliminations(uuid,date,date)', 'intercompany_mirror_unresolved(uuid,date,date)', 'intercompany_journal_chain_changed(uuid)', 'intercompany_journal_claimed(uuid)', 'intercompany_mirrored_duplicate(uuid,date)',
--     'intercompany_mirror_facts(uuid,date)', 'intercompany_mirror_stands(uuid,date)', 'intercompany_mirror_link(uuid,date)', 'intercompany_pair_cutovers(uuid)', 'intercompany_auto_accept_release(uuid[],integer[])');
--   DROP TABLE IF EXISTS intercompany_mirror_links;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- What an EARLIER shape of this migration created for the descoped manual elimination of a mirrored row (docs/plans/2026-11-22-intercompany-manual-
-- elimination-of-mirrored-rows.md) is dropped here, so a database that applied it converges on this one (idempotent: IF EXISTS). The unique index's
-- earlier (row, has-a-reason) shape is replaced below, where the index is built.
DROP FUNCTION IF EXISTS public.intercompany_row_manually_eliminated(uuid, date, date), public.intercompany_manual_cover(uuid);
DELETE FROM public.app_definer_reviews WHERE signature IN ('intercompany_row_manually_eliminated(uuid,date,date)', 'intercompany_manual_cover(uuid)');
ALTER TABLE consolidation_adjustments DROP COLUMN IF EXISTS discarded_by, DROP COLUMN IF EXISTS discarded_at;
DROP INDEX IF EXISTS public.idx_consolidation_adjustments_source;

-- ── 1. Columns ──────────────────────────────────────────────────────────────

-- No app role is granted these: they are set by the guard and the definers below.
ALTER TABLE intercompany_messages
  ADD COLUMN IF NOT EXISTS source_cancelled_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS manual_only BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS auto_attempts INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS auto_next_attempt_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS source_journal_entry_id UUID,
  ADD COLUMN IF NOT EXISTS group_transaction_id UUID;
-- Why a group row is a variance (written by intercompany_sync_group_row only: the parties trigger below refuses a request's write).
ALTER TABLE intercompany_transactions ADD COLUMN IF NOT EXISTS variance_reason TEXT;
-- The first journal a row was matched to: written by intercompany_sync_group_row only and never cleared by a release (the target above is).
ALTER TABLE intercompany_transactions ADD COLUMN IF NOT EXISTS first_target_journal_entry_id UUID;
-- The lookups the mirror makes by the database's own references (a trigger asks "is this row a message's" on every update of a row).
CREATE INDEX IF NOT EXISTS idx_ic_messages_group_transaction ON intercompany_messages (group_transaction_id) WHERE group_transaction_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_ic_messages_source_journal ON intercompany_messages (source_journal_entry_id) WHERE source_journal_entry_id IS NOT NULL;
-- One row per receiver journal, structurally: two rows matched to one journal would both be eliminated (two concurrent syncs see neither the
-- other's uncommitted match; the loser's UPDATE waits on this index and is mapped to a variance, intercompany_sync_core). The column is new here.
DROP INDEX IF EXISTS public.idx_ic_transactions_first_journal;
CREATE UNIQUE INDEX IF NOT EXISTS uq_ic_transactions_first_journal ON intercompany_transactions (first_target_journal_entry_id) WHERE first_target_journal_entry_id IS NOT NULL;
-- The exclusivity checks look rows up by their target journal too (every pair, every chain date): without this they scan every tenant's rows.
CREATE INDEX IF NOT EXISTS idx_ic_transactions_target_journal ON intercompany_transactions (target_journal_entry_id) WHERE target_journal_entry_id IS NOT NULL;
ALTER TABLE intercompany_connection_sides ADD COLUMN IF NOT EXISTS auto_accept_since TIMESTAMPTZ;
-- mirroring_since: from when this side mirrors: the start of the day (Johannesburg) AFTER its customer AND supplier links were both set, NULL while
-- either is missing. Set by the database only (no app role has a column grant on it): the history the per-pair cutover reads (RULING 2026-11-21).
ALTER TABLE intercompany_connection_sides ADD COLUMN IF NOT EXISTS mirroring_since TIMESTAMPTZ;
-- Why a person made a manual elimination for a pair whose documents are mirrored (the API requires it on or after the pair's cutover).
ALTER TABLE consolidation_adjustments ADD COLUMN IF NOT EXISTS manual_reason TEXT;

-- One standing (draft or posted) elimination per intercompany row, enforced by a partial unique index. THIS MIGRATION DOES NOT CHANGE EXISTING
-- CONSOLIDATION DATA: if duplicates already exist the index is skipped (a NOTICE with their number), and the generator's per-row skip still
-- stops new ones (two runs for one group are serialised by an advisory lock, eliminationGenerator.ts). Clean the duplicates by hand and
-- re-run the CREATE INDEX below to enforce it.
DO $$
DECLARE
  v_dups integer;
BEGIN
  SELECT count(*) INTO v_dups FROM (SELECT source_intercompany_id FROM consolidation_adjustments
                                      WHERE source_intercompany_id IS NOT NULL AND status IN ('draft', 'posted')
                                      GROUP BY source_intercompany_id HAVING count(*) > 1) d;
  IF v_dups > 0 THEN
    RAISE NOTICE '1019: % intercompany row(s) have more than one standing elimination; uq_consolidation_adjustments_standing_source NOT created', v_dups;
  ELSE
    IF EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'uq_consolidation_adjustments_standing_source'
                 AND indexdef LIKE '%manual_reason IS NOT NULL%') THEN
      DROP INDEX public.uq_consolidation_adjustments_standing_source;   -- (an earlier shape: one per row AND has-a-reason, which lets two stand)
    END IF;
    CREATE UNIQUE INDEX IF NOT EXISTS uq_consolidation_adjustments_standing_source ON consolidation_adjustments (source_intercompany_id)
      WHERE status IN ('draft', 'posted');   -- (NULLs never collide: a manual adjustment has no source row)
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.intercompany_messages'::regclass AND conname = 'intercompany_messages_status_check'
               AND pg_get_constraintdef(oid) NOT LIKE '%withdrawn%') THEN
    ALTER TABLE intercompany_messages DROP CONSTRAINT intercompany_messages_status_check;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.intercompany_messages'::regclass AND conname = 'intercompany_messages_status_check') THEN
    ALTER TABLE intercompany_messages ADD CONSTRAINT intercompany_messages_status_check
      CHECK (status IN ('pending', 'accepted', 'rejected', 'dismissed', 'failed', 'withdrawn'));
  END IF;
END $$;

-- A side that has auto-accept on today was switched on at its last change.
-- The start of tomorrow in Johannesburg: when a side switched on now starts mirroring (a document approved earlier today was not mirrored,
-- so today is never a cutover day). Pure (no table read), so any role may run it: the sides trigger runs as the writing user.
CREATE OR REPLACE FUNCTION public.intercompany_next_sa_midnight()
RETURNS timestamptz
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog, public, pg_temp
AS $$ SELECT (date_trunc('day', clock_timestamp() AT TIME ZONE 'Africa/Johannesburg') + interval '1 day') AT TIME ZONE 'Africa/Johannesburg' $$;
REVOKE ALL ON FUNCTION public.intercompany_next_sa_midnight() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.intercompany_next_sa_midnight() TO app_user, app_service, migration_admin;   -- (the sides trigger runs as the writer)
UPDATE intercompany_connection_sides SET auto_accept_since = updated_at WHERE auto_accept AND auto_accept_since IS NULL;
-- A side whose links are both set today switches mirroring on from the START OF TOMORROW (Johannesburg): no document was mirrored before
-- this migration, and one approved earlier today (or before it, dated today or later) never will be, so the first cutover day is tomorrow.
UPDATE intercompany_connection_sides SET mirroring_since = public.intercompany_next_sa_midnight()
 WHERE customer_id IS NOT NULL AND supplier_id IS NOT NULL AND mirroring_since IS NULL;

-- auto_accept_since is the moment auto-accept was switched ON; the worker takes only messages created after it, so switching it on
-- never drains a backlog. mirroring_since likewise for the side's mirroring (both links set). Set by the database, whatever was sent (no app
-- role has a column grant on either).
CREATE OR REPLACE FUNCTION public.intercompany_sides_auto_since()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF NOT NEW.auto_accept THEN
    NEW.auto_accept_since := NULL;
  ELSIF TG_OP = 'INSERT' OR NOT OLD.auto_accept OR OLD.auto_accept_since IS NULL THEN
    NEW.auto_accept_since := clock_timestamp();
  ELSE
    NEW.auto_accept_since := OLD.auto_accept_since;
  END IF;
  -- mirroring is ON while both links are set; switched on again after a gap, it starts again (the pair's cutover moves later)
  IF NEW.customer_id IS NULL OR NEW.supplier_id IS NULL THEN
    NEW.mirroring_since := NULL;
  ELSIF TG_OP = 'INSERT' OR OLD.customer_id IS NULL OR OLD.supplier_id IS NULL OR OLD.mirroring_since IS NULL THEN
    NEW.mirroring_since := public.intercompany_next_sa_midnight();   -- (from tomorrow: today's earlier approvals were not mirrored)
  ELSE
    NEW.mirroring_since := OLD.mirroring_since;
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.intercompany_sides_auto_since() FROM PUBLIC;
DROP TRIGGER IF EXISTS trg_intercompany_sides_auto_since ON intercompany_connection_sides;
CREATE TRIGGER trg_intercompany_sides_auto_since BEFORE INSERT OR UPDATE ON intercompany_connection_sides
  FOR EACH ROW EXECUTE FUNCTION public.intercompany_sides_auto_since();
ALTER TABLE intercompany_connection_sides ENABLE ALWAYS TRIGGER trg_intercompany_sides_auto_since;

-- ── 2. The DATABASE writes a document message, the sender never does ────────

DROP FUNCTION IF EXISTS public.intercompany_payload_problem(text, uuid, uuid, jsonb);

-- Text as the receiver's parser takes it: trimmed (all whitespace), cut at p_max characters, NULL when nothing is left.
CREATE OR REPLACE FUNCTION public.intercompany_clean_text(p_text text, p_max integer)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog, public, pg_temp
AS $$ SELECT NULLIF(pg_catalog.left(pg_catalog.regexp_replace(COALESCE(p_text, ''), '^\s+|\s+$', '', 'g'), p_max), '') $$;
REVOKE ALL ON FUNCTION public.intercompany_clean_text(text, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.intercompany_clean_text(text, integer) TO app_user, app_service, migration_admin;

-- Whether a journal is the exact NEGATION of another, account by account: every account's net (debit less credit) on p_child is minus its net on
-- p_parent, and the parent is a journal with something in it. A reversal's link (reversal_of_id) is a writable column; this is what makes a link
-- a REVERSAL by value. SECURITY INVOKER, migration_admin only.
CREATE OR REPLACE FUNCTION public.intercompany_lines_negate(p_child uuid, p_parent uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT EXISTS (SELECT 1 FROM public.gl_journal_lines pl WHERE pl.journal_entry_id = p_parent GROUP BY pl.gl_account_id HAVING sum(pl.debit - pl.credit) <> 0)
     AND NOT EXISTS (
       SELECT 1
         FROM (SELECT gl_account_id, sum(debit - credit) AS n FROM public.gl_journal_lines WHERE journal_entry_id = p_parent GROUP BY gl_account_id) a
         FULL JOIN (SELECT gl_account_id, sum(debit - credit) AS n FROM public.gl_journal_lines WHERE journal_entry_id = p_child GROUP BY gl_account_id) b USING (gl_account_id)
        WHERE COALESCE(a.n, 0) + COALESCE(b.n, 0) <> 0)
$$;
REVOKE ALL ON FUNCTION public.intercompany_lines_negate(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.intercompany_lines_negate(uuid, uuid) TO migration_admin;

-- The reversal chain that starts at p_je, walked ONCE: for each POSTED journal in it (the journal, its reversal, the reversal's reversal, ...),
-- the date from which it counts, its EFFECTIVE date: the latest date on its path from p_je (a link counts as at a date only if it and every
-- journal above it are dated on or before it). Sorted ascending; empty when p_je is not a posted journal of p_company. A link counts only if
-- it is posted, of the same company AND the exact negation of the journal it reverses (a forged, empty or re-pointed link ends the chain).
-- Walked level by level with an index lookup per level (reversal_of_id = ANY(the level)), not as a recursive CTE: the planner cannot size a
-- recursive work table and hashed it against the whole journal table. No depth cap (1018's cap on chains is not relied on): the walk ends
-- because a reachable cycle can only pass through p_je, which is excluded, and nothing is truncated. SECURITY INVOKER, migration_admin only.
CREATE OR REPLACE FUNCTION public.intercompany_journal_chain_eff(p_je uuid, p_company uuid)
RETURNS date[]
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog, public, pg_temp
AS $$
-- Linear in the chain's depth. Every journal has ONE reversal_of_id, so the journals reachable from p_je form a tree whose only possible
-- cycle runs back through p_je itself: excluding p_je (r.id <> p_je) ends the walk, with no growing "seen" array to scan. The dates are
-- appended in place (an element assignment, not a concatenation that copies the array each level) and sorted once at the end.
DECLARE
  v_ids uuid[];
  v_eff date[];
  v_all date[] := '{}'::date[];
  v_n integer := 0;
BEGIN
  SELECT ARRAY[je.id], ARRAY[je.entry_date] INTO v_ids, v_eff FROM public.gl_journal_entries je
   WHERE je.id = p_je AND je.company_id = p_company AND je.status = 'posted';
  IF v_ids IS NULL THEN RETURN '{}'::date[]; END IF;
  LOOP
    FOR i IN 1..cardinality(v_eff) LOOP
      v_n := v_n + 1;
      v_all[v_n] := v_eff[i];
    END LOOP;
    -- the level's children found by the index first (OFFSET 0 keeps the planner from testing the negation on every journal of the company
    -- before the join), then the value test on those few
    SELECT array_agg(c.id ORDER BY c.id), array_agg(c.eff ORDER BY c.id) INTO v_ids, v_eff
      FROM (SELECT r.id, r.reversal_of_id AS parent, GREATEST(r.entry_date, p.eff) AS eff
              FROM unnest(v_ids, v_eff) AS p(id, eff)
              JOIN public.gl_journal_entries r ON r.reversal_of_id = p.id
             WHERE r.id <> p_je AND r.company_id = p_company AND r.status = 'posted'
            OFFSET 0) c
     WHERE public.intercompany_lines_negate(c.id, c.parent);
    EXIT WHEN v_ids IS NULL;
  END LOOP;
  RETURN ARRAY(SELECT e FROM unnest(v_all) AS e ORDER BY e);
END;
$$;
REVOKE ALL ON FUNCTION public.intercompany_journal_chain_eff(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.intercompany_journal_chain_eff(uuid, uuid) TO migration_admin;

-- The number of journals of that chain counting as at p_asat (all of them when NULL): ODD = the ledger carries the document, EVEN = it is out.
-- p_eff, when given, is the chain's intercompany_journal_chain_eff, so a caller judging one chain at many dates walks it once: the count at a
-- date is a binary search of the sorted effective dates (width_bucket), not another walk.
DROP FUNCTION IF EXISTS public.intercompany_journal_chain_length(uuid, uuid, date);
DROP FUNCTION IF EXISTS public.intercompany_journal_chain_length(uuid, uuid, date, date[]);
CREATE OR REPLACE FUNCTION public.intercompany_journal_chain_length(p_je uuid, p_company uuid, p_asat date DEFAULT NULL, p_eff date[] DEFAULT NULL)
RETURNS integer
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT CASE WHEN p_asat IS NULL THEN cardinality(x.e) WHEN cardinality(x.e) = 0 THEN 0 ELSE pg_catalog.width_bucket(p_asat, x.e) END
    FROM (SELECT COALESCE(p_eff, public.intercompany_journal_chain_eff(p_je, p_company)) AS e) x
$$;
REVOKE ALL ON FUNCTION public.intercompany_journal_chain_length(uuid, uuid, date, date[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.intercompany_journal_chain_length(uuid, uuid, date, date[]) TO migration_admin;

-- Whether a document is LIVE in its books: approved (status) and linked to the journal that is its posting (a cancel clears an invoice's link).
-- A cancelled document is not revived by a reversal chain that looks alive again. SECURITY INVOKER, migration_admin only.
CREATE OR REPLACE FUNCTION public.intercompany_document_live(p_kind text, p_doc uuid, p_company uuid, p_je uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT p_je IS NOT NULL AND CASE p_kind
    WHEN 'invoice' THEN EXISTS (SELECT 1 FROM public.customer_invoices ci WHERE ci.id = p_doc AND ci.company_id = p_company AND ci.deleted_at IS NULL
                                  AND ci.status IN ('approved', 'sent', 'partially_paid', 'paid', 'overdue') AND ci.gl_journal_entry_id = p_je)
    WHEN 'credit_note' THEN EXISTS (SELECT 1 FROM public.credit_notes cn WHERE cn.id = p_doc AND cn.company_id = p_company AND cn.type = 'customer'
                                  AND cn.status IN ('approved', 'partially_applied', 'applied') AND cn.gl_journal_entry_id = p_je)
    ELSE false END
$$;
REVOKE ALL ON FUNCTION public.intercompany_document_live(text, uuid, uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.intercompany_document_live(text, uuid, uuid, uuid) TO migration_admin;

-- Whether a group row is one a MESSAGE records (a P2 row: the mirror's, matched by the database only). A definer: a trigger asks it for a
-- writer whose company is not a party of the message and so could not read it.
CREATE OR REPLACE FUNCTION public.intercompany_is_mirrored_row(p_row uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$ SELECT EXISTS (SELECT 1 FROM public.intercompany_messages m WHERE m.group_transaction_id = p_row) $$;
ALTER FUNCTION public.intercompany_is_mirrored_row(uuid) OWNER TO migration_admin;
REVOKE ALL ON FUNCTION public.intercompany_is_mirrored_row(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.intercompany_is_mirrored_row(uuid) TO app_user, app_service, migration_admin;

-- Why the journal p_je does not CARRY the sender's figures on the RECEIVER's side (expense lines net to the sender's amount, input VAT to its VAT,
-- the payable to its total, and no other kind of line), or NULL: judged by VALUE, as the sender's side is (intercompany_sender_journal_value_problem).
-- p_amount is the sender's amount in its own sign (a credit note's is negative). SECURITY INVOKER, migration_admin only.
CREATE OR REPLACE FUNCTION public.intercompany_receiver_journal_value_problem(p_kind text, p_je uuid, p_amount numeric, p_tax numeric, p_total numeric)
RETURNS text
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_sign integer := CASE p_kind WHEN 'credit_note' THEN -1 ELSE 1 END;
  v_expense numeric;
  v_vat numeric;
  v_payable numeric;
  v_other bigint;
BEGIN
  SELECT COALESCE(sum(jl.debit - jl.credit) FILTER (WHERE ga.account_type = 'expense'), 0),
         COALESCE(sum(jl.debit - jl.credit) FILTER (WHERE ga.account_subtype IN ('vat_input', 'vat_input_late_claim')), 0),
         COALESCE(sum(jl.credit - jl.debit) FILTER (WHERE ga.account_subtype = 'payable'), 0),
         count(*) FILTER (WHERE NOT (ga.account_type = 'expense' OR COALESCE(ga.account_subtype, '') IN ('payable', 'vat_input', 'vat_input_late_claim')))
    INTO v_expense, v_vat, v_payable, v_other
    FROM public.gl_journal_lines jl JOIN public.gl_accounts ga ON ga.id = jl.gl_account_id
   WHERE jl.journal_entry_id = p_je AND jl.company_id = (SELECT je.company_id FROM public.gl_journal_entries je WHERE je.id = p_je);   -- the journal's own lines, as the elimination reads them
  IF v_other > 0 THEN RETURN 'the journal has lines that are not expense, payable or input VAT (a capitalised cost needs an unrealised-profit entry)'; END IF;
  IF abs(p_amount - v_expense) <> 0 THEN RETURN 'the expense in the journal is not the sender''s amount'; END IF;
  IF round(v_vat * 100) <> round(v_sign * p_tax * 100) OR round(v_payable * 100) <> round(v_sign * p_total * 100) THEN
    RETURN 'the journal''s input VAT or payable is not the sender''s VAT and total';
  END IF;
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION public.intercompany_receiver_journal_value_problem(text, uuid, numeric, numeric, numeric) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.intercompany_receiver_journal_value_problem(text, uuid, numeric, numeric, numeric) TO migration_admin;

-- The fiscal year of p_company's calendar that contains p_date, or NULL. SECURITY INVOKER, migration_admin only.
CREATE OR REPLACE FUNCTION public.intercompany_fiscal_year(p_company uuid, p_date date)
RETURNS integer
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog, public, pg_temp
AS $$ SELECT fp.fiscal_year FROM public.fiscal_periods fp WHERE fp.company_id = p_company AND p_date BETWEEN fp.start_date AND fp.end_date ORDER BY fp.start_date DESC LIMIT 1 $$;
REVOKE ALL ON FUNCTION public.intercompany_fiscal_year(uuid, date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.intercompany_fiscal_year(uuid, date) TO migration_admin;

-- Why p_je is NOT the approval posting of p_doc (a customer invoice / customer credit note of p_company), or NULL when it is: the company's own,
-- an ORIGINAL posted entry (not a reversal), the one the approval writes (source and description name this document), referenced by no other
-- customer invoice / credit note of the company, and recorded on no other document's message. Whether it still STANDS is the caller's question
-- (a cancelled document's journal is reversed and is still its posting). SECURITY INVOKER, migration_admin only.
CREATE OR REPLACE FUNCTION public.intercompany_own_posting_problem(p_kind text, p_doc uuid, p_company uuid, p_je uuid)
RETURNS text
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  j RECORD;
  v_num text;
  v_source text;
  v_prefix text;
BEGIN
  IF p_je IS NULL THEN RETURN 'the document has no journal'; END IF;
  SELECT je.company_id, je.status, je.reversal_of_id, je.source, je.description INTO j FROM public.gl_journal_entries je WHERE je.id = p_je;
  IF NOT FOUND OR j.company_id IS DISTINCT FROM p_company THEN RETURN 'the journal is not this company''s'; END IF;
  IF j.status IS DISTINCT FROM 'posted' OR j.reversal_of_id IS NOT NULL THEN RETURN 'the journal is not an original posted entry'; END IF;
  IF p_kind = 'invoice' THEN
    SELECT ci.invoice_number INTO v_num FROM public.customer_invoices ci WHERE ci.id = p_doc AND ci.company_id = p_company;
    v_source := 'auto_invoice'; v_prefix := 'Customer invoice ';
  ELSIF p_kind = 'credit_note' THEN
    SELECT cn.credit_note_number INTO v_num FROM public.credit_notes cn WHERE cn.id = p_doc AND cn.company_id = p_company AND cn.type = 'customer';
    v_source := 'auto_credit_note'; v_prefix := 'Credit note ';
  ELSE
    RETURN 'this kind carries no document';
  END IF;
  IF v_num IS NULL OR j.source IS DISTINCT FROM v_source OR j.description IS DISTINCT FROM v_prefix || v_num THEN RETURN 'the journal is not the posting of this document'; END IF;
  IF EXISTS (SELECT 1 FROM public.customer_invoices x WHERE x.company_id = p_company AND x.gl_journal_entry_id = p_je AND x.id <> p_doc)
     OR EXISTS (SELECT 1 FROM public.credit_notes x WHERE x.company_id = p_company AND x.gl_journal_entry_id = p_je AND x.id <> p_doc) THEN
    RETURN 'the journal is the posting of another document';
  END IF;
  IF EXISTS (SELECT 1 FROM public.intercompany_messages m WHERE m.source_journal_entry_id = p_je AND m.source_doc_id <> p_doc) THEN
    RETURN 'the journal is recorded on another document''s message';
  END IF;
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION public.intercompany_own_posting_problem(text, uuid, uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.intercompany_own_posting_problem(text, uuid, uuid, uuid) TO migration_admin;

-- Whether p_row is the sender's own group row for a message: the sender's side (p_from) and the partner's (p_to), the sender's journal the
-- message was sent with, and both companies members of the row's group. Whatever a payload says about a group row is the sender's word; this is
-- what the database knows. SECURITY INVOKER, migration_admin only (the definers below call it).
CREATE OR REPLACE FUNCTION public.intercompany_group_row_ok(p_row uuid, p_from uuid, p_to uuid, p_je uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.intercompany_transactions it
     WHERE it.id = p_row AND it.source_company_id = p_from AND it.target_company_id = p_to
       AND p_je IS NOT NULL AND it.source_journal_entry_id = p_je   -- (NULL is no journal: a row with none is not "the same journal" as a message with none)
       AND EXISTS (SELECT 1 FROM public.company_group_members a WHERE a.group_id = it.group_id AND a.company_id = p_from)
       AND EXISTS (SELECT 1 FROM public.company_group_members b WHERE b.group_id = it.group_id AND b.company_id = p_to))
$$;
REVOKE ALL ON FUNCTION public.intercompany_group_row_ok(uuid, uuid, uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.intercompany_group_row_ok(uuid, uuid, uuid, uuid) TO migration_admin;

-- The payload of a document message, built from the SENDER's books and nothing else: (payload, problem, journal). problem is NULL, or
-- 'not_found' / 'not_approved' / 'unmirrorable: <why>' (a document the receiver's parser would refuse: a negative line, a header that is not
-- its lines, a VAT more than a cent from its rate). SECURITY INVOKER and executable by migration_admin only: it reads whatever company it is
-- told to, so it is reached through intercompany_send_for_source / intercompany_message_source_changed, which name the session company.
-- The rules are the parser's (mirrorPayload.ts parseMirrorPayload), cents-exact; a header VAT is split over the lines by largest remainder.
CREATE OR REPLACE FUNCTION public.intercompany_build_payload(p_kind text, p_source uuid, p_company uuid)
RETURNS TABLE (payload jsonb, problem text, journal_entry_id uuid)
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  d RECORD;
  v_name text;
  v_vat text;
  v_lines jsonb;
  v_n bigint;
  v_sum_c bigint;
  v_sum_v bigint;
  v_bad bigint;
  v_sub bigint;
  v_tax bigint;
  v_tot bigint;
  v_pdf jsonb;
  v_payload jsonb;
BEGIN
  SELECT COALESCE(public.intercompany_clean_text(co.name, 200), ''), public.intercompany_clean_text(co.vat_number, 50)
    INTO v_name, v_vat FROM public.companies co WHERE co.id = p_company;

  IF p_kind = 'invoice' THEN
    SELECT ci.invoice_number AS num, to_char(ci.invoice_date, 'YYYY-MM-DD') AS dt, to_char(ci.due_date, 'YYYY-MM-DD') AS due,
           upper(COALESCE(NULLIF(btrim(ci.currency_code), ''), 'ZAR')) AS cur, ci.subtotal, ci.tax_amount, ci.total_amount, ci.notes, ci.status,
           ci.gl_journal_entry_id AS je, ci.source_document_id AS doc, ci.rendered_pdf_storage_path AS pth, ci.rendered_pdf_sha256 AS sha
      INTO d FROM public.customer_invoices ci WHERE ci.id = p_source AND ci.company_id = p_company AND ci.deleted_at IS NULL;
    IF NOT FOUND THEN RETURN QUERY SELECT NULL::jsonb, 'not_found'::text, NULL::uuid; RETURN; END IF;
    IF d.status NOT IN ('approved', 'sent', 'partially_paid', 'paid', 'overdue') THEN RETURN QUERY SELECT NULL::jsonb, 'not_approved'::text, d.je; RETURN; END IF;
    v_sub := round(COALESCE(d.subtotal, 0) * 100)::bigint; v_tax := round(COALESCE(d.tax_amount, 0) * 100)::bigint; v_tot := round(COALESCE(d.total_amount, 0) * 100)::bigint;

    -- A SINGLE-line document carries its header VAT as its line's VAT whatever the line's rate says (an import with a mixed or rounded rate:
    -- the line IS the document); with several lines each line's VAT is held within a cent of its rate.
    -- A line is sent as quantity x price when that multiplies out to its amount (to the cent; quantity is numeric(10,2) and prices are numeric(15,2),
    -- so the parser's bounds hold); a discounted line is one unit at the line's amount. A line's VAT is its amount at its rate, and the cents the header VAT
    -- is above or below the sum of those go one each to the lines with the largest (below: smallest) fractional cent, round and round.
    WITH it AS (
      SELECT row_number() OVER (ORDER BY i.line_position NULLS LAST, i.created_at, i.id) AS n,
             i.description AS descr, i.quantity AS q, i.unit_price AS up, COALESCE(i.tax_rate, 0) AS r,
             round(COALESCE(i.amount, 0) * 100)::bigint AS c, round(COALESCE(i.tax_rate, 0) * 100)::bigint AS r100
        FROM public.customer_invoice_items i WHERE i.invoice_id = p_source),
    base AS (SELECT it.*, (it.c * it.r100) AS u, floor((it.c * it.r100)::numeric / 10000)::bigint AS b FROM it),
    tot AS (SELECT count(*) AS cnt, COALESCE(sum(base.b), 0)::bigint AS sb FROM base),
    adj AS (
      SELECT base.*, tot.cnt, v_tax - tot.sb AS rest,
             row_number() OVER (ORDER BY (base.u - base.b * 10000) DESC, base.n ASC) AS rk_up,
             row_number() OVER (ORDER BY (base.u - base.b * 10000) ASC, base.n DESC) AS rk_down
        FROM base CROSS JOIN tot),
    fin AS (
      SELECT adj.*, adj.b + CASE WHEN adj.rest > 0 THEN adj.rest / adj.cnt + CASE WHEN adj.rk_up <= adj.rest % adj.cnt THEN 1 ELSE 0 END
                                 WHEN adj.rest < 0 THEN -((-adj.rest) / adj.cnt) - CASE WHEN adj.rk_down <= (-adj.rest) % adj.cnt THEN 1 ELSE 0 END
                                 ELSE 0 END AS vat,
             COALESCE(round(adj.q * adj.up * 100)::bigint = adj.c AND adj.up >= 0 AND adj.q > 0, false) AS mult
        FROM adj)
    SELECT jsonb_agg(jsonb_build_object(
             'description', COALESCE(public.intercompany_clean_text(f.descr, 1000), '(no description)'),
             'quantity', CASE WHEN f.mult THEN f.q ELSE 1 END,
             'unitPrice', CASE WHEN f.mult THEN f.up ELSE (f.c::numeric / 100)::numeric(16, 2) END,
             'taxRate', f.r, 'taxAmount', (f.vat::numeric / 100)::numeric(16, 2), 'lineTotal', (f.c::numeric / 100)::numeric(16, 2)) ORDER BY f.n),
           count(*), COALESCE(sum(f.c), 0), COALESCE(sum(f.vat), 0),
           count(*) FILTER (WHERE NOT (f.c >= 0 AND f.r BETWEEN 0 AND 100 AND f.vat >= 0 AND (f.cnt = 1 OR abs(f.vat * 10000 - f.c * f.r100) <= 10000)))
      INTO v_lines, v_n, v_sum_c, v_sum_v, v_bad FROM fin f;
    IF v_n = 0 OR v_n > 500 THEN RETURN QUERY SELECT NULL::jsonb, 'unmirrorable: needs between 1 and 500 lines'::text, d.je; RETURN; END IF;
    IF v_bad > 0 THEN RETURN QUERY SELECT NULL::jsonb, 'unmirrorable: a line is negative, its tax rate is outside 0 to 100, or its VAT is not its amount at its rate'::text, d.je; RETURN; END IF;
    IF v_sum_c <> v_sub THEN RETURN QUERY SELECT NULL::jsonb, 'unmirrorable: the line totals do not add up to the subtotal'::text, d.je; RETURN; END IF;
    IF v_sum_v <> v_tax THEN RETURN QUERY SELECT NULL::jsonb, 'unmirrorable: the line VAT does not add up to the document VAT'::text, d.je; RETURN; END IF;
    -- The sender's sealed PDF: only the one the sealing wrote for THIS invoice, <company>/<its captured document>.pdf, with the hash that document has.
    v_pdf := CASE WHEN d.pth = lower(p_company::text) || '/' || d.doc::text || '.pdf' AND d.sha ~ '^[0-9a-f]{64}$' AND EXISTS (
                    SELECT 1 FROM public.captured_documents cd
                     WHERE cd.id = d.doc AND cd.company_id = p_company AND cd.storage_path = d.pth AND cd.raw_bytes_sha256 = d.sha)
                  THEN jsonb_build_object('path', d.pth, 'sha256', d.sha) END;
    v_payload := jsonb_build_object(
      'version', 1, 'kind', 'invoice', 'number', d.num, 'date', d.dt, 'dueDate', d.due, 'currency', d.cur,
      'subtotal', (v_sub::numeric / 100)::numeric(16, 2), 'taxAmount', (v_tax::numeric / 100)::numeric(16, 2), 'total', (v_tot::numeric / 100)::numeric(16, 2),
      'senderName', v_name, 'senderVatNumber', v_vat, 'notes', public.intercompany_clean_text(d.notes, 2000),
      'lines', v_lines, 'pdf', v_pdf, 'creditsInvoiceNumber', NULL, 'groupTransactionId', NULL);
  ELSIF p_kind = 'credit_note' THEN
    SELECT COALESCE(cn.credit_note_number, 'CN-' || left(cn.id::text, 8)) AS num, to_char(cn.credit_date, 'YYYY-MM-DD') AS dt,
           upper(COALESCE(NULLIF(btrim(cn.currency), ''), 'ZAR')) AS cur, cn.subtotal, cn.tax_amount, cn.total_amount, cn.tax_rate, cn.reason, cn.status,
           cn.gl_journal_entry_id AS je, ci.invoice_number AS credits
      INTO d FROM public.credit_notes cn
      LEFT JOIN public.customer_invoices ci ON ci.id = cn.customer_invoice_id AND ci.company_id = cn.company_id
     WHERE cn.id = p_source AND cn.company_id = p_company AND cn.type = 'customer';
    IF NOT FOUND THEN RETURN QUERY SELECT NULL::jsonb, 'not_found'::text, NULL::uuid; RETURN; END IF;
    IF d.status NOT IN ('approved', 'partially_applied', 'applied') THEN RETURN QUERY SELECT NULL::jsonb, 'not_approved'::text, d.je; RETURN; END IF;
    v_sub := round(COALESCE(d.subtotal, 0) * 100)::bigint; v_tax := round(COALESCE(d.tax_amount, 0) * 100)::bigint; v_tot := round(COALESCE(d.total_amount, 0) * 100)::bigint;
    IF v_sub < 0 OR v_tax < 0 OR COALESCE(d.tax_rate, 0) NOT BETWEEN 0 AND 100 THEN
      RETURN QUERY SELECT NULL::jsonb, 'unmirrorable: a total or the tax rate is negative or out of range'::text, d.je; RETURN;
    END IF;
    v_payload := jsonb_build_object(
      'version', 1, 'kind', 'credit_note', 'number', d.num, 'date', d.dt, 'dueDate', NULL, 'currency', d.cur,
      'subtotal', (v_sub::numeric / 100)::numeric(16, 2), 'taxAmount', (v_tax::numeric / 100)::numeric(16, 2), 'total', (v_tot::numeric / 100)::numeric(16, 2),
      'senderName', v_name, 'senderVatNumber', v_vat, 'notes', public.intercompany_clean_text(d.reason, 2000),
      'lines', jsonb_build_array(jsonb_build_object(
        'description', COALESCE(public.intercompany_clean_text(d.reason, 1000), 'Credit note ' || d.num), 'quantity', 1,
        'unitPrice', (v_sub::numeric / 100)::numeric(16, 2), 'taxRate', COALESCE(d.tax_rate, 0), 'taxAmount', (v_tax::numeric / 100)::numeric(16, 2),
        'lineTotal', (v_sub::numeric / 100)::numeric(16, 2))),
      'pdf', NULL, 'creditsInvoiceNumber', public.intercompany_clean_text(d.credits, 50), 'groupTransactionId', NULL);
  ELSE
    RETURN QUERY SELECT NULL::jsonb, 'not_found'::text, NULL::uuid; RETURN;
  END IF;

  IF COALESCE(length(d.num), 0) < 1 OR length(d.num) > 50 THEN RETURN QUERY SELECT NULL::jsonb, 'unmirrorable: the document number is missing or too long'::text, d.je; RETURN; END IF;
  IF v_sub + v_tax <> v_tot THEN RETURN QUERY SELECT NULL::jsonb, 'unmirrorable: the total is not the subtotal plus VAT'::text, d.je; RETURN; END IF;
  IF octet_length(v_payload::text) > 262144 THEN RETURN QUERY SELECT NULL::jsonb, 'unmirrorable: the document is too large to send'::text, d.je; RETURN; END IF;
  RETURN QUERY SELECT v_payload, NULL::text, d.je;
END;
$$;
REVOKE ALL ON FUNCTION public.intercompany_build_payload(text, uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.intercompany_build_payload(text, uuid, uuid) TO migration_admin;

DROP FUNCTION IF EXISTS public.intercompany_sender_journal_value_problem(text, uuid, uuid, numeric, numeric, numeric);
-- Why the journal p_je does not CARRY the figures of a customer invoice / credit note (its gross on the receivable, its net on revenue, its VAT
-- on output VAT, all to the cent, nothing else on it), or NULL: judged by VALUE, because who posted a journal and what it says are a writer's.
-- A credit note's journal is the invoice's with the sides swapped. SECURITY INVOKER, migration_admin only.
CREATE OR REPLACE FUNCTION public.intercompany_sender_journal_value_problem(p_kind text, p_je uuid, p_company uuid, p_subtotal numeric, p_total numeric)
RETURNS text
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_sign integer := CASE p_kind WHEN 'credit_note' THEN -1 ELSE 1 END;
  v_ar numeric;
  v_rev numeric;
  v_other bigint;
BEGIN
  SELECT COALESCE(sum(jl.debit - jl.credit) FILTER (WHERE ga.account_subtype = 'receivable'), 0),
         COALESCE(sum(jl.credit - jl.debit) FILTER (WHERE ga.account_type = 'revenue'), 0),
         count(*) FILTER (WHERE NOT (COALESCE(ga.account_subtype, '') = 'receivable' OR ga.account_type = 'revenue' OR COALESCE(ga.account_subtype, '') = 'vat_output'))
    INTO v_ar, v_rev, v_other
    FROM public.gl_journal_lines jl JOIN public.gl_accounts ga ON ga.id = jl.gl_account_id WHERE jl.journal_entry_id = p_je AND jl.company_id = p_company;
  IF v_other > 0 THEN RETURN 'the journal has lines that are not receivable, revenue or output VAT'; END IF;
  IF round(v_ar * 100) <> round(v_sign * p_total * 100) THEN RETURN 'the journal''s receivable is not the document''s total'; END IF;
  IF round(v_rev * 100) <> round(v_sign * p_subtotal * 100) THEN RETURN 'the journal''s revenue is not the document''s subtotal'; END IF;
  -- (the output VAT is implied: a posted journal balances, so receivable = revenue + VAT once the two above hold and total = subtotal + VAT)
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION public.intercompany_sender_journal_value_problem(text, uuid, uuid, numeric, numeric) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.intercompany_sender_journal_value_problem(text, uuid, uuid, numeric, numeric) TO migration_admin;

-- Whether a row other than p_row holds p_je as the DATABASE bound it: as its first match (written by the definer, unique), or as the target of a
-- MIRRORED row (written by the definer only). A writer's own row naming the journal as its target is a writer's column and holds nothing here
-- (else any group writer could remove another pair's elimination with one INSERT). Two EXISTS, each driven by its own index on
-- intercompany_transactions (the mirrored test is a per-row check of the few rows on that journal, never a join the planner could drive
-- from the messages side). SECURITY INVOKER, migration_admin only.
CREATE OR REPLACE FUNCTION public.intercompany_journal_bound_elsewhere(p_je uuid, p_row uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT EXISTS (SELECT 1 FROM public.intercompany_transactions o WHERE o.first_target_journal_entry_id = p_je AND o.id <> p_row)
      OR EXISTS (SELECT 1 FROM public.intercompany_transactions o
                  WHERE o.target_journal_entry_id = p_je AND o.id <> p_row AND public.intercompany_is_mirrored_row(o.id))
$$;
REVOKE ALL ON FUNCTION public.intercompany_journal_bound_elsewhere(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.intercompany_journal_bound_elsewhere(uuid, uuid) TO migration_admin;

-- Why journal p_je is NOT the posting of p_row's receiver document (a supplier invoice / supplier credit note of p_co), or NULL: structural only
-- (the figures are intercompany_receiver_journal_value_problem's). The journal is a posted journal of this company, the one posting THIS document
-- wrote (source and text), standing at p_asat (NULL = now: an odd reversal chain counting links dated on or before it), no other document's
-- posting and no other row's, for the connection's supplier, and in the same financial year of the company's calendar as the sender's date. The
-- document's link to its journal is a column a writer can point anywhere, and the journal's text is a writer's too: hence each check. SECURITY INVOKER, migration_admin only.
DROP FUNCTION IF EXISTS public.intercompany_receiver_journal_problem(uuid, uuid, text, uuid, uuid, date);
DROP FUNCTION IF EXISTS public.intercompany_receiver_journal_problem(uuid, uuid, text, uuid, uuid, date, date[]);
CREATE OR REPLACE FUNCTION public.intercompany_receiver_journal_problem(p_row uuid, p_co uuid, p_doc_type text, p_doc_id uuid, p_je uuid, p_asat date,
                                                                         p_eff date[] DEFAULT NULL)
RETURNS text
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  d RECORD;
  j RECORD;
  v_date date;
  v_conn uuid;
  v_side_supplier uuid;
  v_fy_sender integer;
  v_fy_journal integer;
BEGIN
  IF p_doc_type = 'supplier_invoice' THEN
    SELECT si.supplier_id AS supplier, 'auto_supplier_invoice' AS src, 'Supplier invoice ' || si.invoice_number AS descr INTO d
      FROM public.supplier_invoices si WHERE si.id = p_doc_id AND si.company_id = p_co;
  ELSIF p_doc_type = 'credit_note' THEN
    SELECT cn.supplier_id AS supplier, 'auto_credit_note' AS src, 'Credit note ' || cn.credit_note_number AS descr INTO d
      FROM public.credit_notes cn WHERE cn.id = p_doc_id AND cn.company_id = p_co AND cn.type = 'supplier';
  ELSE
    RETURN 'the receiver''s document is not a bill or a supplier credit note';
  END IF;
  IF NOT FOUND THEN RETURN 'the receiver''s document does not exist'; END IF;
  SELECT it.transaction_date INTO v_date FROM public.intercompany_transactions it WHERE it.id = p_row;
  SELECT x.connection_id INTO v_conn FROM public.intercompany_messages x WHERE x.group_transaction_id = p_row LIMIT 1;
  SELECT s.supplier_id INTO v_side_supplier FROM public.intercompany_connection_sides s WHERE s.connection_id = v_conn AND s.company_id = p_co;
  SELECT je.company_id, je.status, je.source, je.description, je.entry_date INTO j FROM public.gl_journal_entries je WHERE je.id = p_je;
  v_fy_sender := public.intercompany_fiscal_year(p_co, v_date);
  v_fy_journal := public.intercompany_fiscal_year(p_co, j.entry_date);
  IF j.company_id IS DISTINCT FROM p_co OR j.status IS DISTINCT FROM 'posted' THEN
    RETURN 'the bill''s journal is not a posted journal of this company';
  ELSIF j.source IS DISTINCT FROM d.src OR j.description IS DISTINCT FROM d.descr THEN
    RETURN 'the journal is not the one that posting this document wrote';
  ELSIF public.intercompany_journal_chain_length(p_je, p_co, p_asat, p_eff) % 2 = 0 THEN   -- (p_eff: p_je's chain, walked once by the caller)
    RETURN 'the bill''s journal has been reversed';
  ELSIF EXISTS (SELECT 1 FROM public.supplier_invoices x WHERE x.company_id = p_co AND x.gl_journal_entry_id = p_je AND x.id <> p_doc_id)
     OR EXISTS (SELECT 1 FROM public.credit_notes x WHERE x.company_id = p_co AND x.gl_journal_entry_id = p_je AND x.id <> p_doc_id) THEN
    RETURN 'the journal is the posting of another document';
  ELSIF public.intercompany_journal_bound_elsewhere(p_je, p_row) THEN
    RETURN 'the journal is already matched to another transaction';
  ELSIF v_side_supplier IS NULL OR d.supplier IS DISTINCT FROM v_side_supplier THEN
    RETURN 'the supplier is not the one this connection is with';
  ELSIF v_fy_sender IS NULL OR v_fy_journal IS NULL THEN
    RETURN 'the journal or the sender''s date is in no fiscal period of this company';
  ELSIF v_fy_sender <> v_fy_journal THEN
    RETURN 'cut-off: different financial years';
  END IF;
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION public.intercompany_receiver_journal_problem(uuid, uuid, text, uuid, uuid, date, date[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.intercompany_receiver_journal_problem(uuid, uuid, text, uuid, uuid, date, date[]) TO migration_admin;

-- The receiver's journal for a mirrored group row AS AT p_asat, from the ledgers and the documents, or NULL. No hook is needed: the journal the
-- row was first matched to, while it still stands in the same financial year with the sender's figures and no other row holds it
-- (a bound row is moved by nothing the bill's columns say), else the journal the accepted message's bill / credit note links to, when it passes every structural and value check above.
-- SECURITY INVOKER, migration_admin only.
-- p_first_eff / p_doc_eff: the chains of the row's first journal and of the document's journal, walked once by a caller judging many dates.
DROP FUNCTION IF EXISTS public.intercompany_receiver_je(uuid, date);
DROP FUNCTION IF EXISTS public.intercompany_receiver_je(uuid, date, date[], date[]);
CREATE OR REPLACE FUNCTION public.intercompany_receiver_je(p_row uuid, p_asat date, p_first_eff date[] DEFAULT NULL, p_doc_eff date[] DEFAULT NULL)
RETURNS uuid
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  m RECORD;
  t RECORD;
  v_je uuid;
BEGIN
  SELECT x.kind, x.to_company_id AS co, x.target_doc_type AS dtype, x.target_doc_id AS did,
         (x.payload->>'taxAmount')::numeric AS tax, (x.payload->>'total')::numeric AS total INTO m
    FROM public.intercompany_messages x WHERE x.group_transaction_id = p_row AND x.kind IN ('invoice', 'credit_note') AND x.status = 'accepted' LIMIT 1;
  IF NOT FOUND OR m.did IS NULL THEN RETURN NULL; END IF;
  SELECT it.amount, it.transaction_date AS td, it.first_target_journal_entry_id AS first_je INTO t FROM public.intercompany_transactions it WHERE it.id = p_row;
  IF t.first_je IS NOT NULL
     AND public.intercompany_journal_chain_length(t.first_je, m.co, p_asat, p_first_eff) % 2 = 1
     AND public.intercompany_fiscal_year(m.co, t.td) IS NOT NULL
     AND public.intercompany_fiscal_year(m.co, t.td) IS NOT DISTINCT FROM
         public.intercompany_fiscal_year(m.co, (SELECT je.entry_date FROM public.gl_journal_entries je WHERE je.id = t.first_je))
     AND public.intercompany_receiver_journal_value_problem(m.kind, t.first_je, t.amount, m.tax, m.total) IS NULL
     -- no OTHER ROW holds it as the database bound it (intercompany_journal_bound_elsewhere: another row's first match, which the unique index
     -- refuses anyway, or a MIRRORED row's target, e.g. a concurrent re-match: a journal two mirrored rows hold eliminates nothing). A writer's own
     -- row naming the journal, or another document's link to it, is a writer's column and moves no figure here.
     AND NOT public.intercompany_journal_bound_elsewhere(t.first_je, p_row) THEN
    RETURN t.first_je;
  END IF;
  IF m.dtype = 'supplier_invoice' THEN
    SELECT si.gl_journal_entry_id INTO v_je FROM public.supplier_invoices si WHERE si.id = m.did AND si.company_id = m.co;
  ELSIF m.dtype = 'credit_note' THEN
    SELECT cn.gl_journal_entry_id INTO v_je FROM public.credit_notes cn WHERE cn.id = m.did AND cn.company_id = m.co AND cn.type = 'supplier';
  END IF;
  IF v_je IS NULL THEN RETURN NULL; END IF;
  IF public.intercompany_receiver_journal_problem(p_row, m.co, m.dtype, m.did, v_je, p_asat, p_doc_eff) IS NULL
     AND public.intercompany_receiver_journal_value_problem(m.kind, v_je, t.amount, m.tax, m.total) IS NULL THEN
    RETURN v_je;
  END IF;
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION public.intercompany_receiver_je(uuid, date, date[], date[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.intercompany_receiver_je(uuid, date, date[], date[]) TO migration_admin;

-- (an earlier shape of this migration walked each chain again for its dates: intercompany_journal_chain_eff gives them, walked once)
DROP FUNCTION IF EXISTS public.intercompany_journal_chain_dates(uuid, uuid);

-- The receiver's journal of a mirrored row when the PAIR stands as at p_asat, or NULL: the sender's journal stands (an odd chain counting only
-- links dated on or before p_asat) and carries the document's figures by value, and the receiver's journal is intercompany_receiver_je's as at
-- p_asat. p_se / p_fe / p_de: the chains (intercompany_journal_chain_eff) of the sender's, the first-matched and the document's journals, walked
-- once by the derivation, so judging a row at each of its dates costs a binary search per chain, not a walk. SECURITY INVOKER, migration_admin only.
DROP FUNCTION IF EXISTS public.intercompany_mirror_pair_at(uuid, date);
DROP FUNCTION IF EXISTS public.intercompany_mirror_pair_at(uuid, date, date[], date[], date[]);
CREATE OR REPLACE FUNCTION public.intercompany_mirror_pair_at(p_row uuid, p_asat date, p_se date[] DEFAULT NULL, p_fe date[] DEFAULT NULL, p_de date[] DEFAULT NULL)
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT public.intercompany_receiver_je(m.group_transaction_id, p_asat, p_fe, p_de)
    FROM public.intercompany_messages m
   WHERE m.group_transaction_id = p_row AND m.kind IN ('invoice', 'credit_note') AND m.source_journal_entry_id IS NOT NULL
     AND public.intercompany_journal_chain_length(m.source_journal_entry_id, m.from_company_id, p_asat, p_se) % 2 = 1
     AND public.intercompany_sender_journal_value_problem(m.kind, m.source_journal_entry_id, m.from_company_id,
           (m.payload->>'subtotal')::numeric, (m.payload->>'total')::numeric) IS NULL
   LIMIT 1
$$;
REVOKE ALL ON FUNCTION public.intercompany_mirror_pair_at(uuid, date, date[], date[], date[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.intercompany_mirror_pair_at(uuid, date, date[], date[], date[]) TO migration_admin;

-- THE ELIMINATIONS OF THE MIRRORED DOCUMENTS, DERIVED AT READ TIME and never stored, as dated EVENTS. For a group the caller is a member of,
-- and a mirrored row whose two companies are both CURRENT members of it (the reports' member set): the pair STANDS on a date d when, with the
-- ledgers as they stood at d (reversal chains counting only value-negating links dated on or before d), the sender's journal stands and carries
-- the document's figures and the receiver has a standing journal for it (intercompany_receiver_je: the same financial year in the receiver's
-- calendar as the sender's date, the figures by value, no other row's or document's). The elimination is +E on the date the pair starts
-- standing on a receiver journal, and the counter-elimination -E on the date it stops (a value-negating link on either side, or the receiver's
-- journal replaced by another); standing again is a new +E. Those dates are the chains' own journal dates, so the first +E is dated the later
-- of the sender's and the receiver's journal dates. A period p_start..p_end is the sum of the events dated in it (each judged with only the
-- links dated on or before it), so AT ANY MOMENT any range is the sum of its months line by line. A booking, a reversal or a re-reversal in a
-- later period does not change an earlier one. THE LIMIT: the REVERSAL CHAINS are dated (a later reversal never changes an earlier period);
-- the REFERENCE DATA the judgement reads is as it is TODAY and is not dated: the receiver's fiscal periods (the financial-year cut-off), the
-- connection side's supplier and the document's supplier (an UNBOUND row: one never matched by the sync, whose receiver journal is the
-- document's current one), which other rows hold a journal, the group's members and its account mappings. Editing one of them can change a
-- PAST period's figure (and so a report already given); re-pointing a receiver document's journal link does too (1018 refuses that swap to
-- non-superusers). The state only changes on a chain date, so a row is judged on its chain dates inside the period and once just before
-- p_start; a row with no chain date in the period is not judged at all.
-- Within the period a +E and a -E on one receiver journal cancel; what is left is one row per (row, receiver journal): kind 'eliminate' (+E)
-- or 'reverse' (-E), key_date its latest event in the period. One row per elimination LINE, from the journals' OWN lines
-- (each of its own company): the sender's revenue lines (credit - debit) and the receiver's expense lines (debit - credit), signed as the
-- sender wrote the document (a credit note is negative) and negated for a counter-elimination.
DROP FUNCTION IF EXISTS public.intercompany_mirror_eliminations(uuid, date, date);
CREATE OR REPLACE FUNCTION public.intercompany_mirror_eliminations(p_group uuid, p_start date, p_end date)
RETURNS TABLE (transaction_id uuid, source_company_id uuid, target_company_id uuid, amount numeric, transaction_date date, key_date date,
               description text, side text, gl_account_id uuid, net numeric, receiver_journal_id uuid, kind text)
LANGUAGE sql
STABLE
SECURITY DEFINER
-- jit off: the statement's estimated cost (function calls per row) crosses the JIT thresholds, and compiling it cost about 1.6 s per call
-- against about 0.15 s to run it (measured on 10 000 rows); a report call is short and runs once
SET jit = off
SET search_path = pg_catalog, public, pg_temp
AS $$
  WITH RECURSIVE rws AS (
    SELECT it.id, it.source_company_id AS sc, it.target_company_id AS tc, it.amount, it.transaction_date AS td, it.description AS descr,
           m.source_journal_entry_id AS sje, it.first_target_journal_entry_id AS fje, m.from_company_id AS fc, m.to_company_id AS toc,
           CASE m.target_doc_type
             WHEN 'supplier_invoice' THEN (SELECT si.gl_journal_entry_id FROM public.supplier_invoices si WHERE si.id = m.target_doc_id AND si.company_id = m.to_company_id)
             WHEN 'credit_note' THEN (SELECT cn.gl_journal_entry_id FROM public.credit_notes cn WHERE cn.id = m.target_doc_id AND cn.company_id = m.to_company_id AND cn.type = 'supplier')
           END AS dje
      FROM public.intercompany_transactions it
      JOIN public.intercompany_messages m ON m.group_transaction_id = it.id AND m.kind IN ('invoice', 'credit_note')
     WHERE it.group_id = p_group AND p_group IN (SELECT public.rls_user_group_ids())
       AND m.status = 'accepted' AND m.source_journal_entry_id IS NOT NULL AND m.target_doc_id IS NOT NULL   -- (a pending message may carry a target a handler set)
       AND EXISTS (SELECT 1 FROM public.company_group_members a WHERE a.group_id = p_group AND a.company_id = it.source_company_id AND a.left_date IS NULL)
       AND EXISTS (SELECT 1 FROM public.company_group_members b WHERE b.group_id = p_group AND b.company_id = it.target_company_id AND b.left_date IS NULL)
  ), up (id, parent) AS (
    -- BOUNDED BY DATE before any chain is walked: the reversals dated in the period (of the rows' companies, an index range), walked up to the
    -- journal each one reverses, so a row whose chain changes in the period is found from the period's journals, not by walking every row
    SELECT je.id, je.reversal_of_id FROM public.gl_journal_entries je
     WHERE je.reversal_of_id IS NOT NULL AND je.status = 'posted' AND je.entry_date BETWEEN p_start AND p_end
       AND je.company_id = ANY (ARRAY(SELECT rws.sc FROM rws UNION SELECT rws.tc FROM rws))   -- (an array: the (company, date) index serves it)
    UNION
    SELECT p.id, p.reversal_of_id FROM public.gl_journal_entries p JOIN up ON p.id = up.parent
  ), pj AS (
    -- the journals that can be a chain's journal dated in the period: the rows' companies' posted journals dated in it, and the root each
    -- reversal dated in it leads up to (an index range each; then the rows are matched to them by hash, never row by row)
    SELECT je.id FROM public.gl_journal_entries je
     WHERE je.status = 'posted' AND je.entry_date BETWEEN p_start AND p_end
       AND je.company_id = ANY (ARRAY(SELECT rws.sc FROM rws UNION SELECT rws.tc FROM rws))
    UNION
    -- EVERY journal the up-walk passed (not its roots only): a row whose own journal carries a reversal_of_id (or sits in a cycle) is found too
    SELECT up.id FROM up
  ), touched AS (
    -- the rows with a chain date in the period: one of their three journals is one of those
    SELECT r.id FROM rws r JOIN pj ON pj.id = r.sje
    UNION SELECT r.id FROM rws r JOIN pj ON pj.id = r.fje
    UNION SELECT r.id FROM rws r JOIN pj ON pj.id = r.dje
  ), t AS MATERIALIZED (
    SELECT r.* FROM rws r JOIN touched ON touched.id = r.id
  ), ok AS (
    SELECT t.* FROM t WHERE public.intercompany_group_row_ok(t.id, t.fc, t.toc, t.sje)
  ), ch AS MATERIALIZED (
    -- each touched row's three chains, walked ONCE: their journals' effective dates (sorted), reused for every date the row is judged at
    SELECT r.id, public.intercompany_journal_chain_eff(r.sje, r.sc) AS se, public.intercompany_journal_chain_eff(r.fje, r.tc) AS fe,
           public.intercompany_journal_chain_eff(r.dje, r.tc) AS de
      FROM ok r
  ), cand AS (
    -- the dates on or before p_end on which a touched row's pair can start or stop standing (its chains' effective dates)
    SELECT DISTINCT h.id, x.d FROM ch h CROSS JOIN LATERAL unnest(h.se || h.fe || h.de) AS x(d)
     WHERE x.d <= p_end
  ), live AS (
    -- only a row with a chain date in the period can have an event in it. It is judged on those dates, and once just before p_start (only when
    -- it has a date before p_start: otherwise nothing stood), never on its earlier dates: the state is constant between chain dates.
    SELECT c.id, bool_or(c.d < p_start) AS earlier FROM cand c GROUP BY c.id HAVING bool_or(c.d >= p_start)
  ), seq AS (
    SELECT s.id, s.d, s.rje, lag(s.rje) OVER (PARTITION BY s.id ORDER BY s.d) AS prev
      FROM (SELECT c.id, c.d, public.intercompany_mirror_pair_at(c.id, c.d, h.se, h.fe, h.de) AS rje
              FROM cand c JOIN ch h ON h.id = c.id WHERE c.d >= p_start AND c.id IN (SELECT live.id FROM live)
            UNION ALL
            SELECT l.id, p_start - 1, public.intercompany_mirror_pair_at(l.id, p_start - 1, h.se, h.fe, h.de) FROM live l JOIN ch h ON h.id = l.id WHERE l.earlier) s
  ), ev AS (
    SELECT seq.id, seq.d, seq.prev AS rje, -1 AS sgn FROM seq WHERE seq.prev IS NOT NULL AND seq.prev IS DISTINCT FROM seq.rje
    UNION ALL
    SELECT seq.id, seq.d, seq.rje, 1 FROM seq WHERE seq.rje IS NOT NULL AND seq.rje IS DISTINCT FROM seq.prev
  ), net_ev AS (
    SELECT ev.id, ev.rje, sum(ev.sgn)::integer AS sgn, max(ev.d) AS kd FROM ev
     WHERE ev.d BETWEEN p_start AND p_end GROUP BY ev.id, ev.rje HAVING sum(ev.sgn) <> 0
  ), inside AS (
    SELECT r.id, r.sc, r.tc, r.amount, r.td, r.descr, r.sje, n.rje, n.sgn, n.kd FROM net_ev n JOIN ok r ON r.id = n.id
  )
  SELECT i.id, i.sc, i.tc, i.amount, i.td, i.kd, i.descr, 'revenue'::text, jl.gl_account_id, i.sgn * sum(jl.credit - jl.debit), i.rje,
         CASE WHEN i.sgn > 0 THEN 'eliminate' ELSE 'reverse' END
    FROM inside i
    JOIN public.gl_journal_lines jl ON jl.journal_entry_id = i.sje AND jl.company_id = i.sc
    JOIN public.gl_accounts a ON a.id = jl.gl_account_id AND a.account_type = 'revenue'
   GROUP BY i.id, i.sc, i.tc, i.amount, i.td, i.kd, i.descr, i.rje, i.sgn, jl.gl_account_id HAVING sum(jl.credit - jl.debit) <> 0
  UNION ALL
  SELECT i.id, i.sc, i.tc, i.amount, i.td, i.kd, i.descr, 'expense'::text, jl.gl_account_id, i.sgn * sum(jl.debit - jl.credit), i.rje,
         CASE WHEN i.sgn > 0 THEN 'eliminate' ELSE 'reverse' END
    FROM inside i
    JOIN public.gl_journal_lines jl ON jl.journal_entry_id = i.rje AND jl.company_id = i.tc
    JOIN public.gl_accounts a ON a.id = jl.gl_account_id AND a.account_type = 'expense'
   GROUP BY i.id, i.sc, i.tc, i.amount, i.td, i.kd, i.descr, i.rje, i.sgn, jl.gl_account_id HAVING sum(jl.debit - jl.credit) <> 0
$$;
ALTER FUNCTION public.intercompany_mirror_eliminations(uuid, date, date) OWNER TO migration_admin;
REVOKE ALL ON FUNCTION public.intercompany_mirror_eliminations(uuid, date, date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.intercompany_mirror_eliminations(uuid, date, date) TO app_user, app_service, migration_admin;

-- THE MIRRORED ROWS NO PATH ELIMINATES, for the reports and the Eliminations page (the mirror is automatic: nobody would notice otherwise).
-- The generator skips a mirrored row, the manual match refuses it, a manual elimination of it is refused (not supported yet:
-- docs/plans/2026-11-22-intercompany-manual-elimination-of-mirrored-rows.md), and the derivation eliminates it only while the receiver's journal carries
-- the sender's figures in the same financial year: a listed row has NO elimination from any path, and the listing is INFORMATIONAL (the receiver's side
-- must be corrected so that mirroring eliminates it). Listed: a row of the group (both companies current members, the caller a member) dated in the
-- period whose sender journal stands as at the period end by value and whose message is (a) ACCEPTED and its document acted on (approved-class or
-- cancelled) while the pair stands neither at the period end NOR as of all links (a bill dated later, even after today, eliminates on its own date), or
-- (b) REJECTED, DISMISSED or FAILED (nothing will ever eliminate it). PENDING is not listed: it waits in the receiver's inbox. A row still 'matched'
-- by its display columns (a failed hook) is not looked at. reason_code: variance / cancelled / rejected / dismissed / failed.
DROP FUNCTION IF EXISTS public.intercompany_mirror_unresolved(uuid, date, date);
CREATE OR REPLACE FUNCTION public.intercompany_mirror_unresolved(p_group uuid, p_start date, p_end date)
RETURNS TABLE (transaction_id uuid, transaction_date date, description text, amount numeric, reason text, reason_code text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET jit = off
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT it.id, it.transaction_date, it.description, it.amount,
         CASE k.code
           WHEN 'rejected' THEN 'the receiver rejected it' || COALESCE(': ' || NULLIF(btrim(m.reason), ''), '')
           WHEN 'dismissed' THEN 'the receiver dismissed it without accepting it'
           WHEN 'failed' THEN 'the automatic acceptance failed and the receiver has not accepted it'
           ELSE COALESCE(NULLIF(btrim(it.variance_reason), ''),
                         CASE k.code WHEN 'cancelled' THEN 'the receiver cancelled its document'
                              ELSE 'the receiver''s journal does not carry the sender''s figures as a standing posting' END) END,
         k.code
    FROM public.intercompany_transactions it
    JOIN public.intercompany_messages m ON m.group_transaction_id = it.id AND m.kind IN ('invoice', 'credit_note')
    CROSS JOIN LATERAL (
      SELECT COALESCE(
               (SELECT si.status IN ('approved', 'partially_paid', 'paid', 'cancelled') OR si.deleted_at IS NOT NULL
                  FROM public.supplier_invoices si WHERE m.target_doc_type = 'supplier_invoice' AND si.id = m.target_doc_id AND si.company_id = m.to_company_id),
               (SELECT cn.status IN ('approved', 'partially_applied', 'applied', 'cancelled')
                  FROM public.credit_notes cn WHERE m.target_doc_type = 'credit_note' AND cn.id = m.target_doc_id AND cn.company_id = m.to_company_id AND cn.type = 'supplier'),
               false) AS acted,
             COALESCE(
               (SELECT si.status = 'cancelled' OR si.deleted_at IS NOT NULL FROM public.supplier_invoices si
                 WHERE m.target_doc_type = 'supplier_invoice' AND si.id = m.target_doc_id AND si.company_id = m.to_company_id),
               (SELECT cn.status = 'cancelled' FROM public.credit_notes cn
                 WHERE m.target_doc_type = 'credit_note' AND cn.id = m.target_doc_id AND cn.company_id = m.to_company_id AND cn.type = 'supplier'),
               false) AS cancelled) bill
    CROSS JOIN LATERAL (SELECT CASE WHEN m.status <> 'accepted' THEN m.status
                                    WHEN bill.cancelled THEN 'cancelled' ELSE 'variance' END AS code) k
   WHERE it.group_id = p_group AND p_group IN (SELECT public.rls_user_group_ids())
     AND it.transaction_date BETWEEN p_start AND p_end
     AND it.match_status IN ('variance', 'unmatched')
     AND m.status IN ('accepted', 'rejected', 'dismissed', 'failed') AND m.source_journal_entry_id IS NOT NULL
     AND (m.status <> 'accepted' OR (m.target_doc_id IS NOT NULL AND bill.acted
          AND public.intercompany_mirror_pair_at(it.id, p_end) IS NULL AND public.intercompany_mirror_pair_at(it.id, NULL) IS NULL))
     AND EXISTS (SELECT 1 FROM public.company_group_members a WHERE a.group_id = p_group AND a.company_id = it.source_company_id AND a.left_date IS NULL)
     AND EXISTS (SELECT 1 FROM public.company_group_members b WHERE b.group_id = p_group AND b.company_id = it.target_company_id AND b.left_date IS NULL)
     AND public.intercompany_group_row_ok(it.id, m.from_company_id, m.to_company_id, m.source_journal_entry_id)
     AND public.intercompany_journal_chain_length(m.source_journal_entry_id, m.from_company_id, p_end) % 2 = 1
     AND public.intercompany_sender_journal_value_problem(m.kind, m.source_journal_entry_id, m.from_company_id,
           (m.payload->>'subtotal')::numeric, (m.payload->>'total')::numeric) IS NULL
   ORDER BY it.transaction_date, it.id
$$;
ALTER FUNCTION public.intercompany_mirror_unresolved(uuid, date, date) OWNER TO migration_admin;
REVOKE ALL ON FUNCTION public.intercompany_mirror_unresolved(uuid, date, date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.intercompany_mirror_unresolved(uuid, date, date) TO app_user, app_service, migration_admin;

-- The ONE way a document message is written (the messages guard refuses the sender's own INSERT of one). For the session company, a signed-in
-- user with a write role, and an APPROVED customer invoice / customer credit note of that company whose customer is the partner on an ACTIVE
-- connection with a cut-over on or before its date: the database builds the payload (above), the group row of a GROUP pair (the sender's
-- side of the elimination feed: one 'sale' row, a credit note negative, ZAR only) and the message, and returns (message id, NULL, NULL).

-- Otherwise (NULL, reason, detail): 'no_connection' (the common answer: one indexed query), 'no_cutover', 'before_cutover', 'forbidden',
-- 'already_sent', 'not_found', 'not_approved', 'no_journal' (approved in status only: no posted, standing approval journal), 'unmirrorable' (detail: why). Nothing the caller passes is in the message but the two names.
CREATE OR REPLACE FUNCTION public.intercompany_send_for_source(p_doc_type text, p_doc_id uuid)
RETURNS TABLE (message_id uuid, reason text, detail text)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_co uuid := app.current_company_id();
  v_kind text := CASE p_doc_type WHEN 'customer_invoice' THEN 'invoice' WHEN 'credit_note' THEN 'credit_note' END;
  r RECORD;
  b RECORD;
  v_group uuid;
  v_gtx uuid;
  v_msg uuid;
  v_payload jsonb;
  v_jp text;
  ex RECORD;
BEGIN
  IF v_kind IS NULL OR v_co IS NULL THEN RETURN QUERY SELECT NULL::uuid, 'not_found'::text, NULL::text; RETURN; END IF;
  IF v_kind = 'invoice' THEN
    SELECT c.id AS connection_id, c.kind AS connection_kind, c.cutover_date AS cutover, d.invoice_date AS dt,
           CASE WHEN c.company_low_id = v_co THEN c.company_high_id ELSE c.company_low_id END AS partner
      INTO r FROM public.customer_invoices d
      JOIN public.intercompany_connection_sides s ON s.company_id = d.company_id AND s.customer_id = COALESCE(d.client_id, d.customer_id)
      JOIN public.intercompany_connections c ON c.id = s.connection_id AND c.status = 'active'
     WHERE d.id = p_doc_id AND d.company_id = v_co AND d.deleted_at IS NULL LIMIT 1;
  ELSE
    SELECT c.id AS connection_id, c.kind AS connection_kind, c.cutover_date AS cutover, d.credit_date AS dt,
           CASE WHEN c.company_low_id = v_co THEN c.company_high_id ELSE c.company_low_id END AS partner
      INTO r FROM public.credit_notes d
      JOIN public.intercompany_connection_sides s ON s.company_id = d.company_id AND s.customer_id = d.client_id
      JOIN public.intercompany_connections c ON c.id = s.connection_id AND c.status = 'active'
     WHERE d.id = p_doc_id AND d.company_id = v_co AND d.type = 'customer' LIMIT 1;
  END IF;
  IF NOT FOUND THEN RETURN QUERY SELECT NULL::uuid, 'no_connection'::text, NULL::text; RETURN; END IF;
  IF r.cutover IS NULL THEN RETURN QUERY SELECT NULL::uuid, 'no_cutover'::text, NULL::text; RETURN; END IF;
  IF r.dt < r.cutover THEN RETURN QUERY SELECT NULL::uuid, 'before_cutover'::text, NULL::text; RETURN; END IF;
  IF NOT public.intercompany_user_can_write(v_co) THEN
    RETURN QUERY SELECT NULL::uuid, 'forbidden'::text, NULL::text; RETURN;
  END IF;
  SELECT m.id, m.source_cancelled_at, m.source_journal_entry_id AS je INTO ex FROM public.intercompany_messages m
   WHERE m.from_company_id = v_co AND m.source_doc_type = p_doc_type AND m.source_doc_id = p_doc_id AND m.kind = v_kind;
  IF FOUND THEN
    -- A message withdrawn or stamped while its journal was reversed, whose journal is LIVE again (the reversal was reversed): lifted, by the
    -- ledger's parity. Anything else is a message already sent.
    IF ex.source_cancelled_at IS NOT NULL AND ex.je IS NOT NULL AND public.intercompany_journal_chain_length(ex.je, v_co) % 2 = 1
       AND public.intercompany_own_posting_problem(v_kind, p_doc_id, v_co, ex.je) IS NULL AND public.intercompany_revive_message(ex.id) THEN
      RETURN QUERY SELECT ex.id, NULL::text, NULL::text; RETURN;
    END IF;
    RETURN QUERY SELECT NULL::uuid, 'already_sent'::text, NULL::text; RETURN;
  END IF;
  SELECT * INTO b FROM public.intercompany_build_payload(v_kind, p_doc_id, v_co);
  -- An approved document is in the books: its approval journal is posted and stands. One without (a status set by hand, an import) is not
  -- sent, and the journal must be the document's OWN approval posting (not another document's, not a reversal, not one another message records),
  -- so every message carries the journal the cancel is later proved against.
  IF b.problem IS NULL THEN
    v_jp := public.intercompany_own_posting_problem(v_kind, p_doc_id, v_co, b.journal_entry_id);
    IF v_jp IS NULL AND public.intercompany_journal_chain_length(b.journal_entry_id, v_co) % 2 = 1 THEN
      v_jp := public.intercompany_sender_journal_value_problem(v_kind, b.journal_entry_id, v_co,
                (b.payload->>'subtotal')::numeric, (b.payload->>'total')::numeric);
    END IF;
    IF v_jp IS NOT NULL OR public.intercompany_journal_chain_length(b.journal_entry_id, v_co) % 2 = 0 THEN
      RETURN QUERY SELECT NULL::uuid, 'no_journal'::text, v_jp; RETURN;
    END IF;
  END IF;
  IF b.problem IS NOT NULL THEN
    RETURN QUERY SELECT NULL::uuid, split_part(b.problem, ':', 1),
                        CASE WHEN strpos(b.problem, ':') > 0 THEN btrim(substr(b.problem, strpos(b.problem, ':') + 1)) END;
    RETURN;
  END IF;
  v_payload := b.payload;

  IF r.connection_kind = 'group' AND v_payload->>'currency' = 'ZAR' THEN
    SELECT g.id INTO v_group
      FROM public.company_group_members me
      JOIN public.company_groups g ON g.id = me.group_id AND g.is_active IS NOT FALSE
     WHERE me.company_id = v_co AND me.left_date IS NULL AND public.rls_intercompany_parties_ok(g.id, v_co, r.partner, NULL, NULL)
     ORDER BY g.created_at, g.id LIMIT 1;
    IF v_group IS NOT NULL THEN
      -- The elimination feed is secondary: a row that cannot be written leaves the message without a reference (and the sender's log has the warning).
      BEGIN
        INSERT INTO public.intercompany_transactions (group_id, source_company_id, target_company_id, source_journal_entry_id,
                                                     transaction_type, amount, currency, description, transaction_date)
        VALUES (v_group, v_co, r.partner, (SELECT je.id FROM public.gl_journal_entries je WHERE je.id = b.journal_entry_id AND je.company_id = v_co),
                'sale', CASE WHEN v_kind = 'credit_note' THEN -(v_payload->>'subtotal')::numeric ELSE (v_payload->>'subtotal')::numeric END, 'ZAR',
                CASE WHEN v_kind = 'invoice' THEN 'Invoice ' ELSE 'Credit note ' END || (v_payload->>'number') || ' (mirrored)', (v_payload->>'date')::date)
        RETURNING id INTO v_gtx;
      EXCEPTION WHEN OTHERS THEN
        RAISE WARNING 'intercompany group row not written (SQLSTATE %)', SQLSTATE;
        v_gtx := NULL;
      END;
    END IF;
  END IF;
  v_payload := v_payload || jsonb_build_object('groupTransactionId', v_gtx);

  INSERT INTO public.intercompany_messages (connection_id, from_company_id, to_company_id, kind, source_doc_type, source_doc_id, payload, source_journal_entry_id, group_transaction_id)
  VALUES (r.connection_id, v_co, r.partner, v_kind, p_doc_type, p_doc_id, v_payload, b.journal_entry_id, v_gtx)
  ON CONFLICT (from_company_id, source_doc_type, source_doc_id, kind) DO NOTHING
  RETURNING id INTO v_msg;
  IF v_msg IS NULL THEN
    IF v_gtx IS NOT NULL THEN DELETE FROM public.intercompany_transactions WHERE id = v_gtx AND source_company_id = v_co; END IF;
    RETURN QUERY SELECT NULL::uuid, 'already_sent'::text, NULL::text; RETURN;
  END IF;
  RETURN QUERY SELECT v_msg, NULL::text, NULL::text;
END;
$$;
ALTER FUNCTION public.intercompany_send_for_source(text, uuid) OWNER TO migration_admin;
REVOKE ALL ON FUNCTION public.intercompany_send_for_source(text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.intercompany_send_for_source(text, uuid) TO app_user;

-- Whether the sender's source document is no longer what its message carries (its books changed after the send: edited lines, a changed
-- number, a re-dated invoice). For the receiver of the message only: the same builder, compared with the payload but for the group reference.
-- NULL when the caller is not the receiver. A source that is no longer approved reads as changed (the inbox shows a cancelled one on its own).
CREATE OR REPLACE FUNCTION public.intercompany_message_source_changed(p_message uuid)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_co uuid := app.current_company_id();
  m RECORD;
  b RECORD;
BEGIN
  IF v_co IS NULL OR auth.uid() IS NULL OR NOT (v_co IN (SELECT auth.user_companies())) THEN RETURN NULL; END IF;
  SELECT x.kind, x.from_company_id, x.source_doc_id, x.payload INTO m FROM public.intercompany_messages x
   WHERE x.id = p_message AND x.to_company_id = v_co AND x.kind IN ('invoice', 'credit_note');
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT * INTO b FROM public.intercompany_build_payload(m.kind, m.source_doc_id, m.from_company_id);
  RETURN b.payload IS NULL OR (b.payload - 'groupTransactionId') IS DISTINCT FROM (m.payload - 'groupTransactionId');
END;
$$;
ALTER FUNCTION public.intercompany_message_source_changed(uuid) OWNER TO migration_admin;
REVOKE ALL ON FUNCTION public.intercompany_message_source_changed(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.intercompany_message_source_changed(uuid) TO app_user, app_service;

-- Whether the sender's document of a message is OUT of its books: no longer approved (or gone), or the journal the message was sent with is not
-- carried (an even reversal chain by value). The ledger's word, whatever the withdraw hook did: a hook that timed out leaves the message pending.
-- For the receiver of that message only; NULL otherwise.
CREATE OR REPLACE FUNCTION public.intercompany_message_source_out(p_message uuid)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_co uuid := app.current_company_id();
  m RECORD;
  b RECORD;
BEGIN
  IF v_co IS NULL OR auth.uid() IS NULL OR NOT (v_co IN (SELECT auth.user_companies())) THEN RETURN NULL; END IF;
  SELECT x.kind, x.from_company_id, x.source_doc_id, x.source_journal_entry_id AS je INTO m FROM public.intercompany_messages x
   WHERE x.id = p_message AND x.to_company_id = v_co AND x.kind IN ('invoice', 'credit_note');
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT * INTO b FROM public.intercompany_build_payload(m.kind, m.source_doc_id, m.from_company_id);
  RETURN b.payload IS NULL OR (m.je IS NOT NULL AND public.intercompany_journal_chain_length(m.je, m.from_company_id) % 2 = 0);
END;
$$;
ALTER FUNCTION public.intercompany_message_source_out(uuid) OWNER TO migration_admin;
REVOKE ALL ON FUNCTION public.intercompany_message_source_out(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.intercompany_message_source_out(uuid) TO app_user, app_service;

-- ── 3. Messages guard (the 1002 body, plus the three changes above) ─────────

CREATE OR REPLACE FUNCTION public.intercompany_messages_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  conn intercompany_connections%ROWTYPE;
  v_system text := CASE WHEN current_user = 'migration_admin' THEN pg_catalog.current_setting('app.intercompany_system_update', true) END;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT * INTO conn FROM intercompany_connections WHERE id = NEW.connection_id FOR SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'no such connection' USING ERRCODE = '23503';
    END IF;
    IF conn.status <> 'active' THEN
      RAISE EXCEPTION 'a message is sent only on an active connection' USING ERRCODE = '23514';
    END IF;
    IF NOT ((NEW.from_company_id = conn.company_low_id AND NEW.to_company_id = conn.company_high_id)
         OR (NEW.from_company_id = conn.company_high_id AND NEW.to_company_id = conn.company_low_id)) THEN
      RAISE EXCEPTION 'a message goes between the connection''s two companies' USING ERRCODE = '23514';
    END IF;
    IF conn.kind = 'group' AND NOT public.intercompany_in_one_group(conn.company_low_id, conn.company_high_id) THEN
      RAISE EXCEPTION 'a group message needs both companies to be current members of one group' USING ERRCODE = '23514';
    END IF;
    -- A message that carries or names a DOCUMENT is written by the database (invoice / credit note: intercompany_send_for_source, which builds
    -- its payload from the sender's books; interest_invoice and any kind naming a document row have no writer yet: a later phase opens each
    -- through its own definer). A session writing one itself is how a payload carries what the sender's books do not.
    -- (ALLOW-LIST the definers' owner, deny every other login: the request login, the service login's own name, a role added later.)
    IF current_user <> 'migration_admin'
       AND (NEW.kind IN ('invoice', 'credit_note', 'interest_invoice') OR NEW.source_doc_type IN ('customer_invoice', 'credit_note', 'supplier_invoice')) THEN
      RAISE EXCEPTION 'a document message is written by the database from the sender''s document, not by the sender' USING ERRCODE = '42501';
    END IF;
    IF NOT public.intercompany_user_can_write(NEW.from_company_id) THEN
      RAISE EXCEPTION 'a message is sent by a user with a write role in the sending company' USING ERRCODE = '42501';
    END IF;
    -- A message that carries a document names one of the SENDER's (the session company), of the type its kind needs: nobody
    -- can send, and the receiver then mirror-link, another company's invoice.
    IF NEW.kind IN ('invoice', 'credit_note', 'interest_invoice')
       AND NOT public.intercompany_message_doc_exists(NEW.kind, 'source', NEW.source_doc_type, NEW.source_doc_id, NEW.from_company_id) THEN
      RAISE EXCEPTION 'a document message names a source document of the sending company that fits its kind' USING ERRCODE = '23514';
    END IF;
    NEW.status := 'pending';
    NEW.target_doc_type := NULL;
    NEW.target_doc_id := NULL;
    NEW.reason := NULL;
    NEW.error := NULL;
    NEW.handled_by := NULL;
    NEW.handled_at := NULL;
    NEW.handled_via := NULL;
    NEW.manual_only := false;
    NEW.source_cancelled_at := NULL;
    NEW.auto_attempts := 0;
    NEW.auto_next_attempt_at := NULL;
    NEW.created_at := clock_timestamp();
    NEW.updated_at := clock_timestamp();
    RETURN NEW;
  END IF;

  -- The system paths (migration_admin inside a registered definer, with the transaction-local flag; the flag alone proves nothing
  -- because any session can set it): the sender's cancellation of a document (a message not yet handled is WITHDRAWN, a message
  -- the receiver already accepted is only stamped), and the auto-accept queue's claim (attempt counters). Nothing else changes.
  IF v_system IS NOT NULL AND v_system <> '' THEN
    IF NEW.id IS DISTINCT FROM OLD.id OR NEW.connection_id IS DISTINCT FROM OLD.connection_id
       OR NEW.from_company_id IS DISTINCT FROM OLD.from_company_id OR NEW.to_company_id IS DISTINCT FROM OLD.to_company_id
       OR NEW.kind IS DISTINCT FROM OLD.kind OR NEW.source_doc_type IS DISTINCT FROM OLD.source_doc_type
       OR NEW.source_doc_id IS DISTINCT FROM OLD.source_doc_id OR NEW.payload IS DISTINCT FROM OLD.payload
       OR NEW.created_at IS DISTINCT FROM OLD.created_at OR NEW.target_doc_type IS DISTINCT FROM OLD.target_doc_type
       OR NEW.target_doc_id IS DISTINCT FROM OLD.target_doc_id OR NEW.reason IS DISTINCT FROM OLD.reason
       OR NEW.error IS DISTINCT FROM OLD.error OR NEW.handled_by IS DISTINCT FROM OLD.handled_by
       OR NEW.handled_at IS DISTINCT FROM OLD.handled_at OR NEW.handled_via IS DISTINCT FROM OLD.handled_via
       OR NEW.manual_only IS DISTINCT FROM OLD.manual_only
       OR (NEW.source_journal_entry_id IS DISTINCT FROM OLD.source_journal_entry_id AND NOT (v_system = 'backfill' AND OLD.source_journal_entry_id IS NULL))
       OR (NEW.group_transaction_id IS DISTINCT FROM OLD.group_transaction_id AND NOT (v_system = 'backfill' AND OLD.group_transaction_id IS NULL)) THEN
      RAISE EXCEPTION 'a system update of a message changes only its withdrawal and its attempt counters' USING ERRCODE = '23514';
    END IF;
    IF v_system = 'withdraw' THEN
      IF NOT (OLD.source_cancelled_at IS NULL AND NEW.source_cancelled_at IS NOT NULL
              AND ((OLD.status IN ('pending', 'failed', 'dismissed') AND NEW.status = 'withdrawn')
                   OR (OLD.status = 'accepted' AND NEW.status = 'accepted'))
              AND NEW.auto_attempts IS NOT DISTINCT FROM OLD.auto_attempts
              AND NEW.auto_next_attempt_at IS NOT DISTINCT FROM OLD.auto_next_attempt_at) THEN
        RAISE EXCEPTION 'a withdrawal withdraws a message not yet handled, or stamps an accepted one' USING ERRCODE = '23514';
      END IF;
    ELSIF v_system = 'revive' THEN
      -- (intercompany_revive_message) the journal is live again: the withdrawal / stamp is lifted, nothing else moves
      IF NOT (OLD.source_cancelled_at IS NOT NULL AND NEW.source_cancelled_at IS NULL
              AND ((OLD.status = 'withdrawn' AND NEW.status = 'pending') OR (OLD.status = 'accepted' AND NEW.status = 'accepted'))
              AND NEW.auto_attempts IS NOT DISTINCT FROM OLD.auto_attempts AND NEW.auto_next_attempt_at IS NOT DISTINCT FROM OLD.auto_next_attempt_at) THEN
        RAISE EXCEPTION 'a revival lifts a withdrawal or a stamp only' USING ERRCODE = '23514';
      END IF;
    ELSIF v_system = 'backfill' THEN
      -- (section 6b) the migration records a journal / group row a message was written without: nothing else moves
      IF NEW.status IS DISTINCT FROM OLD.status OR NEW.source_cancelled_at IS DISTINCT FROM OLD.source_cancelled_at
         OR NEW.auto_attempts IS DISTINCT FROM OLD.auto_attempts OR NEW.auto_next_attempt_at IS DISTINCT FROM OLD.auto_next_attempt_at THEN
        RAISE EXCEPTION 'a backfill records a journal and a group row only' USING ERRCODE = '23514';
      END IF;
    ELSIF v_system = 'claim' THEN
      IF NEW.status IS DISTINCT FROM OLD.status OR NEW.source_cancelled_at IS DISTINCT FROM OLD.source_cancelled_at THEN
        RAISE EXCEPTION 'a claim changes only the attempt counters' USING ERRCODE = '23514';
      END IF;
    ELSE
      RAISE EXCEPTION 'unknown system update' USING ERRCODE = '23514';
    END IF;
    NEW.updated_at := clock_timestamp();
    RETURN NEW;
  END IF;

  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.connection_id IS DISTINCT FROM OLD.connection_id
     OR NEW.from_company_id IS DISTINCT FROM OLD.from_company_id OR NEW.to_company_id IS DISTINCT FROM OLD.to_company_id
     OR NEW.kind IS DISTINCT FROM OLD.kind OR NEW.source_doc_type IS DISTINCT FROM OLD.source_doc_type
     OR NEW.source_doc_id IS DISTINCT FROM OLD.source_doc_id OR NEW.payload IS DISTINCT FROM OLD.payload
     OR NEW.source_journal_entry_id IS DISTINCT FROM OLD.source_journal_entry_id OR NEW.group_transaction_id IS DISTINCT FROM OLD.group_transaction_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'a message changes only its handling' USING ERRCODE = '23514';
  END IF;
  IF OLD.status IN ('accepted', 'rejected', 'withdrawn') THEN
    RAISE EXCEPTION 'a handled message is final' USING ERRCODE = '23514';
  END IF;
  IF NEW.status = 'withdrawn' OR NEW.source_cancelled_at IS DISTINCT FROM OLD.source_cancelled_at
     OR NEW.manual_only IS DISTINCT FROM OLD.manual_only OR NEW.auto_attempts IS DISTINCT FROM OLD.auto_attempts
     OR NEW.auto_next_attempt_at IS DISTINCT FROM OLD.auto_next_attempt_at THEN
    RAISE EXCEPTION 'a message is withdrawn only by the sender cancelling its document' USING ERRCODE = '23514';
  END IF;
  IF OLD.status = 'dismissed' AND NEW.status <> 'pending' AND NEW.status <> 'dismissed' THEN
    RAISE EXCEPTION 'a dismissed message can only be restored' USING ERRCODE = '23514';
  END IF;
  -- Accepting, rejecting and restoring act on a live relationship; a dismissal does not need one.
  -- (FOR SHARE: a revocation that comes at the same moment waits for this transaction, instead of revoking under it.)
  IF (NEW.status IN ('accepted', 'rejected') OR (OLD.status = 'dismissed' AND NEW.status = 'pending'))
     AND NOT EXISTS (SELECT 1 FROM intercompany_connections WHERE id = OLD.connection_id AND status = 'active' FOR SHARE) THEN
    RAISE EXCEPTION 'a message is accepted, rejected or restored only on an active connection' USING ERRCODE = '23514';
  END IF;
  IF NOT public.intercompany_user_can_write(OLD.to_company_id) THEN
    RAISE EXCEPTION 'a message is handled by a user with a write role in the receiving company' USING ERRCODE = '42501';
  END IF;
  -- A message that creates a document is accepted with that document: it exists in the receiver's company and is of the type
  -- its kind needs. Any target a handler sets (accepting or not) is held to the same rule. (The check is false for a NULL type
  -- or id, so a missing target is refused too.) A kind that creates no document carries no target: whatever was sent is cleared.
  IF NEW.kind IN ('invoice', 'credit_note', 'interest_invoice') THEN
    IF (NEW.status = 'accepted' OR NEW.target_doc_type IS DISTINCT FROM OLD.target_doc_type OR NEW.target_doc_id IS DISTINCT FROM OLD.target_doc_id)
       AND NOT public.intercompany_message_doc_exists(NEW.kind, 'target', NEW.target_doc_type, NEW.target_doc_id, OLD.to_company_id) THEN
      RAISE EXCEPTION 'a message targets a document of the receiving company that fits its kind, and an accepted one names it' USING ERRCODE = '23514';
    END IF;
    IF NEW.status = 'accepted' AND EXISTS (
         SELECT 1 FROM intercompany_messages m
          WHERE m.to_company_id = OLD.to_company_id AND m.id <> OLD.id AND m.status = 'accepted'
            AND m.target_doc_type = NEW.target_doc_type AND m.target_doc_id = NEW.target_doc_id) THEN
      RAISE EXCEPTION 'a document is the target of one accepted message per receiving company' USING ERRCODE = '23514';
    END IF;
  ELSE
    NEW.target_doc_type := NULL;
    NEW.target_doc_id := NULL;
  END IF;
  NEW.updated_at := clock_timestamp();
  -- A message a person put back (restored from a dismissal, or a failed one retried) is that person's to handle: the worker
  -- never takes it again.
  IF NEW.status = 'pending' AND OLD.status <> 'pending' THEN
    NEW.manual_only := true;
  END IF;
  IF NEW.status = 'pending' THEN
    NEW.handled_by := NULL;
    NEW.handled_at := NULL;
    NEW.handled_via := NULL;
  ELSE
    NEW.handled_by := auth.uid();
    NEW.handled_at := clock_timestamp();
    -- 'auto' only for a receiver whose side has auto-accept on an active group connection; anything else is a person's act.
    NEW.handled_via := CASE WHEN pg_catalog.current_setting('app.intercompany_handled_via', true) = 'auto'
        AND EXISTS (SELECT 1 FROM intercompany_connection_sides s JOIN intercompany_connections c ON c.id = s.connection_id
                     WHERE s.connection_id = OLD.connection_id AND s.company_id = OLD.to_company_id AND s.auto_accept
                       AND c.kind = 'group' AND c.status = 'active')
      THEN 'auto' ELSE 'user' END;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_intercompany_messages_guard ON intercompany_messages;
CREATE TRIGGER trg_intercompany_messages_guard BEFORE INSERT OR UPDATE ON intercompany_messages
  FOR EACH ROW EXECUTE FUNCTION public.intercompany_messages_guard();
ALTER TABLE intercompany_messages ENABLE ALWAYS TRIGGER trg_intercompany_messages_guard;
REVOKE ALL ON FUNCTION public.intercompany_messages_guard() FROM PUBLIC;

-- ── 4. The sender's cancellation reaches its message and its group row ──────

-- Puts a group row back to what a document that is not (or no longer) eliminable shows: unmatched, nothing matched, no target journal (the FIRST
-- journal it was matched to stays: only the definer writes it). A DISPLAY state: the eliminations are derived from the ledgers, not from this.
-- SECURITY INVOKER, executable by migration_admin only: the definers below call it.
DROP FUNCTION IF EXISTS public.intercompany_release_group_row(uuid);
CREATE OR REPLACE FUNCTION public.intercompany_release_group_row(p_row uuid)
RETURNS void
LANGUAGE sql
VOLATILE
SECURITY INVOKER
SET search_path = pg_catalog, public, pg_temp
AS $$
  UPDATE public.intercompany_transactions
     SET match_status = 'unmatched', variance_amount = 0, variance_reason = NULL, matched_at = NULL, matched_by = NULL, target_journal_entry_id = NULL
   WHERE id = p_row AND (match_status <> 'unmatched' OR variance_amount <> 0 OR variance_reason IS NOT NULL OR matched_at IS NOT NULL
                         OR matched_by IS NOT NULL OR target_journal_entry_id IS NOT NULL)
$$;
REVOKE ALL ON FUNCTION public.intercompany_release_group_row(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.intercompany_release_group_row(uuid) TO migration_admin;

-- Withdraws (a message not yet handled) or stamps (an accepted one) the message, and releases the group row the database recorded for it. The
-- caller has proved the cancel against the ledger. False when the message is gone, already stamped or already handled otherwise.
CREATE OR REPLACE FUNCTION public.intercompany_withdraw_message(p_message uuid)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  m RECORD;
BEGIN
  SELECT x.id, x.status, x.from_company_id, x.to_company_id, x.source_journal_entry_id AS je, x.group_transaction_id AS gtx INTO m
    FROM public.intercompany_messages x
   WHERE x.id = p_message AND x.source_cancelled_at IS NULL AND x.status IN ('pending', 'failed', 'dismissed', 'accepted') FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;
  PERFORM pg_catalog.set_config('app.intercompany_system_update', 'withdraw', true);
  UPDATE public.intercompany_messages
     SET status = CASE WHEN m.status IN ('pending', 'failed', 'dismissed') THEN 'withdrawn' ELSE m.status END, source_cancelled_at = clock_timestamp()
   WHERE id = m.id;
  PERFORM pg_catalog.set_config('app.intercompany_system_update', '', true);
  IF m.gtx IS NOT NULL AND public.intercompany_group_row_ok(m.gtx, m.from_company_id, m.to_company_id, m.je) THEN
    PERFORM public.intercompany_release_group_row(m.gtx);
  END IF;
  RETURN true;
END;
$$;
REVOKE ALL ON FUNCTION public.intercompany_withdraw_message(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.intercompany_withdraw_message(uuid) TO migration_admin;

-- The other way: the journal a message records is LIVE again (the reversal was itself reversed, by value), AND its document is live in the
-- sender's books (approved, linked to that journal: a cancelled document is not revived by a chain that looks alive). Then a withdrawn message is
-- pending again and a stamped one is not stamped, and the row is judged afresh by the receiver's core (matched again while its document is still
-- approved on the journal it was first matched to; a variance re-evaluated). False (nothing changes) otherwise.
CREATE OR REPLACE FUNCTION public.intercompany_revive_message(p_message uuid)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  m RECORD;
BEGIN
  SELECT x.id, x.kind, x.status, x.from_company_id, x.to_company_id, x.source_doc_id, x.source_journal_entry_id AS je, x.group_transaction_id AS gtx, x.target_doc_type, x.target_doc_id INTO m
    FROM public.intercompany_messages x
   WHERE x.id = p_message AND x.source_cancelled_at IS NOT NULL AND x.status IN ('withdrawn', 'accepted') FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;
  IF NOT public.intercompany_document_live(m.kind, m.source_doc_id, m.from_company_id, m.je)
     OR COALESCE(public.intercompany_journal_chain_length(m.je, m.from_company_id), 0) % 2 <> 1 THEN
    RETURN false;
  END IF;
  PERFORM pg_catalog.set_config('app.intercompany_system_update', 'revive', true);
  UPDATE public.intercompany_messages SET status = CASE WHEN m.status = 'withdrawn' THEN 'pending' ELSE m.status END, source_cancelled_at = NULL WHERE id = m.id;
  PERFORM pg_catalog.set_config('app.intercompany_system_update', '', true);
  IF m.gtx IS NOT NULL AND m.status = 'accepted' AND m.target_doc_id IS NOT NULL AND public.intercompany_group_row_ok(m.gtx, m.from_company_id, m.to_company_id, m.je) THEN
    PERFORM public.intercompany_sync_core(m.to_company_id, m.target_doc_type, m.target_doc_id, NULL);
  END IF;
  RETURN true;
END;
$$;
REVOKE ALL ON FUNCTION public.intercompany_revive_message(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.intercompany_revive_message(uuid) TO migration_admin;

-- Called after a customer invoice / customer credit note is cancelled. Acts only for the session company and a signed-in user of it with a
-- write role, and only when the document is cancelled in that company's books AND the ledger agrees: the message is withdrawn only when the
-- journal it was sent with (recorded by the database at the send) has had its reversal chain taken out (the cancel really reversed it, and an
-- invoice's link to it is cleared, as the cancel service does; the status column alone proves nothing).

-- A message with NO recorded journal
-- proves nothing and is left alone (fail closed). Not yet handled: WITHDRAWN; accepted: only stamped (the receiver's data is never touched).
CREATE OR REPLACE FUNCTION public.intercompany_withdraw_for_source(p_source_type text, p_source_id uuid)
RETURNS integer
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_co uuid := app.current_company_id();
  m RECORD;
  n integer := 0;
  v_chain integer;
  v_prev text;
BEGIN
  -- a 2 s bound that never LOOSENS the caller's (a cancel under underFlowLockBudget may hold a tighter one; '0' = none): set here, put back at every exit
  v_prev := pg_catalog.current_setting('lock_timeout');
  IF v_prev::interval = interval '0' OR v_prev::interval > interval '2s' THEN PERFORM pg_catalog.set_config('lock_timeout', '2s', true); END IF;
  IF v_co IS NULL OR NOT public.intercompany_user_can_write(v_co) THEN PERFORM pg_catalog.set_config('lock_timeout', v_prev, true); RETURN 0; END IF;
  IF p_source_type = 'customer_invoice' THEN
    IF NOT EXISTS (SELECT 1 FROM public.customer_invoices WHERE id = p_source_id AND company_id = v_co AND status = 'cancelled' AND gl_journal_entry_id IS NULL) THEN PERFORM pg_catalog.set_config('lock_timeout', v_prev, true); RETURN 0; END IF;
  ELSIF p_source_type = 'credit_note' THEN
    IF NOT EXISTS (SELECT 1 FROM public.credit_notes WHERE id = p_source_id AND company_id = v_co AND type = 'customer' AND status = 'cancelled') THEN PERFORM pg_catalog.set_config('lock_timeout', v_prev, true); RETURN 0; END IF;
  ELSE
    PERFORM pg_catalog.set_config('lock_timeout', v_prev, true); RETURN 0;
  END IF;
  FOR m IN SELECT x.id, x.source_journal_entry_id AS je FROM public.intercompany_messages x
            WHERE x.from_company_id = v_co AND x.source_doc_type = p_source_type AND x.source_doc_id = p_source_id AND x.kind IN ('invoice', 'credit_note')
  LOOP
    v_chain := CASE WHEN m.je IS NULL THEN 0 ELSE public.intercompany_journal_chain_length(m.je, v_co) END;
    IF v_chain > 0 AND v_chain % 2 = 0 AND public.intercompany_withdraw_message(m.id) THEN n := n + 1; END IF;
  END LOOP;
  PERFORM pg_catalog.set_config('lock_timeout', v_prev, true); RETURN n;
END;
$$;
ALTER FUNCTION public.intercompany_withdraw_for_source(text, uuid) OWNER TO migration_admin;
REVOKE ALL ON FUNCTION public.intercompany_withdraw_for_source(text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.intercompany_withdraw_for_source(text, uuid) TO app_user, app_service;

-- Called after ANY reversal of a journal of the session company (the journal-entry reversal, the MCP tool, a cancel): the chain of the journal
-- it belongs to changed, so what records it is re-evaluated by the ledger's parity. Even (reversed): a message the company sent for it is
-- withdrawn or stamped and its group row released, and a group row matched against it (the company is the receiver) is released. Odd (live
-- again): a withdrawn or stamped message is revived. Write role of the session company only. Returns how many things changed.
CREATE OR REPLACE FUNCTION public.intercompany_journal_chain_changed(p_je uuid)
RETURNS integer
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_co uuid := app.current_company_id();
  v_root uuid;
  v_len integer;
  r RECORD;
  n integer := 0;
  v_prev text;
BEGIN
  -- a 2 s bound that never LOOSENS the caller's (a cancel under underFlowLockBudget may hold a tighter one; '0' = none): set here, put back at every exit
  v_prev := pg_catalog.current_setting('lock_timeout');
  IF v_prev::interval = interval '0' OR v_prev::interval > interval '2s' THEN PERFORM pg_catalog.set_config('lock_timeout', '2s', true); END IF;
  IF v_co IS NULL OR p_je IS NULL OR NOT public.intercompany_user_can_write(v_co) THEN PERFORM pg_catalog.set_config('lock_timeout', v_prev, true); RETURN 0; END IF;
  -- the original of the chain p_je is in (a reversal's reversal belongs to the chain of the journal it undoes)
  WITH RECURSIVE up(id, parent) AS (
    SELECT je.id, je.reversal_of_id FROM public.gl_journal_entries je WHERE je.id = p_je AND je.company_id = v_co
    UNION
    SELECT g.id, g.reversal_of_id FROM public.gl_journal_entries g JOIN up ON g.id = up.parent WHERE g.company_id = v_co)
  SELECT up.id INTO v_root FROM up WHERE up.parent IS NULL LIMIT 1;
  IF v_root IS NULL THEN PERFORM pg_catalog.set_config('lock_timeout', v_prev, true); RETURN 0; END IF;
  v_len := public.intercompany_journal_chain_length(v_root, v_co);
  IF v_len = 0 THEN PERFORM pg_catalog.set_config('lock_timeout', v_prev, true); RETURN 0; END IF;
  FOR r IN SELECT x.id FROM public.intercompany_messages x
            WHERE x.from_company_id = v_co AND x.source_journal_entry_id = v_root AND x.kind IN ('invoice', 'credit_note') LOOP
    IF v_len % 2 = 0 THEN
      IF public.intercompany_withdraw_message(r.id) THEN n := n + 1; END IF;
    ELSIF public.intercompany_revive_message(r.id) THEN
      n := n + 1;
    END IF;
  END LOOP;
  -- the receiver's side: a row matched against this journal is released when it is out, and judged afresh (matched again while its bill is approved on it) when it is live again
  -- (a row keeps its FIRST journal after a reverse-and-repost binds a new target: the first's fate releases it only while it is the target too)
  FOR r IN SELECT it.id, it.target_journal_entry_id AS target, x.target_doc_type, x.target_doc_id FROM public.intercompany_transactions it
             JOIN public.intercompany_messages x ON x.group_transaction_id = it.id AND x.status = 'accepted'
            WHERE it.target_company_id = v_co AND (it.first_target_journal_entry_id = v_root OR it.target_journal_entry_id = v_root) LOOP
    IF v_len % 2 = 0 THEN
      IF r.target IS NULL OR r.target = v_root THEN PERFORM public.intercompany_release_group_row(r.id); END IF;
    ELSE
      PERFORM public.intercompany_sync_core(v_co, r.target_doc_type, r.target_doc_id, NULL);
    END IF;
    n := n + 1;
  END LOOP;
  PERFORM pg_catalog.set_config('lock_timeout', v_prev, true); RETURN n;
END;
$$;
ALTER FUNCTION public.intercompany_journal_chain_changed(uuid) OWNER TO migration_admin;
REVOKE ALL ON FUNCTION public.intercompany_journal_chain_changed(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.intercompany_journal_chain_changed(uuid) TO app_user, app_service;

-- ── 5. The sender's elimination row follows the receiver's APPROVED document ─

-- A recorded transaction keeps everything but its matching; the target journal is the one thing that is set later (to a journal of
-- the target company, when the receiver approves) or cleared (when its document is cancelled or deleted and the row goes unmatched),
-- and only by intercompany_sync_group_row (migration_admin): a writer of a party updating the row directly still cannot (999r).
CREATE OR REPLACE FUNCTION public.intercompany_transaction_parties_immutable()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF NEW.group_id IS DISTINCT FROM OLD.group_id
     OR NEW.source_company_id IS DISTINCT FROM OLD.source_company_id OR NEW.target_company_id IS DISTINCT FROM OLD.target_company_id
     OR NEW.source_journal_entry_id IS DISTINCT FROM OLD.source_journal_entry_id
     OR NEW.amount IS DISTINCT FROM OLD.amount OR NEW.currency IS DISTINCT FROM OLD.currency
     OR NEW.transaction_type IS DISTINCT FROM OLD.transaction_type OR NEW.transaction_date IS DISTINCT FROM OLD.transaction_date
     OR NEW.description IS DISTINCT FROM OLD.description OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'intercompany_transactions: a recorded transaction keeps its group, parties, journals, amount, currency, type, date, description and creation time; matching changes only its status'
      USING ERRCODE = '23514';
  END IF;
  -- A row a message records (a mirrored row) is matched by the database only: no session of any party, third-company group writer or service
  -- login marks it matched, unmatched, signed or with a variance (the inbox shows these columns).
  IF (NEW.match_status IS DISTINCT FROM OLD.match_status OR NEW.matched_by IS DISTINCT FROM OLD.matched_by OR NEW.matched_at IS DISTINCT FROM OLD.matched_at
      OR NEW.variance_amount IS DISTINCT FROM OLD.variance_amount)
     AND current_user <> 'migration_admin' AND public.intercompany_is_mirrored_row(OLD.id) THEN
    RAISE EXCEPTION 'intercompany_transactions: a row the mirror recorded is matched by the database only, from the receiver''s ledger' USING ERRCODE = '23514';
  END IF;
  IF NEW.target_journal_entry_id IS DISTINCT FROM OLD.target_journal_entry_id THEN
    -- Only the registered definer below (migration_admin) sets or clears it; a writer of a party updating the row directly cannot.
    IF current_user <> 'migration_admin' THEN
      RAISE EXCEPTION 'intercompany_transactions: a recorded transaction keeps its group, parties, journals, amount, currency, type, date, description and creation time; matching changes only its status'
        USING ERRCODE = '23514';
    END IF;
    IF NEW.target_journal_entry_id IS NOT NULL AND (OLD.target_journal_entry_id IS NOT NULL OR NOT EXISTS (
         SELECT 1 FROM public.gl_journal_entries je WHERE je.id = NEW.target_journal_entry_id AND je.company_id = NEW.target_company_id)) THEN
      RAISE EXCEPTION 'intercompany_transactions: the target journal is set once, to a journal of the target company' USING ERRCODE = '23514';
    END IF;
    IF NEW.target_journal_entry_id IS NULL AND NEW.match_status IS DISTINCT FROM 'unmatched' THEN
      RAISE EXCEPTION 'intercompany_transactions: the target journal is cleared only with an unmatch' USING ERRCODE = '23514';
    END IF;
  END IF;
  -- the first journal a row was matched to: written by the definer, never cleared (a release does not touch it)
  IF NEW.first_target_journal_entry_id IS DISTINCT FROM OLD.first_target_journal_entry_id
     AND (current_user <> 'migration_admin' OR NEW.first_target_journal_entry_id IS NULL OR NOT EXISTS (
            SELECT 1 FROM public.gl_journal_entries je WHERE je.id = NEW.first_target_journal_entry_id AND je.company_id = NEW.target_company_id)) THEN
    RAISE EXCEPTION 'intercompany_transactions: the first matched journal is written by the database, to a journal of the target company, and never cleared' USING ERRCODE = '23514';
  END IF;
  -- variance_reason is the definer's account of why a row is not matched: no request's caller writes it.
  IF NEW.variance_reason IS DISTINCT FROM OLD.variance_reason AND current_user <> 'migration_admin' THEN
    RAISE EXCEPTION 'intercompany_transactions: the variance reason is written by the database, not by a request' USING ERRCODE = '23514';
  END IF;
  -- matched_by, when it changes, is whoever matched it (a request's caller cannot sign another user's name) and is
  -- cleared only by an unmatch: together with match_status back to 'unmatched'.
  IF NEW.matched_by IS DISTINCT FROM OLD.matched_by AND current_user <> 'migration_admin'
     AND ((NEW.matched_by IS NULL AND NEW.match_status IS DISTINCT FROM 'unmatched')
          OR (NEW.matched_by IS NOT NULL AND (auth.uid() IS NULL OR NEW.matched_by::pg_catalog.text <> auth.uid()))) THEN
    RAISE EXCEPTION 'intercompany_transactions: matched_by is the user who matched it, and is cleared only by an unmatch' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

-- Whether journal p_je is already held: the target or first match of any intercompany row, or the journal of a bill / supplier credit note
-- that an accepted invoice / credit-note message created (a mirrored document, bound or not yet). A definer: the INSERT trigger below asks it
-- for a writer who may not be able to read those rows. Answers a boolean only, and only for a journal of a company that is a current member of
-- a group the CALLER is a member of (rls_user_group_ids(): the only journals a writer's row may name, rls_intercompany_parties_ok); for any
-- other journal it answers false, so it is no oracle on another tenant's journals.
CREATE OR REPLACE FUNCTION public.intercompany_journal_claimed(p_je uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT EXISTS (SELECT 1 FROM public.gl_journal_entries je
                   JOIN public.company_group_members gm ON gm.company_id = je.company_id AND gm.left_date IS NULL
                  WHERE je.id = p_je AND gm.group_id IN (SELECT public.rls_user_group_ids()))
  AND (EXISTS (SELECT 1 FROM public.intercompany_transactions o WHERE o.target_journal_entry_id = p_je)
      OR EXISTS (SELECT 1 FROM public.intercompany_transactions o WHERE o.first_target_journal_entry_id = p_je)
      OR EXISTS (SELECT 1 FROM public.supplier_invoices si JOIN public.intercompany_messages x
                   ON x.target_doc_type = 'supplier_invoice' AND x.target_doc_id = si.id AND x.status = 'accepted' AND x.kind IN ('invoice', 'credit_note')
                  WHERE si.gl_journal_entry_id = p_je)
      OR EXISTS (SELECT 1 FROM public.credit_notes cn JOIN public.intercompany_messages x
                   ON x.target_doc_type = 'credit_note' AND x.target_doc_id = cn.id AND x.status = 'accepted' AND x.kind IN ('invoice', 'credit_note')
                  WHERE cn.gl_journal_entry_id = p_je))
$$;
ALTER FUNCTION public.intercompany_journal_claimed(uuid) OWNER TO migration_admin;
REVOKE ALL ON FUNCTION public.intercompany_journal_claimed(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.intercompany_journal_claimed(uuid) TO app_user, app_service, migration_admin;

-- THE PER-PAIR CUTOVER (RULING 2026-11-21, Hein). For a group the caller is a current member of, and only when it is the group the pair's
-- mirrors go to (the oldest active group with both as members, as intercompany_send_for_source picks): each pair of its current members joined by an
-- ACTIVE group connection with a cut-over date and BOTH sides' mirroring on (customer and supplier links set: mirroring_since), and the pair's
-- cutover: the latest of the connection's cut-over date and the two sides' mirroring_since dates (Johannesburg). From that date every invoice
-- and credit note between the pair is mirrored and eliminated from the ledgers, so the manual (P1) generator drafts nothing for a sale-class
-- row of the pair dated on or after it (either direction), and a hand-made elimination dated on or after it needs a typed reason. A side
-- switched off clears its mirroring_since (the pair has no cutover until it is on again, and then a later one); a revoked connection has none.
DROP FUNCTION IF EXISTS public.intercompany_pair_cutovers(uuid);
CREATE OR REPLACE FUNCTION public.intercompany_pair_cutovers(p_group uuid)
RETURNS TABLE (company_low_id uuid, company_high_id uuid, cutover date)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT c.company_low_id, c.company_high_id,
         GREATEST(c.cutover_date, (sl.mirroring_since AT TIME ZONE 'Africa/Johannesburg')::date, (sh.mirroring_since AT TIME ZONE 'Africa/Johannesburg')::date)
    FROM public.intercompany_connections c
    JOIN public.intercompany_connection_sides sl ON sl.connection_id = c.id AND sl.company_id = c.company_low_id AND sl.mirroring_since IS NOT NULL
    JOIN public.intercompany_connection_sides sh ON sh.connection_id = c.id AND sh.company_id = c.company_high_id AND sh.mirroring_since IS NOT NULL
   WHERE c.status = 'active' AND c.kind = 'group' AND c.cutover_date IS NOT NULL
     AND p_group IN (SELECT public.rls_user_group_ids())
     -- the pair's mirrors are written to ONE group, the oldest active group with both as current members (intercompany_send_for_source):
     -- only that group's eliminations are derived, so only there does the pair have a cutover
     AND p_group = (SELECT g.id FROM public.company_groups g
                     WHERE g.is_active IS NOT FALSE
                       AND EXISTS (SELECT 1 FROM public.company_group_members a WHERE a.group_id = g.id AND a.company_id = c.company_low_id AND a.left_date IS NULL)
                       AND EXISTS (SELECT 1 FROM public.company_group_members b WHERE b.group_id = g.id AND b.company_id = c.company_high_id AND b.left_date IS NULL)
                     ORDER BY g.created_at, g.id LIMIT 1)
     AND EXISTS (SELECT 1 FROM public.company_group_members a WHERE a.group_id = p_group AND a.company_id = c.company_low_id AND a.left_date IS NULL)
     AND EXISTS (SELECT 1 FROM public.company_group_members b WHERE b.group_id = p_group AND b.company_id = c.company_high_id AND b.left_date IS NULL)
$$;
ALTER FUNCTION public.intercompany_pair_cutovers(uuid) OWNER TO migration_admin;
REVOKE ALL ON FUNCTION public.intercompany_pair_cutovers(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.intercompany_pair_cutovers(uuid) TO app_user, app_service, migration_admin;

-- Every SINGLE mirrored document a manual sale-class row may be, closest first (rank 1 = the best): the same group, the sale running the way
-- the row's elimination does (a purchase in reverse), its subtotal or total (signed) the row's amount, its date in the same calendar month as
-- or within 7 days of the row's by the sender's or the receiver's document date, its message accepted with a target document. A CANCELLED
-- sender (source_cancelled_at) is NOT left out: whether it eliminates anything is judged as at a period (intercompany_mirror_stands), never by
-- the stamp, which is today's state. Named by description, else '(no description)', never an id. SECURITY INVOKER, migration_admin only: the
-- duplicate flag and the link function call it after their own membership checks.
CREATE OR REPLACE FUNCTION public.intercompany_mirror_candidates(p_row uuid)
RETURNS TABLE (mirror_row uuid, mirror_ref text, rank bigint)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog, public, pg_temp
AS $$
  WITH r AS (
    SELECT r.id, r.group_id, r.amount, r.transaction_date AS td,
           CASE WHEN r.transaction_type = 'purchase' THEN r.target_company_id ELSE r.source_company_id END AS seller,
           CASE WHEN r.transaction_type = 'purchase' THEN r.source_company_id ELSE r.target_company_id END AS buyer
      FROM public.intercompany_transactions r
     WHERE r.id = p_row AND r.transaction_type IN ('sale', 'purchase', 'mgmt_fee')
       AND NOT EXISTS (SELECT 1 FROM public.intercompany_messages rm WHERE rm.group_transaction_id = r.id)
  ), m AS (
    SELECT o.id, COALESCE(NULLIF(btrim(o.description), ''), '(no description)') AS ref, o.amount AS sub,
           sign(o.amount) * (x.payload->>'total')::numeric AS tot, o.transaction_date AS od, o.created_at,
           COALESCE((SELECT si.invoice_date FROM public.supplier_invoices si WHERE x.target_doc_type = 'supplier_invoice' AND si.id = x.target_doc_id),
                    (SELECT cn.credit_date FROM public.credit_notes cn WHERE x.target_doc_type = 'credit_note' AND cn.id = x.target_doc_id)) AS bd
      FROM r
      JOIN public.intercompany_transactions o ON o.group_id = r.group_id AND o.id <> r.id AND o.source_company_id = r.seller AND o.target_company_id = r.buyer
      JOIN public.intercompany_messages x ON x.group_transaction_id = o.id AND x.kind IN ('invoice', 'credit_note')
     WHERE x.status = 'accepted' AND x.target_doc_id IS NOT NULL
  )
  SELECT m.id, m.ref, row_number() OVER (ORDER BY (r.amount = m.sub AND r.td = m.od) DESC, abs(r.td - m.od), m.created_at, m.id)
    FROM r, m
   WHERE (r.amount = m.sub OR r.amount = m.tot)
     AND (date_trunc('month', r.td) = date_trunc('month', m.od) OR abs(r.td - m.od) <= 7
          OR (m.bd IS NOT NULL AND (date_trunc('month', r.td) = date_trunc('month', m.bd) OR abs(r.td - m.bd) <= 7)))
$$;
REVOKE ALL ON FUNCTION public.intercompany_mirror_candidates(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.intercompany_mirror_candidates(uuid) TO migration_admin;

DROP FUNCTION IF EXISTS public.intercompany_mirror_pick(uuid, date);   -- (round 18's pick: the facts below replace it)

-- The mirrored sales a MANUAL (non-mirrored) group row of a sale type may duplicate (rows dated before its pair's cutover can still overlap a
-- mirror: a document dated after the connection's cut-over date but approved before both sides were on is not mirrored, one approved after is).
-- A FLAG only, never a skip, so it is WIDE (a missing flag lets a person post a double elimination; a spurious one costs a look). A mirrored row
-- of the same group whose sale runs the way the manual row's elimination does: the same source and target for a sale or mgmt_fee, the REVERSE
-- for a purchase (a purchase B -> A is A's sale to B: the P1 generator eliminates the same group accounts). Matched by amount: (1) the SINGLE
-- mirrors that match (intercompany_mirror_candidates: a cancelled sender kept, judged as at the period by the facts), closest first; else (2) the
-- mirrors of that direction whose sender's date is in the row's calendar month, accepted with a target document and carried by the period (a
-- cancelled one counts while its sent-with journal's reversal chain is odd as at p_asat), when their
-- subtotals (or totals) SUM to the row's amount (a monthly total, an invoice net of its credit note). mirror_rows: the mirror(s) in that order;
-- mirror_ref: the closest one's description (else '(no description)') or "N mirrored documents of <month>"; is_sum: (2). A plain match: it walks
-- no ledger (the post refusal's EXISTS and the list's join use it as is). WHAT IS TRUE of the match (which mirror the wording names, whether it
-- is eliminated automatically for the period, whose link holds it) is intercompany_mirror_facts, the one source of every sentence about it. A
-- definer (the caller may not read the messages); it answers only for a row of a group the caller is a current member of. p_asat (NULL:
-- today) is read only for a month-sum member whose sender cancelled it: it counts while the period still carries it (round 20, M1).
DROP FUNCTION IF EXISTS public.intercompany_mirrored_duplicate(uuid, date, date);
DROP FUNCTION IF EXISTS public.intercompany_mirrored_duplicate(uuid, date);
DROP FUNCTION IF EXISTS public.intercompany_mirrored_duplicate(uuid);
CREATE OR REPLACE FUNCTION public.intercompany_mirrored_duplicate(p_row uuid, p_asat date DEFAULT NULL)
RETURNS TABLE (mirror_rows uuid[], mirror_ref text, is_sum boolean)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
  WITH r AS (
    SELECT r.id, r.group_id, r.amount, r.transaction_date AS td,
           CASE WHEN r.transaction_type = 'purchase' THEN r.target_company_id ELSE r.source_company_id END AS seller,
           CASE WHEN r.transaction_type = 'purchase' THEN r.source_company_id ELSE r.target_company_id END AS buyer
      FROM public.intercompany_transactions r
     WHERE r.id = p_row AND r.group_id IN (SELECT public.rls_user_group_ids())
       AND r.transaction_type IN ('sale', 'purchase', 'mgmt_fee')
       AND NOT EXISTS (SELECT 1 FROM public.intercompany_messages rm WHERE rm.group_transaction_id = r.id)
  ), m AS (
    SELECT o.id, o.amount AS sub, sign(o.amount) * (x.payload->>'total')::numeric AS tot, o.transaction_date AS od
      FROM r
      JOIN public.intercompany_transactions o ON o.group_id = r.group_id AND o.id <> r.id AND o.source_company_id = r.seller AND o.target_company_id = r.buyer
      JOIN public.intercompany_messages x ON x.group_transaction_id = o.id AND x.kind IN ('invoice', 'credit_note')
     WHERE x.status = 'accepted' AND x.target_doc_id IS NOT NULL
       -- a member the sender cancelled counts while the period still carries it: its cancel judged AS AT THE PERIOD by the sent-with journal's
       -- reversal chain (a cancel rolled past a locked VAT period or a closed fiscal period is dated later), never by today's stamp
       AND CASE WHEN x.source_cancelled_at IS NULL THEN true
                ELSE public.intercompany_journal_chain_length(x.source_journal_entry_id, o.source_company_id,
                       COALESCE(p_asat, (now() AT TIME ZONE 'Africa/Johannesburg')::date)) % 2 = 1 END
  ), one AS (
    SELECT array_agg(c.mirror_row ORDER BY c.rank) AS rows, (array_agg(c.mirror_ref ORDER BY c.rank))[1] AS ref
      FROM r CROSS JOIN LATERAL public.intercompany_mirror_candidates(r.id) c HAVING count(*) > 0
  ), summed AS (
    SELECT array_agg(m.id ORDER BY m.od, m.id) AS rows, count(*) AS n, sum(m.sub) AS sub, sum(m.tot) AS tot
      FROM r, m WHERE date_trunc('month', m.od) = date_trunc('month', r.td)
  )
  SELECT one.rows, one.ref, false FROM one
  UNION ALL
  SELECT s.rows, s.n || ' mirrored documents of ' || to_char(r.td, 'FMMonth YYYY'), true
    FROM summed s, r WHERE s.n > 1 AND (s.sub = r.amount OR s.tot = r.amount) AND NOT EXISTS (SELECT 1 FROM one)
$$;
ALTER FUNCTION public.intercompany_mirrored_duplicate(uuid, date) OWNER TO migration_admin;
REVOKE ALL ON FUNCTION public.intercompany_mirrored_duplicate(uuid, date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.intercompany_mirrored_duplicate(uuid, date) TO app_user, app_service, migration_admin;

-- WHAT IS TRUE of a manual row's possible mirrored duplicate (intercompany_mirrored_duplicate) for the period ending p_asat (NULL: today): one row
-- per mirror the wording names, each with its description (else '(no description)'), the amount it accounts for (the row's amount for one mirror;
-- its subtotal, or signed total, for a member of a month sum), whether it is eliminated automatically for that period
-- (intercompany_mirror_stands), and whose ACTIVE link of the row's role holds it: 'here' (this row), 'elsewhere' (another row: "matched to a
-- different row"), 'none'; other_role: the role of another row's active link of the OTHER role (the sale's other side); by_total: matched by
-- its total with VAT (mirroring eliminates net of VAT); elim_date: the date its elimination falls on (the later document date, which can be
-- after the period: "stands" judges the pair, not that date); sender_cancelled: the sender's sent-with journal is reversed as at the period end (no revenue is left to eliminate). Of several single candidates (closest first) it names, in this order: the one this row's active link holds; else the
-- closest that stands and no other row's link holds (stopping there); else the closest no other row's link holds (none of those stands: it is
-- named NOT eliminated, never a mirror that is another row's sale); else the closest. A month sum names every member. The ONE source of the
-- generator's note, the list's badge, the 409 and the confirm (mirrorFacts.ts): no sentence is worded from anything else. label: the
-- mirror's description or "N mirrored documents of <month>"; ord: the order to name them in. A definer: only for a row of a group the caller is a
-- current member of (through intercompany_mirrored_duplicate); nothing otherwise.
DROP FUNCTION IF EXISTS public.intercompany_mirror_facts(uuid, date);
CREATE OR REPLACE FUNCTION public.intercompany_mirror_facts(p_row uuid, p_asat date DEFAULT NULL)
RETURNS TABLE (label text, is_sum boolean, ord integer, mirror_row uuid, mirror_ref text, amount numeric, stands boolean, link text,
               by_total boolean, elim_date date, other_role text, sender_cancelled boolean)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET jit = off
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  d record;
  v_role text;
  v_amount numeric;
  v_by_sub boolean;
  v_id uuid;
  v_s boolean;
  v_free uuid;
  v_pick uuid;
  v_pick_s boolean;
  v_ids uuid[] := '{}';
  v_st boolean[] := '{}';
BEGIN
  SELECT x.mirror_rows, x.mirror_ref, x.is_sum INTO d FROM public.intercompany_mirrored_duplicate(p_row, p_asat) x LIMIT 1;
  IF NOT FOUND OR d.mirror_rows IS NULL THEN RETURN; END IF;
  SELECT CASE WHEN t.transaction_type = 'purchase' THEN 'purchase' ELSE 'sale' END, t.amount INTO v_role, v_amount
    FROM public.intercompany_transactions t WHERE t.id = p_row;
  IF d.is_sum THEN
    FOREACH v_id IN ARRAY d.mirror_rows LOOP
      v_ids := v_ids || v_id; v_st := v_st || COALESCE(public.intercompany_mirror_stands(v_id, p_asat), false);
    END LOOP;
  ELSE
    -- the candidate this row's own active link holds
    SELECT l.mirror_row INTO v_pick FROM public.intercompany_mirror_links l
     WHERE l.row_id = p_row AND l.released_at IS NULL AND l.mirror_row = ANY (d.mirror_rows);
    IF v_pick IS NOT NULL THEN
      v_pick_s := COALESCE(public.intercompany_mirror_stands(v_pick, p_asat), false);
    ELSE
      FOREACH v_id IN ARRAY d.mirror_rows LOOP
        CONTINUE WHEN EXISTS (SELECT 1 FROM public.intercompany_mirror_links l
                               WHERE l.mirror_row = v_id AND l.role = v_role AND l.released_at IS NULL AND l.row_id <> p_row);
        v_s := COALESCE(public.intercompany_mirror_stands(v_id, p_asat), false);
        IF v_free IS NULL THEN v_free := v_id; END IF;
        IF v_s THEN v_pick := v_id; v_pick_s := true; EXIT; END IF;
      END LOOP;
      IF v_pick IS NULL AND v_free IS NOT NULL THEN v_pick := v_free; v_pick_s := false; END IF;
      IF v_pick IS NULL THEN v_pick := d.mirror_rows[1]; v_pick_s := COALESCE(public.intercompany_mirror_stands(v_pick, p_asat), false); END IF;
    END IF;
    v_ids := ARRAY[v_pick]; v_st := ARRAY[v_pick_s];
  END IF;
  -- a sum's members account for their subtotals when the subtotals make the row's amount, else for their (signed) totals
  v_by_sub := NOT d.is_sum OR (SELECT sum(o.amount) FROM public.intercompany_transactions o WHERE o.id = ANY (v_ids)) = v_amount;
  RETURN QUERY
    SELECT CASE WHEN d.is_sum THEN d.mirror_ref ELSE COALESCE(NULLIF(btrim(o.description), ''), '(no description)') END, d.is_sum, u.n::integer,
           o.id, COALESCE(NULLIF(btrim(o.description), ''), '(no description)'),
           CASE WHEN NOT d.is_sum THEN v_amount WHEN v_by_sub THEN o.amount ELSE sign(o.amount) * (x.payload->>'total')::numeric END,
           v_st[u.n],
           CASE WHEN EXISTS (SELECT 1 FROM public.intercompany_mirror_links l WHERE l.row_id = p_row AND l.mirror_row = o.id AND l.released_at IS NULL) THEN 'here'
                WHEN EXISTS (SELECT 1 FROM public.intercompany_mirror_links l WHERE l.mirror_row = o.id AND l.role = v_role AND l.released_at IS NULL AND l.row_id <> p_row) THEN 'elsewhere'
                ELSE 'none' END,
           -- matched by its total with VAT (mirroring eliminates the subtotal, net of VAT)
           CASE WHEN d.is_sum THEN NOT v_by_sub ELSE v_amount IS DISTINCT FROM o.amount END,
           -- the date its elimination falls on: the later of the sender's and the receiver's document dates (may be after the period)
           GREATEST(o.transaction_date, COALESCE(x.bd, o.transaction_date)),
           -- the role of an active link of the OTHER role (the purchase side of the sale for a sale row, and the reverse)
           (SELECT l.role FROM public.intercompany_mirror_links l WHERE l.mirror_row = o.id AND l.role <> v_role AND l.released_at IS NULL AND l.row_id <> p_row LIMIT 1),
           -- the SENDER cancelled it as at the period end (the same date "stands" judges the pair at): its sent-with journal's chain is out, having been in
           COALESCE(x.chain > 0 AND x.chain % 2 = 0, false)
      FROM unnest(v_ids) WITH ORDINALITY AS u(id, n)
      JOIN public.intercompany_transactions o ON o.id = u.id
      LEFT JOIN LATERAL (SELECT m.payload,
                                public.intercompany_journal_chain_length(m.source_journal_entry_id, m.from_company_id,
                                  LEAST(COALESCE(p_asat, (now() AT TIME ZONE 'Africa/Johannesburg')::date), (now() AT TIME ZONE 'Africa/Johannesburg')::date)) AS chain,
                                COALESCE((SELECT si.invoice_date FROM public.supplier_invoices si WHERE m.target_doc_type = 'supplier_invoice' AND si.id = m.target_doc_id),
                                         (SELECT cn.credit_date FROM public.credit_notes cn WHERE m.target_doc_type = 'credit_note' AND cn.id = m.target_doc_id)) AS bd
                           FROM public.intercompany_messages m WHERE m.group_transaction_id = o.id AND m.kind IN ('invoice', 'credit_note') LIMIT 1) x ON true
     ORDER BY u.n;
END;
$$;
ALTER FUNCTION public.intercompany_mirror_facts(uuid, date) OWNER TO migration_admin;
REVOKE ALL ON FUNCTION public.intercompany_mirror_facts(uuid, date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.intercompany_mirror_facts(uuid, date) TO app_user, app_service, migration_admin;

-- Whether a mirrored row is ELIMINATED AUTOMATICALLY for a period ending p_asat (NULL: today): its pair stands as at the later of its two
-- document dates (the sender's, the receiver's: the +E falls on the later journal date, so an earlier date would miss a bill booked in a later
-- month) AND still stands as at the later of that date and LEAST(p_asat, today) (a stop dated after the period is the mirror's own -E in a later
-- period, so it does not unmake this period's elimination; one inside it does), AND every revenue line of the sender's journal and every
-- expense line of the receiver's is mapped to a group account of the row's group (an unmapped line drops the whole derived event,
-- mirrorEliminations.ts). A sale booked by the receiver in another financial year (the cut-off), a bill accepted but never approved, a pair
-- reversed in the period, or an unmapped account: false. The three chains are walked ONCE (intercompany_journal_chain_eff) and passed to both
-- judgements. A definer: only for a row of a group the caller is a current member of (else NULL).
DROP FUNCTION IF EXISTS public.intercompany_mirror_stands(uuid);
DROP FUNCTION IF EXISTS public.intercompany_mirror_stands(uuid, date);
CREATE OR REPLACE FUNCTION public.intercompany_mirror_stands(p_row uuid, p_asat date DEFAULT NULL)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET jit = off
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT public.intercompany_mirror_pair_at(h.id, h.later, h.se, h.fe, h.de) IS NOT NULL
         AND public.intercompany_mirror_pair_at(h.id, GREATEST(h.later, LEAST(COALESCE(p_asat, (now() AT TIME ZONE 'Africa/Johannesburg')::date), (now() AT TIME ZONE 'Africa/Johannesburg')::date)), h.se, h.fe, h.de) IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM public.gl_journal_lines jl JOIN public.gl_accounts a ON a.id = jl.gl_account_id AND a.account_type = 'revenue'
                          WHERE jl.journal_entry_id = h.sje AND jl.company_id = h.sc
                            AND NOT EXISTS (SELECT 1 FROM public.group_coa_mappings g WHERE g.group_id = h.gid AND g.company_id = h.sc AND g.company_account_id = jl.gl_account_id))
         AND NOT EXISTS (SELECT 1 FROM public.gl_journal_lines jl JOIN public.gl_accounts a ON a.id = jl.gl_account_id AND a.account_type = 'expense'
                          WHERE jl.journal_entry_id = h.je AND jl.company_id = h.tc
                            AND NOT EXISTS (SELECT 1 FROM public.group_coa_mappings g WHERE g.group_id = h.gid AND g.company_id = h.tc AND g.company_account_id = jl.gl_account_id))
    FROM (
      SELECT it.id, it.group_id AS gid, it.source_company_id AS sc, it.target_company_id AS tc, m.source_journal_entry_id AS sje, bill.je,
             GREATEST(it.transaction_date, COALESCE(bill.d, it.transaction_date)) AS later,
             public.intercompany_journal_chain_eff(m.source_journal_entry_id, it.source_company_id) AS se,
             public.intercompany_journal_chain_eff(it.first_target_journal_entry_id, it.target_company_id) AS fe,
             public.intercompany_journal_chain_eff(bill.je, it.target_company_id) AS de
        FROM public.intercompany_transactions it
        JOIN public.intercompany_messages m ON m.group_transaction_id = it.id AND m.kind IN ('invoice', 'credit_note')
        LEFT JOIN LATERAL (
          SELECT si.invoice_date AS d, si.gl_journal_entry_id AS je FROM public.supplier_invoices si
           WHERE m.target_doc_type = 'supplier_invoice' AND si.id = m.target_doc_id AND si.company_id = m.to_company_id
          UNION ALL
          SELECT cn.credit_date, cn.gl_journal_entry_id FROM public.credit_notes cn
           WHERE m.target_doc_type = 'credit_note' AND cn.id = m.target_doc_id AND cn.company_id = m.to_company_id AND cn.type = 'supplier'
          LIMIT 1) bill ON true
       WHERE it.id = p_row AND it.group_id IN (SELECT public.rls_user_group_ids())
         AND m.source_journal_entry_id IS NOT NULL AND m.target_doc_id IS NOT NULL
       LIMIT 1) h
$$;
ALTER FUNCTION public.intercompany_mirror_stands(uuid, date) OWNER TO migration_admin;
REVOKE ALL ON FUNCTION public.intercompany_mirror_stands(uuid, date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.intercompany_mirror_stands(uuid, date) TO app_user, app_service, migration_admin;

-- THE STORED, EXCLUSIVE LINK of a manual (P1) row to the mirrored document that eliminates it after the pair's cutover (RULING 2026-11-21).
-- One active link per row and one per (mirror, role): a mirror accounts for at most one sale row (sale / mgmt_fee) and one purchase row (the two
-- sides of the same sale), across EVERY run and period, so a later run reads the link instead of matching again. Written only by
-- intercompany_mirror_link (below); no app role may write it. A released link (its mirror stopped eliminating the row) stays as history.
CREATE TABLE IF NOT EXISTS intercompany_mirror_links (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id UUID NOT NULL REFERENCES company_groups(id) ON DELETE CASCADE,
  row_id UUID NOT NULL REFERENCES intercompany_transactions(id) ON DELETE CASCADE,
  mirror_row UUID NOT NULL REFERENCES intercompany_transactions(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('sale', 'purchase')),
  linked_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  linked_by TEXT,
  released_at TIMESTAMPTZ,
  released_for DATE
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_ic_mirror_links_row ON intercompany_mirror_links (row_id) WHERE released_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_ic_mirror_links_mirror_role ON intercompany_mirror_links (mirror_row, role) WHERE released_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_ic_mirror_links_group ON intercompany_mirror_links (group_id);
ALTER TABLE intercompany_mirror_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE intercompany_mirror_links FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_select ON intercompany_mirror_links;
CREATE POLICY tenant_isolation_select ON intercompany_mirror_links FOR SELECT TO app_user USING (group_id IN (SELECT public.rls_user_group_ids()));
REVOKE ALL ON intercompany_mirror_links FROM PUBLIC;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON intercompany_mirror_links FROM app_user;
GRANT SELECT ON intercompany_mirror_links TO app_user;

-- Whether stored link k (row r -> mirror o) still accounts for r in a period ending p_asat: the mirror is a mirrored document of the same group,
-- its sale runs the way r's elimination does, its subtotal or total (signed) is r's amount, its message is accepted, and it is eliminated
-- automatically for that period (intercompany_mirror_stands: a sender cancel reversed AFTER the period leaves the period eliminated). SECURITY INVOKER, migration_admin only (the link function's helper).
CREATE OR REPLACE FUNCTION public.intercompany_mirror_link_holds(p_row uuid, p_mirror uuid, p_asat date)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.intercompany_transactions r
      JOIN public.intercompany_transactions o ON o.id = p_mirror AND o.group_id = r.group_id
       AND o.source_company_id = CASE WHEN r.transaction_type = 'purchase' THEN r.target_company_id ELSE r.source_company_id END
       AND o.target_company_id = CASE WHEN r.transaction_type = 'purchase' THEN r.source_company_id ELSE r.target_company_id END
      JOIN public.intercompany_messages x ON x.group_transaction_id = o.id AND x.kind IN ('invoice', 'credit_note')
     WHERE r.id = p_row AND x.status = 'accepted' AND x.target_doc_id IS NOT NULL   -- (a cancelled sender is judged as at the period, by stands)
       AND (r.amount = o.amount OR r.amount = sign(o.amount) * (x.payload->>'total')::numeric))
    AND COALESCE(public.intercompany_mirror_stands(p_mirror, p_asat), false)
$$;
REVOKE ALL ON FUNCTION public.intercompany_mirror_link_holds(uuid, uuid, date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.intercompany_mirror_link_holds(uuid, uuid, date) TO migration_admin;

-- The generator's question for a manual sale-class row of a mirroring pair dated on or after the pair's cutover, for a period ending p_asat:
-- is it eliminated by a mirrored document? The answer is STORED (intercompany_mirror_links), so it holds across runs and periods:
--   'linked'   the row's link holds (kept), or a new link was made: leave the row to mirroring;
--   'released' its link no longer holds for this period (the mirror stopped eliminating it) and no other candidate takes it: the link is
--              released and the row is drafted (when another candidate takes it, e.g. a re-issue after a cancel, the answer is 'linked');
--   'taken'    every mirror that matches it and eliminates it for the period already accounts for another row of the same role;
--   'closer'   ... or belongs to a closer row ON OR AFTER the cutover with no elimination of its own, which the mirror eliminates for that
--              row's own month (it gets the mirror when its period runs);
--   'none'     no single mirror matches it and eliminates it for the period (or the row is before its pair's cutover, or not the caller's).
-- The candidates are tried in closeness order (intercompany_mirror_candidates), so a second equal sale takes its own free mirror. The run takes
-- the generator's per-group advisory lock, so a direct call is serialised with a run; p_asat is held to [the row's date, today] (Johannesburg;
-- a row dated in the future: its own date) (a later stop is judged by its own counter-elimination; a forged later date can only release a
-- link, which the next proper run makes again).
-- mirror_ref names the mirror concerned. For a row of a group the caller WRITES in (the generator's caller); otherwise 'none'.
DROP FUNCTION IF EXISTS public.intercompany_mirror_link(uuid, date);
CREATE OR REPLACE FUNCTION public.intercompany_mirror_link(p_row uuid, p_asat date)
RETURNS TABLE (state text, mirror_row uuid, mirror_ref text)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET jit = off
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  r record;
  k record;
  c record;
  v_role text;
  v_cutover date;
  v_asat date;
  v_mdate date;
  v_id uuid;
  v_state text := 'none';
  v_ref text;
  v_mid uuid;
  v_today date;
  v_released uuid;
  v_released_ref text;
BEGIN
  SELECT t.id, t.group_id, t.amount, t.transaction_date AS td, t.created_at, t.transaction_type,
         CASE WHEN t.transaction_type = 'purchase' THEN t.target_company_id ELSE t.source_company_id END AS seller,
         CASE WHEN t.transaction_type = 'purchase' THEN t.source_company_id ELSE t.target_company_id END AS buyer
    INTO r FROM public.intercompany_transactions t
   WHERE t.id = p_row AND t.group_id IN (SELECT public.rls_user_write_group_ids()) AND t.transaction_type IN ('sale', 'purchase', 'mgmt_fee')
     AND NOT EXISTS (SELECT 1 FROM public.intercompany_messages rm WHERE rm.group_transaction_id = t.id);
  IF NOT FOUND THEN RETURN QUERY SELECT 'none'::text, NULL::uuid, NULL::text; RETURN; END IF;
  -- only a row on or after its pair's cutover (in this group) is ever left to mirroring
  SELECT pc.cutover INTO v_cutover FROM public.intercompany_pair_cutovers(r.group_id) pc
   WHERE pc.company_low_id = LEAST(r.seller, r.buyer) AND pc.company_high_id = GREATEST(r.seller, r.buyer);
  IF v_cutover IS NULL OR r.td < v_cutover THEN RETURN QUERY SELECT 'none'::text, NULL::uuid, NULL::text; RETURN; END IF;
  PERFORM pg_advisory_xact_lock(hashtext('consolidation-eliminations:' || r.group_id::text));
  v_role := CASE WHEN r.transaction_type = 'purchase' THEN 'purchase' ELSE 'sale' END;
  v_today := (now() AT TIME ZONE 'Africa/Johannesburg')::date;
  v_asat := GREATEST(LEAST(COALESCE(p_asat, v_today), v_today), r.td);   -- [the row's date, today] (a future-dated row: its own date)

  SELECT l.id, l.mirror_row AS mid, COALESCE(NULLIF(btrim(o.description), ''), '(no description)') AS ref INTO k
    FROM public.intercompany_mirror_links l JOIN public.intercompany_transactions o ON o.id = l.mirror_row
   WHERE l.row_id = p_row AND l.released_at IS NULL;
  IF FOUND THEN
    IF public.intercompany_mirror_link_holds(p_row, k.mid, v_asat) THEN
      RETURN QUERY SELECT 'linked'::text, k.mid, k.ref; RETURN;
    END IF;
    -- released, then the row's other candidates are tried (a cancel and re-issue inside the period: the re-issue takes the row)
    UPDATE public.intercompany_mirror_links SET released_at = clock_timestamp(), released_for = v_asat WHERE id = k.id;
    v_released := k.mid; v_released_ref := k.ref;
  END IF;

  FOR c IN SELECT * FROM public.intercompany_mirror_candidates(p_row) ORDER BY rank LOOP
    -- the cheap test first: a mirror already linked for this role is taken (whether it holds is its own row's question)
    IF EXISTS (SELECT 1 FROM public.intercompany_mirror_links l WHERE l.mirror_row = c.mirror_row AND l.role = v_role AND l.released_at IS NULL) THEN
      IF v_state <> 'closer' THEN v_state := 'taken'; v_mid := c.mirror_row; v_ref := c.mirror_ref; END IF;
      CONTINUE;
    END IF;
    IF NOT public.intercompany_mirror_link_holds(p_row, c.mirror_row, v_asat) THEN
      IF v_mid IS NULL THEN v_mid := c.mirror_row; v_ref := c.mirror_ref; END IF;   -- ('none', naming the closest)
      CONTINUE;
    END IF;
    SELECT o.transaction_date INTO v_mdate FROM public.intercompany_transactions o WHERE o.id = c.mirror_row;
    -- a closer row ON OR AFTER the cutover that matches this mirror and has no elimination of its own yet gets it (cheap filters first)
    IF EXISTS (
      SELECT 1 FROM public.intercompany_transactions x
       WHERE x.group_id = r.group_id AND x.id <> r.id AND x.match_status = 'matched' AND x.amount = r.amount AND x.transaction_date >= v_cutover
         AND CASE WHEN x.transaction_type = 'purchase' THEN 'purchase' ELSE 'sale' END = v_role AND x.transaction_type IN ('sale', 'purchase', 'mgmt_fee')
         AND CASE WHEN x.transaction_type = 'purchase' THEN x.target_company_id ELSE x.source_company_id END = r.seller
         AND CASE WHEN x.transaction_type = 'purchase' THEN x.source_company_id ELSE x.target_company_id END = r.buyer
         AND x.transaction_date BETWEEN v_mdate - 38 AND v_mdate + 38
         AND (abs(x.transaction_date - v_mdate), x.transaction_date, x.created_at, x.id) < (abs(r.td - v_mdate), r.td, r.created_at, r.id)
         AND NOT EXISTS (SELECT 1 FROM public.intercompany_mirror_links l WHERE l.row_id = x.id AND l.released_at IS NULL)
         AND NOT EXISTS (SELECT 1 FROM public.consolidation_adjustments ca WHERE ca.source_intercompany_id = x.id AND ca.status IN ('draft', 'posted'))
         AND NOT EXISTS (SELECT 1 FROM public.intercompany_messages xm WHERE xm.group_transaction_id = x.id)
         AND EXISTS (SELECT 1 FROM public.intercompany_mirror_candidates(x.id) xc WHERE xc.mirror_row = c.mirror_row AND xc.rank = 1)
         -- ... and the mirror can hold it: it eliminates x for x's own month (else x could never take it, and this row would be starved)
         AND public.intercompany_mirror_link_holds(x.id, c.mirror_row, LEAST((date_trunc('month', x.transaction_date) + interval '1 month - 1 day')::date, v_today)))
    THEN
      IF v_state <> 'closer' THEN v_mid := c.mirror_row; v_ref := c.mirror_ref; END IF;   -- (names the closest such mirror)
      v_state := 'closer';
      CONTINUE;
    END IF;
    INSERT INTO public.intercompany_mirror_links (group_id, row_id, mirror_row, role, linked_by)
    VALUES (r.group_id, p_row, c.mirror_row, v_role, auth.uid()) ON CONFLICT DO NOTHING RETURNING id INTO v_id;
    IF v_id IS NOT NULL THEN RETURN QUERY SELECT 'linked'::text, c.mirror_row, c.mirror_ref; RETURN; END IF;
    IF v_state <> 'closer' THEN v_state := 'taken'; v_mid := c.mirror_row; v_ref := c.mirror_ref; END IF;
  END LOOP;
  IF v_released IS NOT NULL THEN RETURN QUERY SELECT 'released'::text, v_released, v_released_ref; RETURN; END IF;
  RETURN QUERY SELECT v_state, v_mid, v_ref;
END;
$$;
ALTER FUNCTION public.intercompany_mirror_link(uuid, date) OWNER TO migration_admin;
REVOKE ALL ON FUNCTION public.intercompany_mirror_link(uuid, date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.intercompany_mirror_link(uuid, date) TO app_user, migration_admin;

-- A request's new row names no match and no reason (the 999r body, plus the two columns of 1019).
CREATE OR REPLACE FUNCTION public.intercompany_transaction_recorded_fresh()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF current_user <> 'migration_admin' THEN
    IF NEW.match_status IS DISTINCT FROM 'unmatched' OR NEW.matched_by IS NOT NULL OR NEW.matched_at IS NOT NULL
       OR COALESCE(NEW.variance_amount, 0) <> 0 OR NEW.first_target_journal_entry_id IS NOT NULL OR NEW.variance_reason IS NOT NULL THEN
      RAISE EXCEPTION 'intercompany_transactions: a new transaction is unmatched, unsigned and without variance' USING ERRCODE = '23514';
    END IF;
    -- a writer's row may not name a journal another row already holds, or the journal of a mirrored document (asked of a definer: the rows that
    -- hold it may be of a group or tenant the writer cannot read). The definer answers only for the signed-in user's groups, so a session with
    -- no user (the service login: no service path writes these rows, the only writer is the request route) may not name a journal at all.
    IF NEW.target_journal_entry_id IS NOT NULL AND auth.uid() IS NULL THEN
      RAISE EXCEPTION 'intercompany_transactions: a transaction naming a target journal is written by a signed-in user' USING ERRCODE = '23514';
    END IF;
    IF NEW.target_journal_entry_id IS NOT NULL AND public.intercompany_journal_claimed(NEW.target_journal_entry_id) THEN
      RAISE EXCEPTION 'intercompany_transactions: the target journal is already another transaction''s or a mirrored document''s' USING ERRCODE = '23514';
    END IF;
    NEW.created_at := pg_catalog.now();
  END IF;
  RETURN NEW;
END;
$$;

-- The judgement of the group row of a receiver's bill / supplier credit note (the receiver and the actor are PARAMETERS: the callers are the
-- sync definer below, for the session company, and the revival paths, for the message's receiver). Only for a document that is the target of an accepted message to that company whose group row the DATABASE recorded.

-- The row follows the LEDGERS, never a writable status or link column:
--   unmatched : the SENDER's journal the message records has been reversed (the ledger's parity; a stamp is only the withdrawal's record), or the
--               bill is not approved AND the journal the row was first matched to is really out of the ledger;
--   unchanged : the journal the row was FIRST matched to still stands: nothing the bill's columns say (its supplier, its journal link, its
--               status) moves a bound row. The one exception is a row the sender's cancel released that is live again: it is matched again;

--   matched   : the bill's journal is posted, standing, the receiver's own, the one posting THIS document wrote, no other document's, in the
--               same FINANCIAL YEAR (the receiver's calendar) as the sender's date, not another row's target, for the connection's supplier, and
--               it carries the sender's figures by value: expense lines net to the sender's amount, input VAT to its VAT, the payable to its
--               total, and no other kind of line;
--   variance  : any of those fails, with variance_reason saying which.

-- The row's status is a display value (nothing reads a figure from it). Returns the row's status, or NULL.
CREATE OR REPLACE FUNCTION public.intercompany_sync_core(p_co uuid, p_doc_type text, p_doc_id uuid, p_actor uuid)
RETURNS text
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_co uuid := p_co;
  m RECORD;
  d RECORD;
  t RECORD;
  v_chain integer;
  v_first_chain integer;
  v_first_stands boolean;
  v_sender_out boolean;
  v_status text;
  v_reason text;
  v_variance numeric := 0;
BEGIN
  SELECT x.connection_id, x.from_company_id, x.kind, x.source_doc_type, x.source_doc_id, x.source_cancelled_at, x.source_journal_entry_id AS source_je,
         x.group_transaction_id AS gtx, (x.payload->>'taxAmount')::numeric AS tax, (x.payload->>'total')::numeric AS total INTO m
    FROM public.intercompany_messages x
   WHERE x.to_company_id = v_co AND x.status = 'accepted' AND x.target_doc_type = p_doc_type AND x.target_doc_id = p_doc_id
     AND x.kind IN ('invoice', 'credit_note') AND x.group_transaction_id IS NOT NULL
   LIMIT 1;
  IF NOT FOUND THEN RETURN NULL; END IF;
  IF p_doc_type = 'supplier_invoice' THEN
    SELECT si.gl_journal_entry_id AS je,
           (si.deleted_at IS NULL AND si.status IN ('approved', 'partially_paid', 'paid')) AS ok INTO d
      FROM public.supplier_invoices si WHERE si.id = p_doc_id AND si.company_id = v_co;
  ELSIF p_doc_type = 'credit_note' THEN
    SELECT cn.gl_journal_entry_id AS je,
           (cn.status IN ('approved', 'partially_applied', 'applied')) AS ok INTO d
      FROM public.credit_notes cn WHERE cn.id = p_doc_id AND cn.company_id = v_co AND cn.type = 'supplier';
  ELSE
    RETURN NULL;
  END IF;
  IF NOT FOUND THEN RETURN NULL; END IF;
  -- The row is the one the DATABASE recorded for this message (never a payload field): the sender's row to this company for the journal it was sent with.
  IF NOT public.intercompany_group_row_ok(m.gtx, m.from_company_id, v_co, m.source_je) THEN RETURN NULL; END IF;
  SELECT it.amount, it.transaction_date, it.match_status, it.target_journal_entry_id, it.first_target_journal_entry_id AS first_je INTO t
    FROM public.intercompany_transactions it WHERE it.id = m.gtx FOR UPDATE;
  IF NOT FOUND THEN RETURN NULL; END IF;

  v_chain := CASE WHEN m.source_je IS NULL THEN 0 ELSE public.intercompany_journal_chain_length(m.source_je, m.from_company_id) END;
  v_first_chain := CASE WHEN t.first_je IS NULL THEN 0 ELSE public.intercompany_journal_chain_length(t.first_je, v_co) END;
  v_first_stands := t.first_je IS NOT NULL AND v_first_chain > 0 AND v_first_chain % 2 <> 0;
  -- The sender's cancel as the LEDGER has it now (a stamp lifted by a revival does not count; a message that records no journal falls back to its stamp).
  v_sender_out := CASE WHEN m.source_je IS NULL THEN m.source_cancelled_at IS NOT NULL ELSE v_chain > 0 AND v_chain % 2 = 0 END;

  IF v_sender_out THEN
    PERFORM public.intercompany_release_group_row(m.gtx);
    RETURN 'unmatched';
  ELSIF v_first_stands THEN
    -- A bound row is moved by its first journal's fate or the sender's cancel, never by the bill's own columns. A row released by the sender's
    -- cancel whose cancel was undone is matched again on the same journal while the bill is still approved on it.
    IF t.match_status = 'unmatched' AND COALESCE(d.ok, false) AND d.je IS NOT DISTINCT FROM t.first_je THEN
      UPDATE public.intercompany_transactions SET match_status = 'matched', variance_amount = 0, variance_reason = NULL, matched_at = clock_timestamp(),
             matched_by = p_actor, target_journal_entry_id = t.first_je WHERE id = m.gtx;
      RETURN 'matched';
    END IF;
    RETURN t.match_status;
  ELSIF NOT (COALESCE(d.ok, false) AND d.je IS NOT NULL) THEN
    PERFORM public.intercompany_release_group_row(m.gtx);
    RETURN 'unmatched';
  END IF;

  v_reason := public.intercompany_receiver_journal_problem(m.gtx, v_co, p_doc_type, p_doc_id, d.je, NULL);
  IF v_reason IS NULL THEN
    v_variance := abs(t.amount - COALESCE((SELECT sum(jl.debit - jl.credit) FROM public.gl_journal_lines jl JOIN public.gl_accounts ga ON ga.id = jl.gl_account_id
                                            WHERE jl.journal_entry_id = d.je AND jl.company_id = v_co AND ga.account_type = 'expense'), 0));
    v_reason := public.intercompany_receiver_journal_value_problem(m.kind, d.je, t.amount, m.tax, m.total);
  END IF;
  v_status := CASE WHEN v_reason IS NULL THEN 'matched' ELSE 'variance' END;

  -- Only a MATCH binds the row to a journal, and the FIRST match is recorded once and kept (with the document's current journal, the receiver
  -- journals the derived eliminations read: a period before ONE reverse-and-repost still sees the journal that stood in it; a journal linked in
  -- between two re-posts is not kept). A row whose first journal is out of the ledger may bind a new target
  -- (cleared first: only an unmatch clears it). The first journal is never cleared by a release.
  -- A journal is any row's first match once (uq_ic_transactions_first_journal): a concurrent sync that matched the same journal for another
  -- row waits on that index and loses here, as a variance.
  BEGIN
    IF v_status = 'matched' AND t.target_journal_entry_id IS NOT NULL AND t.target_journal_entry_id <> d.je THEN
      UPDATE public.intercompany_transactions SET match_status = 'unmatched', variance_amount = 0, variance_reason = NULL, matched_at = NULL, matched_by = NULL,
             target_journal_entry_id = NULL WHERE id = m.gtx;
    END IF;
    UPDATE public.intercompany_transactions
       SET match_status = v_status, variance_amount = v_variance, variance_reason = v_reason, matched_at = clock_timestamp(), matched_by = p_actor,
           target_journal_entry_id = CASE WHEN v_status = 'matched' THEN COALESCE(target_journal_entry_id, d.je) ELSE target_journal_entry_id END,
           first_target_journal_entry_id = CASE WHEN v_status = 'matched' THEN COALESCE(first_target_journal_entry_id, d.je) ELSE first_target_journal_entry_id END
     WHERE id = m.gtx;
  EXCEPTION WHEN unique_violation THEN
    v_status := 'variance';
    UPDATE public.intercompany_transactions
       SET match_status = 'variance', variance_amount = v_variance, variance_reason = 'the journal is already matched to another transaction',
           matched_at = clock_timestamp(), matched_by = p_actor
     WHERE id = m.gtx;
  END;
  RETURN v_status;
END;
$$;
REVOKE ALL ON FUNCTION public.intercompany_sync_core(uuid, text, uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.intercompany_sync_core(uuid, text, uuid, uuid) TO migration_admin;

-- Called after the receiver's bill / supplier credit note is approved, cancelled or deleted: for the session company only, a signed-in user of it
-- with a write role; the judgement is intercompany_sync_core's. Returns the row's status, or NULL when there is nothing to do.
CREATE OR REPLACE FUNCTION public.intercompany_sync_group_row(p_doc_type text, p_doc_id uuid)
RETURNS text
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_co uuid := app.current_company_id();
  v_prev text;
  v_res text;
BEGIN
  -- a 2 s bound that never LOOSENS the caller's (a cancel under underFlowLockBudget may hold a tighter one; '0' = none): set here, put back at every exit
  v_prev := pg_catalog.current_setting('lock_timeout');
  IF v_prev::interval = interval '0' OR v_prev::interval > interval '2s' THEN PERFORM pg_catalog.set_config('lock_timeout', '2s', true); END IF;
  IF v_co IS NULL OR NOT public.intercompany_user_can_write(v_co) THEN PERFORM pg_catalog.set_config('lock_timeout', v_prev, true); RETURN NULL; END IF;
  v_res := public.intercompany_sync_core(v_co, p_doc_type, p_doc_id, auth.uid()::uuid);
  PERFORM pg_catalog.set_config('lock_timeout', v_prev, true);
  RETURN v_res;
END;
$$;
ALTER FUNCTION public.intercompany_sync_group_row(text, uuid) OWNER TO migration_admin;
REVOKE ALL ON FUNCTION public.intercompany_sync_group_row(text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.intercompany_sync_group_row(text, uuid) TO app_user, app_service;

-- ── 6. The auto-accept queue ────────────────────────────────────────────────

DROP FUNCTION IF EXISTS public.intercompany_auto_accept_queue(integer);
CREATE OR REPLACE FUNCTION public.intercompany_auto_accept_queue(p_limit integer DEFAULT 50, p_claim boolean DEFAULT true)
RETURNS TABLE (message_id uuid, to_company_id uuid, actor_user_id text, attempt integer)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF p_claim THEN PERFORM pg_catalog.set_config('app.intercompany_system_update', 'claim', true); END IF;
  RETURN QUERY
  WITH eligible AS (
    SELECT m.id AS mid, m.to_company_id AS co, w.user_id AS uid, m.auto_attempts AS att, m.created_at AS cat, m.auto_next_attempt_at AS nxt,
           row_number() OVER (PARTITION BY m.to_company_id ORDER BY COALESCE(m.auto_next_attempt_at, m.created_at), m.created_at, m.id) AS rn
      FROM public.intercompany_messages m
      JOIN public.intercompany_connections c
        ON c.id = m.connection_id AND c.status = 'active' AND c.kind = 'group'
      JOIN public.intercompany_connection_sides s
        ON s.connection_id = m.connection_id AND s.company_id = m.to_company_id AND s.auto_accept
       AND s.auto_accept_since IS NOT NULL AND m.created_at >= s.auto_accept_since
      JOIN public.companies rc
        ON rc.id = m.to_company_id
       AND rc.status IS DISTINCT FROM 'suspended' AND rc.status IS DISTINCT FROM 'deleted' AND rc.suspended_at IS NULL
      CROSS JOIN LATERAL (
        SELECT cu.user_id
          FROM public.company_users cu
          JOIN public.users u ON u.id = cu.user_id
         WHERE cu.company_id = m.to_company_id
           AND cu.role = ANY (ARRAY['owner', 'admin', 'manager'])
           AND u.is_active IS TRUE AND u.status = 'active' AND u.suspended_at IS NULL
         ORDER BY CASE cu.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END, cu.created_at, cu.user_id
         LIMIT 1
      ) w
     WHERE m.status = 'pending' AND m.kind IN ('invoice', 'credit_note') AND NOT m.manual_only
       AND m.auto_attempts < 8 AND (m.auto_next_attempt_at IS NULL OR m.auto_next_attempt_at <= clock_timestamp())
       AND public.intercompany_shared_group(c.company_low_id, c.company_high_id)
  ), picked AS (
    SELECT e.* FROM eligible e WHERE e.rn <= 10
     ORDER BY COALESCE(e.nxt, e.cat), e.cat, e.mid
     LIMIT LEAST(GREATEST(COALESCE(p_limit, 50), 1), 200)
  ), locked AS (
    -- a claim takes a message only if no other claim holds its lock (SKIP LOCKED never waits: it skips a locked row, so two overlapping runs never
    -- attempt the same message twice) and it is still at the attempt this run's pick read (a run that committed between the pick and the lock has
    -- moved it on: once locked, the quals are re-checked against the committed row, so the second run skips it too)
    SELECT m.id AS lid FROM public.intercompany_messages m JOIN picked p ON p.mid = m.id
     WHERE p_claim AND m.status = 'pending' AND m.auto_attempts = p.att
       FOR UPDATE OF m SKIP LOCKED
  ), claimed AS (
    UPDATE public.intercompany_messages m
       SET auto_attempts = m.auto_attempts + 1,
           auto_next_attempt_at = clock_timestamp() + LEAST(power(2, m.auto_attempts)::integer, 60) * interval '1 minute'
      FROM locked l WHERE m.id = l.lid
    RETURNING m.id AS cid
  )
  SELECT p.mid, p.co, p.uid, p.att + CASE WHEN p_claim THEN 1 ELSE 0 END FROM picked p
   WHERE NOT p_claim OR p.mid IN (SELECT l.lid FROM locked l)
   ORDER BY COALESCE(p.nxt, p.cat), p.cat, p.mid;
  IF p_claim THEN PERFORM pg_catalog.set_config('app.intercompany_system_update', '', true); END IF;
END;
$$;
ALTER FUNCTION public.intercompany_auto_accept_queue(integer, boolean) OWNER TO migration_admin;
REVOKE ALL ON FUNCTION public.intercompany_auto_accept_queue(integer, boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.intercompany_auto_accept_queue(integer, boolean) FROM app_user;
GRANT EXECUTE ON FUNCTION public.intercompany_auto_accept_queue(integer, boolean) TO app_service, migration_admin;

-- Gives back the attempt of claimed messages the worker did not start (it stopped at its time budget): the attempt counter goes down by one
-- and the back-off is cleared (the claim had already replaced any earlier back-off with its own), so a message deferred only by the budget is
-- retried by the next run and never exhausted by it. ONLY a message still at the attempt this run's claim gave it (p_attempts, as the queue
-- returned it): a message another run has claimed since is that run's, and is left alone. Pending messages only. app_service only.
DROP FUNCTION IF EXISTS public.intercompany_auto_accept_release(uuid[]);
DROP FUNCTION IF EXISTS public.intercompany_auto_accept_release(uuid[], integer[]);
CREATE OR REPLACE FUNCTION public.intercompany_auto_accept_release(p_messages uuid[], p_attempts integer[])
RETURNS integer
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_n integer;
BEGIN
  PERFORM pg_catalog.set_config('app.intercompany_system_update', 'claim', true);
  UPDATE public.intercompany_messages m SET auto_attempts = GREATEST(m.auto_attempts - 1, 0), auto_next_attempt_at = NULL
    FROM unnest(p_messages, p_attempts) AS c(id, attempt)
   WHERE m.id = c.id AND m.auto_attempts = c.attempt AND m.status = 'pending' AND m.auto_attempts > 0;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  PERFORM pg_catalog.set_config('app.intercompany_system_update', '', true);
  RETURN v_n;
END;
$$;
ALTER FUNCTION public.intercompany_auto_accept_release(uuid[], integer[]) OWNER TO migration_admin;
REVOKE ALL ON FUNCTION public.intercompany_auto_accept_release(uuid[], integer[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.intercompany_auto_accept_release(uuid[], integer[]) FROM app_user;
GRANT EXECUTE ON FUNCTION public.intercompany_auto_accept_release(uuid[], integer[]) TO app_service, migration_admin;

-- The pending messages the queue has given up on (every attempt used, never a restored one, on a connection that is still active: a revoked
-- connection's messages can never be accepted, so they are no alert): they sit pending for a person, and the worker reports them as stuck.
-- Ids only; app_service and migration_admin. (The 8 is the queue's attempt limit above; AUTO_ACCEPT_MAX_ATTEMPTS in inboxRead.ts, held equal by a test.)
DROP FUNCTION IF EXISTS public.intercompany_auto_accept_exhausted();
CREATE OR REPLACE FUNCTION public.intercompany_auto_accept_exhausted()
RETURNS TABLE (message_id uuid)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT m.id FROM public.intercompany_messages m JOIN public.intercompany_connections c ON c.id = m.connection_id AND c.status = 'active'
   WHERE m.status = 'pending' AND m.kind IN ('invoice', 'credit_note') AND NOT m.manual_only AND m.auto_attempts >= 8
$$;
ALTER FUNCTION public.intercompany_auto_accept_exhausted() OWNER TO migration_admin;
REVOKE ALL ON FUNCTION public.intercompany_auto_accept_exhausted() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.intercompany_auto_accept_exhausted() TO app_service, migration_admin;

-- ── 6b. Messages written before the database recorded their journal and group row ──
-- source_journal_entry_id and group_transaction_id are the database's own record (set by intercompany_send_for_source). A message that has none
-- gets them only where the database can PROVE them: the journal is the group row's source journal (written by the send) or the document's own
-- link, and in either case the document's approval posting (intercompany_own_posting_problem: the company's, original, named for this document,
-- no other document's, on no other message); the group row is the payload's reference only when it is the sender's to this receiver for that

-- journal (intercompany_group_row_ok). Anything else stays NULL, and the definers fail closed on NULL. It runs as migration_admin through the
-- guard's own 'backfill' system update (the guard stays on; only these two NULL columns may be set).
DO $$
DECLARE
  r RECORD;
  v_g uuid;
  v_cand uuid;
  v_je uuid;
BEGIN
  SET LOCAL ROLE migration_admin;
  PERFORM pg_catalog.set_config('app.intercompany_system_update', 'backfill', true);
  FOR r IN SELECT m.id, m.kind, m.from_company_id, m.to_company_id, m.source_doc_id, m.payload->>'groupTransactionId' AS gtx
             FROM public.intercompany_messages m
            WHERE m.source_journal_entry_id IS NULL AND m.kind IN ('invoice', 'credit_note')
            ORDER BY m.created_at, m.id
  LOOP
    v_je := NULL;
    v_g := CASE WHEN r.gtx ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN r.gtx::uuid END;
    IF v_g IS NOT NULL THEN
      SELECT it.source_journal_entry_id INTO v_cand FROM public.intercompany_transactions it
       WHERE it.id = v_g AND it.source_company_id = r.from_company_id AND it.target_company_id = r.to_company_id;
      IF v_cand IS NOT NULL AND public.intercompany_own_posting_problem(r.kind, r.source_doc_id, r.from_company_id, v_cand) IS NULL THEN v_je := v_cand; END IF;
    END IF;
    IF v_je IS NULL THEN
      v_cand := CASE r.kind
        WHEN 'invoice' THEN (SELECT ci.gl_journal_entry_id FROM public.customer_invoices ci WHERE ci.id = r.source_doc_id AND ci.company_id = r.from_company_id)
        ELSE (SELECT cn.gl_journal_entry_id FROM public.credit_notes cn WHERE cn.id = r.source_doc_id AND cn.company_id = r.from_company_id AND cn.type = 'customer') END;
      IF v_cand IS NOT NULL AND public.intercompany_own_posting_problem(r.kind, r.source_doc_id, r.from_company_id, v_cand) IS NULL THEN v_je := v_cand; END IF;
    END IF;
    IF v_je IS NOT NULL THEN
      UPDATE public.intercompany_messages SET source_journal_entry_id = v_je WHERE id = r.id;
    END IF;
  END LOOP;
  UPDATE public.intercompany_messages m SET group_transaction_id = (m.payload->>'groupTransactionId')::uuid
   WHERE m.group_transaction_id IS NULL AND m.source_journal_entry_id IS NOT NULL AND m.kind IN ('invoice', 'credit_note') AND m.payload->>'groupTransactionId' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     AND public.intercompany_group_row_ok((m.payload->>'groupTransactionId')::uuid, m.from_company_id, m.to_company_id, m.source_journal_entry_id);
  PERFORM pg_catalog.set_config('app.intercompany_system_update', '', true);
  RESET ROLE;
END $$;

-- ── 7. The definer registry (930) ───────────────────────────────────────────

DELETE FROM public.app_definer_reviews WHERE signature IN ('intercompany_auto_accept_queue(integer)', 'intercompany_mirrored_duplicate(uuid,date,date)', 'intercompany_mirrored_duplicate(uuid)', 'intercompany_mirror_stands(uuid)', 'intercompany_auto_accept_release(uuid[])');
INSERT INTO public.app_definer_reviews (signature, writes, body_md5)
SELECT v.signature, v.writes, public.app_definer_hash(v.fn::regprocedure)
  FROM (VALUES
    ('intercompany_auto_accept_queue(integer,boolean)', 'public.intercompany_auto_accept_queue(integer, boolean)',
     'intercompany_messages.auto_attempts and auto_next_attempt_at only (the claim, through the messages guard system path, when p_claim); otherwise a read of intercompany_messages, intercompany_connections, intercompany_connection_sides, companies, company_users, users: the pending invoice / credit-note messages whose receiver side switched auto_accept on before they were created, on an active group connection that still shares a current active group, never a restored one, at most 10 per receiver, with the receiver company and one write-role user in good standing; executable by app_service and migration_admin only'),
    ('intercompany_withdraw_for_source(text,uuid)', 'public.intercompany_withdraw_for_source(text, uuid)',
     'intercompany_messages.status = ''withdrawn'' (a message not yet handled) and source_cancelled_at (also an accepted one), through the messages guard system path, for the messages the session company (a write-role user) sent for a customer invoice / credit note that is cancelled in its books AND whose recorded sent-with journal has had its reversal chain taken out (a message with no recorded journal is left alone); and the group row the database recorded for each (checked to be the sender''s to that receiver for that journal): intercompany_transactions back to unmatched, target journal cleared (a display state: no elimination is stored or reversed); nothing for any other company or an uncancelled document'),
    ('intercompany_sync_group_row(text,uuid)', 'public.intercompany_sync_group_row(text, uuid)',
     'intercompany_transactions.match_status, variance_amount, variance_reason, matched_at, matched_by, target_journal_entry_id and first_target_journal_entry_id of the one group row behind an accepted message to the session company (a write-role user) whose target is the given supplier invoice / supplier credit note of that company: matched only on the receiver''s posted, standing, own journal that is no other document''s posting and nets to the sender''s amount, variance with a reason otherwise, unmatched while the document is not approved or the sender''s document is cancelled; display columns only: no consolidation_adjustments row is written, and no figure is read from these columns'),
    ('intercompany_send_for_source(text,uuid)', 'public.intercompany_send_for_source(text, uuid)',
     'intercompany_messages (one invoice / credit_note message, its payload built from the session company''s approved customer invoice or customer credit note with a posted, standing approval journal, and recording that journal and the group row) and intercompany_transactions (the sender''s one ''sale'' group row, for a group connection, ZAR) for the session company (a write-role user) and a document of that company whose customer is the partner on an active connection past its cut-over; nothing for any other company or an unapproved document'),
    ('intercompany_auto_accept_exhausted()', 'public.intercompany_auto_accept_exhausted()',
     'nothing: a count of pending invoice / credit-note messages whose every auto-accept attempt is used; executable by app_service and migration_admin only'),
    ('intercompany_mirrored_duplicate(uuid,date)', 'public.intercompany_mirrored_duplicate(uuid, date)',
     'nothing: for a manual sale-class group row of a group the caller is a current member of, the mirrored sale(s) it may duplicate (the same group, the sale running the way the row''s elimination does, the single mirrors whose subtotal or total is the row''s amount near its date, closest first, or the sum of that month''s mirrors, a cancelled one counted while the period still carries it by its reversal chain): a plain match, no ledger walk but that chain for a cancelled sum member; a flag for the elimination generator, the eliminations list and posting, never a skip'),
    ('intercompany_mirror_facts(uuid,date)', 'public.intercompany_mirror_facts(uuid, date)',
     'nothing: for a manual sale-class group row of a group the caller is a current member of (through intercompany_mirrored_duplicate), the facts of the mirror(s) the duplicate wording names for a period: each one''s description, the amount it accounts for, whether it is eliminated automatically for that period (intercompany_mirror_stands) and whether an active link of this row, of another row of the same role or of a row of the other role holds it (a read of intercompany_mirror_links), whether it matched by its total with VAT, and the date its elimination falls on; the one source of the generator note, the list badge, the 409 and the confirm'),
    ('intercompany_mirror_stands(uuid,date)', 'public.intercompany_mirror_stands(uuid, date)',
     'nothing: for a mirrored row of a group the caller is a current member of, whether it is eliminated automatically for a period: its pair stands as at the later of its two document dates and as at the later of that and the period end (or today), and its revenue and expense lines are mapped to group accounts'),
    ('intercompany_mirror_link(uuid,date)', 'public.intercompany_mirror_link(uuid, date)',
     'intercompany_mirror_links (one active link per manual row and per mirror and role; a link released when its mirror no longer eliminates the row for the period, the row''s other candidates then tried): for a manual sale-class row on or after its pair''s cutover in a group the caller writes in, the stored answer whether a mirrored document eliminates it. Callable by any writer of the group (the generator calls it per row); it takes the generator''s per-group advisory lock and holds the date to [the row''s date, today], so a direct call can do nothing a generator run would not'),
    ('intercompany_auto_accept_release(uuid[],integer[])', 'public.intercompany_auto_accept_release(uuid[], integer[])',
     'intercompany_messages.auto_attempts / auto_next_attempt_at of PENDING messages the worker claimed but did not start (its time budget), still at the attempt its claim gave them: one attempt given back, the back-off cleared; app_service only'),
    ('intercompany_pair_cutovers(uuid)', 'public.intercompany_pair_cutovers(uuid)',
     'nothing: for a group the caller is a current member of that is the group a pair''s mirrors go to (the oldest active common group), each mirroring pair of its current members (an active group connection with a cut-over date and both sides'' mirroring on) and the pair''s cutover date (RULING 2026-11-21)'),
    ('intercompany_journal_claimed(uuid)', 'public.intercompany_journal_claimed(uuid)',
     'nothing: whether a journal of a company in a group the caller is a current member of (false for any other journal) is already the target or first match of an intercompany row, or the journal of a document an accepted mirror message created (a boolean, for the intercompany_transactions INSERT trigger of a writer who may not read those rows)'),
    ('intercompany_is_mirrored_row(uuid)', 'public.intercompany_is_mirrored_row(uuid)',
     'nothing: whether a group row is the one a message records (a read of intercompany_messages for a trigger of a writer who is no party of the message)'),
    ('intercompany_mirror_eliminations(uuid,date,date)', 'public.intercompany_mirror_eliminations(uuid, date, date)',
     'nothing: a read of the mirrored group rows of a group the caller is a member of (both companies current members), their journals'' dated reversal chains and the receiver''s documents, giving the elimination and counter-elimination lines dated in a period (derived from the ledgers as they stood on each event date, never stored)'),
    ('intercompany_mirror_unresolved(uuid,date,date)', 'public.intercompany_mirror_unresolved(uuid, date, date)',
     'nothing: for a group the caller is a member of, the mirrored group rows dated in a period (both companies current members) whose sender journal still stands as at the period end and whose message the receiver accepted and acted on (approved or cancelled its document) while the pair stands neither at the period end nor as of all links, or the receiver rejected, dismissed or failed to accept,, with the reason and a reason code (a read of intercompany_transactions, intercompany_messages, the receiver''s document status and the journals'' reversal chains); informational: the reports and the Eliminations page say these have no elimination from any path'),
    ('intercompany_message_source_out(uuid)', 'public.intercompany_message_source_out(uuid)',
     'nothing: a read of the sender''s approved document through the payload builder and of the sent-with journal''s reversal chain, for the receiver of that message only'),
    ('intercompany_journal_chain_changed(uuid)', 'public.intercompany_journal_chain_changed(uuid)',
     'intercompany_messages.status / source_cancelled_at (withdrawn or stamped when a journal the session company sent a message for is reversed, revived when it is live again, through the messages guard system path) and intercompany_transactions display columns (released: unmatched, target journal cleared; or matched again on the journal first matched to) for rows the session company (a write-role user) sent or received against that journal; no consolidation_adjustments row is written; nothing for any other company'),
    ('intercompany_message_source_changed(uuid)', 'public.intercompany_message_source_changed(uuid)',
     'nothing: a read of the sender''s approved document through the payload builder, compared with the stored payload, for the receiver of that message only')
  ) AS v(signature, fn, writes)
ON CONFLICT (signature) DO UPDATE SET writes = EXCLUDED.writes, body_md5 = EXCLUDED.body_md5;

DO $$
BEGIN
  IF pg_catalog.has_function_privilege('public', 'public.intercompany_auto_accept_queue(integer, boolean)', 'EXECUTE')
     OR pg_catalog.has_function_privilege('app_user', 'public.intercompany_auto_accept_queue(integer, boolean)', 'EXECUTE')
     OR pg_catalog.has_function_privilege('public', 'public.intercompany_withdraw_for_source(text, uuid)', 'EXECUTE')
     OR pg_catalog.has_function_privilege('public', 'public.intercompany_sync_group_row(text, uuid)', 'EXECUTE')
     OR pg_catalog.has_function_privilege('public', 'public.intercompany_send_for_source(text, uuid)', 'EXECUTE')
     OR pg_catalog.has_function_privilege('public', 'public.intercompany_message_source_changed(uuid)', 'EXECUTE')
     OR pg_catalog.has_function_privilege('public', 'public.intercompany_message_source_out(uuid)', 'EXECUTE')
     OR pg_catalog.has_function_privilege('app_user', 'public.intercompany_receiver_je(uuid, date, date[], date[])', 'EXECUTE')
     OR pg_catalog.has_function_privilege('app_user', 'public.intercompany_receiver_journal_problem(uuid, uuid, text, uuid, uuid, date, date[])', 'EXECUTE')
     OR pg_catalog.has_function_privilege('app_user', 'public.intercompany_build_payload(text, uuid, uuid)', 'EXECUTE')
     OR pg_catalog.has_function_privilege('app_service', 'public.intercompany_build_payload(text, uuid, uuid)', 'EXECUTE')
     OR pg_catalog.has_function_privilege('app_user', 'public.intercompany_auto_accept_exhausted()', 'EXECUTE')
     OR pg_catalog.has_function_privilege('public', 'public.intercompany_auto_accept_exhausted()', 'EXECUTE')
     OR pg_catalog.has_function_privilege('public', 'public.intercompany_is_mirrored_row(uuid)', 'EXECUTE')
     OR pg_catalog.has_function_privilege('public', 'public.intercompany_journal_claimed(uuid)', 'EXECUTE')
     OR pg_catalog.has_function_privilege('public', 'public.intercompany_mirrored_duplicate(uuid, date)', 'EXECUTE')
     OR pg_catalog.has_function_privilege('public', 'public.intercompany_mirror_facts(uuid, date)', 'EXECUTE')
     OR pg_catalog.has_function_privilege('public', 'public.intercompany_mirror_stands(uuid, date)', 'EXECUTE')
     OR pg_catalog.has_function_privilege('public', 'public.intercompany_mirror_link(uuid, date)', 'EXECUTE')
     OR pg_catalog.has_function_privilege('public', 'public.intercompany_pair_cutovers(uuid)', 'EXECUTE')
     OR pg_catalog.has_function_privilege('public', 'public.intercompany_auto_accept_release(uuid[], integer[])', 'EXECUTE')
     OR pg_catalog.has_function_privilege('app_user', 'public.intercompany_journal_bound_elsewhere(uuid, uuid)', 'EXECUTE')
     OR pg_catalog.has_function_privilege('public', 'public.intercompany_mirror_eliminations(uuid, date, date)', 'EXECUTE')
     OR pg_catalog.has_function_privilege('public', 'public.intercompany_mirror_unresolved(uuid, date, date)', 'EXECUTE')
     OR pg_catalog.has_function_privilege('app_user', 'public.intercompany_receiver_journal_value_problem(text, uuid, numeric, numeric, numeric)', 'EXECUTE')
     OR pg_catalog.has_function_privilege('app_user', 'public.intercompany_fiscal_year(uuid, date)', 'EXECUTE')
     OR pg_catalog.has_function_privilege('public', 'public.intercompany_journal_chain_changed(uuid)', 'EXECUTE')
     OR pg_catalog.has_function_privilege('app_user', 'public.intercompany_sync_core(uuid, text, uuid, uuid)', 'EXECUTE')
     OR pg_catalog.has_function_privilege('app_user', 'public.intercompany_lines_negate(uuid, uuid)', 'EXECUTE')
     OR pg_catalog.has_function_privilege('app_user', 'public.intercompany_document_live(text, uuid, uuid, uuid)', 'EXECUTE')
     OR pg_catalog.has_function_privilege('app_user', 'public.intercompany_withdraw_message(uuid)', 'EXECUTE')
     OR pg_catalog.has_function_privilege('app_user', 'public.intercompany_revive_message(uuid)', 'EXECUTE')
     OR pg_catalog.has_function_privilege('app_user', 'public.intercompany_sender_journal_value_problem(text, uuid, uuid, numeric, numeric)', 'EXECUTE')
     OR pg_catalog.has_function_privilege('app_user', 'public.intercompany_group_row_ok(uuid, uuid, uuid, uuid)', 'EXECUTE')
     OR pg_catalog.has_function_privilege('app_user', 'public.intercompany_own_posting_problem(text, uuid, uuid, uuid)', 'EXECUTE')
     OR pg_catalog.has_function_privilege('app_user', 'public.intercompany_release_group_row(uuid)', 'EXECUTE')
     OR pg_catalog.has_function_privilege('app_user', 'public.intercompany_journal_chain_length(uuid, uuid, date, date[])', 'EXECUTE')
     OR pg_catalog.has_function_privilege('app_user', 'public.intercompany_journal_chain_eff(uuid, uuid)', 'EXECUTE')
     OR pg_catalog.has_function_privilege('app_user', 'public.intercompany_mirror_pair_at(uuid, date, date[], date[], date[])', 'EXECUTE') THEN
    RAISE EXCEPTION '1019: a role it must not reach can execute an intercompany P2 definer function';
  END IF;
END $$;
