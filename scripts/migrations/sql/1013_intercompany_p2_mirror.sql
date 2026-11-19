-- 1013: Intercompany P2 (invoice + credit-note mirror). Plan: docs/plans/2026-11-17-intercompany-mirror-posting.md (P2).
-- Applies on top of 1000 / 1002; idempotent (CREATE OR REPLACE, IF NOT EXISTS, DROP ... IF EXISTS), adds columns, drops none.
--
-- WHAT
--   1. A message carries ITS source document (intercompany_payload_problem, called by the messages guard on INSERT): the source is
--      approved, and the payload's number, date, currency, subtotal, VAT, total, line count and line amounts, and the sender's own
--      name and VAT number, are the sender's books'. A sender cannot send amounts, a name or a VAT number that are not its own.
--   2. A sender's CANCELLATION of a document reaches its message: intercompany_withdraw_for_source (definer) WITHDRAWS a message not
--      yet handled (status 'withdrawn', not acceptable, never auto-accepted) and only stamps `source_cancelled_at` on one the receiver
--      already accepted (the receiver's data is never touched). The messages guard takes these system updates only from migration_admin
--      with the transaction-local flag app.intercompany_system_update (the flag alone proves nothing: any session can set it).
--   3. The auto-accept worker's own definer path, intercompany_auto_accept_queue(limit, claim):
--        the worker has no user and no company, and intercompany_in_one_group is false without a signed-in user (it is no membership
--        oracle), so the one cross-tenant READ it needs is this function. It returns ids only; a message whose RECEIVER side has
--        auto_accept on (and switched on BEFORE the message was created: sides.auto_accept_since) on an ACTIVE GROUP connection whose
--        companies still share a current active group (intercompany_shared_group), never a message a person restored or retried
--        (manual_only), with one write-role user of the receiver in good standing (the allow-list withAuth applies). At most 10 per
--        receiver per call, so one pair cannot starve the others. With claim it stamps an attempt (auto_attempts, auto_next_attempt_at,
--        exponential back-off up to an hour, at most 8 attempts), so a message that keeps deferring never blocks the head of the queue.
--        Executable by app_service and migration_admin only.
--   4. intercompany_sync_group_row (definer): the sender's side of intercompany_transactions is marked matched ONLY when the receiver's
--      bill / credit note is APPROVED (target journal set, variance = the sender's amount less the receiver's subtotal), and goes back
--      to unmatched when that document is cancelled or deleted. Accepting a message creates a draft and eliminates nothing.
--      intercompany_transaction_parties_immutable lets target_journal_entry_id be set (to a journal of the target company) or cleared
--      with that move; every other recorded column stays immutable.
--
-- DEFINER REGISTRY (930): intercompany_auto_accept_queue, intercompany_withdraw_for_source and intercompany_sync_group_row are
-- registered in app_definer_reviews (owner migration_admin, search_path pinned, pg_temp last).
-- OLD COLOUR: nothing in the previous release reads these columns or calls these functions. LOCKS: new columns with defaults (no
-- rewrite), function bodies, one status CHECK replaced.
--
-- Rollback (code first):
--   DROP FUNCTION IF EXISTS public.intercompany_auto_accept_queue(integer, boolean), public.intercompany_withdraw_for_source(text, uuid),
--     public.intercompany_sync_group_row(text, uuid), public.intercompany_payload_problem(text, uuid, uuid, jsonb);
--   DROP TRIGGER IF EXISTS trg_intercompany_sides_auto_since ON intercompany_connection_sides; DROP FUNCTION IF EXISTS public.intercompany_sides_auto_since();
--   (the 1002 body of intercompany_messages_guard and the 999r body of intercompany_transaction_parties_immutable return by re-applying them)
--   ALTER TABLE intercompany_messages DROP COLUMN IF EXISTS source_cancelled_at, DROP COLUMN IF EXISTS manual_only,
--     DROP COLUMN IF EXISTS auto_attempts, DROP COLUMN IF EXISTS auto_next_attempt_at;
--   ALTER TABLE intercompany_connection_sides DROP COLUMN IF EXISTS auto_accept_since;
--   DELETE FROM app_definer_reviews WHERE signature IN ('intercompany_auto_accept_queue(integer,boolean)',
--     'intercompany_withdraw_for_source(text,uuid)', 'intercompany_sync_group_row(text,uuid)');

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- ── 1. Columns ──────────────────────────────────────────────────────────────

-- No app role is granted these: they are set by the guard and the definers below.
ALTER TABLE intercompany_messages
  ADD COLUMN IF NOT EXISTS source_cancelled_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS manual_only BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS auto_attempts INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS auto_next_attempt_at TIMESTAMPTZ;
ALTER TABLE intercompany_connection_sides ADD COLUMN IF NOT EXISTS auto_accept_since TIMESTAMPTZ;

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

-- ── 2. A message carries its source document ────────────────────────────────

-- NULL when the payload is the sender's document as the sender's books have it, else a sentence saying what is not. SECURITY INVOKER:
-- the sender reads its own documents under its own RLS, so a document that is not the sender's is not found.
CREATE OR REPLACE FUNCTION public.intercompany_payload_problem(p_kind text, p_source uuid, p_company uuid, p_payload jsonb)
RETURNS text
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  d RECORD;
  c RECORD;
  v_lines numeric[];
  v_items numeric[];
BEGIN
  IF jsonb_typeof(p_payload->'lines') IS DISTINCT FROM 'array' THEN RETURN 'the payload has no lines'; END IF;
  IF p_kind = 'invoice' THEN
    SELECT ci.invoice_number AS num, ci.invoice_date::text AS dt, upper(ci.currency_code) AS cur, ci.subtotal, ci.tax_amount, ci.total_amount, ci.status
      INTO d FROM public.customer_invoices ci
     WHERE ci.id = p_source AND ci.company_id = p_company AND ci.deleted_at IS NULL;
    IF NOT FOUND THEN RETURN 'the source invoice is not this company''s'; END IF;
    IF d.status NOT IN ('approved', 'sent', 'partially_paid', 'paid', 'overdue') THEN RETURN 'the source invoice is not approved'; END IF;
    SELECT array_agg(i.amount ORDER BY i.amount) INTO v_items FROM public.customer_invoice_items i WHERE i.invoice_id = p_source;
  ELSIF p_kind = 'credit_note' THEN
    SELECT COALESCE(cn.credit_note_number, 'CN-' || left(cn.id::text, 8)) AS num, cn.credit_date::text AS dt, upper(cn.currency) AS cur,
           cn.subtotal, cn.tax_amount, cn.total_amount, cn.status
      INTO d FROM public.credit_notes cn
     WHERE cn.id = p_source AND cn.company_id = p_company AND cn.type = 'customer';
    IF NOT FOUND THEN RETURN 'the source credit note is not this company''s'; END IF;
    IF d.status NOT IN ('approved', 'partially_applied', 'applied') THEN RETURN 'the source credit note is not approved'; END IF;
    v_items := ARRAY[d.subtotal];
  ELSE
    RETURN 'this kind carries no document';
  END IF;
  IF jsonb_typeof(p_payload->'number') IS DISTINCT FROM 'string' OR p_payload->>'number' <> d.num THEN RETURN 'the number is not the document''s'; END IF;
  IF p_payload->>'date' IS DISTINCT FROM d.dt THEN RETURN 'the date is not the document''s'; END IF;
  IF upper(p_payload->>'currency') IS DISTINCT FROM d.cur THEN RETURN 'the currency is not the document''s'; END IF;
  IF jsonb_typeof(p_payload->'subtotal') IS DISTINCT FROM 'number' OR (p_payload->>'subtotal')::numeric <> d.subtotal THEN RETURN 'the subtotal is not the document''s'; END IF;
  IF jsonb_typeof(p_payload->'taxAmount') IS DISTINCT FROM 'number' OR (p_payload->>'taxAmount')::numeric <> COALESCE(d.tax_amount, 0) THEN RETURN 'the VAT is not the document''s'; END IF;
  IF jsonb_typeof(p_payload->'total') IS DISTINCT FROM 'number' OR (p_payload->>'total')::numeric <> d.total_amount THEN RETURN 'the total is not the document''s'; END IF;
  SELECT array_agg((l->>'lineTotal')::numeric ORDER BY (l->>'lineTotal')::numeric) INTO v_lines FROM jsonb_array_elements(p_payload->'lines') l;
  IF COALESCE(v_lines, ARRAY[]::numeric[]) IS DISTINCT FROM COALESCE(v_items, ARRAY[]::numeric[]) THEN RETURN 'the lines are not the document''s'; END IF;
  SELECT co.name, co.vat_number INTO c FROM public.companies co WHERE co.id = p_company;
  IF p_payload->>'senderName' IS DISTINCT FROM left(COALESCE(c.name, ''), 200) THEN RETURN 'the sender name is not the company''s'; END IF;
  IF COALESCE(p_payload->>'senderVatNumber', '') <> left(COALESCE(c.vat_number, ''), 50) THEN RETURN 'the sender VAT number is not the company''s'; END IF;
  RETURN NULL;
EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range OR invalid_parameter_value THEN
  RETURN 'the payload is malformed';
END;
$$;
REVOKE ALL ON FUNCTION public.intercompany_payload_problem(text, uuid, uuid, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.intercompany_payload_problem(text, uuid, uuid, jsonb) TO app_user, app_service, migration_admin;

-- ── 3. Messages guard (the 1002 body, plus the three changes above) ─────────

CREATE OR REPLACE FUNCTION public.intercompany_messages_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  conn intercompany_connections%ROWTYPE;
  v_problem text;
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
    IF NOT public.intercompany_user_can_write(NEW.from_company_id) THEN
      RAISE EXCEPTION 'a message is sent by a user with a write role in the sending company' USING ERRCODE = '42501';
    END IF;
    -- A message that carries a document names one of the SENDER's (the session company), of the type its kind needs: nobody
    -- can send, and the receiver then mirror-link, another company's invoice.
    IF NEW.kind IN ('invoice', 'credit_note', 'interest_invoice')
       AND NOT public.intercompany_message_doc_exists(NEW.kind, 'source', NEW.source_doc_type, NEW.source_doc_id, NEW.from_company_id) THEN
      RAISE EXCEPTION 'a document message names a source document of the sending company that fits its kind' USING ERRCODE = '23514';
    END IF;
    -- A message that carries a document carries THAT document: approved, and its number, date, currency, totals, lines and the
    -- sender's own name and VAT number as the sender's books have them. A sender cannot send amounts that are not its document.
    IF NEW.kind IN ('invoice', 'credit_note') THEN
      v_problem := public.intercompany_payload_problem(NEW.kind, NEW.source_doc_id, NEW.from_company_id, NEW.payload);
      IF v_problem IS NOT NULL THEN
        RAISE EXCEPTION 'a document message carries its source document: %', v_problem USING ERRCODE = '23514';
      END IF;
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
       OR NEW.manual_only IS DISTINCT FROM OLD.manual_only THEN
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

-- ── 4. The sender's cancellation reaches its message ────────────────────────

-- Called after a customer invoice / customer credit note is cancelled. Acts only for the session company, a signed-in user of it, and
-- only when the document really is cancelled in that company's books: it is no way to withdraw a message at will.
CREATE OR REPLACE FUNCTION public.intercompany_withdraw_for_source(p_source_type text, p_source_id uuid)
RETURNS integer
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_co uuid := app.current_company_id();
  n integer;
BEGIN
  IF v_co IS NULL OR auth.uid() IS NULL OR NOT (v_co IN (SELECT auth.user_companies())) THEN RETURN 0; END IF;
  IF p_source_type = 'customer_invoice' THEN
    IF NOT EXISTS (SELECT 1 FROM public.customer_invoices WHERE id = p_source_id AND company_id = v_co AND status = 'cancelled') THEN RETURN 0; END IF;
  ELSIF p_source_type = 'credit_note' THEN
    IF NOT EXISTS (SELECT 1 FROM public.credit_notes WHERE id = p_source_id AND company_id = v_co AND type = 'customer' AND status = 'cancelled') THEN RETURN 0; END IF;
  ELSE
    RETURN 0;
  END IF;
  PERFORM pg_catalog.set_config('app.intercompany_system_update', 'withdraw', true);
  UPDATE public.intercompany_messages m
     SET status = CASE WHEN m.status IN ('pending', 'failed', 'dismissed') THEN 'withdrawn' ELSE m.status END,
         source_cancelled_at = clock_timestamp()
   WHERE m.from_company_id = v_co AND m.source_doc_type = p_source_type AND m.source_doc_id = p_source_id
     AND m.kind IN ('invoice', 'credit_note') AND m.source_cancelled_at IS NULL
     AND m.status IN ('pending', 'failed', 'dismissed', 'accepted');
  GET DIAGNOSTICS n = ROW_COUNT;
  PERFORM pg_catalog.set_config('app.intercompany_system_update', '', true);
  RETURN n;
END;
$$;
ALTER FUNCTION public.intercompany_withdraw_for_source(text, uuid) OWNER TO migration_admin;
REVOKE ALL ON FUNCTION public.intercompany_withdraw_for_source(text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.intercompany_withdraw_for_source(text, uuid) TO app_user, app_service;

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
  -- matched_by, when it changes, is whoever matched it (a request's caller cannot sign another user's name) and is
  -- cleared only by an unmatch: together with match_status back to 'unmatched'.
  IF NEW.matched_by IS DISTINCT FROM OLD.matched_by AND current_user = 'app_user'
     AND ((NEW.matched_by IS NULL AND NEW.match_status IS DISTINCT FROM 'unmatched')
          OR (NEW.matched_by IS NOT NULL AND (auth.uid() IS NULL OR NEW.matched_by::pg_catalog.text <> auth.uid()))) THEN
    RAISE EXCEPTION 'intercompany_transactions: matched_by is the user who matched it, and is cleared only by an unmatch' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

-- Called after the receiver's bill / supplier credit note is approved, cancelled or deleted. For the session company only, a signed-in
-- user of it, and only for a document that is the target of an accepted message to that company with a group row: approved
-- (journal posted, not deleted) = matched (or 'variance' when the receiver's subtotal is not the sender's), anything else = unmatched.
-- Returns the row's status, or NULL when there is nothing to do. Never changes a row of another pair of companies.
CREATE OR REPLACE FUNCTION public.intercompany_sync_group_row(p_doc_type text, p_doc_id uuid)
RETURNS text
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_co uuid := app.current_company_id();
  m RECORD;
  d RECORD;
  t RECORD;
  v_approved boolean;
  v_amount numeric;
  v_variance numeric;
  v_status text;
BEGIN
  IF v_co IS NULL OR auth.uid() IS NULL OR NOT (v_co IN (SELECT auth.user_companies())) THEN RETURN NULL; END IF;
  SELECT x.from_company_id, x.kind, (x.payload->>'groupTransactionId')::uuid AS gtx INTO m
    FROM public.intercompany_messages x
   WHERE x.to_company_id = v_co AND x.status = 'accepted' AND x.target_doc_type = p_doc_type AND x.target_doc_id = p_doc_id
     AND x.kind IN ('invoice', 'credit_note') AND x.payload->>'groupTransactionId' IS NOT NULL
   LIMIT 1;
  IF NOT FOUND THEN RETURN NULL; END IF;
  IF p_doc_type = 'supplier_invoice' THEN
    SELECT si.subtotal AS subtotal, si.gl_journal_entry_id AS je, (si.deleted_at IS NULL AND si.status IN ('approved', 'partially_paid', 'paid')) AS ok INTO d
      FROM public.supplier_invoices si WHERE si.id = p_doc_id AND si.company_id = v_co;
  ELSIF p_doc_type = 'credit_note' THEN
    SELECT -cn.subtotal AS subtotal, cn.gl_journal_entry_id AS je, (cn.status IN ('approved', 'partially_applied', 'applied')) AS ok INTO d
      FROM public.credit_notes cn WHERE cn.id = p_doc_id AND cn.company_id = v_co AND cn.type = 'supplier';
  ELSE
    RETURN NULL;
  END IF;
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT it.amount, it.match_status INTO t FROM public.intercompany_transactions it
   WHERE it.id = m.gtx AND it.target_company_id = v_co AND it.source_company_id = m.from_company_id;
  IF NOT FOUND THEN RETURN NULL; END IF;
  v_approved := COALESCE(d.ok, false) AND d.je IS NOT NULL;
  IF v_approved THEN
    v_amount := t.amount;
    v_variance := abs(v_amount - d.subtotal);
    v_status := CASE WHEN v_variance = 0 THEN 'matched' ELSE 'variance' END;
    UPDATE public.intercompany_transactions SET match_status = v_status, variance_amount = v_variance, matched_at = clock_timestamp(),
           matched_by = auth.uid()::uuid, target_journal_entry_id = COALESCE(target_journal_entry_id, d.je)
     WHERE id = m.gtx AND target_company_id = v_co AND source_company_id = m.from_company_id;
  ELSE
    v_status := 'unmatched';
    UPDATE public.intercompany_transactions SET match_status = 'unmatched', variance_amount = 0, matched_at = NULL, matched_by = NULL,
           target_journal_entry_id = NULL
     WHERE id = m.gtx AND target_company_id = v_co AND source_company_id = m.from_company_id;
  END IF;
  RETURN v_status;
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

-- ── 7. The definer registry (930) ───────────────────────────────────────────

DELETE FROM public.app_definer_reviews WHERE signature = 'intercompany_auto_accept_queue(integer)';
INSERT INTO public.app_definer_reviews (signature, writes, body_md5)
SELECT v.signature, v.writes, public.app_definer_hash(v.fn::regprocedure)
  FROM (VALUES
    ('intercompany_auto_accept_queue(integer,boolean)', 'public.intercompany_auto_accept_queue(integer, boolean)',
     'intercompany_messages.auto_attempts and auto_next_attempt_at only (the claim, through the messages guard system path, when p_claim); otherwise a read of intercompany_messages, intercompany_connections, intercompany_connection_sides, companies, company_users, users: the pending invoice / credit-note messages whose receiver side switched auto_accept on before they were created, on an active group connection that still shares a current active group, never a restored one, at most 10 per receiver, with the receiver company and one write-role user in good standing; executable by app_service and migration_admin only'),
    ('intercompany_withdraw_for_source(text,uuid)', 'public.intercompany_withdraw_for_source(text, uuid)',
     'intercompany_messages.status = ''withdrawn'' (a message not yet handled) and source_cancelled_at (also an accepted one) for the messages the session company sent for a customer invoice / credit note that is cancelled in its books, through the messages guard system path; nothing for any other company or an uncancelled document'),
    ('intercompany_sync_group_row(text,uuid)', 'public.intercompany_sync_group_row(text, uuid)',
     'intercompany_transactions.match_status, variance_amount, matched_at, matched_by and target_journal_entry_id of the one group row behind an accepted message to the session company whose target is the given supplier invoice / supplier credit note of that company: matched (or variance) while the document is approved, unmatched otherwise')
  ) AS v(signature, fn, writes)
ON CONFLICT (signature) DO UPDATE SET writes = EXCLUDED.writes, body_md5 = EXCLUDED.body_md5;

DO $$
BEGIN
  IF pg_catalog.has_function_privilege('public', 'public.intercompany_auto_accept_queue(integer, boolean)', 'EXECUTE')
     OR pg_catalog.has_function_privilege('app_user', 'public.intercompany_auto_accept_queue(integer, boolean)', 'EXECUTE')
     OR pg_catalog.has_function_privilege('public', 'public.intercompany_withdraw_for_source(text, uuid)', 'EXECUTE')
     OR pg_catalog.has_function_privilege('public', 'public.intercompany_sync_group_row(text, uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION '1013: a role it must not reach can execute an intercompany P2 definer function';
  END IF;
END $$;
