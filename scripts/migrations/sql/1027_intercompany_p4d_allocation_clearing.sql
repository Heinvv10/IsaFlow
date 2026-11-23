-- 1027: Intercompany P4-D, the RECEIVER clears an allocation message with a contra settlement. Plan: docs/plans/2026-11-23-intercompany-p4d-receiver-clearing.md
-- (section (i) supersedes the earlier text; parent: docs/plans/2026-11-17-intercompany-mirror-posting.md, P4). Applies on top of 1026. Forward only:
-- no table or column changes; one partial index (5b). The liveness definer is REPLACED, one SECURITY DEFINER is new (the full clearing check,
-- split from it in fix round 2, M4) and three INVOKER helpers are new. Edited in place (not yet released) by fix round 1 (F1, F2, F3, F5, F6,
-- F9, M4, m3, m5), fix round 2 (A1, A3, M4, L1, L5) and fix round 3 (A, C).

-- WHAT
--   0. intercompany_is_loan_class(account, company), STABLE INVOKER: the loan or intercompany balance-sheet accounts a clearing may touch (asset
--      other_current_asset / other; liability current_liability / other_current_liability / long_term_liability / other; never a system
--      account: the seeded charts carry their controls, bank, VAT, payroll and 2215 as system accounts; and never an account holding a
--      bank-statement line (real money: ap/settlementKind.moneyAccountSql's rule, round 2 A1) or named by any bank table (bank_accounts,
--      bank_feed_connections, bank_statement_imports, bank_import_batches, bank_reconciliations, bank_transfer_link_log: round 3 A). ONE rule:
--      the definers, the
--      guard, the service's loan-account lock, the side form and its picker all ask this function.
--   1. intercompany_allocation_message_live(message) is DROPPED and CREATED again (its row type changes), the LIGHT check the inbox asks once
--      per open row: the 1026 body, a new reason future_dated (the payload's payment date after today, Johannesburg: m3), and
--      clearing_voided: for an ACCEPTED message, whether its clearing receipt's journal chain is even (voided; the net chain: a reversal of the
--      reversal stands again), else NULL. The inbox's "Clearing voided" chip reads it (L5: the caps' own rule).
--   1b. intercompany_allocation_clearable(message), SECURITY DEFINER, STABLE, the FULL check Accept and the guard ask: the light answer first
--      (one source for liveness), then, when live, two figure-free outputs:
--        cap              NULL when this message's amount fits every cap, else 'payer_loan_unset' (round 3, C: the payer side names no
--                         loan-class loan account, so nothing it paid can count), 'cash_not_through_loan' (nothing cleared yet and still too
--                         much) or 'already_cleared'. The caps, each net of what EVERY receiver's other accepted, standing clearings of the same payer
--                         already cleared (F2; a clearing stands while its receipt's journal chain is odd: F9):
--                           the payer payment:  LEAST(its live allocations, what its standing journal credited the payer side's loan account)
--                           the payer journal:  that loan credit (a batch's journal is shared by its members)
--                           the payer bill:     its live allocations whose payment is processed / reconciled on a standing journal that credited
--                                               the loan account (F3: cleared, the payer voids and pays again: the bill is not cleared twice)
--                         The loan account counts only while it is a loan class (F1, A1: a side re-pointed at a bank or a money account funds
--                         nothing). Accepted limit: inside a group, 'already_cleared' tells a receiver that some receiver cleared the payment.
--        payer_loan_type  the payer side's loan account's type ('asset' / 'liability') when it is a loan class, else NULL (F5: the receiver's
--                         must be the other type)
--   2. intercompany_allocation_cap_lock(message), INVOKER, VOLATILE: pg_advisory_xact_lock on the payer's payment, journal and bill keys
--      (hashtextextended('<payer>:payment|journal|bill:<id>', 1027), ascending): every clearing of the same payer, by ANY receiver, waits for the
--      others before its caps are read (F2). The RECEIVER's message only (to_company_id = the session company: A3); anyone else takes nothing.
--      The service takes it right after the message lock; the guard again before it judges (re-entrant).
--   3. intercompany_allocation_target_ok(message, payload, connection, receiver, target type, target id), INVOKER, STABLE: the clearing a message
--      is accepted with. A customer payment of the receiver, payment_method 'contra', confirmed, created AND confirmed by the acting user
--      (auth.uid(): M4), bank_reference stamped 'IC:<message id>', its amount the payload's (2 dp), its contra (bank_account_id) the receiver
--      side's loan account, itself a loan class (F6), dated on or after the payment date and the invoice date (F4 / F6), exactly ONE allocation
--      line, to the payload's issuerDocument invoice (the receiver's), for that amount; its journal posted, never reversed, exactly two lines: DR
--      the loan account, CR the receiver's receivable control (system account, subtype receivable), both = amount, and no other accepted
--      allocation message's receipt on that journal (M4). And the message is live, within every cap, and the two loan accounts of opposite
--      types (F5), all asked of intercompany_allocation_clearable. Anything else is false. It assumes the receipt services post EXACTLY two lines for a
--      one-invoice contra receipt (accepted limit: a change there must change this). Service-only (not in the guard): the period / VAT lock, the customer link, the currency, the pair's
--      cut-over, the group connection and the open amount (the invoice's own amount_paid constraint holds that one).
--   4. The messages guard (the 1025 body; only the target section changes): an `allocation` message is accepted only after the cap lock and with
--      target_doc_type 'customer_payment' and a target intercompany_allocation_target_ok passes (23514 otherwise: closes the direct-UPDATE
--      `accepted` hole, #1788), one accepted message per target; its target changes on no other transition (23514).
--   5b. intercompany_messages_allocation_accepted_by_payer: a partial index (from_company_id) WHERE kind = 'allocation' AND status = 'accepted',
--      for the cross-receiver scan of 1b (every call reads the payer's accepted allocations; the index keeps that to the payer's own rows).
--   5. Grants, deploy-safe: each function REVOKEs PUBLIC and GRANTs only what it needs; any other role found able to EXECUTE one (a default
--      privilege of the creating role, e.g. Supabase's anon / authenticated / service_role) has it REVOKED, and a revoke the migration role
--      cannot make is a WARNING naming the role, never a halt. Strict (an EXCEPTION): PUBLIC, app_user's grants, the definer's owner and hash.
-- The auto-accept worker, its queue, loadInboxRow and the invoice inbox keep their kind IN ('invoice','credit_note') filter: automation never
-- accepts an allocation.

-- DEFINER REGISTRY (930): the replaced definer is registered again in app_definer_reviews AFTER create and owner change (new hash). OLD COLOUR: the
-- previous release's allocationInbox.ts selects `live, reason` by name from the definer, which the new row type still carries; nothing in it accepts an
-- allocation, and the new guard refuses only an accepted allocation (or a target on one), which no old code writes.

-- Rollback (code first), in THIS order (L1: the guard calls the helpers, so it is put back before they go):
--   1. Restore 1025's intercompany_messages_guard, EXACTLY this one statement (never a whole earlier file):
--        sed -n '/^CREATE OR REPLACE FUNCTION public.intercompany_messages_guard/,/^\$\$;/p' scripts/migrations/sql/1025_intercompany_p4b_allocation_sender.sql | psql ...
--   2. DROP FUNCTION IF EXISTS public.intercompany_allocation_target_ok(uuid, jsonb, uuid, uuid, text, uuid);
--      DROP FUNCTION IF EXISTS public.intercompany_allocation_cap_lock(uuid);
--      DROP FUNCTION IF EXISTS public.intercompany_allocation_clearable(uuid);
--      DELETE FROM app_definer_reviews WHERE signature = 'intercompany_allocation_clearable(uuid)';
--      DROP INDEX IF EXISTS public.intercompany_messages_allocation_accepted_by_payer;
--   3. Restore 1026's definer: DROP FUNCTION public.intercompany_allocation_message_live(uuid); then apply 1026 again whole (it holds only the
--      definer, its owner, grants, registry row and assertion: idempotent).
--   4. DROP FUNCTION IF EXISTS public.intercompany_is_loan_class(uuid, uuid);   (last: the definers above called it)
--   (accepted allocation messages and their contra customer payments stay: they are ledger history; a clearing is undone by voiding its receipt)

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- ── 0. The loan classes ─────────────────────────────────────────────────────

-- (an earlier draft of this migration took (type, subtype, is_system); it reads the account itself now, bank-statement lines included)
DROP FUNCTION IF EXISTS public.intercompany_is_loan_class(text, text, boolean);
CREATE OR REPLACE FUNCTION public.intercompany_is_loan_class(p_account uuid, p_company uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT COALESCE((
    SELECT ga.is_system_account = false
       AND CASE ga.account_type
             WHEN 'asset' THEN ga.account_subtype IN ('other_current_asset', 'other')
             WHEN 'liability' THEN ga.account_subtype IN ('current_liability', 'other_current_liability', 'long_term_liability', 'other')
             ELSE false END
       AND NOT EXISTS (SELECT 1 FROM public.bank_transactions bt WHERE bt.bank_account_id = ga.id AND bt.company_id = ga.company_id)
       -- (round 3, A) nor one any bank table names: a registered bank account, a bank feed, a statement import, an import batch, a
       -- reconciliation, a transfer-link log (each of these columns is the GL account the bank side posts to)
       AND NOT EXISTS (SELECT 1 FROM public.bank_accounts b WHERE b.gl_account_id = ga.id)
       AND NOT EXISTS (SELECT 1 FROM public.bank_feed_connections f WHERE f.bank_account_id = ga.id)
       AND NOT EXISTS (SELECT 1 FROM public.bank_statement_imports i WHERE i.bank_account_id = ga.id)
       AND NOT EXISTS (SELECT 1 FROM public.bank_import_batches ib WHERE ib.bank_account_id = ga.id)
       AND NOT EXISTS (SELECT 1 FROM public.bank_reconciliations r WHERE r.bank_account_id = ga.id)
       AND NOT EXISTS (SELECT 1 FROM public.bank_transfer_link_log tl WHERE tl.bank_account_id = ga.id)
      FROM public.gl_accounts ga
     WHERE ga.id = p_account AND ga.company_id = p_company), false)
$$;
REVOKE ALL ON FUNCTION public.intercompany_is_loan_class(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.intercompany_is_loan_class(uuid, uuid) TO app_user, migration_admin;

-- ── 1. The light liveness definer (the inbox's) ─────────────────────────────

-- (an earlier draft of this migration created intercompany_allocation_cleared(uuid); the full definer answers the caps itself now)
DROP FUNCTION IF EXISTS public.intercompany_allocation_cleared(uuid);
DROP FUNCTION IF EXISTS public.intercompany_allocation_message_live(uuid);
CREATE OR REPLACE FUNCTION public.intercompany_allocation_message_live(p_message uuid)
RETURNS TABLE (live boolean, reason text, clearing_voided boolean)
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
  v_voided boolean;
  m RECORD;
  pa RECORD;
  sp RECORD;
  si RECORD;
BEGIN
  <<main>>
  BEGIN
    -- the receiver only: a signed-in member of the session company, which is the message's to_company; anything else is the one answer
    IF v_co IS NULL OR auth.uid() IS NULL OR p_message IS NULL OR NOT (v_co IN (SELECT auth.user_companies())) THEN v_reason := 'not_found'; EXIT main; END IF;
    SELECT x.id, x.status, x.from_company_id, x.connection_id, x.source_doc_id, x.source_journal_entry_id AS je, x.payload, x.target_doc_type, x.target_doc_id INTO m
      FROM public.intercompany_messages x
     WHERE x.id = p_message AND x.to_company_id = v_co AND x.kind = 'allocation' AND x.source_doc_type = 'payment_allocation';
    IF NOT FOUND THEN v_reason := 'not_found'; EXIT main; END IF;
    -- (1027, L5) an accepted message: is its clearing receipt voided? (the receiver's own receipt, its journal chain even: the caps' rule)
    IF m.status = 'accepted' AND m.target_doc_type = 'customer_payment' THEN
      SELECT COALESCE(public.intercompany_journal_chain_length(p.gl_journal_entry_id, p.company_id), 0) % 2 = 0 INTO v_voided
        FROM public.customer_payments p WHERE p.id = m.target_doc_id AND p.company_id = v_co;
    END IF;
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
    -- (1027, m3) a payment dated after today (Johannesburg) is not yet a fact anything is cleared against
    IF v_date > pg_catalog.to_char((pg_catalog.now() AT TIME ZONE 'Africa/Johannesburg')::date, 'YYYY-MM-DD') THEN v_reason := 'future_dated'; EXIT main; END IF;
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
  END main;
  RETURN QUERY SELECT v_reason = 'ok', v_reason, v_voided;
END;
$$;
ALTER FUNCTION public.intercompany_allocation_message_live(uuid) OWNER TO migration_admin;
REVOKE ALL ON FUNCTION public.intercompany_allocation_message_live(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.intercompany_allocation_message_live(uuid) TO app_user;

-- ── 1b. The full clearing check (Accept's and the guard's) ──────────────────

-- The light answer first (the one source of liveness: it is the receiver check too), then the caps and the payer's loan type, read as the
-- definers' owner (the payer's rows and every receiver's accepted clearings of the same payer, which no session can read). No figure leaves.
CREATE OR REPLACE FUNCTION public.intercompany_allocation_clearable(p_message uuid)
RETURNS TABLE (live boolean, reason text, cap text, payer_loan_type text)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_live boolean;
  v_reason text;
  v_amount numeric;
  v_loan uuid;
  v_ptype text;
  v_credit numeric;
  v_paysum numeric;
  v_billsum numeric;
  v_bypay numeric;
  v_byje numeric;
  v_bybill numeric;
  v_cap text;
  m RECORD;
  pa RECORD;
BEGIN
  SELECT l.live, l.reason INTO v_live, v_reason FROM public.intercompany_allocation_message_live(p_message) l;
  IF v_live IS NOT TRUE THEN
    RETURN QUERY SELECT false, COALESCE(v_reason, 'not_found'), NULL::text, NULL::text;
    RETURN;
  END IF;
  -- live: the message is the session company's (the light check said so), its allocation row exists and matches the payload
  SELECT x.id, x.from_company_id, x.connection_id, x.source_doc_id, x.source_journal_entry_id AS je, x.payload INTO m
    FROM public.intercompany_messages x WHERE x.id = p_message AND x.to_company_id = app.current_company_id() AND x.kind = 'allocation';
  SELECT a.payment_id, a.invoice_id INTO pa FROM public.payment_allocations a WHERE a.id = m.source_doc_id;
  v_amount := pg_catalog.round((m.payload ->> 'amount')::numeric, 2);
  -- the payer side's loan account counts only while it is a loan class (F1, A1); its credit in the standing journal, net of any debit to it,
  -- never below 0
  SELECT s.loan_account_id, ga.account_type INTO v_loan, v_ptype
    FROM public.intercompany_connection_sides s
    JOIN public.gl_accounts ga ON ga.id = s.loan_account_id AND ga.company_id = m.from_company_id
   WHERE s.connection_id = m.connection_id AND s.company_id = m.from_company_id
     AND public.intercompany_is_loan_class(ga.id, ga.company_id);
  v_credit := CASE WHEN v_loan IS NULL THEN 0 ELSE GREATEST(0, COALESCE((SELECT sum(COALESCE(jl.credit, 0) - COALESCE(jl.debit, 0))
                FROM public.gl_journal_lines jl WHERE jl.journal_entry_id = m.je AND jl.company_id = m.from_company_id AND jl.gl_account_id = v_loan), 0)) END;
  SELECT COALESCE(sum(a.amount_allocated), 0) INTO v_paysum FROM public.payment_allocations a WHERE a.payment_id = pa.payment_id;
  -- (F3) the bill's live loan-funded allocations: rows to the bill whose payment is the payer's, processed / reconciled, on a standing journal
  -- (its own, else its batch's) that credited the loan account
  SELECT COALESCE(sum(a.amount_allocated), 0) INTO v_billsum
    FROM public.payment_allocations a
    JOIN public.supplier_payments p ON p.id = a.payment_id AND p.company_id = m.from_company_id AND p.status IN ('processed', 'reconciled')
    LEFT JOIN public.supplier_payment_batches b ON b.id = p.batch_id AND b.company_id = m.from_company_id
    CROSS JOIN LATERAL (SELECT COALESCE(p.gl_journal_entry_id, b.gl_journal_entry_id) AS je) j
   WHERE a.invoice_id = pa.invoice_id AND v_loan IS NOT NULL AND j.je IS NOT NULL
     AND COALESCE(public.intercompany_journal_chain_length(j.je, m.from_company_id), 0) % 2 = 1
     AND EXISTS (SELECT 1 FROM public.gl_journal_lines jl
                  WHERE jl.journal_entry_id = j.je AND jl.company_id = m.from_company_id AND jl.gl_account_id = v_loan AND jl.credit > 0);
  -- (F2, F9) what EVERY receiver already cleared of the same payer: its other accepted allocation messages whose clearing receipt still stands
  -- (the receipt's journal chain is odd); the partial index on (from_company_id) keeps the scan to the payer's accepted allocations
  SELECT COALESCE(sum(c.amount) FILTER (WHERE c.payment = (m.payload #>> '{payment,id}')), 0),
         COALESCE(sum(c.amount) FILTER (WHERE c.je = m.je), 0),
         COALESCE(sum(c.amount) FILTER (WHERE c.bill = (m.payload #>> '{payerDocument,id}')), 0)
    INTO v_bypay, v_byje, v_bybill
    FROM (SELECT x.payload #>> '{payment,id}' AS payment, x.source_journal_entry_id AS je, x.payload #>> '{payerDocument,id}' AS bill,
                 CASE WHEN pg_catalog.jsonb_typeof(x.payload -> 'amount') = 'number' THEN pg_catalog.round((x.payload ->> 'amount')::numeric, 2) ELSE 0 END AS amount
            FROM public.intercompany_messages x
            JOIN public.customer_payments cp ON cp.id = x.target_doc_id AND cp.company_id = x.to_company_id
           WHERE x.from_company_id = m.from_company_id AND x.kind = 'allocation' AND x.status = 'accepted' AND x.id <> m.id
             AND x.target_doc_type = 'customer_payment'
             AND COALESCE(public.intercompany_journal_chain_length(cp.gl_journal_entry_id, cp.company_id), 0) % 2 = 1) c;
  v_cap := CASE
    WHEN v_loan IS NULL THEN 'payer_loan_unset'
    WHEN (v_bypay + v_amount > LEAST(v_paysum, v_credit) AND v_bypay > 0) OR (v_byje + v_amount > v_credit AND v_byje > 0)
      OR (v_bybill + v_amount > v_billsum AND v_bybill > 0) THEN 'already_cleared'
    WHEN v_bypay + v_amount > LEAST(v_paysum, v_credit) OR v_byje + v_amount > v_credit OR v_bybill + v_amount > v_billsum THEN 'cash_not_through_loan'
  END;
  RETURN QUERY SELECT true, 'ok'::text, v_cap, v_ptype;
END;
$$;
ALTER FUNCTION public.intercompany_allocation_clearable(uuid) OWNER TO migration_admin;
REVOKE ALL ON FUNCTION public.intercompany_allocation_clearable(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.intercompany_allocation_clearable(uuid) TO app_user;

-- ── 5b. The cross-receiver scan's index ─────────────────────────────────────

CREATE INDEX IF NOT EXISTS intercompany_messages_allocation_accepted_by_payer
  ON public.intercompany_messages (from_company_id) WHERE kind = 'allocation' AND status = 'accepted';

-- ── 2. The payer's advisory locks ───────────────────────────────────────────

-- INVOKER, VOLATILE (a lock taken in a STABLE function would leave its later reads on the old snapshot). The RECEIVER's message only (A3:
-- to_company_id is the session company; the payer, who can read its own sent message, takes nothing).
CREATE OR REPLACE FUNCTION public.intercompany_allocation_cap_lock(p_message uuid)
RETURNS void
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  k bigint;
BEGIN
  FOR k IN
    SELECT DISTINCT x.key FROM public.intercompany_messages m
     CROSS JOIN LATERAL (VALUES
       (pg_catalog.hashtextextended(m.from_company_id::text || ':payment:' || COALESCE(m.payload #>> '{payment,id}', ''), 1027)),
       (pg_catalog.hashtextextended(m.from_company_id::text || ':journal:' || COALESCE(m.source_journal_entry_id::text, ''), 1027)),
       (pg_catalog.hashtextextended(m.from_company_id::text || ':bill:' || COALESCE(m.payload #>> '{payerDocument,id}', ''), 1027))) AS x(key)
     WHERE m.id = p_message AND m.kind = 'allocation' AND m.to_company_id = app.current_company_id()
     ORDER BY x.key
  LOOP
    PERFORM pg_catalog.pg_advisory_xact_lock(k);
  END LOOP;
END;
$$;
REVOKE ALL ON FUNCTION public.intercompany_allocation_cap_lock(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.intercompany_allocation_cap_lock(uuid) TO app_user;

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
  v_paydate date;
  v_loan uuid;
  v_rtype text;
  v_je uuid;
  v_live RECORD;
BEGIN
  IF p_message IS NULL OR p_receiver IS NULL OR p_target IS NULL OR p_type IS DISTINCT FROM 'customer_payment' OR auth.uid() IS NULL THEN RETURN false; END IF;
  v_amount := CASE WHEN pg_catalog.jsonb_typeof(p_payload -> 'amount') = 'number' THEN pg_catalog.round((p_payload ->> 'amount')::numeric, 2) END;
  v_invoice := CASE WHEN (p_payload #>> '{issuerDocument,type}') = 'customer_invoice' AND (p_payload #>> '{issuerDocument,id}') ~ v_uuid
                    THEN (p_payload #>> '{issuerDocument,id}')::uuid END;
  v_paydate := CASE WHEN (p_payload #>> '{payment,date}') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN (p_payload #>> '{payment,date}')::date END;
  IF v_amount IS NULL OR v_amount <= 0 OR v_invoice IS NULL OR v_paydate IS NULL THEN RETURN false; END IF;
  -- the receiver side's loan account, a loan class (F6)
  SELECT s.loan_account_id, ga.account_type INTO v_loan, v_rtype
    FROM public.intercompany_connection_sides s
    JOIN public.gl_accounts ga ON ga.id = s.loan_account_id AND ga.company_id = p_receiver
   WHERE s.connection_id = p_connection AND s.company_id = p_receiver
     AND public.intercompany_is_loan_class(ga.id, ga.company_id);
  IF v_loan IS NULL THEN RETURN false; END IF;
  -- the receiver's confirmed contra receipt, stamped for THIS message, of the payload's amount, against the loan account, made and confirmed by the
  -- acting user (M4), dated on or after the payment (F6)
  SELECT p.gl_journal_entry_id INTO v_je FROM public.customer_payments p
   WHERE p.id = p_target AND p.company_id = p_receiver AND p.payment_method = 'contra' AND p.status = 'confirmed'
     AND p.bank_reference = 'IC:' || p_message::text AND pg_catalog.round(p.total_amount, 2) = v_amount AND p.bank_account_id = v_loan
     AND p.created_by::text = auth.uid()::text AND p.confirmed_by::text = auth.uid()::text AND p.payment_date >= v_paydate;
  IF NOT FOUND OR v_je IS NULL THEN RETURN false; END IF;
  -- one allocation line, to the payload's invoice (the receiver's), for the amount, the receipt dated on or after the invoice (F4)
  IF (SELECT count(*) FROM public.customer_payment_allocations a WHERE a.payment_id = p_target) <> 1
     OR NOT EXISTS (SELECT 1 FROM public.customer_payment_allocations a
                      JOIN public.customer_invoices ci ON ci.id = a.invoice_id AND ci.company_id = p_receiver
                      JOIN public.customer_payments p ON p.id = a.payment_id AND p.payment_date >= ci.invoice_date
                     WHERE a.payment_id = p_target AND a.invoice_id = v_invoice AND pg_catalog.round(a.amount_allocated, 2) = v_amount) THEN
    RETURN false;
  END IF;
  -- its journal: posted, never reversed, exactly DR loan / CR receivable control for the amount, and no other accepted clearing's (M4)
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
                       AND pg_catalog.round(l.credit, 2) = v_amount AND COALESCE(l.debit, 0) = 0)
     OR EXISTS (SELECT 1 FROM public.intercompany_messages x
                  JOIN public.customer_payments q ON q.id = x.target_doc_id AND q.company_id = x.to_company_id
                 WHERE x.to_company_id = p_receiver AND x.kind = 'allocation' AND x.status = 'accepted' AND x.id <> p_message
                   AND x.target_doc_type = 'customer_payment' AND q.gl_journal_entry_id = v_je) THEN
    RETURN false;
  END IF;
  -- still true in the payer's books, within every cap (every receiver's), the payer's loan account of the other type (the service checked all
  -- of it under its locks; this is the backstop, after the guard took the same cap lock)
  SELECT * INTO v_live FROM public.intercompany_allocation_clearable(p_message);
  IF v_live.live IS NOT TRUE OR v_live.cap IS NOT NULL OR v_live.payer_loan_type IS NULL OR v_live.payer_loan_type = v_rtype THEN RETURN false; END IF;
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
    -- (1027) An allocation is accepted with the clearing the receiver posted for it (allocationClearService.ts), after the payer's cap lock (every
    -- receiver's clearing of the same payer payment / journal / bill waits here for the others: re-entrant when the service already holds it),
    -- while the message is live and within every cap (intercompany_allocation_target_ok). A direct UPDATE to accepted names no such payment and
    -- is refused. Its target changes on no other transition.
    IF NEW.status = 'accepted' THEN
      PERFORM public.intercompany_allocation_cap_lock(OLD.id);
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
     'nothing (STABLE): a read, for the RECEIVER of an allocation message only (a signed-in member of the session company, which is the message''s to_company), of that message, the link and connection it names (judged first: a dead relationship is link_gone, the payment before the cut-over before_cutover, after today future_dated, and no payer row is read for any), then the payer''s payment_allocations row, its supplier_payments row, supplier_payment_batches (a member''s standing journal), supplier_invoices (each under the payer''s company) and gl_journal_entries (the reversal chain of the journal the message recorded); for an accepted message the receiver''s own clearing receipt (customer_payments) and its journal chain; answers one (live, reason, clearing_voided) row and no row data; not_found for anyone else, a missing message or another kind'),
    ('intercompany_allocation_clearable(uuid)', 'public.intercompany_allocation_clearable(uuid)',
     'nothing (STABLE): the light check intercompany_allocation_message_live first (the receiver only), then, when live, the payer''s payment_allocations rows (its payment''s and its bill''s), supplier_payments, supplier_payment_batches, the payer''s intercompany_connection_sides row and its loan account (gl_accounts, and through intercompany_is_loan_class bank_transactions, bank_accounts, bank_feed_connections, bank_statement_imports, bank_import_batches, bank_reconciliations, bank_transfer_link_log), gl_journal_entries / gl_journal_lines (what the standing journal credited that loan account, reversal chains), and every receiver''s accepted allocation messages of the same payer with their customer_payments and those receipts'' journal chains (the caps); answers one (live, reason, cap, payer_loan_type) row with no figure')
  ) AS v(signature, fn, writes)
ON CONFLICT (signature) DO UPDATE SET writes = EXCLUDED.writes, body_md5 = EXCLUDED.body_md5;

-- Every role that can EXECUTE a function of this migration is one it is meant for (m5): a superuser, the function's owner (or a member of it),
-- migration_admin or app_user (or a member of either: such a role reaches every app_user grant anyway); PUBLIC never. DEPLOY-SAFE: any other
-- role found holding EXECUTE (a default privilege of the creating role, e.g. Supabase's anon / authenticated / service_role) has it REVOKED
-- here; a role the migration role cannot revoke from, or one that still reaches the function another way, is a WARNING (named), never a halt.
-- What stays strict below: PUBLIC must not, app_user must, the definer's owner and its registry hash.
DO $$
DECLARE
  g RECORD;
BEGIN
  FOR g IN
    SELECT r.rolname, f.sig
      FROM (VALUES ('public.intercompany_allocation_message_live(uuid)'), ('public.intercompany_allocation_cap_lock(uuid)'),
                   ('public.intercompany_is_loan_class(uuid, uuid)'), ('public.intercompany_allocation_clearable(uuid)'),
                   ('public.intercompany_allocation_target_ok(uuid, jsonb, uuid, uuid, text, uuid)')) AS f(sig)
      JOIN pg_catalog.pg_proc p ON p.oid = f.sig::regprocedure
     CROSS JOIN pg_catalog.pg_roles r
     WHERE pg_catalog.has_function_privilege(r.oid, p.oid, 'EXECUTE')
       AND NOT (r.rolsuper OR r.oid = p.proowner OR pg_catalog.pg_has_role(r.oid, p.proowner, 'MEMBER')
                OR pg_catalog.pg_has_role(r.oid, 'app_user', 'MEMBER') OR pg_catalog.pg_has_role(r.oid, 'migration_admin', 'MEMBER'))
     ORDER BY r.rolname, f.sig
  LOOP
    BEGIN
      EXECUTE pg_catalog.format('REVOKE ALL ON FUNCTION %s FROM %I', g.sig, g.rolname);
    EXCEPTION WHEN insufficient_privilege OR undefined_object THEN
      RAISE WARNING '1027: could not revoke EXECUTE on % from % (%): revoke it by hand', g.sig, g.rolname, SQLERRM;
    END;
    IF pg_catalog.has_function_privilege(g.rolname, g.sig, 'EXECUTE') THEN
      RAISE WARNING '1027: % can still execute % (through another grant or membership): revoke it by hand', g.rolname, g.sig;
    END IF;
  END LOOP;
END $$;

DO $$
BEGIN
  IF pg_catalog.has_function_privilege('public', 'public.intercompany_allocation_message_live(uuid)', 'EXECUTE')
     OR pg_catalog.has_function_privilege('public', 'public.intercompany_allocation_cap_lock(uuid)', 'EXECUTE')
     OR pg_catalog.has_function_privilege('public', 'public.intercompany_is_loan_class(uuid, uuid)', 'EXECUTE')
     OR pg_catalog.has_function_privilege('public', 'public.intercompany_allocation_target_ok(uuid, jsonb, uuid, uuid, text, uuid)', 'EXECUTE')
     OR NOT pg_catalog.has_function_privilege('app_user', 'public.intercompany_allocation_message_live(uuid)', 'EXECUTE')
     OR NOT pg_catalog.has_function_privilege('app_user', 'public.intercompany_allocation_cap_lock(uuid)', 'EXECUTE')
     OR pg_catalog.has_function_privilege('public', 'public.intercompany_allocation_clearable(uuid)', 'EXECUTE')
     OR NOT pg_catalog.has_function_privilege('app_user', 'public.intercompany_allocation_clearable(uuid)', 'EXECUTE')
     OR NOT pg_catalog.has_function_privilege('app_user', 'public.intercompany_is_loan_class(uuid, uuid)', 'EXECUTE')
     OR NOT pg_catalog.has_function_privilege('app_user', 'public.intercompany_allocation_target_ok(uuid, jsonb, uuid, uuid, text, uuid)', 'EXECUTE')
     OR NOT pg_catalog.has_function_privilege('migration_admin', 'public.intercompany_is_loan_class(uuid, uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION '1027: PUBLIC can execute an allocation clearing function, or app_user / migration_admin cannot execute what it needs';
  END IF;
  IF EXISTS (SELECT 1 FROM (VALUES ('intercompany_allocation_message_live(uuid)'), ('intercompany_allocation_clearable(uuid)')) d(sig)
              WHERE (SELECT pg_catalog.pg_get_userbyid(p.proowner) FROM pg_catalog.pg_proc p WHERE p.oid = ('public.' || d.sig)::regprocedure) <> 'migration_admin'
                 OR NOT EXISTS (SELECT 1 FROM public.app_definer_reviews r WHERE r.signature = d.sig
                                 AND r.body_md5 = public.app_definer_hash(('public.' || d.sig)::regprocedure))) THEN
    RAISE EXCEPTION '1027: a clearing definer is not owned by migration_admin, or its registry row does not hold its hash';
  END IF;
END $$;
