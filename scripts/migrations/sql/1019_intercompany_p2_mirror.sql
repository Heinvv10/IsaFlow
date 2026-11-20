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
--      period being the sum of the events dated in it, so at any moment a range is the sum of its months. Past periods change only if a receiver
--      document's journal link is re-pointed (1018 refuses that swap to non-superusers). No hook, lock or repair stands between a ledger and a figure.

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
--     public.intercompany_journal_chain_changed(uuid), public.intercompany_mirror_eliminations(uuid, date, date), public.intercompany_is_mirrored_row(uuid),
--     public.intercompany_auto_accept_exhausted();

--   DROP FUNCTION IF EXISTS public.intercompany_sync_core(uuid, text, uuid, uuid), public.intercompany_withdraw_message(uuid), public.intercompany_revive_message(uuid),
--     public.intercompany_release_group_row(uuid), public.intercompany_build_payload(text, uuid, uuid), public.intercompany_clean_text(text, integer),
--     public.intercompany_journal_chain_length(uuid, uuid, date), public.intercompany_lines_negate(uuid, uuid), public.intercompany_document_live(text, uuid, uuid, uuid),
--     public.intercompany_group_row_ok(uuid, uuid, uuid, uuid), public.intercompany_own_posting_problem(text, uuid, uuid, uuid),
--     public.intercompany_sender_journal_value_problem(text, uuid, uuid, numeric, numeric), public.intercompany_fiscal_year(uuid, date), public.intercompany_receiver_je(uuid, date), public.intercompany_receiver_journal_problem(uuid, uuid, text, uuid, uuid, date),
--     public.intercompany_message_source_out(uuid), public.intercompany_receiver_journal_value_problem(text, uuid, numeric, numeric, numeric),
--     public.intercompany_journal_chain_dates(uuid, uuid), public.intercompany_mirror_pair_at(uuid, date), public.intercompany_journal_bound_elsewhere(uuid, uuid),
--     public.intercompany_journal_claimed(uuid), public.intercompany_mirrored_duplicate(uuid);

--   DROP TRIGGER IF EXISTS trg_intercompany_sides_auto_since ON intercompany_connection_sides; DROP FUNCTION IF EXISTS public.intercompany_sides_auto_since();
--   (the 1002 body of intercompany_messages_guard and the 999r body of intercompany_transaction_parties_immutable / recorded_fresh return by re-applying them)

--   ALTER TABLE intercompany_messages DROP COLUMN IF EXISTS source_cancelled_at, DROP COLUMN IF EXISTS manual_only, DROP COLUMN IF EXISTS auto_attempts,
--     DROP COLUMN IF EXISTS auto_next_attempt_at, DROP COLUMN IF EXISTS source_journal_entry_id, DROP COLUMN IF EXISTS group_transaction_id;
--   ALTER TABLE intercompany_transactions DROP COLUMN IF EXISTS variance_reason, DROP COLUMN IF EXISTS first_target_journal_entry_id;
--   ALTER TABLE intercompany_connection_sides DROP COLUMN IF EXISTS auto_accept_since;
--   DROP INDEX IF EXISTS uq_consolidation_adjustments_standing_source;
--   DROP INDEX IF EXISTS idx_ic_transactions_target_journal;
--   (the indexes idx_ic_messages_group_transaction, idx_ic_messages_source_journal, uq_ic_transactions_first_journal drop with their columns)

--   DELETE FROM app_definer_reviews WHERE signature LIKE 'intercompany\_%' AND signature IN ('intercompany_auto_accept_queue(integer,boolean)',
--     'intercompany_withdraw_for_source(text,uuid)', 'intercompany_sync_group_row(text,uuid)', 'intercompany_send_for_source(text,uuid)',
--     'intercompany_message_source_changed(uuid)', 'intercompany_auto_accept_exhausted()', 'intercompany_is_mirrored_row(uuid)',
--     'intercompany_mirror_eliminations(uuid,date,date)', 'intercompany_journal_chain_changed(uuid)', 'intercompany_journal_claimed(uuid)', 'intercompany_mirrored_duplicate(uuid)');

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

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
-- other's uncommitted match; the loser's UPDATE waits on this index and is mapped to a variance, intercompany_sync_core). The column is new
-- in this migration, so no existing row can collide.
DROP INDEX IF EXISTS public.idx_ic_transactions_first_journal;
CREATE UNIQUE INDEX IF NOT EXISTS uq_ic_transactions_first_journal ON intercompany_transactions (first_target_journal_entry_id) WHERE first_target_journal_entry_id IS NOT NULL;
-- The exclusivity checks look rows up by their target journal too (every pair, every chain date): without this they scan every tenant's rows.
CREATE INDEX IF NOT EXISTS idx_ic_transactions_target_journal ON intercompany_transactions (target_journal_entry_id) WHERE target_journal_entry_id IS NOT NULL;
ALTER TABLE intercompany_connection_sides ADD COLUMN IF NOT EXISTS auto_accept_since TIMESTAMPTZ;

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
UPDATE intercompany_connection_sides SET auto_accept_since = updated_at WHERE auto_accept AND auto_accept_since IS NULL;

-- auto_accept_since is the moment auto-accept was switched ON; the worker takes only messages created after it, so switching it on
-- never drains a backlog. Set by the database, whatever was sent (no app role has a column grant on it).
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

-- The number of POSTED journals in the reversal chain that starts at p_je (the journal, its reversal, the reversal's reversal, ...), 0 when
-- p_je is not a posted journal of p_company. A link counts only if it is posted, of the same company AND the exact negation of the journal it
-- reverses (a forged, empty or re-pointed link ends the chain). With p_asat, only journals DATED on or before it count (the ledger as it stood
-- at the end of a period: a reversal booked later does not change an earlier period). ODD = the ledger carries the document, EVEN = it is out.
DROP FUNCTION IF EXISTS public.intercompany_journal_chain_length(uuid, uuid, date);
CREATE OR REPLACE FUNCTION public.intercompany_journal_chain_length(p_je uuid, p_company uuid, p_asat date DEFAULT NULL)
RETURNS integer
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog, public, pg_temp
AS $$
  WITH RECURSIVE chain(id) AS (
    SELECT je.id FROM public.gl_journal_entries je
     WHERE je.id = p_je AND je.company_id = p_company AND je.status = 'posted' AND (p_asat IS NULL OR je.entry_date <= p_asat)
    UNION
    SELECT r.id FROM public.gl_journal_entries r JOIN chain ON r.reversal_of_id = chain.id
     WHERE r.company_id = p_company AND r.status = 'posted' AND (p_asat IS NULL OR r.entry_date <= p_asat) AND public.intercompany_lines_negate(r.id, chain.id)
  )
  SELECT count(*)::integer FROM chain
$$;
REVOKE ALL ON FUNCTION public.intercompany_journal_chain_length(uuid, uuid, date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.intercompany_journal_chain_length(uuid, uuid, date) TO migration_admin;

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
       AND it.source_journal_entry_id IS NOT DISTINCT FROM p_je
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
-- document's link to its journal is a column a writer can point anywhere, and the journal's text is a writer's too: hence each check.
-- SECURITY INVOKER, migration_admin only.
CREATE OR REPLACE FUNCTION public.intercompany_receiver_journal_problem(p_row uuid, p_co uuid, p_doc_type text, p_doc_id uuid, p_je uuid, p_asat date)
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
  ELSIF public.intercompany_journal_chain_length(p_je, p_co, p_asat) % 2 = 0 THEN
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
REVOKE ALL ON FUNCTION public.intercompany_receiver_journal_problem(uuid, uuid, text, uuid, uuid, date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.intercompany_receiver_journal_problem(uuid, uuid, text, uuid, uuid, date) TO migration_admin;

-- The receiver's journal for a mirrored group row AS AT p_asat, from the ledgers and the documents, or NULL. No hook is needed: the journal the
-- row was first matched to, while it still stands in the same financial year with the sender's figures and no other row holds it
-- (a bound row is moved by nothing the bill's columns say), else the journal the accepted message's bill / credit note links to, when it passes every structural and value check above.
-- SECURITY INVOKER, migration_admin only.
CREATE OR REPLACE FUNCTION public.intercompany_receiver_je(p_row uuid, p_asat date)
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
    FROM public.intercompany_messages x WHERE x.group_transaction_id = p_row AND x.kind IN ('invoice', 'credit_note') LIMIT 1;
  IF NOT FOUND OR m.did IS NULL THEN RETURN NULL; END IF;
  SELECT it.amount, it.transaction_date AS td, it.first_target_journal_entry_id AS first_je INTO t FROM public.intercompany_transactions it WHERE it.id = p_row;
  IF t.first_je IS NOT NULL
     AND public.intercompany_journal_chain_length(t.first_je, m.co, p_asat) % 2 = 1
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
  IF public.intercompany_receiver_journal_problem(p_row, m.co, m.dtype, m.did, v_je, p_asat) IS NULL
     AND public.intercompany_receiver_journal_value_problem(m.kind, v_je, t.amount, m.tax, m.total) IS NULL THEN
    RETURN v_je;
  END IF;
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION public.intercompany_receiver_je(uuid, date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.intercompany_receiver_je(uuid, date) TO migration_admin;

-- The dates on which p_je's reversal chain can change (its journal and every value-negating posted link below it, of p_company), whatever
-- the date: the only dates on which a pair resting on that chain can start or stop standing. SECURITY INVOKER, migration_admin only.
CREATE OR REPLACE FUNCTION public.intercompany_journal_chain_dates(p_je uuid, p_company uuid)
RETURNS SETOF date
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog, public, pg_temp
AS $$
  WITH RECURSIVE chain(id, d) AS (
    SELECT je.id, je.entry_date FROM public.gl_journal_entries je WHERE je.id = p_je AND je.company_id = p_company AND je.status = 'posted'
    UNION
    SELECT r.id, r.entry_date FROM public.gl_journal_entries r JOIN chain ON r.reversal_of_id = chain.id
     WHERE r.company_id = p_company AND r.status = 'posted' AND public.intercompany_lines_negate(r.id, chain.id)
  )
  SELECT chain.d FROM chain
$$;
REVOKE ALL ON FUNCTION public.intercompany_journal_chain_dates(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.intercompany_journal_chain_dates(uuid, uuid) TO migration_admin;

-- The receiver's journal of a mirrored row when the PAIR stands as at p_asat, or NULL: the sender's journal stands (an odd chain counting only
-- links dated on or before p_asat) and carries the document's figures by value, and the receiver's journal is intercompany_receiver_je's as at
-- p_asat. SECURITY INVOKER, migration_admin only.
CREATE OR REPLACE FUNCTION public.intercompany_mirror_pair_at(p_row uuid, p_asat date)
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT public.intercompany_receiver_je(m.group_transaction_id, p_asat)
    FROM public.intercompany_messages m
   WHERE m.group_transaction_id = p_row AND m.kind IN ('invoice', 'credit_note') AND m.source_journal_entry_id IS NOT NULL
     AND public.intercompany_journal_chain_length(m.source_journal_entry_id, m.from_company_id, p_asat) % 2 = 1
     AND public.intercompany_sender_journal_value_problem(m.kind, m.source_journal_entry_id, m.from_company_id,
           (m.payload->>'subtotal')::numeric, (m.payload->>'total')::numeric) IS NULL
   LIMIT 1
$$;
REVOKE ALL ON FUNCTION public.intercompany_mirror_pair_at(uuid, date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.intercompany_mirror_pair_at(uuid, date) TO migration_admin;

-- THE ELIMINATIONS OF THE MIRRORED DOCUMENTS, DERIVED AT READ TIME and never stored, as dated EVENTS. For a group the caller is a member of,
-- and a mirrored row whose two companies are both CURRENT members of it (the reports' member set): the pair STANDS on a date d when, with the
-- ledgers as they stood at d (reversal chains counting only value-negating links dated on or before d), the sender's journal stands and carries
-- the document's figures and the receiver has a standing journal for it (intercompany_receiver_je: the same financial year in the receiver's
-- calendar as the sender's date, the figures by value, no other row's or document's). The elimination is +E on the date the pair starts
-- standing on a receiver journal, and the counter-elimination -E on the date it stops (a value-negating link on either side, or the receiver's
-- journal replaced by another); standing again is a new +E. Those dates are the chains' own journal dates, so the first +E is dated the later
-- of the sender's and the receiver's journal dates. A period p_start..p_end is the sum of the events dated in it (each judged with only the
-- links dated on or before it), so AT ANY MOMENT any range is the sum of its months line by line. A booking, a reversal or a re-reversal in a
-- later period does not change an earlier one. A PAST period does change when a receiver document's journal link is RE-POINTED: the receiver
-- journals read are the row's first match and the document's CURRENT journal, so a journal it was linked to in between is forgotten (no dated
-- history of links is kept). 1018 refuses a swap of a document's journal link to every non-superuser session. The state only changes on a
-- chain date, so a row is judged on its chain dates inside the period and once just before p_start; a row with no chain date in the period
-- is not judged at all.
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
       AND m.source_journal_entry_id IS NOT NULL AND m.target_doc_id IS NOT NULL
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
    SELECT up.id FROM up WHERE up.parent IS NULL
  ), touched AS (
    -- the rows with a chain date in the period: one of their three journals is one of those
    SELECT r.id FROM rws r JOIN pj ON pj.id = r.sje
    UNION SELECT r.id FROM rws r JOIN pj ON pj.id = r.fje
    UNION SELECT r.id FROM rws r JOIN pj ON pj.id = r.dje
  ), t AS MATERIALIZED (
    SELECT r.* FROM rws r JOIN touched ON touched.id = r.id
  ), ok AS (
    SELECT t.* FROM t WHERE public.intercompany_group_row_ok(t.id, t.fc, t.toc, t.sje)
  ), cand AS (
    -- the dates on or before p_end on which a touched row's pair can start or stop standing (its chains' own journal dates)
    SELECT DISTINCT r.id, x.d FROM ok r
      CROSS JOIN LATERAL (SELECT public.intercompany_journal_chain_dates(r.sje, r.sc) AS d
                          UNION SELECT public.intercompany_journal_chain_dates(r.fje, r.tc)
                          UNION SELECT public.intercompany_journal_chain_dates(r.dje, r.tc)) x
     WHERE x.d <= p_end
  ), live AS (
    -- only a row with a chain date in the period can have an event in it. It is judged on those dates, and once just before p_start (only when
    -- it has a date before p_start: otherwise nothing stood), never on its earlier dates: the state is constant between chain dates.
    SELECT c.id, bool_or(c.d < p_start) AS earlier FROM cand c GROUP BY c.id HAVING bool_or(c.d >= p_start)
  ), seq AS (
    SELECT s.id, s.d, s.rje, lag(s.rje) OVER (PARTITION BY s.id ORDER BY s.d) AS prev
      FROM (SELECT c.id, c.d, public.intercompany_mirror_pair_at(c.id, c.d) AS rje FROM cand c WHERE c.d >= p_start AND c.id IN (SELECT live.id FROM live)
            UNION ALL
            SELECT l.id, p_start - 1, public.intercompany_mirror_pair_at(l.id, p_start - 1) FROM live l WHERE l.earlier) s
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
SET lock_timeout = '2s'
AS $$
DECLARE
  v_co uuid := app.current_company_id();
  m RECORD;
  n integer := 0;
  v_chain integer;
BEGIN
  IF v_co IS NULL OR NOT public.intercompany_user_can_write(v_co) THEN RETURN 0; END IF;
  IF p_source_type = 'customer_invoice' THEN
    IF NOT EXISTS (SELECT 1 FROM public.customer_invoices WHERE id = p_source_id AND company_id = v_co AND status = 'cancelled' AND gl_journal_entry_id IS NULL) THEN RETURN 0; END IF;
  ELSIF p_source_type = 'credit_note' THEN
    IF NOT EXISTS (SELECT 1 FROM public.credit_notes WHERE id = p_source_id AND company_id = v_co AND type = 'customer' AND status = 'cancelled') THEN RETURN 0; END IF;
  ELSE
    RETURN 0;
  END IF;
  FOR m IN SELECT x.id, x.source_journal_entry_id AS je FROM public.intercompany_messages x
            WHERE x.from_company_id = v_co AND x.source_doc_type = p_source_type AND x.source_doc_id = p_source_id AND x.kind IN ('invoice', 'credit_note')
  LOOP
    v_chain := CASE WHEN m.je IS NULL THEN 0 ELSE public.intercompany_journal_chain_length(m.je, v_co) END;
    IF v_chain > 0 AND v_chain % 2 = 0 AND public.intercompany_withdraw_message(m.id) THEN n := n + 1; END IF;
  END LOOP;
  RETURN n;
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
SET lock_timeout = '2s'
AS $$
DECLARE
  v_co uuid := app.current_company_id();
  v_root uuid;
  v_len integer;
  r RECORD;
  n integer := 0;
BEGIN
  IF v_co IS NULL OR p_je IS NULL OR NOT public.intercompany_user_can_write(v_co) THEN RETURN 0; END IF;
  -- the original of the chain p_je is in (a reversal's reversal belongs to the chain of the journal it undoes)
  WITH RECURSIVE up(id, parent) AS (
    SELECT je.id, je.reversal_of_id FROM public.gl_journal_entries je WHERE je.id = p_je AND je.company_id = v_co
    UNION
    SELECT g.id, g.reversal_of_id FROM public.gl_journal_entries g JOIN up ON g.id = up.parent WHERE g.company_id = v_co)
  SELECT up.id INTO v_root FROM up WHERE up.parent IS NULL LIMIT 1;
  IF v_root IS NULL THEN RETURN 0; END IF;
  v_len := public.intercompany_journal_chain_length(v_root, v_co);
  IF v_len = 0 THEN RETURN 0; END IF;
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
  RETURN n;
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

-- Why a MANUAL (non-mirrored) group row is the same sale as a mirrored document, or NULL: its source or target journal is a mirrored message's
-- sent-with journal, a mirrored row's bound journal or the journal of a document an accepted mirror message created; or a mirrored row of the
-- same group joins the same two companies (either way round) for the same amount on the same date. The mirrored document's elimination is
-- derived, so the generator must not store a second one for that row. A definer (the caller may not read the messages); it answers only for a
-- row of a group the caller is a current member of, NULL otherwise.
CREATE OR REPLACE FUNCTION public.intercompany_mirrored_duplicate(p_row uuid)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT CASE
    WHEN EXISTS (SELECT 1 FROM unnest(ARRAY[r.source_journal_entry_id, r.target_journal_entry_id]) j(je) WHERE j.je IS NOT NULL AND (
                   EXISTS (SELECT 1 FROM public.intercompany_messages x WHERE x.source_journal_entry_id = j.je AND x.kind IN ('invoice', 'credit_note'))
                OR EXISTS (SELECT 1 FROM public.intercompany_transactions o JOIN public.intercompany_messages x ON x.group_transaction_id = o.id
                            WHERE o.first_target_journal_entry_id = j.je OR o.target_journal_entry_id = j.je)
                OR EXISTS (SELECT 1 FROM public.supplier_invoices si JOIN public.intercompany_messages x
                             ON x.target_doc_type = 'supplier_invoice' AND x.target_doc_id = si.id AND x.status = 'accepted' WHERE si.gl_journal_entry_id = j.je)
                OR EXISTS (SELECT 1 FROM public.credit_notes cn JOIN public.intercompany_messages x
                             ON x.target_doc_type = 'credit_note' AND x.target_doc_id = cn.id AND x.status = 'accepted' WHERE cn.gl_journal_entry_id = j.je)))
      THEN 'its journal is a mirrored document''s'
    WHEN EXISTS (SELECT 1 FROM public.intercompany_transactions o JOIN public.intercompany_messages x ON x.group_transaction_id = o.id
                  WHERE o.group_id = r.group_id AND o.id <> r.id AND o.transaction_date = r.transaction_date AND abs(o.amount) = abs(r.amount)
                    AND ((o.source_company_id = r.source_company_id AND o.target_company_id = r.target_company_id)
                      OR (o.source_company_id = r.target_company_id AND o.target_company_id = r.source_company_id)))
      THEN 'a mirrored document of the same two companies, amount and date'
  END
  FROM public.intercompany_transactions r
  WHERE r.id = p_row AND r.group_id IN (SELECT public.rls_user_group_ids()) AND NOT public.intercompany_is_mirrored_row(r.id)
$$;
ALTER FUNCTION public.intercompany_mirrored_duplicate(uuid) OWNER TO migration_admin;
REVOKE ALL ON FUNCTION public.intercompany_mirrored_duplicate(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.intercompany_mirrored_duplicate(uuid) TO app_user, app_service, migration_admin;

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
SET lock_timeout = '2s'
AS $$
DECLARE
  v_co uuid := app.current_company_id();
BEGIN
  IF v_co IS NULL OR NOT public.intercompany_user_can_write(v_co) THEN RETURN NULL; END IF;
  RETURN public.intercompany_sync_core(v_co, p_doc_type, p_doc_id, auth.uid()::uuid);
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
  ), claimed AS (
    UPDATE public.intercompany_messages m
       SET auto_attempts = m.auto_attempts + 1,
           auto_next_attempt_at = clock_timestamp() + LEAST(power(2, m.auto_attempts)::integer, 60) * interval '1 minute'
      FROM picked p WHERE p_claim AND m.id = p.mid
    RETURNING m.id AS cid
  )
  SELECT p.mid, p.co, p.uid, p.att + CASE WHEN p_claim THEN 1 ELSE 0 END FROM picked p
   ORDER BY COALESCE(p.nxt, p.cat), p.cat, p.mid;
  IF p_claim THEN PERFORM pg_catalog.set_config('app.intercompany_system_update', '', true); END IF;
END;
$$;
ALTER FUNCTION public.intercompany_auto_accept_queue(integer, boolean) OWNER TO migration_admin;
REVOKE ALL ON FUNCTION public.intercompany_auto_accept_queue(integer, boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.intercompany_auto_accept_queue(integer, boolean) FROM app_user;
GRANT EXECUTE ON FUNCTION public.intercompany_auto_accept_queue(integer, boolean) TO app_service, migration_admin;

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
   WHERE m.group_transaction_id IS NULL AND m.kind IN ('invoice', 'credit_note') AND m.payload->>'groupTransactionId' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     AND public.intercompany_group_row_ok((m.payload->>'groupTransactionId')::uuid, m.from_company_id, m.to_company_id, m.source_journal_entry_id);
  PERFORM pg_catalog.set_config('app.intercompany_system_update', '', true);
  RESET ROLE;
END $$;

-- ── 7. The definer registry (930) ───────────────────────────────────────────

DELETE FROM public.app_definer_reviews WHERE signature = 'intercompany_auto_accept_queue(integer)';
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
    ('intercompany_mirrored_duplicate(uuid)', 'public.intercompany_mirrored_duplicate(uuid)',
     'nothing: why a manual group row of a group the caller is a current member of is the same sale as a mirrored document (its journal is a mirrored document''s, or a mirrored row of the same pair, amount and date), for the elimination generator to skip it; NULL otherwise'),
    ('intercompany_journal_claimed(uuid)', 'public.intercompany_journal_claimed(uuid)',
     'nothing: whether a journal of a company in a group the caller is a current member of (false for any other journal) is already the target or first match of an intercompany row, or the journal of a document an accepted mirror message created (a boolean, for the intercompany_transactions INSERT trigger of a writer who may not read those rows)'),
    ('intercompany_is_mirrored_row(uuid)', 'public.intercompany_is_mirrored_row(uuid)',
     'nothing: whether a group row is the one a message records (a read of intercompany_messages for a trigger of a writer who is no party of the message)'),
    ('intercompany_mirror_eliminations(uuid,date,date)', 'public.intercompany_mirror_eliminations(uuid, date, date)',
     'nothing: a read of the mirrored group rows of a group the caller is a member of (both companies current members), their journals'' dated reversal chains and the receiver''s documents, giving the elimination and counter-elimination lines dated in a period (derived from the ledgers as they stood on each event date, never stored)'),
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
     OR pg_catalog.has_function_privilege('app_user', 'public.intercompany_receiver_je(uuid, date)', 'EXECUTE')
     OR pg_catalog.has_function_privilege('app_user', 'public.intercompany_receiver_journal_problem(uuid, uuid, text, uuid, uuid, date)', 'EXECUTE')
     OR pg_catalog.has_function_privilege('app_user', 'public.intercompany_build_payload(text, uuid, uuid)', 'EXECUTE')
     OR pg_catalog.has_function_privilege('app_service', 'public.intercompany_build_payload(text, uuid, uuid)', 'EXECUTE')
     OR pg_catalog.has_function_privilege('app_user', 'public.intercompany_auto_accept_exhausted()', 'EXECUTE')
     OR pg_catalog.has_function_privilege('public', 'public.intercompany_auto_accept_exhausted()', 'EXECUTE')
     OR pg_catalog.has_function_privilege('public', 'public.intercompany_is_mirrored_row(uuid)', 'EXECUTE')
     OR pg_catalog.has_function_privilege('public', 'public.intercompany_journal_claimed(uuid)', 'EXECUTE')
     OR pg_catalog.has_function_privilege('public', 'public.intercompany_mirrored_duplicate(uuid)', 'EXECUTE')
     OR pg_catalog.has_function_privilege('app_user', 'public.intercompany_journal_bound_elsewhere(uuid, uuid)', 'EXECUTE')
     OR pg_catalog.has_function_privilege('public', 'public.intercompany_mirror_eliminations(uuid, date, date)', 'EXECUTE')
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
     OR pg_catalog.has_function_privilege('app_user', 'public.intercompany_journal_chain_length(uuid, uuid, date)', 'EXECUTE')
     OR pg_catalog.has_function_privilege('app_user', 'public.intercompany_journal_chain_dates(uuid, uuid)', 'EXECUTE')
     OR pg_catalog.has_function_privilege('app_user', 'public.intercompany_mirror_pair_at(uuid, date)', 'EXECUTE') THEN
    RAISE EXCEPTION '1019: a role it must not reach can execute an intercompany P2 definer function';
  END IF;
END $$;
