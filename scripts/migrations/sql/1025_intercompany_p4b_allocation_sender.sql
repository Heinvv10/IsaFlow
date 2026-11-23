-- 1025: Intercompany P4-B, the payer's ALLOCATION message (outbox only). Plan: docs/plans/2026-11-23-intercompany-p4b-allocation-sender.md
-- (parent: docs/plans/2026-11-17-intercompany-mirror-posting.md, P4). Applies on top of 1019; idempotent (CREATE OR REPLACE, ON CONFLICT).
-- Forward only: no table, column or index changes. NO LEDGER WRITE and no receiver behaviour: C/D (draft clearing, contra-settle) and E come later.

-- WHAT
--   1. intercompany_send_for_allocation(allocation id), a registered SECURITY DEFINER (owner migration_admin) modelled on intercompany_send_for_source:
--      the PAYER (the session company) applied posted cash (payment_allocations row of its supplier_payments row) to one of its bills; the bill is
--      one side of an ACTIVE link whose other side is the partner's customer_invoice, on an ACTIVE LOAN connection past its cut-over: the DATABASE
--      builds the payload from the payer's own rows and writes ONE kind='allocation' message for the partner, recording the standing payment journal.
--      The app names the row id and nothing else. Otherwise (NULL, reason, NULL): no_session, not_found, no_link, no_connection,
--      not_loan, no_cutover, before_cutover, forbidden, not_posted, no_journal, already_sent.
--   2. The messages guard (the 1019 body + two names): an allocation message, or one naming a 'payment_allocation', is written by migration_admin only,
--      and names a payment allocation of the SENDER's own payment (intercompany_message_doc_exists, new 'allocation' branch). A session's own INSERT of
--      one is refused 42501; the update path is unchanged (an allocation creates no document: the target is cleared).
-- No change: the kind CHECK already allows 'allocation'; the inbox, the auto-accept queue and the receiver's reads filter kind IN ('invoice',
-- 'credit_note'), so the receiver never sees an allocation message. 'payment' stays open to app_user (about ten suites use it as a probe; E closes it).

-- DEFINER REGISTRY (930): the definer is registered in app_definer_reviews AFTER its owner is set (the hash covers the owner). OLD COLOUR: nothing in
-- the previous release calls the function or writes an allocation message; the new guard only refuses what no old code wrote.

-- Rollback (code first):
--   DELETE FROM intercompany_messages WHERE kind = 'allocation';   -- (before restoring the guard: it would still refuse nothing, but nothing reads them)
--   DROP FUNCTION IF EXISTS public.intercompany_send_for_allocation(uuid);
--   DELETE FROM app_definer_reviews WHERE signature = 'intercompany_send_for_allocation(uuid)';
--   Restore the two function bodies this migration replaced, EXACTLY these two statements in this order (never a whole earlier file: 1002 also
--   carries an older intercompany_messages_guard, which would land over 1019's):
--     1. 1002's intercompany_message_doc_exists (defined in 1002 only; 1019 does not redefine it):
--          sed -n '/^CREATE OR REPLACE FUNCTION public.intercompany_message_doc_exists/,/^\$\$;/p' scripts/migrations/sql/1002_intercompany_round2.sql | psql ...
--     2. 1019's intercompany_messages_guard (section 3 of 1019, the latest body before this migration):
--          sed -n '/^CREATE OR REPLACE FUNCTION public.intercompany_messages_guard/,/^\$\$;/p' scripts/migrations/sql/1019_intercompany_p2_mirror.sql | psql ...
--   (the trigger, the owner and the grants of both are untouched by this migration, so nothing else needs restoring)

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- ── 1. intercompany_message_doc_exists: the 'allocation' source ─────────────

-- (the 1002 body + one branch.) Source of an allocation message: a payment allocation whose PAYMENT is the sender's. The target role stays false:
-- an allocation creates no document.
CREATE OR REPLACE FUNCTION public.intercompany_message_doc_exists(p_kind text, p_role text, p_type text, p_id uuid, p_company uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT COALESCE(CASE
    WHEN p_kind IN ('invoice', 'interest_invoice') AND p_role = 'source' THEN p_type = 'customer_invoice'
      AND EXISTS (SELECT 1 FROM public.customer_invoices WHERE id = p_id AND company_id = p_company)
    WHEN p_kind IN ('invoice', 'interest_invoice') AND p_role = 'target' THEN p_type = 'supplier_invoice'
      AND EXISTS (SELECT 1 FROM public.supplier_invoices WHERE id = p_id AND company_id = p_company)
    WHEN p_kind = 'credit_note' AND p_role = 'source' THEN p_type = 'credit_note'
      AND EXISTS (SELECT 1 FROM public.credit_notes WHERE id = p_id AND company_id = p_company AND type = 'customer')
    WHEN p_kind = 'credit_note' AND p_role = 'target' THEN p_type = 'credit_note'
      AND EXISTS (SELECT 1 FROM public.credit_notes WHERE id = p_id AND company_id = p_company AND type = 'supplier')
    WHEN p_kind = 'allocation' AND p_role = 'source' THEN p_type = 'payment_allocation'
      AND EXISTS (SELECT 1 FROM public.payment_allocations pa JOIN public.supplier_payments sp ON sp.id = pa.payment_id
                   WHERE pa.id = p_id AND sp.company_id = p_company)
    ELSE false
  END, false)
$$;

-- ── 2. Messages guard (the 1019 body, plus 'allocation' / 'payment_allocation') ──

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
    -- its payload from the sender's books; allocation (1025): intercompany_send_for_allocation, which builds it from the payer's own payment
    -- allocation; interest_invoice and any other kind naming a document row have no writer yet: a later phase opens each through its own
    -- definer). A session writing one itself is how a payload carries what the sender's books do not.
    -- (ALLOW-LIST the definers' owner, deny every other login: the request login, the service login's own name, a role added later.)
    IF current_user <> 'migration_admin'
       AND (NEW.kind IN ('invoice', 'credit_note', 'interest_invoice', 'allocation')
            OR NEW.source_doc_type IN ('customer_invoice', 'credit_note', 'supplier_invoice', 'payment_allocation')) THEN
      RAISE EXCEPTION 'a document message is written by the database from the sender''s document, not by the sender' USING ERRCODE = '42501';
    END IF;
    IF NOT public.intercompany_user_can_write(NEW.from_company_id) THEN
      RAISE EXCEPTION 'a message is sent by a user with a write role in the sending company' USING ERRCODE = '42501';
    END IF;
    -- A message that carries a document names one of the SENDER's (the session company), of the type its kind needs: nobody
    -- can send, and the receiver then mirror-link, another company's invoice.
    IF NEW.kind IN ('invoice', 'credit_note', 'interest_invoice', 'allocation')
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
       OR (NEW.group_transaction_id IS DISTINCT FROM OLD.group_transaction_id AND NOT (v_system = 'backfill' AND (OLD.group_transaction_id IS NULL OR (NEW.group_transaction_id IS NULL AND OLD.source_journal_entry_id IS NULL)))) THEN
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
      -- (section 6b) the migration records a journal / group row a message was written without, or clears a group row it bound unproved: nothing else moves
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

-- ── 3. The definer ──────────────────────────────────────────────────────────

-- Session company P = app.current_company_id(); every answer but the message is (NULL, reason, NULL). A call with no session at all (no session
-- company, or no signed-in user: a categorization sweep or any caller outside a request) answers `no_session` BEFORE any row is looked at, so
-- the caller can tell "expected: nothing to say" from `not_found` (a bug). The write role is asked next (forbidden),
-- before any answer that says something about a row, a link or a connection: a user who may not send learns nothing about them. Then:
--   1 not_found    the allocation row, its payment (company_id = P) and its bill (company_id = P, not deleted) exist
--   2 no_link      the bill's slot (P, 'supplier_invoice', bill) is in an ACTIVE link whose other side is a customer_invoice of the connection's partner
--   3 no_connection / not_loan   the link's connection is active, and settles by loan
--   4 no_cutover / before_cutover   the connection has a cut-over and the payment is dated on or after it
--   6 not_posted / no_journal   the payment is processed or reconciled (a NULL status is neither), on a posted journal (its own, else its batch's,
--                  the batch being P's) whose chain stands (odd length)
--   7 already_sent a message for this allocation exists (the unique key makes the INSERT a no-op too: a racing writer is told the same)
-- The lock bound is tighten-only (2 s, never loosening a tighter caller's) and the caller's value is put back at the one exit.
CREATE OR REPLACE FUNCTION public.intercompany_send_for_allocation(p_allocation uuid)
RETURNS TABLE (message_id uuid, reason text, detail text)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_co uuid := app.current_company_id();
  v_prev text;
  v_reason text;
  v_msg uuid;
  v_je uuid;
  v_cash boolean;
  v_loan uuid;
  v_partner uuid;
  a RECORD;
  l RECORD;
BEGIN
  v_prev := pg_catalog.current_setting('lock_timeout');
  IF v_prev::interval = interval '0' OR v_prev::interval > interval '2s' THEN PERFORM pg_catalog.set_config('lock_timeout', '2s', true); END IF;
  <<main>>
  BEGIN
    IF v_co IS NULL OR auth.uid() IS NULL THEN v_reason := 'no_session'; EXIT main; END IF;
    IF p_allocation IS NULL THEN v_reason := 'not_found'; EXIT main; END IF;
    IF NOT public.intercompany_user_can_write(v_co) THEN v_reason := 'forbidden'; EXIT main; END IF;
    -- 1: the payer's own rows, the company named on the payment AND on the bill
    SELECT pa.amount_allocated AS amount, sp.id AS payment_id, sp.payment_number, sp.reference, sp.payment_date, sp.payment_method, sp.status AS payment_status,
           sp.gl_journal_entry_id AS payment_journal, sp.batch_id, si.id AS bill_id, si.invoice_number AS bill_number,
           COALESCE(NULLIF(si.currency_code, ''), NULLIF(si.currency, ''), 'ZAR') AS currency
      INTO a FROM public.payment_allocations pa
      JOIN public.supplier_payments sp ON sp.id = pa.payment_id AND sp.company_id = v_co
      JOIN public.supplier_invoices si ON si.id = pa.invoice_id AND si.company_id = v_co AND si.deleted_at IS NULL
     WHERE pa.id = p_allocation;
    IF NOT FOUND THEN v_reason := 'not_found'; EXIT main; END IF;
    -- 2: the bill is one side of an ACTIVE link whose other side is the partner's customer invoice
    SELECT k.id AS link_id, k.origin, k.status AS link_status, k.connection_id, c.status AS connection_status, c.settlement_mode, c.cutover_date,
           CASE WHEN c.company_low_id = v_co THEN c.company_high_id ELSE c.company_low_id END AS partner,
           CASE WHEN k.company_a_id = v_co THEN k.doc_b_id ELSE k.doc_a_id END AS issuer_doc
      INTO l FROM public.intercompany_document_slots s
      JOIN public.intercompany_document_links k ON k.id = s.link_id AND k.status = 'active'
      JOIN public.intercompany_connections c ON c.id = k.connection_id AND v_co IN (c.company_low_id, c.company_high_id)
     WHERE s.company_id = v_co AND s.doc_type = 'supplier_invoice' AND s.doc_id = a.bill_id
       AND ((k.company_a_id = v_co AND k.doc_a_type = 'supplier_invoice' AND k.doc_a_id = a.bill_id
             AND k.doc_b_type = 'customer_invoice' AND k.company_b_id = CASE WHEN c.company_low_id = v_co THEN c.company_high_id ELSE c.company_low_id END)
         OR (k.company_b_id = v_co AND k.doc_b_type = 'supplier_invoice' AND k.doc_b_id = a.bill_id
             AND k.doc_a_type = 'customer_invoice' AND k.company_a_id = CASE WHEN c.company_low_id = v_co THEN c.company_high_id ELSE c.company_low_id END))
     LIMIT 1
       FOR SHARE OF k, c;   -- the link and the connection are read as they stand and held until the message is written: a revoke / unlink in flight is waited for (under the 2 s bound)
    IF NOT FOUND THEN v_reason := 'no_link'; EXIT main; END IF;
    -- 3, 4: the connection
    IF l.connection_status <> 'active' THEN v_reason := 'no_connection'; EXIT main; END IF;
    IF l.settlement_mode <> 'loan' THEN v_reason := 'not_loan'; EXIT main; END IF;
    IF l.cutover_date IS NULL THEN v_reason := 'no_cutover'; EXIT main; END IF;
    IF a.payment_date < l.cutover_date THEN v_reason := 'before_cutover'; EXIT main; END IF;
    -- 6: posted cash: the payment's own journal, else its batch's (a batch member carries none; the batch must be P's), standing in the ledger
    IF a.payment_status IS NULL OR a.payment_status NOT IN ('processed', 'reconciled') THEN v_reason := 'not_posted'; EXIT main; END IF;
    v_je := COALESCE(a.payment_journal,
                     (SELECT b.gl_journal_entry_id FROM public.supplier_payment_batches b WHERE b.id = a.batch_id AND b.company_id = v_co));
    IF v_je IS NULL OR public.intercompany_journal_chain_length(v_je, v_co) % 2 <> 1 THEN v_reason := 'no_journal'; EXIT main; END IF;
    -- 7: once
    IF EXISTS (SELECT 1 FROM public.intercompany_messages m WHERE m.from_company_id = v_co AND m.source_doc_type = 'payment_allocation'
                  AND m.source_doc_id = p_allocation AND m.kind = 'allocation') THEN
      v_reason := 'already_sent'; EXIT main;
    END IF;
    SELECT s.loan_account_id INTO v_loan FROM public.intercompany_connection_sides s WHERE s.connection_id = l.connection_id AND s.company_id = v_co;
    v_partner := l.partner;
    -- cashLegIsLoanAccount is read from the JOURNAL the message stands on, not from a document column (a batch member's own bank_account_id, a
    -- provisional settlement's bank account and the batch's are not what the ledger credited): the journal CREDITS the payer's loan account.
    v_cash := v_loan IS NOT NULL AND EXISTS (SELECT 1 FROM public.gl_journal_lines jl
                WHERE jl.journal_entry_id = v_je AND jl.company_id = v_co AND jl.gl_account_id = v_loan AND jl.credit > 0);
    INSERT INTO public.intercompany_messages (connection_id, from_company_id, to_company_id, kind, source_doc_type, source_doc_id, payload, source_journal_entry_id)
    VALUES (l.connection_id, v_co, v_partner, 'allocation', 'payment_allocation', p_allocation,
            pg_catalog.jsonb_build_object(
              'version', 1, 'kind', 'allocation', 'allocationId', p_allocation, 'amount', pg_catalog.round(a.amount, 2), 'currency', a.currency,
              'payment', pg_catalog.jsonb_build_object(
                'id', a.payment_id, 'number', public.intercompany_clean_text(a.payment_number, 50), 'reference', public.intercompany_clean_text(a.reference, 255),
                'date', pg_catalog.to_char(a.payment_date, 'YYYY-MM-DD'), 'method', public.intercompany_clean_text(a.payment_method, 20),
                'cashLegIsLoanAccount', v_cash),
              'payerDocument', pg_catalog.jsonb_build_object('type', 'supplier_invoice', 'id', a.bill_id, 'number', public.intercompany_clean_text(a.bill_number, 100)),
              'issuerDocument', pg_catalog.jsonb_build_object('type', 'customer_invoice', 'id', l.issuer_doc),
              'linkId', l.link_id, 'linkOrigin', l.origin),
            v_je)
    ON CONFLICT (from_company_id, source_doc_type, source_doc_id, kind) DO NOTHING
    RETURNING id INTO v_msg;
    IF v_msg IS NULL THEN v_reason := 'already_sent'; END IF;
  END main;
  PERFORM pg_catalog.set_config('lock_timeout', v_prev, true);
  RETURN QUERY SELECT v_msg, v_reason, NULL::text;
END;
$$;
ALTER FUNCTION public.intercompany_send_for_allocation(uuid) OWNER TO migration_admin;
REVOKE ALL ON FUNCTION public.intercompany_send_for_allocation(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.intercompany_send_for_allocation(uuid) TO app_user;

-- ── 4. The definer registry (930), after the owner is set ───────────────────

INSERT INTO public.app_definer_reviews (signature, writes, body_md5)
SELECT v.signature, v.writes, public.app_definer_hash(v.fn::regprocedure)
  FROM (VALUES
    ('intercompany_send_for_allocation(uuid)', 'public.intercompany_send_for_allocation(uuid)',
     'intercompany_messages (one kind=''allocation'' message, its payload built from the session company''s own payment allocation: its processed or reconciled supplier payment on a posted, standing journal, its bill, and the ACTIVE link of that bill to the partner''s customer invoice on an active LOAN connection past its cut-over, recording that journal) for the session company (a write-role user) only; nothing else is written (no journal, no group row, no document), a read of payment_allocations, supplier_payments, supplier_invoices, supplier_payment_batches, gl_journal_entries, gl_journal_lines, intercompany_messages (has a message been written), company_users (the write role), intercompany_document_slots, intercompany_document_links (held FOR SHARE), intercompany_connections (held FOR SHARE) and intercompany_connection_sides; nothing for another company''s rows')
  ) AS v(signature, fn, writes)
ON CONFLICT (signature) DO UPDATE SET writes = EXCLUDED.writes, body_md5 = EXCLUDED.body_md5;

DO $$
BEGIN
  IF pg_catalog.has_function_privilege('public', 'public.intercompany_send_for_allocation(uuid)', 'EXECUTE')
     OR NOT pg_catalog.has_function_privilege('app_user', 'public.intercompany_send_for_allocation(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION '1025: a role it must not reach can execute intercompany_send_for_allocation (PUBLIC), or app_user cannot';
  END IF;
END $$;
