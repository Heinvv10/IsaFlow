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
--   Reasons, cheapest first, the first failure wins (all (false, reason) but ok):
--     not_found           not the receiver's allocation message (or no session, or no member)
--     not_pending         the message is handled (not pending / failed): it is not re-judged
--     allocation_gone     its payment_allocations row is gone (unapplied, a bank unwind, the payment deleted: the row cascades)
--     changed             the row's payment, bill or amount, or the payment's number / reference / date / method, the bill's number or currency,
--                         differ from the payload (text through intercompany_clean_text, money at 2 dp)
--     payment_not_posted  the payment is not the payer's, or not processed / reconciled (draft, approved, cancelled = voided, NULL)
--     journal_reversed    the journal the message recorded has an even (or no) reversal chain, or the payment's standing journal (its own, else
--                         its batch's, the batch being the payer's) is no longer the one recorded
--     bill_gone           the bill is not the payer's, or deleted
--     link_gone           the payload's link is not ACTIVE on the message's connection, joining the payer's bill to the receiver's issuerDocument
--                         customer_invoice, or that connection is not active / not loan
--     duplicate           another pending / failed allocation message to the receiver names the same payment and bill through a standing
--                         allocation row (belt and braces: the allocation row is UNIQUE(payment, bill) and the message key includes it)
--     ok                  (true, 'ok')
--   Unapply then re-apply makes a NEW allocation row and a new message: the old one answers allocation_gone, so only one is ever live.
-- The lock bound is tighten-only (2 s, never loosening a tighter caller's) and the caller's value is put back at the one exit.

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
  v_prev text;
  v_reason text;
  v_amount numeric;
  v_has_payment boolean;
  v_has_bill boolean;
  v_standing uuid;
  v_link uuid;
  v_issuer uuid;
  m RECORD;
  pa RECORD;
  sp RECORD;
  si RECORD;
BEGIN
  v_prev := pg_catalog.current_setting('lock_timeout');
  IF v_prev::interval = interval '0' OR v_prev::interval > interval '2s' THEN PERFORM pg_catalog.set_config('lock_timeout', '2s', true); END IF;
  <<main>>
  BEGIN
    -- the receiver only: a signed-in member of the session company, which is the message's to_company; anything else is the one answer
    IF v_co IS NULL OR auth.uid() IS NULL OR p_message IS NULL OR NOT (v_co IN (SELECT auth.user_companies())) THEN v_reason := 'not_found'; EXIT main; END IF;
    SELECT x.id, x.status, x.from_company_id, x.connection_id, x.source_doc_id, x.source_journal_entry_id AS je, x.payload INTO m
      FROM public.intercompany_messages x
     WHERE x.id = p_message AND x.to_company_id = v_co AND x.kind = 'allocation' AND x.source_doc_type = 'payment_allocation';
    IF NOT FOUND THEN v_reason := 'not_found'; EXIT main; END IF;
    IF m.status NOT IN ('pending', 'failed') THEN v_reason := 'not_pending'; EXIT main; END IF;
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
    -- the link the payload names (an id that is no UUID names none): still active on this connection, joining the payer's bill and the
    -- receiver's issuer invoice, on a connection that is active and settles by loan
    v_link := CASE WHEN (m.payload ->> 'linkId') ~ v_uuid THEN (m.payload ->> 'linkId')::uuid END;
    v_issuer := CASE WHEN (m.payload #>> '{issuerDocument,id}') ~ v_uuid THEN (m.payload #>> '{issuerDocument,id}')::uuid END;
    IF (m.payload #>> '{issuerDocument,type}') IS DISTINCT FROM 'customer_invoice' OR NOT EXISTS (
         SELECT 1 FROM public.intercompany_document_links k
           JOIN public.intercompany_connections c ON c.id = k.connection_id AND c.status = 'active' AND c.settlement_mode = 'loan'
          WHERE k.id = v_link AND k.status = 'active' AND k.connection_id = m.connection_id
            AND ((k.company_a_id = m.from_company_id AND k.doc_a_type = 'supplier_invoice' AND k.doc_a_id = pa.invoice_id
                  AND k.company_b_id = v_co AND k.doc_b_type = 'customer_invoice' AND k.doc_b_id = v_issuer)
              OR (k.company_b_id = m.from_company_id AND k.doc_b_type = 'supplier_invoice' AND k.doc_b_id = pa.invoice_id
                  AND k.company_a_id = v_co AND k.doc_a_type = 'customer_invoice' AND k.doc_a_id = v_issuer))) THEN
      v_reason := 'link_gone'; EXIT main;
    END IF;
    IF EXISTS (SELECT 1 FROM public.intercompany_messages o JOIN public.payment_allocations oa ON oa.id = o.source_doc_id
                WHERE o.to_company_id = v_co AND o.kind = 'allocation' AND o.source_doc_type = 'payment_allocation' AND o.id <> m.id
                  AND o.status IN ('pending', 'failed') AND oa.payment_id = pa.payment_id AND oa.invoice_id = pa.invoice_id
                  AND (o.payload #>> '{payment,id}') = pa.payment_id::text AND (o.payload #>> '{payerDocument,id}') = pa.invoice_id::text) THEN
      v_reason := 'duplicate'; EXIT main;
    END IF;
    v_reason := 'ok';
  END main;
  PERFORM pg_catalog.set_config('lock_timeout', v_prev, true);
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
     'nothing (STABLE): a read, for the RECEIVER of an allocation message only (a signed-in member of the session company, which is the message''s to_company), of that message, the payer''s payment_allocations row, its supplier_payments row, supplier_payment_batches (a member''s standing journal), supplier_invoices (each under the payer''s company), gl_journal_entries (the reversal chain of the journal the message recorded), intercompany_document_links, intercompany_connections and the receiver''s other allocation messages; answers one (live, reason) row and no row data; not_found for anyone else, a missing message or another kind')
  ) AS v(signature, fn, writes)
ON CONFLICT (signature) DO UPDATE SET writes = EXCLUDED.writes, body_md5 = EXCLUDED.body_md5;

DO $$
BEGIN
  IF pg_catalog.has_function_privilege('public', 'public.intercompany_allocation_message_live(uuid)', 'EXECUTE')
     OR NOT pg_catalog.has_function_privilege('app_user', 'public.intercompany_allocation_message_live(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION '1026: a role it must not reach can execute intercompany_allocation_message_live (PUBLIC), or app_user cannot';
  END IF;
END $$;
