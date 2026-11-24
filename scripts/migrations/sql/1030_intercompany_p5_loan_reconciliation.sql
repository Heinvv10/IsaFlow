-- 1030: Intercompany P5, the loan reconciliation report (READ ONLY). Plan: docs/plans/2026-11-24-intercompany-p5-reconciliation.md (sections (m),
-- (k) and (l) binding; parent docs/plans/2026-11-17-intercompany-mirror-posting.md, P5). Applies on top of 1029; idempotent (CREATE OR REPLACE,
-- ON CONFLICT). Forward only: no table, column or index change, no change to any existing function, guard or the undo gate.
--
-- WHAT (five functions; nothing is written: no table, row, message, flag, audit row or advisory lock; no row lock; every one STABLE, so a
-- report's one statement reads ONE snapshot, partner figures and message states alike; the last block HALTS otherwise)
--   b1 intercompany_journal_chain_members(je, company) RETURNS TABLE(id): the ids of the journals intercompany_journal_chain_eff (1019) walks
--      (the same walk, the same negation test intercompany_lines_negate, the same exclusion of je in the loop): GL attribution needs ids.
--      STABLE INVOKER, migration_admin only.
--   b2 intercompany_allocation_payer_state(message, asat, eff) RETURNS text: the payer side of an allocation message, ACCEPTED ones included
--      (1027's live tail without its receiver-session check or status filter). Allocation, payment and bill facts as they are now; the
--      journal chain as at `asat`, judged from `eff` (the chain's intercompany_journal_chain_eff, computed ONCE by the caller: b2 never walks
--      a chain and does not call intercompany_allocation_payer_standing, (l).8). First failure wins: allocation_gone, changed (payment / bill
--      / amount differ from the payload), payment_not_posted, journal_reversed (no recorded journal, not the payment's standing one, no posted
--      chain, or an even chain at asat), dated_after (the root journal is dated after asat), bill_gone; else standing. STABLE INVOKER,
--      migration_admin only.
--   b0 intercompany_loan_recon_partner_state(connection, company) RETURNS text: the ONE partner-consent judgement ((k).1, (k).3, (l).2). The
--      relationship first, so a company that is no longer a partner never learns the partner's flag or set-up: connection_not_active,
--      not_group, not_one_group (intercompany_shared_group: STABLE, no lock); then the company's OWN fact loan_unset (its loan account NULL,
--      not its own, a header, or not a loan class); only then the partner's: partner_flag_off (its override, else is_global; no plan read:
--      fail closed), partner_setup (its loan account NULL, not its own, a header, also the loan account of another of its connection sides, or
--      not a loan class: one generic word); else ok. "A loan class" is 1027's intercompany_is_loan_class (no bank subtype, no bank-statement
--      line, no bank table naming it), as P4-D / P4-E count a loan account (round 1, HIGH-1). STABLE INVOKER, migration_admin only.
--   b3 intercompany_loan_recon_messages(connection), a registered SECURITY DEFINER: per allocation message of the connection between the
--      session company S and the connection's partner X (S a party), coarse words and booleans only: no figure, no partner id, no partner
--      text. Every partner-fact column is NULL unless b0 says ok (computed once at the top): the payer's columns when S received the message
--      (`in`), the receiver's (receiver_journal_differs included) and partner_document when S sent it (`out`); loan_account_changed is the OR
--      of both sides' parts (NULL when the partner's part is withheld and S's own is false). A side's loan account counts only while it is a
--      loan class (1027). A withheld side's journal lines, chains and loan account are not read at all. Each journal chain is walked ONCE (one
--      intercompany_journal_chain_eff per distinct payer journal and per clearing receipt). Zero rows for anyone but a signed-in member of S
--      with an intercompany write role, S having the flag, the connection S's.
--   b4 intercompany_loan_recon_summary(connection), a registered SECURITY DEFINER: ONE row: b0's word, T, S's loan account balance at T, its
--      part from this connection's allocation journals (A_S, a DISTINCT set of b1 members) and the rest (no own figures when S's account is
--      not a loan class), whether S's loan account also
--      serves another of S's connections; and, only when b0 says ok, X's balance and its non-allocation part on the account X named for this
--      connection. Posted, company on line AND entry, entry_date <= T (getPostedAccountBalance's definition plus the date). I1 (balance =
--      attributed + other) is asserted for both. Same caller check as b3; zero rows otherwise.
--   T is the statement's Africa/Johannesburg date, computed inside: there is no date argument ((k).2).
--
-- DEFINER REGISTRY (930): b3 and b4 registered in app_definer_reviews AFTER the owner is set (the hash covers the owner). OLD COLOUR: nothing
-- in the previous release calls any of them.
--
-- Rollback (code first: the report's routes are the only callers):
--   DROP FUNCTION IF EXISTS public.intercompany_loan_recon_summary(uuid);
--   DROP FUNCTION IF EXISTS public.intercompany_loan_recon_messages(uuid);
--   DROP FUNCTION IF EXISTS public.intercompany_loan_recon_partner_state(uuid, uuid);
--   DROP FUNCTION IF EXISTS public.intercompany_allocation_payer_state(uuid, date, date[]);
--   DROP FUNCTION IF EXISTS public.intercompany_journal_chain_members(uuid, uuid);
--   DELETE FROM app_definer_reviews WHERE signature IN ('intercompany_loan_recon_messages(uuid)', 'intercompany_loan_recon_summary(uuid)');

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- ── b1: the members of a journal's reversal chain ───────────────────────────

CREATE OR REPLACE FUNCTION public.intercompany_journal_chain_members(p_je uuid, p_company uuid)
RETURNS TABLE (id uuid)
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog, public, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  v_ids uuid[];
  v_all uuid[] := '{}'::uuid[];
BEGIN
  SELECT ARRAY[je.id] INTO v_ids FROM public.gl_journal_entries je WHERE je.id = p_je AND je.company_id = p_company AND je.status = 'posted';
  IF v_ids IS NULL THEN RETURN; END IF;
  LOOP
    v_all := v_all || v_ids;
    SELECT pg_catalog.array_agg(c.id ORDER BY c.id) INTO v_ids
      FROM (SELECT r.id, r.reversal_of_id AS parent
              FROM unnest(v_ids) AS p(id)
              JOIN public.gl_journal_entries r ON r.reversal_of_id = p.id
             WHERE r.id <> p_je AND r.company_id = p_company AND r.status = 'posted'
            OFFSET 0) c
     WHERE public.intercompany_lines_negate(c.id, c.parent);
    EXIT WHEN v_ids IS NULL;
  END LOOP;
  RETURN QUERY SELECT x FROM unnest(v_all) AS x;
END;
$$;
REVOKE ALL ON FUNCTION public.intercompany_journal_chain_members(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.intercompany_journal_chain_members(uuid, uuid) FROM app_user;
GRANT EXECUTE ON FUNCTION public.intercompany_journal_chain_members(uuid, uuid) TO migration_admin;

-- ── b2: the payer side of an allocation message, accepted ones included ─────

CREATE OR REPLACE FUNCTION public.intercompany_allocation_payer_state(p_message uuid, p_asat date, p_eff date[])
RETURNS text
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_amount numeric;
  v_standing uuid;
  v_len integer;
  m RECORD;
  pa RECORD;
  sp RECORD;
BEGIN
  SELECT x.from_company_id AS payer, x.source_doc_id, x.source_journal_entry_id AS je, x.payload INTO m
    FROM public.intercompany_messages x WHERE x.id = p_message AND x.kind = 'allocation' AND x.source_doc_type = 'payment_allocation';
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT a.payment_id, a.invoice_id, a.amount_allocated INTO pa FROM public.payment_allocations a WHERE a.id = m.source_doc_id;
  IF NOT FOUND THEN RETURN 'allocation_gone'; END IF;
  v_amount := CASE WHEN pg_catalog.jsonb_typeof(m.payload -> 'amount') = 'number' THEN pg_catalog.round((m.payload ->> 'amount')::numeric, 2) END;
  IF pa.payment_id::text IS DISTINCT FROM (m.payload #>> '{payment,id}') OR pa.invoice_id::text IS DISTINCT FROM (m.payload #>> '{payerDocument,id}')
     OR pg_catalog.round(pa.amount_allocated, 2) IS DISTINCT FROM v_amount THEN
    RETURN 'changed';
  END IF;
  SELECT p.status, p.gl_journal_entry_id, p.batch_id INTO sp FROM public.supplier_payments p WHERE p.id = pa.payment_id AND p.company_id = m.payer;
  IF NOT FOUND OR sp.status IS NULL OR sp.status NOT IN ('processed', 'reconciled') THEN RETURN 'payment_not_posted'; END IF;
  v_standing := COALESCE(sp.gl_journal_entry_id,
                         (SELECT b.gl_journal_entry_id FROM public.supplier_payment_batches b WHERE b.id = sp.batch_id AND b.company_id = m.payer));
  -- no posted chain at all (an empty eff) is not a journal dated after T: it is no journal the ledger carries
  IF m.je IS NULL OR v_standing IS DISTINCT FROM m.je OR COALESCE(pg_catalog.cardinality(p_eff), 0) = 0 THEN RETURN 'journal_reversed'; END IF;
  v_len := public.intercompany_journal_chain_length(m.je, m.payer, p_asat, p_eff);
  IF v_len = 0 THEN RETURN 'dated_after'; END IF;
  IF v_len % 2 = 0 THEN RETURN 'journal_reversed'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.supplier_invoices b WHERE b.id = pa.invoice_id AND b.company_id = m.payer AND b.deleted_at IS NULL) THEN
    RETURN 'bill_gone';
  END IF;
  RETURN 'standing';
END;
$$;
REVOKE ALL ON FUNCTION public.intercompany_allocation_payer_state(uuid, date, date[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.intercompany_allocation_payer_state(uuid, date, date[]) FROM app_user;
GRANT EXECUTE ON FUNCTION public.intercompany_allocation_payer_state(uuid, date, date[]) TO migration_admin;

-- ── b0: may the partner's facts be shown? (the relationship first) ──────────

CREATE OR REPLACE FUNCTION public.intercompany_loan_recon_partner_state(p_connection uuid, p_company uuid)
RETURNS text
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_x uuid;
  v_own uuid;
  v_xl uuid;
  v_flag boolean;
  c RECORD;
BEGIN
  SELECT k.status, k.kind, k.company_low_id, k.company_high_id INTO c
    FROM public.intercompany_connections k WHERE k.id = p_connection AND p_company IN (k.company_low_id, k.company_high_id);
  IF NOT FOUND OR c.status IS DISTINCT FROM 'active' THEN RETURN 'connection_not_active'; END IF;
  IF c.kind IS DISTINCT FROM 'group' THEN RETURN 'not_group'; END IF;
  v_x := CASE WHEN c.company_low_id = p_company THEN c.company_high_id ELSE c.company_low_id END;
  IF NOT public.intercompany_shared_group(p_company, v_x) THEN RETURN 'not_one_group'; END IF;
  -- the session company's own set-up
  SELECT s.loan_account_id INTO v_own FROM public.intercompany_connection_sides s WHERE s.connection_id = p_connection AND s.company_id = p_company;
  -- (round 1, HIGH-1) a loan account is one only while it is a loan class (1027's intercompany_is_loan_class: no bank subtype, no bank-statement
  -- line, no bank table naming it), as 1027 / 1029 count it: an account that is or became a bank account is no loan account
  IF v_own IS NULL OR NOT EXISTS (SELECT 1 FROM public.gl_accounts ga WHERE ga.id = v_own AND ga.company_id = p_company)
     OR EXISTS (SELECT 1 FROM public.gl_accounts ch WHERE ch.parent_account_id = v_own AND ch.company_id = p_company)
     OR NOT public.intercompany_is_loan_class(v_own, p_company) THEN
    RETURN 'loan_unset';
  END IF;
  -- only now the partner's facts: its flag (override, else is_global; no plan read), then its loan account
  SELECT COALESCE(o.enabled, ff.is_global, false) INTO v_flag
    FROM public.feature_flags ff
    LEFT JOIN public.company_feature_overrides o ON o.feature_id = ff.id AND o.company_id = v_x
   WHERE ff.code = 'intercompany_loan_clearing';
  IF v_flag IS NOT TRUE THEN RETURN 'partner_flag_off'; END IF;
  SELECT s.loan_account_id INTO v_xl FROM public.intercompany_connection_sides s WHERE s.connection_id = p_connection AND s.company_id = v_x;
  IF v_xl IS NULL OR NOT EXISTS (SELECT 1 FROM public.gl_accounts ga WHERE ga.id = v_xl AND ga.company_id = v_x)
     OR EXISTS (SELECT 1 FROM public.gl_accounts ch WHERE ch.parent_account_id = v_xl AND ch.company_id = v_x)
     OR EXISTS (SELECT 1 FROM public.intercompany_connection_sides o WHERE o.company_id = v_x AND o.loan_account_id = v_xl AND o.connection_id <> p_connection)
     OR NOT public.intercompany_is_loan_class(v_xl, v_x) THEN
    RETURN 'partner_setup';
  END IF;
  RETURN 'ok';
END;
$$;
REVOKE ALL ON FUNCTION public.intercompany_loan_recon_partner_state(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.intercompany_loan_recon_partner_state(uuid, uuid) FROM app_user;
GRANT EXECUTE ON FUNCTION public.intercompany_loan_recon_partner_state(uuid, uuid) TO migration_admin;

-- ── b3: the per-message states ──────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.intercompany_loan_recon_messages(p_connection uuid)
RETURNS TABLE (message_id uuid, direction text, payer_state text, payer_after_t boolean, payer_loan_credit boolean, payer_counts boolean,
               payer_journal_differs boolean, receiver_state text, receiver_after_t boolean, receiver_counts boolean, receiver_journal_differs boolean,
               loan_account_changed boolean, partner_document text)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  v_co uuid := app.current_company_id();
  v_t date := (pg_catalog.statement_timestamp() AT TIME ZONE 'Africa/Johannesburg')::date;
  v_uuid constant text := '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';
  v_x uuid;
  v_ok boolean;
BEGIN
  -- the caller: a signed-in member of the session company with an intercompany write role, the company having the flag, the connection its own
  IF v_co IS NULL OR auth.uid() IS NULL OR p_connection IS NULL OR NOT (v_co IN (SELECT auth.user_companies()))
     OR NOT public.intercompany_user_can_write(v_co) THEN
    RETURN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.feature_flags ff LEFT JOIN public.company_feature_overrides o ON o.feature_id = ff.id AND o.company_id = v_co
                  WHERE ff.code = 'intercompany_loan_clearing' AND COALESCE(o.enabled, ff.is_global, false)) THEN
    RETURN;
  END IF;
  SELECT CASE WHEN k.company_low_id = v_co THEN k.company_high_id ELSE k.company_low_id END INTO v_x
    FROM public.intercompany_connections k WHERE k.id = p_connection AND v_co IN (k.company_low_id, k.company_high_id);
  IF v_x IS NULL THEN RETURN; END IF;
  -- the partner-consent gate, ONCE ((k).1)
  v_ok := public.intercompany_loan_recon_partner_state(p_connection, v_co) = 'ok';
  RETURN QUERY
  WITH m AS MATERIALIZED (
    SELECT x.id, x.from_company_id AS payer, x.to_company_id AS receiver, x.status, x.source_doc_id, x.source_journal_entry_id AS je, x.payload,
           x.target_doc_type, x.target_doc_id, CASE WHEN x.from_company_id = v_co THEN 'out' ELSE 'in' END AS dir,
           CASE WHEN pg_catalog.jsonb_typeof(x.payload -> 'amount') = 'number' THEN pg_catalog.round((x.payload ->> 'amount')::numeric, 2) END AS amount
      FROM public.intercompany_messages x
     WHERE x.connection_id = p_connection AND x.kind = 'allocation' AND x.source_doc_type = 'payment_allocation'
       -- S is a party, and the other party is the connection's partner (a row naming a third company is not read)
       AND x.from_company_id IN (v_co, v_x) AND x.to_company_id IN (v_co, v_x)
  ),
  -- (round 1, MED-2) a side's loan account counts only while it is a loan class, as 1027 counts it (an account that is or became a bank account
  -- is NO loan account: no loan credit or debit on it, and a loan-paid payload has no loan line); the partner's row is read only when b0 says ok
  sd AS MATERIALIZED (
    SELECT s.company_id, CASE WHEN public.intercompany_is_loan_class(s.loan_account_id, s.company_id) THEN s.loan_account_id END AS loan_account_id
      FROM public.intercompany_connection_sides s WHERE s.connection_id = p_connection AND (v_ok OR s.company_id = v_co)
  ),
  -- each payer root chain walked ONCE; the partner's only when it may be shown
  pj AS MATERIALIZED (
    SELECT d.je, d.payer, public.intercompany_journal_chain_eff(d.je, d.payer) AS eff
      FROM (SELECT DISTINCT m.je, m.payer FROM m WHERE m.je IS NOT NULL AND (v_ok OR m.payer = v_co)) d
  ),
  -- each clearing receipt chain walked ONCE; the partner's only when it may be shown
  rj AS MATERIALIZED (
    SELECT r.id, r.company_id, r.status, r.gl_journal_entry_id AS je, public.intercompany_journal_chain_eff(r.gl_journal_entry_id, r.company_id) AS eff
      FROM public.customer_payments r
     WHERE (r.id, r.company_id) IN (SELECT m.target_doc_id, m.receiver FROM m
                                     WHERE m.status = 'accepted' AND m.target_doc_type = 'customer_payment' AND (v_ok OR m.receiver = v_co))
  ),
  f AS (
    SELECT m.*, (v_ok OR m.payer = v_co) AS see_payer, (v_ok OR m.receiver = v_co) AS see_receiver,
           pj.eff AS peff, COALESCE(pg_catalog.cardinality(pj.eff), 0) AS pn,
           -- (round 1, timing) a side's journal lines are read only when that side may be shown: the CASE runs no subquery for a withheld side
           CASE WHEN NOT (v_ok OR m.payer = v_co) THEN NULL WHEN m.je IS NULL OR ps.loan_account_id IS NULL THEN 0
                ELSE (SELECT COALESCE(sum(l.credit - l.debit), 0) FROM public.gl_journal_lines l
                       WHERE l.journal_entry_id = m.je AND l.company_id = m.payer AND l.gl_account_id = ps.loan_account_id) END AS pcredit,
           CASE WHEN NOT (v_ok OR m.payer = v_co) THEN NULL WHEN m.je IS NULL OR ps.loan_account_id IS NULL THEN false
                ELSE EXISTS (SELECT 1 FROM public.gl_journal_lines l
                              WHERE l.journal_entry_id = m.je AND l.company_id = m.payer AND l.gl_account_id = ps.loan_account_id) END AS pline,
           r.id IS NOT NULL AS rfound, r.status AS rstatus, r.je AS rje, r.eff AS reff, COALESCE(pg_catalog.cardinality(r.eff), 0) AS rn,
           CASE WHEN NOT (v_ok OR m.receiver = v_co) THEN NULL WHEN r.je IS NULL OR rs.loan_account_id IS NULL THEN 0
                ELSE (SELECT COALESCE(sum(l.debit - l.credit), 0) FROM public.gl_journal_lines l
                       WHERE l.journal_entry_id = r.je AND l.company_id = m.receiver AND l.gl_account_id = rs.loan_account_id) END AS rdebit,
           CASE WHEN NOT (v_ok OR m.receiver = v_co) THEN NULL WHEN r.je IS NULL OR rs.loan_account_id IS NULL THEN false
                ELSE EXISTS (SELECT 1 FROM public.gl_journal_lines l
                              WHERE l.journal_entry_id = r.je AND l.company_id = m.receiver AND l.gl_account_id = rs.loan_account_id) END AS rline
      FROM m
      LEFT JOIN pj ON pj.je = m.je AND pj.payer = m.payer
      LEFT JOIN sd ps ON ps.company_id = m.payer
      LEFT JOIN sd rs ON rs.company_id = m.receiver
      LEFT JOIN rj r ON m.status = 'accepted' AND m.target_doc_type = 'customer_payment' AND r.id = m.target_doc_id AND r.company_id = m.receiver
  ),
  g AS (
    SELECT f.*,
           CASE WHEN f.see_payer THEN public.intercompany_allocation_payer_state(f.id, v_t, f.peff) END AS pstate,
           CASE WHEN f.see_payer AND f.pn > 0 THEN public.intercompany_journal_chain_length(f.je, f.payer, v_t, f.peff) WHEN f.see_payer THEN 0 END AS plen,
           CASE WHEN f.see_receiver AND f.rn > 0 THEN public.intercompany_journal_chain_length(f.rje, f.receiver, v_t, f.reff) WHEN f.see_receiver THEN 0 END AS rlen
      FROM f
  ),
  h AS (
    SELECT g.*,
           CASE WHEN NOT g.see_receiver THEN NULL
                WHEN g.status <> 'accepted' THEN 'not_accepted'
                WHEN NOT g.rfound THEN 'target_missing'
                WHEN g.rstatus = 'cancelled' OR g.rn = 0 THEN 'clearing_voided'
                WHEN g.rlen = 0 THEN 'clearing_dated_after'
                WHEN g.rlen % 2 = 0 THEN 'clearing_voided'
                ELSE 'clearing_standing' END AS rstate
      FROM g
  )
  SELECT h.id, h.dir, h.pstate,
         CASE WHEN h.see_payer THEN h.pn > 0 AND h.plen < h.pn END,
         CASE WHEN h.see_payer THEN h.pcredit > 0 END,
         CASE WHEN h.see_payer THEN h.pstate = 'standing' END,
         -- the root journal's loan credit against the messages standing on it whose allocation row still exists ((k).6); judged only while it
         -- credits the loan account and its chain is odd as at T (a reversed journal nets to nothing on the account)
         CASE WHEN h.see_payer THEN h.pcredit > 0 AND h.plen % 2 = 1
              AND pg_catalog.round(h.pcredit, 2) <> (SELECT COALESCE(sum(m2.amount), 0) FROM m m2
                                                      WHERE m2.je = h.je AND m2.payer = h.payer
                                                        AND EXISTS (SELECT 1 FROM public.payment_allocations a WHERE a.id = m2.source_doc_id)) END,
         h.rstate,
         CASE WHEN h.see_receiver THEN h.rn > 0 AND h.rlen < h.rn END,
         CASE WHEN h.see_receiver THEN h.status = 'accepted' AND h.rstate = 'clearing_standing' AND h.rdebit > 0 END,
         -- (round 1, LOW-5) the clearing receipt's loan debit against the accepted messages targeting it (at most one: intercompany_messages_target_uq,
         -- 1002:258), judged like payer_journal_differs: only while it debits the loan account and its chain is odd as at T
         CASE WHEN h.see_receiver THEN h.status = 'accepted' AND h.rdebit > 0 AND h.rlen % 2 = 1
              AND pg_catalog.round(h.rdebit, 2) <> (SELECT COALESCE(sum(m2.amount), 0) FROM m m2
                                                     WHERE m2.status = 'accepted' AND m2.target_doc_type = 'customer_payment'
                                                       AND m2.target_doc_id = h.target_doc_id AND m2.receiver = h.receiver) END,
         -- the payer's part: the payload says loan-paid but the payer journal has no line on the payer side's CURRENT loan account; the receiver's:
         -- the message is accepted but the receipt's journal has none on the receiver side's ((k).8). An accepted message that was never loan-paid
         -- is no changed account: it is not_through_loan ((l).4 row (F, F); round 1, (g))
         (CASE WHEN h.see_payer THEN (h.payload #>> '{payment,cashLegIsLoanAccount}') = 'true' AND h.pn > 0 AND NOT h.pline END)
           OR (CASE WHEN h.see_receiver THEN h.status = 'accepted' AND h.rn > 0 AND NOT h.rline END),
         CASE WHEN h.dir = 'out' AND v_ok THEN (
           SELECT CASE WHEN i.id IS NULL OR i.deleted_at IS NOT NULL OR i.status = 'cancelled' THEN 'gone'
                       WHEN i.status IS NULL OR i.status NOT IN ('approved', 'sent', 'partially_paid', 'overdue') THEN 'not_open'
                       WHEN pg_catalog.upper(COALESCE(NULLIF(i.currency_code, ''), 'ZAR')) <> 'ZAR' THEN 'currency'
                       ELSE 'open' END
             FROM (SELECT 1) one
             LEFT JOIN public.customer_invoices i
               ON i.id = CASE WHEN (h.payload #>> '{issuerDocument,id}') ~ v_uuid THEN (h.payload #>> '{issuerDocument,id}')::uuid END
              AND i.company_id = h.receiver) END
    FROM h;
END;
$$;
ALTER FUNCTION public.intercompany_loan_recon_messages(uuid) OWNER TO migration_admin;
REVOKE ALL ON FUNCTION public.intercompany_loan_recon_messages(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.intercompany_loan_recon_messages(uuid) TO app_user;

-- ── b4: the connection's figures ────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.intercompany_loan_recon_summary(p_connection uuid)
RETURNS TABLE (partner_state text, as_of date, own_balance numeric, own_attributed numeric, own_other numeric, own_loan_shared boolean,
               partner_balance numeric, partner_other numeric)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  v_co uuid := app.current_company_id();
  v_t date := (pg_catalog.statement_timestamp() AT TIME ZONE 'Africa/Johannesburg')::date;
  v_x uuid;
  v_state text;
  v_own uuid;
  v_xl uuid;
  v_shared boolean;
  v_b numeric;
  v_a numeric;
  v_o numeric;
  v_ob numeric;
  v_oa numeric;
  v_oo numeric;
  v_pb numeric;
  v_po numeric;
  y RECORD;
BEGIN
  IF v_co IS NULL OR auth.uid() IS NULL OR p_connection IS NULL OR NOT (v_co IN (SELECT auth.user_companies()))
     OR NOT public.intercompany_user_can_write(v_co) THEN
    RETURN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.feature_flags ff LEFT JOIN public.company_feature_overrides fo ON fo.feature_id = ff.id AND fo.company_id = v_co
                  WHERE ff.code = 'intercompany_loan_clearing' AND COALESCE(fo.enabled, ff.is_global, false)) THEN
    RETURN;
  END IF;
  SELECT CASE WHEN k.company_low_id = v_co THEN k.company_high_id ELSE k.company_low_id END INTO v_x
    FROM public.intercompany_connections k WHERE k.id = p_connection AND v_co IN (k.company_low_id, k.company_high_id);
  IF v_x IS NULL THEN RETURN; END IF;
  -- b0 alone judges the partner's flag, its loan account and its sharing ((l).7): nothing of the partner is recomputed here
  v_state := public.intercompany_loan_recon_partner_state(p_connection, v_co);
  SELECT s.loan_account_id INTO v_own FROM public.intercompany_connection_sides s WHERE s.connection_id = p_connection AND s.company_id = v_co;
  -- (round 1, MED-2) S's own account counts only while it is a loan class, as 1027 counts it: a bank account is no loan account (no own figures)
  IF v_own IS NOT NULL AND NOT public.intercompany_is_loan_class(v_own, v_co) THEN
    v_own := NULL;
  END IF;
  IF v_own IS NOT NULL THEN
    v_shared := EXISTS (SELECT 1 FROM public.intercompany_connection_sides s
                         WHERE s.company_id = v_co AND s.loan_account_id = v_own AND s.connection_id <> p_connection);
  END IF;
  -- the partner's loan account is read only to sum its lines, and only when b0 says its facts may be shown
  IF v_state = 'ok' THEN
    SELECT s.loan_account_id INTO v_xl FROM public.intercompany_connection_sides s WHERE s.connection_id = p_connection AND s.company_id = v_x;
  END IF;
  FOR y IN SELECT * FROM (VALUES (v_co, v_x, v_own), (v_x, v_co, v_xl)) AS z(co, other, loan) WHERE z.loan IS NOT NULL LOOP
    -- A_Y: the DISTINCT members of the payer chains of Y's outgoing allocation messages on this connection and of the clearing receipts of
    -- Y's accepted incoming ones; the balance is getPostedAccountBalance's (posted, company on line and entry) as at T
    WITH a AS (
      SELECT DISTINCT mem.id
        FROM public.intercompany_messages x
       CROSS JOIN LATERAL public.intercompany_journal_chain_members(x.source_journal_entry_id, x.from_company_id) mem
       WHERE x.connection_id = p_connection AND x.kind = 'allocation' AND x.source_doc_type = 'payment_allocation'
         AND x.from_company_id = y.co AND x.to_company_id = y.other AND x.source_journal_entry_id IS NOT NULL
      UNION
      SELECT mem.id
        FROM public.intercompany_messages x
        JOIN public.customer_payments r ON r.id = x.target_doc_id AND r.company_id = y.co
       CROSS JOIN LATERAL public.intercompany_journal_chain_members(r.gl_journal_entry_id, r.company_id) mem
       WHERE x.connection_id = p_connection AND x.kind = 'allocation' AND x.source_doc_type = 'payment_allocation'
         AND x.to_company_id = y.co AND x.from_company_id = y.other AND x.status = 'accepted' AND x.target_doc_type = 'customer_payment'
    ),
    l AS (
      SELECT jl.journal_entry_id, jl.debit - jl.credit AS net
        FROM public.gl_journal_lines jl
        JOIN public.gl_journal_entries je ON je.id = jl.journal_entry_id
       WHERE jl.gl_account_id = y.loan AND jl.company_id = y.co AND je.company_id = y.co AND je.status = 'posted' AND je.entry_date <= v_t
    )
    SELECT pg_catalog.round(COALESCE((SELECT sum(l.net) FROM l), 0), 2),
           pg_catalog.round(COALESCE((SELECT sum(l.net) FROM a JOIN l ON l.journal_entry_id = a.id), 0), 2),
           pg_catalog.round(COALESCE((SELECT sum(l.net) FROM l WHERE NOT EXISTS (SELECT 1 FROM a WHERE a.id = l.journal_entry_id)), 0), 2)
      INTO v_b, v_a, v_o;
    -- I1: the balance is the attributed part plus the rest, from the same lines
    IF v_b IS DISTINCT FROM v_a + v_o THEN
      RAISE EXCEPTION 'intercompany_loan_recon_summary: I1 does not hold' USING ERRCODE = 'P0001';
    END IF;
    IF y.co = v_co THEN
      v_ob := v_b; v_oa := v_a; v_oo := v_o;
    ELSE
      v_pb := v_b; v_po := v_o;
    END IF;
  END LOOP;
  RETURN QUERY SELECT v_state, v_t, v_ob, v_oa, v_oo, v_shared,
                      CASE WHEN v_state = 'ok' THEN v_pb END, CASE WHEN v_state = 'ok' THEN v_po END;
END;
$$;
ALTER FUNCTION public.intercompany_loan_recon_summary(uuid) OWNER TO migration_admin;
REVOKE ALL ON FUNCTION public.intercompany_loan_recon_summary(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.intercompany_loan_recon_summary(uuid) TO app_user;

-- ── b5: the definer registry (930), after the owner is set ──────────────────

INSERT INTO public.app_definer_reviews (signature, writes, body_md5)
SELECT v.signature, v.writes, public.app_definer_hash(v.fn::regprocedure)
  FROM (VALUES
    ('intercompany_loan_recon_messages(uuid)', 'public.intercompany_loan_recon_messages(uuid)',
     'nothing (STABLE, no lock): for a signed-in member with an intercompany write role of the session company, the company having the intercompany_loan_clearing flag (feature_flags / company_feature_overrides: override, else is_global) and the connection its own (intercompany_connections), a read of the connection''s allocation intercompany_messages between the company and its partner, the two intercompany_connection_sides rows (their loan accounts), through intercompany_loan_recon_partner_state the partner-consent facts (intercompany_connections, company_group_members / company_groups through intercompany_shared_group, gl_accounts, feature_flags / company_feature_overrides of the partner, intercompany_connection_sides, and through intercompany_is_loan_class bank_transactions, bank_accounts, bank_feed_connections, bank_statement_imports, bank_import_batches, bank_reconciliations, bank_transfer_link_log for both loan accounts), each payer journal''s and clearing receipt''s reversal chain once (gl_journal_entries, gl_journal_lines through intercompany_journal_chain_eff / intercompany_lines_negate), through intercompany_allocation_payer_state the payment_allocations / supplier_payments / supplier_payment_batches / supplier_invoices rows, the payer journal''s gl_journal_lines on the payer side''s loan account, an accepted message''s customer_payments row and its gl_journal_lines on the receiver side''s loan account (and the receipt''s loan debit against its accepted message''s amount), and for a message the company sent the receiver''s customer_invoices row (status, deleted_at, currency_code); answers per message coarse words and booleans only (no figure, no partner id, no partner text), every partner fact NULL unless the partner-consent gate says ok; zero rows for anyone else'),
    ('intercompany_loan_recon_summary(uuid)', 'public.intercompany_loan_recon_summary(uuid)',
     'nothing (STABLE, no lock): for a signed-in member with an intercompany write role of the session company, the company having the intercompany_loan_clearing flag (feature_flags / company_feature_overrides: override, else is_global) and the connection its own (intercompany_connections), the partner-consent word of intercompany_loan_recon_partner_state (intercompany_connections, company_group_members / company_groups, gl_accounts, feature_flags / company_feature_overrides of the partner, intercompany_connection_sides, and through intercompany_is_loan_class the bank tables bank_transactions, bank_accounts, bank_feed_connections, bank_statement_imports, bank_import_batches, bank_reconciliations, bank_transfer_link_log for both loan accounts), the two intercompany_connection_sides rows (their loan accounts; the partner''s only when the gate says ok), the connection''s allocation intercompany_messages and accepted ones'' customer_payments rows, their journals'' reversal chains (gl_journal_entries, gl_journal_lines through intercompany_journal_chain_members / intercompany_lines_negate), and the posted gl_journal_lines / gl_journal_entries on each company''s own loan account dated on or before today; answers ONE row: the gate''s word, the date, the company''s balance on its loan account split into its allocation part and the rest, whether that account serves another of its connections, and (only when the gate says ok) the partner''s balance and its non-allocation part on the account the partner named for this connection; zero rows for anyone else')
  ) AS v(signature, fn, writes)
ON CONFLICT (signature) DO UPDATE SET writes = EXCLUDED.writes, body_md5 = EXCLUDED.body_md5;

-- DEPLOY-SAFE (the 1027 / 1029 pattern): any role other than a superuser, the owner (or a member of it), app_user (for b3 / b4 only) or
-- migration_admin (or a member of either) found able to EXECUTE one (a default privilege of the creating role, e.g. Supabase's anon /
-- authenticated / service_role) has it REVOKED, CASCADE; a revoke that fails is a WARNING naming the role, never a halt.
DO $$
DECLARE
  g RECORD;
BEGIN
  FOR g IN
    SELECT r.rolname, f.sig
      FROM (VALUES ('public.intercompany_loan_recon_messages(uuid)', true), ('public.intercompany_loan_recon_summary(uuid)', true),
                   ('public.intercompany_loan_recon_partner_state(uuid, uuid)', false), ('public.intercompany_allocation_payer_state(uuid, date, date[])', false),
                   ('public.intercompany_journal_chain_members(uuid, uuid)', false)) AS f(sig, app)
      JOIN pg_catalog.pg_proc p ON p.oid = f.sig::regprocedure
     CROSS JOIN pg_catalog.pg_roles r
     WHERE pg_catalog.has_function_privilege(r.oid, p.oid, 'EXECUTE')
       AND NOT (r.rolsuper OR r.oid = p.proowner OR pg_catalog.pg_has_role(r.oid, p.proowner, 'MEMBER')
                OR (f.app AND pg_catalog.pg_has_role(r.oid, 'app_user', 'MEMBER'))
                OR pg_catalog.pg_has_role(r.oid, 'migration_admin', 'MEMBER'))
     ORDER BY r.rolname, f.sig
  LOOP
    BEGIN
      EXECUTE pg_catalog.format('REVOKE ALL ON FUNCTION %s FROM %I CASCADE', g.sig, g.rolname);
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING '1030: could not revoke EXECUTE on % from % (%): revoke it by hand', g.sig, g.rolname, SQLERRM;
    END;
    IF pg_catalog.has_function_privilege(g.rolname, g.sig, 'EXECUTE') THEN
      RAISE WARNING '1030: % can still execute % (through another grant or membership): revoke it by hand', g.rolname, g.sig;
    END IF;
  END LOOP;
END $$;

-- The halts: what makes a function unsafe whatever its grants (a definer's owner and registry hash; every pinned search_path) and what breaks
-- the ONE snapshot ((k).10): b0-b4 and EVERY function they (or the report's statement) call must be STABLE, because a VOLATILE callee takes a
-- new snapshot per query. Grants that are not as intended are WARNINGS (fail closed: a missing app_user grant refuses the report).
DO $$
DECLARE
  d RECORD;
  v_vol "char";
BEGIN
  -- (round 1, MED-10) b3 / b4 read FORCE RLS tables (intercompany_messages, gl_journal_lines, gl_accounts, customer_payments, bank_transactions,
  -- ...) as their owner: an owner that does not bypass row security would see no row and the report would answer an empty ledger as if true
  IF NOT COALESCE((SELECT r.rolsuper OR r.rolbypassrls FROM pg_catalog.pg_roles r WHERE r.rolname = 'migration_admin'), false) THEN
    RAISE EXCEPTION '1030: migration_admin does not bypass row security: the report''s definers would read FORCE RLS tables as empty';
  END IF;
  FOR d IN SELECT * FROM (VALUES ('public.intercompany_loan_recon_messages(uuid)', 'intercompany_loan_recon_messages(uuid)', true),
                                 ('public.intercompany_loan_recon_summary(uuid)', 'intercompany_loan_recon_summary(uuid)', true),
                                 ('public.intercompany_loan_recon_partner_state(uuid, uuid)', NULL, false),
                                 ('public.intercompany_allocation_payer_state(uuid, date, date[])', NULL, false),
                                 ('public.intercompany_journal_chain_members(uuid, uuid)', NULL, false)) AS x(fn, sig, app) LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_proc p WHERE p.oid = d.fn::regprocedure AND p.proconfig @> ARRAY['search_path=pg_catalog, public, pg_temp']) THEN
      RAISE EXCEPTION '1030: % does not pin its search_path', d.fn;
    END IF;
    IF d.sig IS NOT NULL AND ((SELECT pg_catalog.pg_get_userbyid(p.proowner) FROM pg_catalog.pg_proc p WHERE p.oid = d.fn::regprocedure) <> 'migration_admin'
       OR NOT EXISTS (SELECT 1 FROM public.app_definer_reviews r WHERE r.signature = d.sig AND r.body_md5 = public.app_definer_hash(d.fn::regprocedure))) THEN
      RAISE EXCEPTION '1030: % is not owned by migration_admin, or its registry row does not hold its hash', d.fn;
    END IF;
    IF pg_catalog.has_function_privilege('public', d.fn, 'EXECUTE') THEN
      RAISE WARNING '1030: PUBLIC can still execute %: revoke it by hand', d.fn;
    END IF;
    IF pg_catalog.has_function_privilege('app_user', d.fn, 'EXECUTE') IS DISTINCT FROM d.app THEN
      RAISE WARNING '1030: app_user % execute %: % it by hand', CASE WHEN d.app THEN 'cannot' ELSE 'can still' END, d.fn,
        CASE WHEN d.app THEN 'grant' ELSE 'revoke' END;
    END IF;
    IF NOT pg_catalog.has_function_privilege('migration_admin', d.fn, 'EXECUTE') THEN
      RAISE WARNING '1030: migration_admin cannot execute %: grant it by hand', d.fn;
    END IF;
  END LOOP;
  FOR d IN SELECT * FROM (VALUES ('public.intercompany_loan_recon_messages(uuid)'), ('public.intercompany_loan_recon_summary(uuid)'),
                                 ('public.intercompany_loan_recon_partner_state(uuid, uuid)'), ('public.intercompany_allocation_payer_state(uuid, date, date[])'),
                                 ('public.intercompany_journal_chain_members(uuid, uuid)'), ('app.current_company_id()'), ('auth.uid()'),
                                 ('auth.user_companies()'), ('public.intercompany_user_can_write(uuid)'), ('public.intercompany_shared_group(uuid, uuid)'),
                                 ('public.intercompany_journal_chain_eff(uuid, uuid)'), ('public.intercompany_journal_chain_length(uuid, uuid, date, date[])'),
                                 ('public.intercompany_lines_negate(uuid, uuid)'), ('public.intercompany_pair_cutovers(uuid)'),
                                 ('public.rls_user_group_ids()'), ('public.intercompany_is_loan_class(uuid, uuid)')) AS x(fn) LOOP
    SELECT p.provolatile INTO v_vol FROM pg_catalog.pg_proc p WHERE p.oid = d.fn::regprocedure;
    IF v_vol IS DISTINCT FROM 's' THEN
      RAISE EXCEPTION '1030: % is not STABLE (%): the report would read more than one snapshot', d.fn, v_vol;
    END IF;
  END LOOP;
END $$;
