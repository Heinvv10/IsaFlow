-- 1027: Intercompany P4-D, the RECEIVER clears an allocation message with a contra settlement. Plan: docs/plans/2026-11-23-intercompany-p4d-receiver-clearing.md
-- (section (i) supersedes the earlier text; parent: docs/plans/2026-11-17-intercompany-mirror-posting.md, P4). Applies on top of 1026. Forward only:
-- no table, column or index changes; no new SECURITY DEFINER (the liveness definer is REPLACED, two INVOKER helpers are new).

-- WHAT
--   1. intercompany_allocation_message_live(message) is DROPPED and CREATED again (its row type changes): the 1026 body, plus two outputs, both
--      NULL unless the answer is ok:
--        clearable_total    the most the receiver may clear for the message's payer PAYMENT, judged by the payer's books: LEAST(the sum of that
--                           payment's live payment_allocations rows, what the standing journal the message recorded CREDITED (net of debits,
--                           never below 0) to the payer side's loan_account_id); 0 when the journal made no loan credit (cash went through a bank)
--        journal_clearable  that loan credit alone: the most every accepted message standing on the one journal may clear together (a batch's
--                           journal is shared by its members)
--      (four columns, not the plan's three: the journal cap of (i).1(b) needs the loan credit of the journal, and the receiver cannot read the
--      payer's journal.)
--   2. intercompany_allocation_cleared(message), INVOKER, STABLE: what the receiver's OTHER accepted allocation messages from the same payer
--      already cleared, by the same payload payment id (by_payment) and by the same recorded journal (by_journal). A clearing counts unless it was
--      VOIDED (its receipt cancelled and its journal reversed, which the receipt void does): a voided clearing no longer counts, so it can be
--      cleared again; anything less than a void still counts (the safe side of a cap).
--   3. intercompany_allocation_target_ok(message, payload, connection, receiver, target type, target id), INVOKER, STABLE: the clearing a message
--      is accepted with. A customer payment of the receiver, payment_method 'contra', confirmed, bank_reference stamped 'IC:<message id>', its
--      amount the payload's (2 dp), its contra (bank_account_id) the receiver side's loan account, exactly ONE allocation line, to the payload's
--      issuerDocument invoice (the receiver's), for that amount; its journal posted, never reversed, exactly two lines: DR the loan account, CR the
--      receiver's receivable control (system account, subtype receivable), both = amount. And the message is still live, and within its caps
--      (by_payment + amount <= clearable_total, by_journal + amount <= journal_clearable). Anything else is false.
--   4. The messages guard (the 1025 body; only the target section changes): an `allocation` message is accepted only with target_doc_type
--      'customer_payment' and a target intercompany_allocation_target_ok passes (23514 otherwise: closes the direct-UPDATE `accepted` hole,
--      #1788), one accepted message per target; its target changes on no other transition (23514).
-- The auto-accept worker, its queue, loadInboxRow and the invoice inbox keep their kind IN ('invoice','credit_note') filter: automation never
-- accepts an allocation.

-- DEFINER REGISTRY (930): the replaced definer is registered again in app_definer_reviews AFTER create and owner change (new hash). OLD COLOUR: the
-- previous release's allocationInbox.ts selects `live, reason` by name from the definer, which the new row type still carries; nothing in it accepts an
-- allocation, and the new guard refuses only an accepted allocation (or a target on one), which no old code writes.

-- Rollback (code first):
--   DROP FUNCTION IF EXISTS public.intercompany_allocation_target_ok(uuid, jsonb, uuid, uuid, text, uuid);
--   DROP FUNCTION IF EXISTS public.intercompany_allocation_cleared(uuid);
--   Restore 1025's intercompany_messages_guard, EXACTLY this one statement (never a whole earlier file):
--     sed -n '/^CREATE OR REPLACE FUNCTION public.intercompany_messages_guard/,/^\$\$;/p' scripts/migrations/sql/1025_intercompany_p4b_allocation_sender.sql | psql ...
--   Restore 1026's definer: DROP FUNCTION public.intercompany_allocation_message_live(uuid); then apply 1026 again whole (it holds only the definer,
--   its owner, grants, registry row and assertion: idempotent).
--   (accepted allocation messages and their contra customer payments stay: they are ledger history; a clearing is undone by voiding its receipt)

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- ── 1. The liveness definer, with what may be cleared ───────────────────────

DROP FUNCTION IF EXISTS public.intercompany_allocation_message_live(uuid);
CREATE OR REPLACE FUNCTION public.intercompany_allocation_message_live(p_message uuid)
RETURNS TABLE (live boolean, reason text, clearable_total numeric, journal_clearable numeric)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_co uuid := app.current_company_id();
  v_uuid constant text := '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';
  v_reason text;
  v_amount numeric;
  v_has_payment boolean;
  v_has_bill boolean;
  v_standing uuid;
  v_link uuid;
  v_issuer uuid;
  v_bill uuid;
  v_date text;
  v_cutover date;
  v_paysum numeric;
  v_loan uuid;
  v_credit numeric;
  v_clear numeric;
  v_jclear numeric;
  m RECORD;
  pa RECORD;
  sp RECORD;
  si RECORD;
BEGIN
  <<main>>
  BEGIN
    -- the receiver only: a signed-in member of the session company, which is the message's to_company; anything else is the one answer
    IF v_co IS NULL OR auth.uid() IS NULL OR p_message IS NULL OR NOT (v_co IN (SELECT auth.user_companies())) THEN v_reason := 'not_found'; EXIT main; END IF;
    SELECT x.id, x.status, x.from_company_id, x.connection_id, x.source_doc_id, x.source_journal_entry_id AS je, x.payload INTO m
      FROM public.intercompany_messages x
     WHERE x.id = p_message AND x.to_company_id = v_co AND x.kind = 'allocation' AND x.source_doc_type = 'payment_allocation';
    IF NOT FOUND THEN v_reason := 'not_found'; EXIT main; END IF;
    IF m.status NOT IN ('pending', 'failed') THEN v_reason := 'not_pending'; EXIT main; END IF;
    -- the relationship, from the payload and the link / connection rows only (an id that is no UUID names nothing): the connection active and
    -- loan, and the payload's link still active on it, joining the payload's bill of the payer to the receiver's issuer invoice
    v_link := CASE WHEN (m.payload ->> 'linkId') ~ v_uuid THEN (m.payload ->> 'linkId')::uuid END;
    v_issuer := CASE WHEN (m.payload #>> '{issuerDocument,type}') = 'customer_invoice' AND (m.payload #>> '{issuerDocument,id}') ~ v_uuid
                     THEN (m.payload #>> '{issuerDocument,id}')::uuid END;
    v_bill := CASE WHEN (m.payload #>> '{payerDocument,id}') ~ v_uuid THEN (m.payload #>> '{payerDocument,id}')::uuid END;
    SELECT c.cutover_date INTO v_cutover
      FROM public.intercompany_document_links k
      JOIN public.intercompany_connections c ON c.id = k.connection_id AND c.status = 'active' AND c.settlement_mode = 'loan'
     WHERE k.id = v_link AND k.status = 'active' AND k.connection_id = m.connection_id
       AND ((k.company_a_id = m.from_company_id AND k.doc_a_type = 'supplier_invoice' AND k.doc_a_id = v_bill
             AND k.company_b_id = v_co AND k.doc_b_type = 'customer_invoice' AND k.doc_b_id = v_issuer)
         OR (k.company_b_id = m.from_company_id AND k.doc_b_type = 'supplier_invoice' AND k.doc_b_id = v_bill
             AND k.company_a_id = v_co AND k.doc_a_type = 'customer_invoice' AND k.doc_a_id = v_issuer));
    IF NOT FOUND THEN v_reason := 'link_gone'; EXIT main; END IF;
    -- the cut-over, against the payload's payment date (ISO text compares as a date; anything else is no date)
    v_date := m.payload #>> '{payment,date}';
    IF v_cutover IS NULL OR v_date IS NULL OR v_date !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' OR v_date < pg_catalog.to_char(v_cutover, 'YYYY-MM-DD') THEN
      v_reason := 'before_cutover'; EXIT main;
    END IF;
    -- only now the payer's rows
    SELECT a.payment_id, a.invoice_id, a.amount_allocated INTO pa FROM public.payment_allocations a WHERE a.id = m.source_doc_id;
    IF NOT FOUND THEN v_reason := 'allocation_gone'; EXIT main; END IF;
    -- the payer's payment and bill, each under the payer's company (the message's sender)
    SELECT p.payment_number, p.reference, p.payment_date, p.payment_method, p.status, p.gl_journal_entry_id, p.batch_id INTO sp
      FROM public.supplier_payments p WHERE p.id = pa.payment_id AND p.company_id = m.from_company_id;
    v_has_payment := FOUND;
    SELECT b.invoice_number, b.deleted_at, COALESCE(NULLIF(b.currency_code, ''), NULLIF(b.currency, ''), 'ZAR') AS currency INTO si
      FROM public.supplier_invoices b WHERE b.id = pa.invoice_id AND b.company_id = m.from_company_id;
    v_has_bill := FOUND;
    v_amount := CASE WHEN pg_catalog.jsonb_typeof(m.payload -> 'amount') = 'number' THEN pg_catalog.round((m.payload ->> 'amount')::numeric, 2) END;
    IF pa.payment_id::text IS DISTINCT FROM (m.payload #>> '{payment,id}')
       OR pa.invoice_id::text IS DISTINCT FROM (m.payload #>> '{payerDocument,id}')
       OR pg_catalog.round(pa.amount_allocated, 2) IS DISTINCT FROM v_amount
       OR (v_has_payment AND (public.intercompany_clean_text(sp.payment_number, 50) IS DISTINCT FROM (m.payload #>> '{payment,number}')
             OR public.intercompany_clean_text(sp.reference, 255) IS DISTINCT FROM (m.payload #>> '{payment,reference}')
             OR pg_catalog.to_char(sp.payment_date, 'YYYY-MM-DD') IS DISTINCT FROM (m.payload #>> '{payment,date}')
             OR public.intercompany_clean_text(sp.payment_method, 20) IS DISTINCT FROM (m.payload #>> '{payment,method}')))
       OR (v_has_bill AND (public.intercompany_clean_text(si.invoice_number, 100) IS DISTINCT FROM (m.payload #>> '{payerDocument,number}')
             OR si.currency IS DISTINCT FROM (m.payload ->> 'currency'))) THEN
      v_reason := 'changed'; EXIT main;
    END IF;
    IF NOT v_has_payment OR sp.status IS NULL OR sp.status NOT IN ('processed', 'reconciled') THEN v_reason := 'payment_not_posted'; EXIT main; END IF;
    v_standing := COALESCE(sp.gl_journal_entry_id,
                           (SELECT b.gl_journal_entry_id FROM public.supplier_payment_batches b WHERE b.id = sp.batch_id AND b.company_id = m.from_company_id));
    IF m.je IS NULL OR v_standing IS DISTINCT FROM m.je
       OR COALESCE(public.intercompany_journal_chain_length(m.je, m.from_company_id), 0) % 2 <> 1 THEN
      v_reason := 'journal_reversed'; EXIT main;
    END IF;
    IF NOT v_has_bill OR si.deleted_at IS NOT NULL THEN v_reason := 'bill_gone'; EXIT main; END IF;
    v_reason := 'ok';
    -- (1027) what may be cleared: the payment's live allocation rows, and what the standing journal credited the payer side's loan account (net
    -- of any debit to it, never below 0; 0 when the payer side names no loan account or the cash went through a bank)
    SELECT COALESCE(sum(a.amount_allocated), 0) INTO v_paysum FROM public.payment_allocations a WHERE a.payment_id = pa.payment_id;
    SELECT s.loan_account_id INTO v_loan FROM public.intercompany_connection_sides s WHERE s.connection_id = m.connection_id AND s.company_id = m.from_company_id;
    v_credit := CASE WHEN v_loan IS NULL THEN 0 ELSE GREATEST(0, COALESCE((SELECT sum(COALESCE(jl.credit, 0) - COALESCE(jl.debit, 0))
                  FROM public.gl_journal_lines jl WHERE jl.journal_entry_id = m.je AND jl.company_id = m.from_company_id AND jl.gl_account_id = v_loan), 0)) END;
    v_clear := pg_catalog.round(LEAST(v_paysum, v_credit), 2);
    v_jclear := pg_catalog.round(v_credit, 2);
  END main;
  RETURN QUERY SELECT v_reason = 'ok', v_reason, v_clear, v_jclear;
END;
$$;
ALTER FUNCTION public.intercompany_allocation_message_live(uuid) OWNER TO migration_admin;
REVOKE ALL ON FUNCTION public.intercompany_allocation_message_live(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.intercompany_allocation_message_live(uuid) TO app_user;

-- ── 2. What the receiver already cleared for the same payment / journal ─────

-- INVOKER: the session's own rows only (RLS: the receiver's messages and payments). A clearing COUNTS unless it was voided: its receipt cancelled
-- AND its journal reversed by a posted reversal (the receipt void does both). Counting more is the safe side of a cap: a receipt journal reversed
-- by hand but not cancelled still counts. (intercompany_journal_chain_length is migration_admin's only, so the receiver's own chain is judged
-- by its first reversal here.)
CREATE OR REPLACE FUNCTION public.intercompany_allocation_cleared(p_message uuid)
RETURNS TABLE (by_payment numeric, by_journal numeric)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog, public, pg_temp
AS $$
  WITH me AS (
    SELECT m.id, m.to_company_id, m.from_company_id, m.payload #>> '{payment,id}' AS payment, m.source_journal_entry_id AS je
      FROM public.intercompany_messages m
     WHERE m.id = p_message AND m.kind = 'allocation'
  ), standing AS (
    SELECT x.payload #>> '{payment,id}' AS payment, x.source_journal_entry_id AS je,
           CASE WHEN pg_catalog.jsonb_typeof(x.payload -> 'amount') = 'number' THEN pg_catalog.round((x.payload ->> 'amount')::numeric, 2) ELSE 0 END AS amount
      FROM me
      JOIN public.intercompany_messages x ON x.to_company_id = me.to_company_id AND x.from_company_id = me.from_company_id AND x.kind = 'allocation'
       AND x.status = 'accepted' AND x.id <> me.id AND x.target_doc_type = 'customer_payment'
      JOIN public.customer_payments p ON p.id = x.target_doc_id AND p.company_id = x.to_company_id
     WHERE NOT (p.status = 'cancelled' AND EXISTS (SELECT 1 FROM public.gl_journal_entries r
                                                     WHERE r.reversal_of_id = p.gl_journal_entry_id AND r.company_id = p.company_id AND r.status = 'posted'))
  )
  SELECT COALESCE((SELECT sum(s.amount) FROM standing s, me WHERE s.payment = me.payment), 0),
         COALESCE((SELECT sum(s.amount) FROM standing s, me WHERE s.je = me.je), 0)
    FROM me
$$;
REVOKE ALL ON FUNCTION public.intercompany_allocation_cleared(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.intercompany_allocation_cleared(uuid) TO app_user;

-- ── 3. The clearing an allocation message is accepted with ──────────────────

-- INVOKER (the guard's session: the receiver's own rows under RLS). True only for the clearing allocationClearService.ts posts for THIS message.
CREATE OR REPLACE FUNCTION public.intercompany_allocation_target_ok(
  p_message uuid, p_payload jsonb, p_connection uuid, p_receiver uuid, p_type text, p_target uuid)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_uuid constant text := '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';
  v_amount numeric;
  v_invoice uuid;
  v_loan uuid;
  v_je uuid;
  v_live RECORD;
  v_cleared RECORD;
BEGIN
  IF p_message IS NULL OR p_receiver IS NULL OR p_target IS NULL OR p_type IS DISTINCT FROM 'customer_payment' THEN RETURN false; END IF;
  v_amount := CASE WHEN pg_catalog.jsonb_typeof(p_payload -> 'amount') = 'number' THEN pg_catalog.round((p_payload ->> 'amount')::numeric, 2) END;
  v_invoice := CASE WHEN (p_payload #>> '{issuerDocument,type}') = 'customer_invoice' AND (p_payload #>> '{issuerDocument,id}') ~ v_uuid
                    THEN (p_payload #>> '{issuerDocument,id}')::uuid END;
  IF v_amount IS NULL OR v_amount <= 0 OR v_invoice IS NULL THEN RETURN false; END IF;
  SELECT s.loan_account_id INTO v_loan FROM public.intercompany_connection_sides s WHERE s.connection_id = p_connection AND s.company_id = p_receiver;
  IF v_loan IS NULL THEN RETURN false; END IF;
  -- the receiver's confirmed contra receipt, stamped for THIS message, of the payload's amount, against the loan account
  SELECT p.gl_journal_entry_id INTO v_je FROM public.customer_payments p
   WHERE p.id = p_target AND p.company_id = p_receiver AND p.payment_method = 'contra' AND p.status = 'confirmed'
     AND p.bank_reference = 'IC:' || p_message::text AND pg_catalog.round(p.total_amount, 2) = v_amount AND p.bank_account_id = v_loan;
  IF NOT FOUND OR v_je IS NULL THEN RETURN false; END IF;
  -- one allocation line, to the payload's invoice (the receiver's), for the amount
  IF (SELECT count(*) FROM public.customer_payment_allocations a WHERE a.payment_id = p_target) <> 1
     OR NOT EXISTS (SELECT 1 FROM public.customer_payment_allocations a
                      JOIN public.customer_invoices ci ON ci.id = a.invoice_id AND ci.company_id = p_receiver
                     WHERE a.payment_id = p_target AND a.invoice_id = v_invoice AND pg_catalog.round(a.amount_allocated, 2) = v_amount) THEN
    RETURN false;
  END IF;
  -- its journal: posted, never reversed, exactly DR loan / CR receivable control for the amount
  IF NOT EXISTS (SELECT 1 FROM public.gl_journal_entries je WHERE je.id = v_je AND je.company_id = p_receiver AND je.status = 'posted')
     OR EXISTS (SELECT 1 FROM public.gl_journal_entries r WHERE r.reversal_of_id = v_je AND r.company_id = p_receiver)
     OR (SELECT count(*) FROM public.gl_journal_lines l WHERE l.journal_entry_id = v_je) <> 2
     OR NOT EXISTS (SELECT 1 FROM public.gl_journal_lines l
                     WHERE l.journal_entry_id = v_je AND l.company_id = p_receiver AND l.gl_account_id = v_loan
                       AND pg_catalog.round(l.debit, 2) = v_amount AND COALESCE(l.credit, 0) = 0)
     OR NOT EXISTS (SELECT 1 FROM public.gl_journal_lines l
                      JOIN public.gl_accounts ga ON ga.id = l.gl_account_id AND ga.company_id = p_receiver AND ga.is_system_account
                       AND ga.account_subtype = 'receivable'
                     WHERE l.journal_entry_id = v_je AND l.company_id = p_receiver
                       AND pg_catalog.round(l.credit, 2) = v_amount AND COALESCE(l.debit, 0) = 0) THEN
    RETURN false;
  END IF;
  -- still true in the payer's books, and within what they let be cleared (the service checked both under its locks; this is the backstop)
  SELECT * INTO v_live FROM public.intercompany_allocation_message_live(p_message);
  IF v_live.live IS NOT TRUE THEN RETURN false; END IF;
  SELECT * INTO v_cleared FROM public.intercompany_allocation_cleared(p_message);
  IF COALESCE(v_cleared.by_payment, 0) + v_amount > COALESCE(v_live.clearable_total, 0)
     OR COALESCE(v_cleared.by_journal, 0) + v_amount > COALESCE(v_live.journal_clearable, 0) THEN
    RETURN false;
  END IF;
  RETURN true;
END;
$$;
REVOKE ALL ON FUNCTION public.intercompany_allocation_target_ok(uuid, jsonb, uuid, uuid, text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.intercompany_allocation_target_ok(uuid, jsonb, uuid, uuid, text, uuid) TO app_user;

-- ── 4. Messages guard (the 1025 body; the target section adds `allocation`) ──

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
  ELSIF NEW.kind = 'allocation' THEN
    -- (1027) An allocation is accepted with the clearing the receiver posted for it (allocationClearService.ts): its contra customer payment,
    -- stamped for this message, of the payload's amount and invoice, on a standing two-line journal DR loan / CR receivable, while the message is
    -- live and within what the payer's books let be cleared (intercompany_allocation_target_ok). A direct UPDATE to accepted names no such
    -- payment and is refused. Its target changes on no other transition.
    IF NEW.status = 'accepted' THEN
      IF NOT public.intercompany_allocation_target_ok(OLD.id, OLD.payload, OLD.connection_id, OLD.to_company_id, NEW.target_doc_type, NEW.target_doc_id) THEN
        RAISE EXCEPTION 'an allocation message is accepted with the clearing posted for it' USING ERRCODE = '23514';
      END IF;
      IF EXISTS (
           SELECT 1 FROM intercompany_messages m
            WHERE m.to_company_id = OLD.to_company_id AND m.id <> OLD.id AND m.status = 'accepted'
              AND m.target_doc_type = NEW.target_doc_type AND m.target_doc_id = NEW.target_doc_id) THEN
        RAISE EXCEPTION 'a document is the target of one accepted message per receiving company' USING ERRCODE = '23514';
      END IF;
    ELSIF NEW.target_doc_type IS DISTINCT FROM OLD.target_doc_type OR NEW.target_doc_id IS DISTINCT FROM OLD.target_doc_id THEN
      RAISE EXCEPTION 'an allocation message names its clearing only when it is accepted' USING ERRCODE = '23514';
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

-- ── 5. The definer registry (930), after the owner is set ───────────────────

INSERT INTO public.app_definer_reviews (signature, writes, body_md5)
SELECT v.signature, v.writes, public.app_definer_hash(v.fn::regprocedure)
  FROM (VALUES
    ('intercompany_allocation_message_live(uuid)', 'public.intercompany_allocation_message_live(uuid)',
     'nothing (STABLE): a read, for the RECEIVER of an allocation message only (a signed-in member of the session company, which is the message''s to_company), of that message, the link and connection it names (judged first: a dead relationship is link_gone, the payment before the cut-over before_cutover, and no payer row is read for either), then the payer''s payment_allocations rows (the message''s row, and the sum of its payment''s rows), its supplier_payments row, supplier_payment_batches (a member''s standing journal), supplier_invoices (each under the payer''s company), the payer''s intercompany_connection_sides row (its loan account) and gl_journal_entries / gl_journal_lines (the reversal chain of the journal the message recorded, and what it credited to that loan account); answers one (live, reason, clearable_total, journal_clearable) row, the two amounts only when live; not_found for anyone else, a missing message or another kind')
  ) AS v(signature, fn, writes)
ON CONFLICT (signature) DO UPDATE SET writes = EXCLUDED.writes, body_md5 = EXCLUDED.body_md5;

DO $$
BEGIN
  IF pg_catalog.has_function_privilege('public', 'public.intercompany_allocation_message_live(uuid)', 'EXECUTE')
     OR NOT pg_catalog.has_function_privilege('app_user', 'public.intercompany_allocation_message_live(uuid)', 'EXECUTE')
     OR pg_catalog.has_function_privilege('public', 'public.intercompany_allocation_cleared(uuid)', 'EXECUTE')
     OR pg_catalog.has_function_privilege('public', 'public.intercompany_allocation_target_ok(uuid, jsonb, uuid, uuid, text, uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION '1027: PUBLIC can execute an allocation clearing function, or app_user cannot execute the liveness definer';
  END IF;
  IF (SELECT pg_catalog.pg_get_userbyid(p.proowner) FROM pg_catalog.pg_proc p WHERE p.oid = 'public.intercompany_allocation_message_live(uuid)'::regprocedure) <> 'migration_admin'
     OR NOT EXISTS (SELECT 1 FROM public.app_definer_reviews r WHERE r.signature = 'intercompany_allocation_message_live(uuid)'
                     AND r.body_md5 = public.app_definer_hash('public.intercompany_allocation_message_live(uuid)'::regprocedure)) THEN
    RAISE EXCEPTION '1027: the liveness definer is not owned by migration_admin, or its registry row does not hold its hash';
  END IF;
END $$;
