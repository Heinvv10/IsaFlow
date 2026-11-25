-- 1026: Intercompany P4-C, the RECEIVER's question "is this allocation message still true?". Plan: docs/plans/2026-11-23-intercompany-p4c-allocation-inbox.md
-- (parent: docs/plans/2026-11-17-intercompany-mirror-posting.md, P4; the #1788 M1 prerequisite). Applies on top of 1025; idempotent (CREATE OR REPLACE,
-- ON CONFLICT). Forward only: no table, column or index changes, and NO change to the messages guard (D owns the accepted transition).

-- WHAT
--   intercompany_allocation_message_live(message id) RETURNS TABLE(live, reason), a registered SECURITY DEFINER (owner migration_admin), STABLE: it
--   reads and writes nothing else. The RECEIVER (the session company is the message's to_company, a signed-in member: a read role, not a write role)
--   asks whether the payer's rows an `allocation` message (1025) was built from still say what it says. The receiver cannot read the payer's rows;
--   this answers one row and nothing more. Everyone else, and a missing or non-allocation message, gets the same (false, 'not_found'): no
--   existence oracle. The answer is ADVISORY: it takes no row lock (a read of a settled fact needs none), so D re-calls it under its own locks,
--   inside the transaction that acts on the message.
--   Reasons, the first failure wins (all (false, reason) but ok). The RELATIONSHIP is judged before any payer row is read: a dead relationship
--   answers link_gone and nothing more specific, so the receiver learns nothing more of the payer's books once the pair is no longer live.
--     not_found           not the receiver's allocation message (or no session, or no member)
--     not_pending         the message is handled (not pending / failed): it is not re-judged
--     link_gone           the message's connection is not active or not loan, or the payload's link is not ACTIVE on it joining the payload's
--                         bill of the payer (supplier_invoice) to the receiver's issuerDocument customer_invoice (all from the payload and the
--                         link / connection rows: no payer document is read)
--     before_cutover      the connection has no cut-over, or the payload's payment date is before it (or is no date); one answer for both:
--                         nothing is mirrored before a cut-over the pair has set
--     allocation_gone     its payment_allocations row is gone (unapplied, a bank unwind, the payment deleted: the row cascades)
--     changed             the row's payment, bill or amount, or the payment's number / reference / date / method, the bill's number or currency,
--                         differ from the payload (text through intercompany_clean_text, money at 2 dp)
--     payment_not_posted  the payment is not the payer's, or not processed / reconciled (draft, approved, cancelled = voided, NULL)
--     journal_reversed    the journal the message recorded has an even (or no) reversal chain, or the payment's standing journal (its own, else
--                         its batch's, the batch being the payer's) is no longer the one recorded
--     bill_gone           the bill is not the payer's, or deleted
--     ok                  (true, 'ok')
--   Unapply then re-apply makes a NEW allocation row and a new message: the old one answers allocation_gone, so only one is ever live (two live
--   messages for one payment and bill cannot exist: the allocation row is UNIQUE(payment, bill) and the message key names that row).
--   No lock setting of its own: it takes no row lock. Its relation locks can still wait on DDL; the caller (allocationInbox.ts) bounds the wait
--   once per page (tighten-only 2 s) and stops asking after the first failure.

-- DEFINER REGISTRY (930): the definer is registered in app_definer_reviews AFTER its owner is set (the hash covers the owner). OLD COLOUR: nothing in
-- the previous release calls the function.

-- Rollback (code first):
--   DROP FUNCTION IF EXISTS public.intercompany_allocation_message_live(uuid);
--   DELETE FROM app_definer_reviews WHERE signature = 'intercompany_allocation_message_live(uuid)';
--   (nothing else: no table, guard, grant or other function is touched by this migration)

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

CREATE OR REPLACE FUNCTION public.intercompany_allocation_message_live(p_message uuid)
RETURNS TABLE (live boolean, reason text)
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
  END main;
  RETURN QUERY SELECT v_reason = 'ok', v_reason;
END;
$$;
ALTER FUNCTION public.intercompany_allocation_message_live(uuid) OWNER TO migration_admin;
REVOKE ALL ON FUNCTION public.intercompany_allocation_message_live(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.intercompany_allocation_message_live(uuid) TO app_user;

-- ── The definer registry (930), after the owner is set ──────────────────────

INSERT INTO public.app_definer_reviews (signature, writes, body_md5)
SELECT v.signature, v.writes, public.app_definer_hash(v.fn::regprocedure)
  FROM (VALUES
    ('intercompany_allocation_message_live(uuid)', 'public.intercompany_allocation_message_live(uuid)',
     'nothing (STABLE): a read, for the RECEIVER of an allocation message only (a signed-in member of the session company, which is the message''s to_company), of that message, the link and connection it names (judged first: a dead relationship is link_gone, the payment before the cut-over before_cutover, and no payer row is read for either), then the payer''s payment_allocations row, its supplier_payments row, supplier_payment_batches (a member''s standing journal), supplier_invoices (each under the payer''s company) and gl_journal_entries (the reversal chain of the journal the message recorded); answers one (live, reason) row and no row data; not_found for anyone else, a missing message or another kind')
  ) AS v(signature, fn, writes)
ON CONFLICT (signature) DO UPDATE SET writes = EXCLUDED.writes, body_md5 = EXCLUDED.body_md5;

DO $$
BEGIN
  IF pg_catalog.has_function_privilege('public', 'public.intercompany_allocation_message_live(uuid)', 'EXECUTE')
     OR NOT pg_catalog.has_function_privilege('app_user', 'public.intercompany_allocation_message_live(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION '1026: a role it must not reach can execute intercompany_allocation_message_live (PUBLIC), or app_user cannot';
  END IF;
END $$;
