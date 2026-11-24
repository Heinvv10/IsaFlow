-- 1031: Intercompany F, the payer's PAYMENT message and the receiver's match of it (cash mode). Plan: docs/plans/2026-11-24-intercompany-p6f-match-suggestions.md
-- (sections (k) and (l) binding; parent: docs/plans/2026-11-17-intercompany-mirror-posting.md, rule 3 cash mode, P4 row). Applies on top of 1029 (and
-- beside P5's 1030, which replaces none of these bodies). Forward only. NO JOURNAL is posted by anything here, in either company.

-- WHAT
--   IX1 intercompany_messages_one_payment_kind: ONE message of kind allocation OR payment per payer allocation row (from_company_id,
--       source_doc_id) WHERE source_doc_type = 'payment_allocation': the database authority for "never both kinds" (a race loser gets 23505,
--       which neither definer's ON CONFLICT absorbs: 1000's intercompany_messages_once includes the kind). The migration HALTS on duplicates.
--   IX2 intercompany_messages_target_uq (1002) narrowed to kind <> 'payment': a receipt absorbs SEVERAL accepted payment messages up to its total
--       (MED-2 consumption, enforced by the guard); every other kind keeps one accepted message per target.
--   intercompany_message_doc_exists: a 'payment' source branch identical to 'allocation''s.
--   H1 intercompany_payment_payer_standing(message), STABLE INVOKER, EXECUTE migration_admin only: 1029's allocation payer standing, kind payment.
--   D2 intercompany_payment_message_state(message) -> (live, state), registered SECURITY DEFINER, STABLE, no lock: the RECEIVER's one word,
--       first wins: connection_gone, not_enabled (its flag), future_dated, before_cutover (the connection's cut-over, payment date), payer_gone
--       (H1), link_gone, currency, then target_cancelled / target_ok for an accepted message, else open. (false, 'not_found') for anyone else.
--   H3 intercompany_allocation_cap_lock (1027): kind IN ('allocation', 'payment'), so a payment accept holds the payer's payment / journal / bill keys.
--   H2 intercompany_payment_target_ok(...), STABLE INVOKER (the guard's session): D2 says `open`, and the target is a non-contra receipt of the
--       receiver on the side's customer dated within [payment date, today], either the F draft stamped IC:<message> by the acting user for exactly
--       the amount on open rand invoices of that customer dated on or after the cut-over, or a confirmed / reconciled receipt in the MED-2
--       candidate set with an unconsumed amount >= the message's.
--   G1 the messages guard (the 1027 body): 'payment' is migration_admin's only (closes app_user's INSERT gap), names the sender's own payment
--       allocation, is accepted only after the cap lock and the receipt lock with a target H2 passes and within the receipt's consumption, and
--       the new system transition 'redraft' (D4) returns an accepted payment message to pending with no target and no handling.
--   D1 intercompany_send_for_payment(allocation), registered SECURITY DEFINER: the payer's payment message (see its header).
--   D3 intercompany_send_for_allocation (the 1025 body): the payer's flag in SQL, the payer journal key first, and payment_sent. Re-registered.
--   D4 intercompany_discard_payment_draft(message, payment, reason), registered SECURITY DEFINER: the receiver discards the F draft an accepted
--       payment message names (draft -> cancelled, message -> pending, the 'redraft' system transition).
--   The dark flag's description (one flag for both kinds, (k) Q5).

-- DEFINER REGISTRY (930): D1, D2, D4 registered, D3 re-registered (new hash), each AFTER create and owner change. OLD COLOUR: the previous release
-- calls D3 by the same signature and reads its reasons by name (two new words, not_enabled and payment_sent, both silent there); nothing in it
-- writes a payment message or reads D1, D2 or D4. The old release's allocationUndoGate reads kind = 'allocation' only: during the release window
-- an accepted PAYMENT message does not yet stop the old colour's void (accepted limit of the window: nothing accepts one before the new colour).

-- Rollback (code first), in THIS order:
--   1. Restore 1027's intercompany_messages_guard and intercompany_allocation_cap_lock, EXACTLY these two statements:
--        sed -n '/^CREATE OR REPLACE FUNCTION public.intercompany_messages_guard/,/^\$\$;/p' scripts/migrations/sql/1027_intercompany_p4d_allocation_clearing.sql | psql ...
--        sed -n '/^CREATE OR REPLACE FUNCTION public.intercompany_allocation_cap_lock/,/^\$\$;/p' scripts/migrations/sql/1027_intercompany_p4d_allocation_clearing.sql | psql ...
--   2. Restore 1025's intercompany_message_doc_exists and intercompany_send_for_allocation, EXACTLY these two statements, then re-register D3:
--        sed -n '/^CREATE OR REPLACE FUNCTION public.intercompany_message_doc_exists/,/^\$\$;/p' scripts/migrations/sql/1025_intercompany_p4b_allocation_sender.sql | psql ...
--        sed -n '/^CREATE OR REPLACE FUNCTION public.intercompany_send_for_allocation/,/^\$\$;/p' scripts/migrations/sql/1025_intercompany_p4b_allocation_sender.sql | psql ...
--        UPDATE app_definer_reviews SET body_md5 = app_definer_hash('public.intercompany_send_for_allocation(uuid)'::regprocedure) WHERE signature = 'intercompany_send_for_allocation(uuid)';
--   3. DROP FUNCTION IF EXISTS public.intercompany_discard_payment_draft(uuid, uuid, text);
--      DROP FUNCTION IF EXISTS public.intercompany_send_for_payment(uuid);
--      DROP FUNCTION IF EXISTS public.intercompany_payment_target_ok(uuid, jsonb, uuid, uuid, text, uuid);
--      DROP FUNCTION IF EXISTS public.intercompany_payment_message_state(uuid);
--      DROP FUNCTION IF EXISTS public.intercompany_payment_payer_standing(uuid);   (last: D2 calls it)
--      DELETE FROM app_definer_reviews WHERE signature IN ('intercompany_send_for_payment(uuid)', 'intercompany_payment_message_state(uuid)',
--        'intercompany_discard_payment_draft(uuid,uuid,text)');
--   4. IX2 back to 1002:258 (only once no two ACCEPTED payment messages share a target):
--        DROP INDEX IF EXISTS public.intercompany_messages_target_uq;
--        CREATE UNIQUE INDEX intercompany_messages_target_uq ON intercompany_messages (to_company_id, target_doc_type, target_doc_id)
--          WHERE status = 'accepted' AND target_doc_id IS NOT NULL;
--      DROP INDEX IF EXISTS public.intercompany_messages_one_payment_kind;
--   5. The flag's description back to 1028's text (cosmetic).
--   (payment messages and F draft receipts stay: they are the receiver's history; a draft is discarded through the app)

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- ── IX1 / IX2 ───────────────────────────────────────────────────────────────

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.intercompany_messages
              WHERE source_doc_type = 'payment_allocation' AND kind IN ('allocation', 'payment')
              GROUP BY from_company_id, source_doc_id HAVING count(*) > 1) THEN
    RAISE EXCEPTION '1031: a payer allocation row carries more than one allocation / payment message: resolve it by hand before this migration';
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS intercompany_messages_one_payment_kind
  ON public.intercompany_messages (from_company_id, source_doc_id)
  WHERE source_doc_type = 'payment_allocation' AND kind IN ('allocation', 'payment');

DROP INDEX IF EXISTS public.intercompany_messages_target_uq;
CREATE UNIQUE INDEX IF NOT EXISTS intercompany_messages_target_uq
  ON public.intercompany_messages (to_company_id, target_doc_type, target_doc_id)
  WHERE status = 'accepted' AND target_doc_id IS NOT NULL AND kind <> 'payment';

-- ── intercompany_message_doc_exists: the 'payment' source (the 1025 body + one branch) ──

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
    WHEN p_kind = 'payment' AND p_role = 'source' THEN p_type = 'payment_allocation'
      AND EXISTS (SELECT 1 FROM public.payment_allocations pa JOIN public.supplier_payments sp ON sp.id = pa.payment_id
                   WHERE pa.id = p_id AND sp.company_id = p_company)
    ELSE false
  END, false)
$$;

-- ── H1: the payer side of a payment message still stands (1029's rule, kind payment) ──

CREATE OR REPLACE FUNCTION public.intercompany_payment_payer_standing(p_message uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1
      FROM public.intercompany_messages m
      JOIN public.payment_allocations a ON a.id = m.source_doc_id
      JOIN public.supplier_payments p ON p.id = a.payment_id AND p.company_id = m.from_company_id AND p.status IN ('processed', 'reconciled')
     WHERE m.id = p_message AND m.kind = 'payment' AND m.source_doc_type = 'payment_allocation' AND m.source_journal_entry_id IS NOT NULL
       AND m.source_journal_entry_id = COALESCE(p.gl_journal_entry_id,
             (SELECT b.gl_journal_entry_id FROM public.supplier_payment_batches b WHERE b.id = p.batch_id AND b.company_id = m.from_company_id))
       AND COALESCE(public.intercompany_journal_chain_length(m.source_journal_entry_id, m.from_company_id), 0) % 2 = 1)
$$;
REVOKE ALL ON FUNCTION public.intercompany_payment_payer_standing(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.intercompany_payment_payer_standing(uuid) TO migration_admin;

-- ── D2: the receiver's state word ───────────────────────────────────────────

-- The RECEIVER only (a signed-in member of the session company, which is the message's to_company); anything else is (false, 'not_found').
-- One word, no figure, no id, no partner text. The guard (H2) and the confirm gate (icDraftConfirmGate.ts) ask it.
CREATE OR REPLACE FUNCTION public.intercompany_payment_message_state(p_message uuid)
RETURNS TABLE (live boolean, state text)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_co uuid := app.current_company_id();
  v_uuid constant text := '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';
  v_state text;
  v_flag boolean;
  v_date text;
  v_link uuid;
  v_issuer uuid;
  v_bill uuid;
  m RECORD;
  c RECORD;
BEGIN
  <<main>>
  BEGIN
    IF v_co IS NULL OR auth.uid() IS NULL OR p_message IS NULL OR NOT (v_co IN (SELECT auth.user_companies())) THEN v_state := 'not_found'; EXIT main; END IF;
    SELECT x.id, x.status, x.from_company_id, x.connection_id, x.payload, x.target_doc_type, x.target_doc_id INTO m
      FROM public.intercompany_messages x
     WHERE x.id = p_message AND x.to_company_id = v_co AND x.kind = 'payment' AND x.source_doc_type = 'payment_allocation';
    IF NOT FOUND THEN v_state := 'not_found'; EXIT main; END IF;
    -- the relationship: active, group, both companies still in one group (the STABLE helper; never the VOLATILE intercompany_in_one_group)
    SELECT k.status, k.kind, k.cutover_date, k.company_low_id, k.company_high_id INTO c FROM public.intercompany_connections k WHERE k.id = m.connection_id;
    IF NOT FOUND OR c.status <> 'active' OR c.kind <> 'group' OR NOT public.intercompany_shared_group(c.company_low_id, c.company_high_id) THEN
      v_state := 'connection_gone'; EXIT main;
    END IF;
    -- the receiver's dark flag: its override, else is_global; no plan read (fail closed)
    SELECT COALESCE(o.enabled, ff.is_global, false) INTO v_flag
      FROM public.feature_flags ff
      LEFT JOIN public.company_feature_overrides o ON o.feature_id = ff.id AND o.company_id = v_co
     WHERE ff.code = 'intercompany_loan_clearing';
    IF v_flag IS NOT TRUE THEN v_state := 'not_enabled'; EXIT main; END IF;
    v_date := m.payload #>> '{payment,date}';
    IF v_date ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
       AND v_date > pg_catalog.to_char((pg_catalog.now() AT TIME ZONE 'Africa/Johannesburg')::date, 'YYYY-MM-DD') THEN
      v_state := 'future_dated'; EXIT main;
    END IF;
    -- (MED-3) the connection's cut-over against the payment date: the sender's rule (1025 / D1), so the two sides agree
    IF c.cutover_date IS NULL OR v_date IS NULL OR v_date !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' OR v_date < pg_catalog.to_char(c.cutover_date, 'YYYY-MM-DD') THEN
      v_state := 'before_cutover'; EXIT main;
    END IF;
    IF NOT public.intercompany_payment_payer_standing(m.id) THEN v_state := 'payer_gone'; EXIT main; END IF;
    -- the payload's link still active on this connection, joining the payer's bill to the receiver's issuer invoice (an id that is no UUID names nothing)
    v_link := CASE WHEN (m.payload ->> 'linkId') ~ v_uuid THEN (m.payload ->> 'linkId')::uuid END;
    v_issuer := CASE WHEN (m.payload #>> '{issuerDocument,type}') = 'customer_invoice' AND (m.payload #>> '{issuerDocument,id}') ~ v_uuid
                     THEN (m.payload #>> '{issuerDocument,id}')::uuid END;
    v_bill := CASE WHEN (m.payload #>> '{payerDocument,id}') ~ v_uuid THEN (m.payload #>> '{payerDocument,id}')::uuid END;
    IF NOT EXISTS (
      SELECT 1 FROM public.intercompany_document_links k
       WHERE k.id = v_link AND k.status = 'active' AND k.connection_id = m.connection_id
         AND ((k.company_a_id = m.from_company_id AND k.doc_a_type = 'supplier_invoice' AND k.doc_a_id = v_bill
               AND k.company_b_id = v_co AND k.doc_b_type = 'customer_invoice' AND k.doc_b_id = v_issuer)
           OR (k.company_b_id = m.from_company_id AND k.doc_b_type = 'supplier_invoice' AND k.doc_b_id = v_bill
               AND k.company_a_id = v_co AND k.doc_a_type = 'customer_invoice' AND k.doc_a_id = v_issuer))) THEN
      v_state := 'link_gone'; EXIT main;
    END IF;
    IF pg_catalog.upper(COALESCE(m.payload ->> 'currency', '')) <> 'ZAR' THEN v_state := 'currency'; EXIT main; END IF;
    IF m.status = 'accepted' THEN
      v_state := CASE WHEN m.target_doc_type = 'customer_payment' AND EXISTS (
                        SELECT 1 FROM public.customer_payments p WHERE p.id = m.target_doc_id AND p.company_id = v_co AND p.status <> 'cancelled')
                      THEN 'target_ok' ELSE 'target_cancelled' END;
      EXIT main;
    END IF;
    v_state := 'open';
  END main;
  RETURN QUERY SELECT v_state IN ('open', 'target_ok'), v_state;
END;
$$;
ALTER FUNCTION public.intercompany_payment_message_state(uuid) OWNER TO migration_admin;
REVOKE ALL ON FUNCTION public.intercompany_payment_message_state(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.intercompany_payment_message_state(uuid) TO app_user;

-- ── H3: the payer's advisory locks, both payment kinds (the 1027 body, one word) ──

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
     WHERE m.id = p_message AND m.kind IN ('allocation', 'payment') AND m.to_company_id = app.current_company_id()
     ORDER BY x.key
  LOOP
    PERFORM pg_catalog.pg_advisory_xact_lock(k);
  END LOOP;
END;
$$;
REVOKE ALL ON FUNCTION public.intercompany_allocation_cap_lock(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.intercompany_allocation_cap_lock(uuid) TO app_user;

-- ── H2: the receipt a payment message is accepted with ─────────────────────

-- INVOKER (the guard's session: the receiver's own rows under RLS). The receipt row is already held FOR UPDATE by the guard (and by the accept
-- service before it), so the consumption read below is a statement after that wait. A receipt's journal counts while it is posted and never
-- reversed (app_user cannot ask intercompany_journal_chain_length; stricter than an odd chain: a reversal of a reversal is not a candidate).
CREATE OR REPLACE FUNCTION public.intercompany_payment_target_ok(
  p_message uuid, p_payload jsonb, p_connection uuid, p_receiver uuid, p_type text, p_id uuid)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_uuid constant text := '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';
  v_state text;
  v_amount numeric;
  v_paydate date;
  v_today date := (pg_catalog.now() AT TIME ZONE 'Africa/Johannesburg')::date;
  v_issuer uuid;
  v_customer uuid;
  v_cutover date;
  v_allocated numeric;
  v_consumed numeric;
  r RECORD;
BEGIN
  IF p_message IS NULL OR p_receiver IS NULL OR p_id IS NULL OR p_type IS DISTINCT FROM 'customer_payment' OR auth.uid() IS NULL THEN RETURN false; END IF;
  -- (k) H-2: the message is open in the receiver's words (flag, payer standing, link and connection alive, not future-dated, rand, cut-over)
  SELECT s.state INTO v_state FROM public.intercompany_payment_message_state(p_message) s;
  IF v_state IS DISTINCT FROM 'open' THEN RETURN false; END IF;
  v_amount := CASE WHEN pg_catalog.jsonb_typeof(p_payload -> 'amount') = 'number' THEN pg_catalog.round((p_payload ->> 'amount')::numeric, 2) END;
  v_paydate := CASE WHEN (p_payload #>> '{payment,date}') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN (p_payload #>> '{payment,date}')::date END;
  v_issuer := CASE WHEN (p_payload #>> '{issuerDocument,id}') ~ v_uuid THEN (p_payload #>> '{issuerDocument,id}')::uuid END;
  IF v_amount IS NULL OR v_amount <= 0 OR v_paydate IS NULL THEN RETURN false; END IF;
  SELECT s.customer_id INTO v_customer FROM public.intercompany_connection_sides s WHERE s.connection_id = p_connection AND s.company_id = p_receiver;
  SELECT c.cutover_date INTO v_cutover FROM public.intercompany_connections c WHERE c.id = p_connection;
  IF v_customer IS NULL OR v_cutover IS NULL THEN RETURN false; END IF;
  -- the receiver's own receipt on the side's customer, not a contra (a P4-D clearing), dated within [payment date, today]
  SELECT p.id, p.status, p.bank_reference, p.created_by, pg_catalog.round(p.total_amount, 2) AS total, p.gl_journal_entry_id AS je INTO r
    FROM public.customer_payments p
   WHERE p.id = p_id AND p.company_id = p_receiver AND p.client_id = v_customer AND p.payment_method IS DISTINCT FROM 'contra'
     AND p.payment_date >= v_paydate AND p.payment_date <= v_today;
  IF NOT FOUND THEN RETURN false; END IF;
  SELECT COALESCE(sum(a.amount_allocated), 0) INTO v_allocated FROM public.customer_payment_allocations a WHERE a.payment_id = p_id;
  IF r.status = 'draft' THEN
    -- the F draft: stamped for THIS message by the acting user, exactly the amount, allocated exactly, every invoice the receiver's, of the
    -- customer, in rand, open and dated on or after the connection's cut-over
    IF r.bank_reference IS DISTINCT FROM 'IC:' || p_message::text OR r.created_by::text IS DISTINCT FROM auth.uid()::text
       OR r.total <> v_amount OR pg_catalog.round(v_allocated, 2) <> v_amount THEN
      RETURN false;
    END IF;
    IF EXISTS (SELECT 1 FROM public.customer_payment_allocations a
                 LEFT JOIN public.customer_invoices ci ON ci.id = a.invoice_id AND ci.company_id = p_receiver AND ci.deleted_at IS NULL
                WHERE a.payment_id = p_id
                  AND (ci.id IS NULL OR COALESCE(ci.client_id, ci.customer_id) IS DISTINCT FROM v_customer
                       OR pg_catalog.upper(COALESCE(NULLIF(ci.currency_code, ''), 'ZAR')) <> 'ZAR'
                       OR ci.status IS NULL OR ci.status NOT IN ('approved', 'sent', 'partially_paid', 'overdue')
                       OR ci.invoice_date IS NULL OR ci.invoice_date < v_cutover)) THEN
      RETURN false;
    END IF;
    RETURN true;
  END IF;
  -- an existing receipt: the MED-2 candidate set (confirmed / reconciled on a standing journal; not the F draft of another message: keyed on
  -- that message's target AND its stamp, LOW-2; allocated to the linked invoice or with an unallocated remainder that covers the amount) and
  -- an unconsumed amount (its total less what accepted payment messages already took) that covers the amount
  IF r.status NOT IN ('confirmed', 'reconciled') OR r.je IS NULL
     OR NOT EXISTS (SELECT 1 FROM public.gl_journal_entries je WHERE je.id = r.je AND je.company_id = p_receiver AND je.status = 'posted')
     OR EXISTS (SELECT 1 FROM public.gl_journal_entries x WHERE x.reversal_of_id = r.je AND x.company_id = p_receiver)
     OR EXISTS (SELECT 1 FROM public.intercompany_messages x
                 WHERE x.to_company_id = p_receiver AND x.kind = 'payment' AND x.status = 'accepted' AND x.id <> p_message
                   AND x.target_doc_type = 'customer_payment' AND x.target_doc_id = p_id AND r.bank_reference = 'IC:' || x.id::text) THEN
    RETURN false;
  END IF;
  IF NOT (EXISTS (SELECT 1 FROM public.customer_payment_allocations a WHERE a.payment_id = p_id AND a.invoice_id = v_issuer)
          OR pg_catalog.round(r.total - v_allocated, 2) >= v_amount) THEN
    RETURN false;
  END IF;
  SELECT COALESCE(sum(pg_catalog.round((x.payload ->> 'amount')::numeric, 2)), 0) INTO v_consumed
    FROM public.intercompany_messages x
   WHERE x.to_company_id = p_receiver AND x.kind = 'payment' AND x.status = 'accepted' AND x.id <> p_message
     AND x.target_doc_type = 'customer_payment' AND x.target_doc_id = p_id AND pg_catalog.jsonb_typeof(x.payload -> 'amount') = 'number';
  RETURN r.total - v_consumed >= v_amount;
END;
$$;
REVOKE ALL ON FUNCTION public.intercompany_payment_target_ok(uuid, jsonb, uuid, uuid, text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.intercompany_payment_target_ok(uuid, jsonb, uuid, uuid, text, uuid) TO app_user;

-- ── G1: messages guard (the 1027 body; INSERT closes 'payment', the target section adds it, the system path adds 'redraft') ──

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
    -- definer; payment (1031): intercompany_send_for_payment, from the payer's own payment allocation on a CASH connection). A session writing
    -- one itself is how a payload carries what the sender's books do not.
    -- (ALLOW-LIST the definers' owner, deny every other login: the request login, the service login's own name, a role added later.)
    IF current_user <> 'migration_admin'
       AND (NEW.kind IN ('invoice', 'credit_note', 'interest_invoice', 'allocation', 'payment')
            OR NEW.source_doc_type IN ('customer_invoice', 'credit_note', 'supplier_invoice', 'payment_allocation')) THEN
      RAISE EXCEPTION 'a document message is written by the database from the sender''s document, not by the sender' USING ERRCODE = '42501';
    END IF;
    IF NOT public.intercompany_user_can_write(NEW.from_company_id) THEN
      RAISE EXCEPTION 'a message is sent by a user with a write role in the sending company' USING ERRCODE = '42501';
    END IF;
    -- A message that carries a document names one of the SENDER's (the session company), of the type its kind needs: nobody
    -- can send, and the receiver then mirror-link, another company's invoice.
    IF NEW.kind IN ('invoice', 'credit_note', 'interest_invoice', 'allocation', 'payment')
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
       OR NEW.created_at IS DISTINCT FROM OLD.created_at OR NEW.reason IS DISTINCT FROM OLD.reason OR NEW.error IS DISTINCT FROM OLD.error
       -- (1031, LOW-1) a redraft clears the target and the handling and sets manual_only: its own arm below holds it to exactly that
       OR (v_system <> 'redraft' AND (NEW.target_doc_type IS DISTINCT FROM OLD.target_doc_type
             OR NEW.target_doc_id IS DISTINCT FROM OLD.target_doc_id OR NEW.handled_by IS DISTINCT FROM OLD.handled_by
             OR NEW.handled_at IS DISTINCT FROM OLD.handled_at OR NEW.handled_via IS DISTINCT FROM OLD.handled_via
             OR NEW.manual_only IS DISTINCT FROM OLD.manual_only))
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
    ELSIF v_system = 'redraft' THEN
      -- (1031, Q1) intercompany_discard_payment_draft: the receiver discarded the F draft an accepted PAYMENT message named; the message is open
      -- again, with no target and no handling, a person's to handle (never the worker's); nothing else moves
      IF NOT (NEW.kind = 'payment' AND OLD.status = 'accepted' AND NEW.status = 'pending'
              AND NEW.target_doc_type IS NULL AND NEW.target_doc_id IS NULL
              AND NEW.handled_by IS NULL AND NEW.handled_at IS NULL AND NEW.handled_via IS NULL AND NEW.manual_only IS TRUE
              AND NEW.source_cancelled_at IS NOT DISTINCT FROM OLD.source_cancelled_at
              AND NEW.auto_attempts IS NOT DISTINCT FROM OLD.auto_attempts
              AND NEW.auto_next_attempt_at IS NOT DISTINCT FROM OLD.auto_next_attempt_at) THEN
        RAISE EXCEPTION 'a redraft returns an accepted payment message to pending with no target' USING ERRCODE = '23514';
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
  ELSIF NEW.kind = 'payment' THEN
    -- (1031) A payment message is accepted with a RECEIPT of the receiver that matches it (paymentAcceptService.ts: an existing receipt, or the F
    -- draft it created): the payer's cap lock first (every acceptance of the same payer payment / journal / bill waits: re-entrant when the
    -- service holds it), then the receipt row FOR UPDATE (concurrent accepts onto one receipt serialise), then, each its own statement (a
    -- snapshot after the waits), intercompany_payment_target_ok (the message must be `open` in D2's words, H-2) and the consumption rule:
    -- a receipt absorbs accepted payment messages up to its total (MED-2; the one-accepted-message-per-target index excludes this kind, IX2).
    -- Its target changes on no other transition.
    IF NEW.status = 'accepted' THEN
      PERFORM public.intercompany_allocation_cap_lock(OLD.id);
      PERFORM 1 FROM customer_payments p WHERE NEW.target_doc_type = 'customer_payment' AND p.id = NEW.target_doc_id AND p.company_id = OLD.to_company_id FOR UPDATE;
      IF NOT public.intercompany_payment_target_ok(OLD.id, OLD.payload, OLD.connection_id, OLD.to_company_id, NEW.target_doc_type, NEW.target_doc_id) THEN
        RAISE EXCEPTION 'a payment message is accepted with a receipt of the receiving company that matches it' USING ERRCODE = '23514';
      END IF;
      IF (SELECT pg_catalog.round(p.total_amount, 2) FROM customer_payments p WHERE p.id = NEW.target_doc_id AND p.company_id = OLD.to_company_id)
         - COALESCE((SELECT sum(pg_catalog.round((m.payload ->> 'amount')::numeric, 2)) FROM intercompany_messages m
                      WHERE m.to_company_id = OLD.to_company_id AND m.id <> OLD.id AND m.kind = 'payment' AND m.status = 'accepted'
                        AND m.target_doc_type = 'customer_payment' AND m.target_doc_id = NEW.target_doc_id
                        AND pg_catalog.jsonb_typeof(m.payload -> 'amount') = 'number'), 0)
         < pg_catalog.round((OLD.payload ->> 'amount')::numeric, 2) THEN
        RAISE EXCEPTION 'a receipt absorbs accepted payment messages up to its total' USING ERRCODE = '23514';
      END IF;
    ELSIF NEW.target_doc_type IS DISTINCT FROM OLD.target_doc_type OR NEW.target_doc_id IS DISTINCT FROM OLD.target_doc_id THEN
      RAISE EXCEPTION 'a payment message names its receipt only when it is accepted' USING ERRCODE = '23514';
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

-- ── D1: the payer's payment message ─────────────────────────────────────────

-- Session company P = app.current_company_id(); every answer but the message is (NULL, reason, NULL). In order (the first that applies):
--   no_session        no session company or no signed-in user (a caller outside a request), before any row
--   not_found         a NULL allocation id
--   forbidden         no intercompany write role in P (before anything about a row, a link or a connection)
--   not_enabled       P's dark flag intercompany_loan_clearing: its override, else is_global; no plan read (fail closed)
--   not_found         the allocation, its payment (P's) or its bill (P's, not deleted) is not there
--   not_posted / no_journal   the payment has no journal root to key on (not processed / reconciled: not_posted; else no_journal)
--   -- the PAYER JOURNAL KEY of that root (1027's key; the cap lock, the undo gate and D3 take it): every check below re-reads after the wait --
--   not_partner_supplier   the bill's supplier is the payer side's supplier on no ACTIVE CASH connection of P
--   ambiguous         it is on more than one (no LIMIT 1, Q6; the unique side index makes this unreachable today: defence in depth)
--   not_linked        the bill holds no ACTIVE link on THAT connection to a customer invoice of the partner (link and connection FOR SHARE)
--   no_connection / not_group / not_cash   the connection as it stands under the share
--   no_cutover / before_cutover   the connection's cut-over and the payment date (1025's and 1027's live rule, MED-3)
--   not_posted / no_journal   processed or reconciled, on its standing journal (its own, else its batch's) with an odd chain
--   through_loan      that journal credits the payer side's loan account (the allocation kind's, D3)
--   allocation_sent   an allocation message exists for this row (Z1)
--   superseded        an ACCEPTED message of P for the same payment names an allocation row that no longer exists (MED-1)
--   already_sent      a payment message for this row exists (the unique key makes the INSERT a no-op for a racing writer too)
-- The lock bound is tighten-only (2 s) and the caller's value is put back at the one exit.
CREATE OR REPLACE FUNCTION public.intercompany_send_for_payment(p_allocation uuid)
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
  v_flag boolean;
  v_root uuid;
  v_je uuid;
  v_n integer;
  v_conn uuid;
  v_loan uuid;
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
    SELECT COALESCE(o.enabled, ff.is_global, false) INTO v_flag
      FROM public.feature_flags ff
      LEFT JOIN public.company_feature_overrides o ON o.feature_id = ff.id AND o.company_id = v_co
     WHERE ff.code = 'intercompany_loan_clearing';
    IF v_flag IS NOT TRUE THEN v_reason := 'not_enabled'; EXIT main; END IF;
    -- the payer's own rows (an unlocked read: the root to key on)
    SELECT sp.gl_journal_entry_id AS payment_journal, sp.batch_id, sp.status AS payment_status INTO a
      FROM public.payment_allocations pa
      JOIN public.supplier_payments sp ON sp.id = pa.payment_id AND sp.company_id = v_co
      JOIN public.supplier_invoices si ON si.id = pa.invoice_id AND si.company_id = v_co AND si.deleted_at IS NULL
     WHERE pa.id = p_allocation;
    IF NOT FOUND THEN v_reason := 'not_found'; EXIT main; END IF;
    v_root := COALESCE(a.payment_journal,
                       (SELECT b.gl_journal_entry_id FROM public.supplier_payment_batches b WHERE b.id = a.batch_id AND b.company_id = v_co));
    IF v_root IS NULL THEN
      v_reason := CASE WHEN a.payment_status IN ('processed', 'reconciled') THEN 'no_journal' ELSE 'not_posted' END; EXIT main;
    END IF;
    PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(v_co::text || ':journal:' || v_root::text, 1027));
    -- after the wait, everything again
    SELECT pa.amount_allocated AS amount, sp.id AS payment_id, sp.payment_number, sp.reference, sp.payment_date, sp.payment_method, sp.status AS payment_status,
           sp.gl_journal_entry_id AS payment_journal, sp.batch_id, si.id AS bill_id, si.invoice_number AS bill_number, si.invoice_date AS bill_date,
           si.supplier_id, COALESCE(NULLIF(si.currency_code, ''), NULLIF(si.currency, ''), 'ZAR') AS currency
      INTO a FROM public.payment_allocations pa
      JOIN public.supplier_payments sp ON sp.id = pa.payment_id AND sp.company_id = v_co
      JOIN public.supplier_invoices si ON si.id = pa.invoice_id AND si.company_id = v_co AND si.deleted_at IS NULL
     WHERE pa.id = p_allocation;
    IF NOT FOUND THEN v_reason := 'not_found'; EXIT main; END IF;
    -- the bill's supplier on exactly one active cash connection side of P
    SELECT count(*)::integer, min(s.connection_id::text)::uuid INTO v_n, v_conn
      FROM public.intercompany_connection_sides s
      JOIN public.intercompany_connections c ON c.id = s.connection_id AND c.status = 'active' AND c.settlement_mode = 'cash'
     WHERE s.company_id = v_co AND s.supplier_id = a.supplier_id;
    IF v_n = 0 THEN v_reason := 'not_partner_supplier'; EXIT main; END IF;
    IF v_n > 1 THEN v_reason := 'ambiguous'; EXIT main; END IF;
    -- the bill's ACTIVE link on THAT connection to the partner's customer invoice (one active link per document: no LIMIT); held FOR SHARE
    SELECT k.id AS link_id, k.connection_id, c.status AS connection_status, c.kind, c.settlement_mode, c.cutover_date,
           CASE WHEN c.company_low_id = v_co THEN c.company_high_id ELSE c.company_low_id END AS partner,
           CASE WHEN k.company_a_id = v_co THEN k.doc_b_id ELSE k.doc_a_id END AS issuer_doc
      INTO l FROM public.intercompany_document_slots s
      JOIN public.intercompany_document_links k ON k.id = s.link_id AND k.status = 'active' AND k.connection_id = v_conn
      JOIN public.intercompany_connections c ON c.id = k.connection_id AND v_co IN (c.company_low_id, c.company_high_id)
     WHERE s.company_id = v_co AND s.doc_type = 'supplier_invoice' AND s.doc_id = a.bill_id
       AND ((k.company_a_id = v_co AND k.doc_a_type = 'supplier_invoice' AND k.doc_a_id = a.bill_id
             AND k.doc_b_type = 'customer_invoice' AND k.company_b_id = CASE WHEN c.company_low_id = v_co THEN c.company_high_id ELSE c.company_low_id END)
         OR (k.company_b_id = v_co AND k.doc_b_type = 'supplier_invoice' AND k.doc_b_id = a.bill_id
             AND k.doc_a_type = 'customer_invoice' AND k.company_a_id = CASE WHEN c.company_low_id = v_co THEN c.company_high_id ELSE c.company_low_id END))
       FOR SHARE OF k, c;
    IF NOT FOUND THEN v_reason := 'not_linked'; EXIT main; END IF;
    IF l.connection_status <> 'active' THEN v_reason := 'no_connection'; EXIT main; END IF;
    IF l.kind <> 'group' THEN v_reason := 'not_group'; EXIT main; END IF;
    IF l.settlement_mode IS DISTINCT FROM 'cash' THEN v_reason := 'not_cash'; EXIT main; END IF;
    IF l.cutover_date IS NULL THEN v_reason := 'no_cutover'; EXIT main; END IF;
    IF a.payment_date < l.cutover_date THEN v_reason := 'before_cutover'; EXIT main; END IF;
    IF a.payment_status IS NULL OR a.payment_status NOT IN ('processed', 'reconciled') THEN v_reason := 'not_posted'; EXIT main; END IF;
    v_je := COALESCE(a.payment_journal,
                     (SELECT b.gl_journal_entry_id FROM public.supplier_payment_batches b WHERE b.id = a.batch_id AND b.company_id = v_co));
    IF v_je IS NULL OR v_je IS DISTINCT FROM v_root OR public.intercompany_journal_chain_length(v_je, v_co) % 2 <> 1 THEN
      v_reason := 'no_journal'; EXIT main;
    END IF;
    SELECT s.loan_account_id INTO v_loan FROM public.intercompany_connection_sides s WHERE s.connection_id = l.connection_id AND s.company_id = v_co;
    IF v_loan IS NOT NULL AND EXISTS (SELECT 1 FROM public.gl_journal_lines jl
                                       WHERE jl.journal_entry_id = v_je AND jl.company_id = v_co AND jl.gl_account_id = v_loan AND jl.credit > 0) THEN
      v_reason := 'through_loan'; EXIT main;
    END IF;
    IF EXISTS (SELECT 1 FROM public.intercompany_messages m WHERE m.from_company_id = v_co AND m.source_doc_type = 'payment_allocation'
                  AND m.source_doc_id = p_allocation AND m.kind = 'allocation') THEN
      v_reason := 'allocation_sent'; EXIT main;
    END IF;
    IF EXISTS (SELECT 1 FROM public.intercompany_messages m
                WHERE m.from_company_id = v_co AND m.kind IN ('allocation', 'payment') AND m.status = 'accepted'
                  AND m.source_doc_type = 'payment_allocation' AND (m.payload #>> '{payment,id}') = a.payment_id::text
                  AND NOT EXISTS (SELECT 1 FROM public.payment_allocations x WHERE x.id = m.source_doc_id)) THEN
      v_reason := 'superseded'; EXIT main;
    END IF;
    IF EXISTS (SELECT 1 FROM public.intercompany_messages m WHERE m.from_company_id = v_co AND m.source_doc_type = 'payment_allocation'
                  AND m.source_doc_id = p_allocation AND m.kind = 'payment') THEN
      v_reason := 'already_sent'; EXIT main;
    END IF;
    INSERT INTO public.intercompany_messages (connection_id, from_company_id, to_company_id, kind, source_doc_type, source_doc_id, payload, source_journal_entry_id)
    VALUES (l.connection_id, v_co, l.partner, 'payment', 'payment_allocation', p_allocation,
            pg_catalog.jsonb_build_object(
              'version', 1, 'kind', 'payment', 'allocationId', p_allocation, 'amount', pg_catalog.round(a.amount, 2), 'currency', a.currency,
              'payment', pg_catalog.jsonb_build_object(
                'id', a.payment_id, 'number', public.intercompany_clean_text(a.payment_number, 50), 'reference', public.intercompany_clean_text(a.reference, 255),
                'date', pg_catalog.to_char(a.payment_date, 'YYYY-MM-DD'), 'method', public.intercompany_clean_text(a.payment_method, 20)),
              'payerDocument', pg_catalog.jsonb_build_object('type', 'supplier_invoice', 'id', a.bill_id,
                'number', public.intercompany_clean_text(a.bill_number, 100), 'date', pg_catalog.to_char(a.bill_date, 'YYYY-MM-DD')),
              'issuerDocument', pg_catalog.jsonb_build_object('type', 'customer_invoice', 'id', l.issuer_doc),
              'linkId', l.link_id),
            v_je)
    ON CONFLICT (from_company_id, source_doc_type, source_doc_id, kind) DO NOTHING
    RETURNING id INTO v_msg;
    IF v_msg IS NULL THEN v_reason := 'already_sent'; END IF;
  END main;
  PERFORM pg_catalog.set_config('lock_timeout', v_prev, true);
  RETURN QUERY SELECT v_msg, v_reason, NULL::text;
END;
$$;
ALTER FUNCTION public.intercompany_send_for_payment(uuid) OWNER TO migration_admin;
REVOKE ALL ON FUNCTION public.intercompany_send_for_payment(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.intercompany_send_for_payment(uuid) TO app_user;

-- ── D3: the allocation sender (the 1025 body: the flag in SQL, the payer journal key first, payment_sent) ──

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
  v_flag boolean;
  v_root uuid;
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
    -- (1031, L-1) the payer's dark flag, in SQL: its override, else is_global; no plan read (fail closed)
    SELECT COALESCE(o.enabled, ff.is_global, false) INTO v_flag
      FROM public.feature_flags ff
      LEFT JOIN public.company_feature_overrides o ON o.feature_id = ff.id AND o.company_id = v_co
     WHERE ff.code = 'intercompany_loan_clearing';
    IF v_flag IS NOT TRUE THEN v_reason := 'not_enabled'; EXIT main; END IF;
    -- 1: the payer's own rows, the company named on the payment AND on the bill
    SELECT pa.amount_allocated AS amount, sp.id AS payment_id, sp.payment_number, sp.reference, sp.payment_date, sp.payment_method, sp.status AS payment_status,
           sp.gl_journal_entry_id AS payment_journal, sp.batch_id, si.id AS bill_id, si.invoice_number AS bill_number,
           COALESCE(NULLIF(si.currency_code, ''), NULLIF(si.currency, ''), 'ZAR') AS currency
      INTO a FROM public.payment_allocations pa
      JOIN public.supplier_payments sp ON sp.id = pa.payment_id AND sp.company_id = v_co
      JOIN public.supplier_invoices si ON si.id = pa.invoice_id AND si.company_id = v_co AND si.deleted_at IS NULL
     WHERE pa.id = p_allocation;
    IF NOT FOUND THEN v_reason := 'not_found'; EXIT main; END IF;
    -- (1031, MED-4) the PAYER JOURNAL KEY of the payment's standing journal root (its own, else its batch's: an unlocked read of the payer's
    -- payment row), BEFORE the link / connection FOR SHARE below: the key 1027's cap lock, the payer undo gate and D1 take. A payment with no
    -- journal yet has nothing a receiver could clear or match, so nothing to wait for (it is refused below). Every check after the key
    -- re-reads (a new statement, a new snapshot): the payer's rows again first.
    v_root := COALESCE(a.payment_journal,
                       (SELECT b.gl_journal_entry_id FROM public.supplier_payment_batches b WHERE b.id = a.batch_id AND b.company_id = v_co));
    IF v_root IS NOT NULL THEN
      PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(v_co::text || ':journal:' || v_root::text, 1027));
      SELECT pa.amount_allocated AS amount, sp.id AS payment_id, sp.payment_number, sp.reference, sp.payment_date, sp.payment_method, sp.status AS payment_status,
             sp.gl_journal_entry_id AS payment_journal, sp.batch_id, si.id AS bill_id, si.invoice_number AS bill_number,
             COALESCE(NULLIF(si.currency_code, ''), NULLIF(si.currency, ''), 'ZAR') AS currency
        INTO a FROM public.payment_allocations pa
        JOIN public.supplier_payments sp ON sp.id = pa.payment_id AND sp.company_id = v_co
        JOIN public.supplier_invoices si ON si.id = pa.invoice_id AND si.company_id = v_co AND si.deleted_at IS NULL
       WHERE pa.id = p_allocation;
      IF NOT FOUND THEN v_reason := 'not_found'; EXIT main; END IF;
    END IF;
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
       FOR SHARE OF k, c;   -- a revoke / unlink in flight is waited for here (under the 2 s bound) and the row is re-read as it then stands. The two row locks last until
                            -- the CALLER'S TRANSACTION ends (a row lock survives the savepoint release, and in processBatch spans every member's call), not just
                            -- until this function returns: a later revoke / unlink waits for the caller's commit.
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
    -- (1031, Z1) once across the two kinds: a payment message for this row (sent while the connection was cash) is the row's one message
    IF EXISTS (SELECT 1 FROM public.intercompany_messages m WHERE m.from_company_id = v_co AND m.source_doc_type = 'payment_allocation'
                  AND m.source_doc_id = p_allocation AND m.kind = 'payment') THEN
      v_reason := 'payment_sent'; EXIT main;
    END IF;
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

-- ── D4: the receiver discards the F draft of an accepted payment message ─────

-- (k) Q1. One transaction (the request's), this order (M-3): the session company is the message's receiver and the session user a member with
-- the intercompany write role AND Approve on Customers & AR (the app's rule: owner / admin always; a write role holds it by its
-- company_user_permissions row, else a manager's default unless withheld); the message FOR UPDATE (payment, accepted, its target this receipt);
-- the receipt FOR UPDATE (the receiver's, stamped IC:<message>, not a contra); the receipt draft -> cancelled (its allocation rows stay, as
-- cancelCustomerPayment keeps them; a cancelled draft claims nothing on the invoice); then the message back to pending with no target through
-- the guard's 'redraft' system transition. Answers (ok, reason): forbidden, not_found, not_target, not_ic_draft, not_draft (nothing written
-- for any of them) or (true, 'ok'). customer_payments has no cancelled_by / cancelled_at / reason columns: the reason goes in its description
-- (cancelCustomerPayment's form) and who / when in the service's audit_log row.
CREATE OR REPLACE FUNCTION public.intercompany_discard_payment_draft(p_message uuid, p_payment uuid, p_reason text)
RETURNS TABLE (ok boolean, reason text)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_co uuid := app.current_company_id();
  v_reason text;
  v_id uuid;
  v_note text;
  u RECORD;
  m RECORD;
  p RECORD;
BEGIN
  <<main>>
  BEGIN
    IF v_co IS NULL OR auth.uid() IS NULL OR p_message IS NULL OR p_payment IS NULL OR NOT (v_co IN (SELECT auth.user_companies()))
       OR NOT public.intercompany_user_can_write(v_co) THEN
      v_reason := 'forbidden'; EXIT main;
    END IF;
    SELECT cu.role, COALESCE(cu.approve_withheld, false) AS withheld, perm.can_approve, (perm.module_key IS NOT NULL) AS has_row INTO u
      FROM public.company_users cu
      LEFT JOIN public.company_user_permissions perm ON perm.company_id = cu.company_id AND perm.user_id = cu.user_id AND perm.module_key = 'customers'
     WHERE cu.company_id = v_co AND cu.user_id::text = auth.uid()::text
     LIMIT 1;
    IF NOT FOUND OR NOT (u.role IN ('owner', 'admin')
                         OR (u.role IN ('manager', 'accountant', 'bookkeeper')
                             AND CASE WHEN u.has_row THEN COALESCE(u.can_approve, false)
                                      ELSE NOT (u.withheld OR u.role IN ('accountant', 'bookkeeper')) END)) THEN
      v_reason := 'forbidden'; EXIT main;
    END IF;
    SELECT x.id, x.status, x.target_doc_type, x.target_doc_id INTO m
      FROM public.intercompany_messages x WHERE x.id = p_message AND x.to_company_id = v_co AND x.kind = 'payment'
       FOR UPDATE;
    IF NOT FOUND THEN v_reason := 'not_found'; EXIT main; END IF;
    IF m.status <> 'accepted' OR m.target_doc_type IS DISTINCT FROM 'customer_payment' OR m.target_doc_id IS DISTINCT FROM p_payment THEN
      v_reason := 'not_target'; EXIT main;
    END IF;
    SELECT x.id, x.bank_reference, x.payment_method INTO p
      FROM public.customer_payments x WHERE x.id = p_payment AND x.company_id = v_co
       FOR UPDATE;
    IF NOT FOUND OR p.bank_reference IS DISTINCT FROM 'IC:' || p_message::text OR p.payment_method IS NOT DISTINCT FROM 'contra' THEN
      v_reason := 'not_ic_draft'; EXIT main;
    END IF;
    v_note := ' [CANCELLED: ' || COALESCE(NULLIF(public.intercompany_clean_text(p_reason, 200), ''), 'intercompany draft discarded') || ']';
    UPDATE public.customer_payments SET status = 'cancelled', description = COALESCE(description, '') || v_note
     WHERE id = p_payment AND company_id = v_co AND status = 'draft'
    RETURNING id INTO v_id;
    IF v_id IS NULL THEN v_reason := 'not_draft'; EXIT main; END IF;
    PERFORM pg_catalog.set_config('app.intercompany_system_update', 'redraft', true);
    UPDATE public.intercompany_messages
       SET status = 'pending', target_doc_type = NULL, target_doc_id = NULL, handled_by = NULL, handled_at = NULL, handled_via = NULL, manual_only = true
     WHERE id = p_message AND to_company_id = v_co;
    PERFORM pg_catalog.set_config('app.intercompany_system_update', '', true);
    v_reason := 'ok';
  END main;
  RETURN QUERY SELECT v_reason = 'ok', v_reason;
END;
$$;
ALTER FUNCTION public.intercompany_discard_payment_draft(uuid, uuid, text) OWNER TO migration_admin;
REVOKE ALL ON FUNCTION public.intercompany_discard_payment_draft(uuid, uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.intercompany_discard_payment_draft(uuid, uuid, text) TO app_user;

-- ── The flag's description (Q5: one flag for both kinds) ────────────────────

UPDATE public.feature_flags
   SET description = 'Intercompany payment messages: loan-mode clearing (allocation messages) and cash-mode payment match suggestions (payment messages). Off by default.'
 WHERE code = 'intercompany_loan_clearing';

-- ── The definer registry (930), after the owners are set ────────────────────

INSERT INTO public.app_definer_reviews (signature, writes, body_md5)
SELECT v.signature, v.writes, public.app_definer_hash(v.fn::regprocedure)
  FROM (VALUES
    ('intercompany_send_for_payment(uuid)', 'public.intercompany_send_for_payment(uuid)',
     'intercompany_messages (one kind=''payment'' message, its payload built from the session company''s own payment allocation: its processed or reconciled supplier payment on a posted, standing journal that does not credit its loan account, its bill, and the ACTIVE link of that bill to the partner''s customer invoice on the ONE active CASH group connection whose payer side names the bill''s supplier, past the connection''s cut-over, recording that journal) for the session company (a write-role user, the dark flag on) only; nothing else is written (no journal, no document), a read of payment_allocations, supplier_payments, supplier_payment_batches, supplier_invoices, gl_journal_entries, gl_journal_lines (the reversal chain, the loan-account credit), intercompany_document_slots, intercompany_document_links (held FOR SHARE), intercompany_connections (held FOR SHARE), intercompany_connection_sides, feature_flags, company_feature_overrides, company_users (the write role) and intercompany_messages (has either kind been written for the row; an accepted message of the payment whose row is gone); takes one advisory key (the payer journal key of the payment''s journal root); nothing for another company''s rows'),
    ('intercompany_payment_message_state(uuid)', 'public.intercompany_payment_message_state(uuid)',
     'nothing (STABLE, no lock): for the RECEIVER of a payment message only (a signed-in member of the session company, which is the message''s to_company), a read of that message, its intercompany_connections row and company_group_members / company_groups (intercompany_shared_group), feature_flags / company_feature_overrides (its own flag), intercompany_document_links (the payload''s link), through intercompany_payment_payer_standing the payer''s payment_allocations / supplier_payments / supplier_payment_batches rows and journal chain (gl_journal_entries), and for an accepted message its target receipt (customer_payments, the receiver''s); answers one (live, state) row, one word and no row data; not_found for anyone else, a missing message or another kind'),
    ('intercompany_send_for_allocation(uuid)', 'public.intercompany_send_for_allocation(uuid)',
     'intercompany_messages (one kind=''allocation'' message, its payload built from the session company''s own payment allocation: its processed or reconciled supplier payment on a posted, standing journal, its bill, and the ACTIVE link of that bill to the partner''s customer invoice on an active LOAN connection past its cut-over, recording that journal) for the session company (a write-role user, the dark flag on) only; nothing else is written (no journal, no group row, no document), a read of payment_allocations, supplier_payments, supplier_invoices, supplier_payment_batches, gl_journal_entries, gl_journal_lines, intercompany_messages (has a message of either kind been written: and a read of payment messages), company_users (the write role), intercompany_document_slots, intercompany_document_links (held FOR SHARE), intercompany_connections (held FOR SHARE), intercompany_connection_sides, feature_flags and company_feature_overrides; takes one advisory key (the payer journal key of the payment''s journal root, before the shares); nothing for another company''s rows'),
    ('intercompany_discard_payment_draft(uuid,uuid,text)', 'public.intercompany_discard_payment_draft(uuid, uuid, text)',
     'customer_payments (one row of the session company: the F draft stamped IC:<message> that an accepted payment message names, status draft -> cancelled, the reason appended to its description) and intercompany_messages (that message back to pending with no target and no handling, manual_only, through the guard''s redraft system transition) for the RECEIVER (a signed-in member with an intercompany write role and Approve on Customers & AR) only; a read of company_users and company_user_permissions (the approve right), the message FOR UPDATE and the receipt FOR UPDATE; nothing else')
  ) AS v(signature, fn, writes)
ON CONFLICT (signature) DO UPDATE SET writes = EXCLUDED.writes, body_md5 = EXCLUDED.body_md5;

-- DEPLOY-SAFE (the 1027 / 1029 pattern): any role other than a superuser, the owner (or a member of it), app_user (not for H1) or
-- migration_admin (or a member of either) found able to EXECUTE one of these has it REVOKED; a revoke that fails is a WARNING, never a halt.
DO $$
DECLARE
  g RECORD;
BEGIN
  FOR g IN
    SELECT r.rolname, f.sig
      FROM (VALUES ('public.intercompany_send_for_payment(uuid)'), ('public.intercompany_payment_message_state(uuid)'),
                   ('public.intercompany_send_for_allocation(uuid)'), ('public.intercompany_discard_payment_draft(uuid, uuid, text)'),
                   ('public.intercompany_payment_payer_standing(uuid)'), ('public.intercompany_payment_target_ok(uuid, jsonb, uuid, uuid, text, uuid)'),
                   ('public.intercompany_allocation_cap_lock(uuid)')) AS f(sig)
      JOIN pg_catalog.pg_proc p ON p.oid = f.sig::regprocedure
     CROSS JOIN pg_catalog.pg_roles r
     WHERE pg_catalog.has_function_privilege(r.oid, p.oid, 'EXECUTE')
       AND NOT (r.rolsuper OR r.oid = p.proowner OR pg_catalog.pg_has_role(r.oid, p.proowner, 'MEMBER')
                OR (f.sig <> 'public.intercompany_payment_payer_standing(uuid)' AND pg_catalog.pg_has_role(r.oid, 'app_user', 'MEMBER'))
                OR pg_catalog.pg_has_role(r.oid, 'migration_admin', 'MEMBER'))
     ORDER BY r.rolname, f.sig
  LOOP
    BEGIN
      EXECUTE pg_catalog.format('REVOKE ALL ON FUNCTION %s FROM %I CASCADE', g.sig, g.rolname);
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING '1031: could not revoke EXECUTE on % from % (%): revoke it by hand', g.sig, g.rolname, SQLERRM;
    END;
    IF pg_catalog.has_function_privilege(g.rolname, g.sig, 'EXECUTE') THEN
      RAISE WARNING '1031: % can still execute % (through another grant or membership): revoke it by hand', g.rolname, g.sig;
    END IF;
  END LOOP;
END $$;

-- The halts: PUBLIC execute, app_user missing on D1 / D2 / D4 / H2 / H3, app_user having H1, a definer not owned by migration_admin or whose
-- registry row does not hold its hash, a search_path not pinned.
DO $$
DECLARE
  d RECORD;
BEGIN
  FOR d IN SELECT * FROM (VALUES
      ('public.intercompany_send_for_payment(uuid)', 'intercompany_send_for_payment(uuid)', true),
      ('public.intercompany_payment_message_state(uuid)', 'intercompany_payment_message_state(uuid)', true),
      ('public.intercompany_send_for_allocation(uuid)', 'intercompany_send_for_allocation(uuid)', true),
      ('public.intercompany_discard_payment_draft(uuid, uuid, text)', 'intercompany_discard_payment_draft(uuid,uuid,text)', true),
      ('public.intercompany_payment_target_ok(uuid, jsonb, uuid, uuid, text, uuid)', NULL, true),
      ('public.intercompany_allocation_cap_lock(uuid)', NULL, true),
      ('public.intercompany_payment_payer_standing(uuid)', NULL, false)) AS x(fn, sig, app) LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_proc p WHERE p.oid = d.fn::regprocedure AND p.proconfig @> ARRAY['search_path=pg_catalog, public, pg_temp']) THEN
      RAISE EXCEPTION '1031: % does not pin its search_path', d.fn;
    END IF;
    IF d.sig IS NOT NULL AND ((SELECT pg_catalog.pg_get_userbyid(p.proowner) FROM pg_catalog.pg_proc p WHERE p.oid = d.fn::regprocedure) <> 'migration_admin'
       OR NOT EXISTS (SELECT 1 FROM public.app_definer_reviews r WHERE r.signature = d.sig AND r.body_md5 = public.app_definer_hash(d.fn::regprocedure))) THEN
      RAISE EXCEPTION '1031: % is not owned by migration_admin, or its registry row does not hold its hash', d.fn;
    END IF;
    IF pg_catalog.has_function_privilege('public', d.fn, 'EXECUTE') THEN
      RAISE EXCEPTION '1031: PUBLIC can execute %', d.fn;
    END IF;
    IF pg_catalog.has_function_privilege('app_user', d.fn, 'EXECUTE') IS DISTINCT FROM d.app THEN
      RAISE EXCEPTION '1031: app_user % execute %', CASE WHEN d.app THEN 'cannot' ELSE 'can' END, d.fn;
    END IF;
  END LOOP;
END $$;
