-- 1029: Intercompany P4-E, the PAYER's question "can the partner clear what I am about to clear?". Plan: docs/plans/2026-11-24-intercompany-p4e-payer-loan-clearing.md
-- (section (j) binding, items 5 and 8; parent: docs/plans/2026-11-17-intercompany-mirror-posting.md, P4). Applies on top of 1028; idempotent
-- (CREATE OR REPLACE, ON CONFLICT). Forward only: no table, column or index changes, no change to any guard or to an existing function. Edited in
-- place (not yet released) by fix round 1 (B: the connection hold definer; C: the preflight counts this payer's own messages) and fix round 2
-- (MED-1: a bank-paid message is neither claimed nor a hold; LOW-5: the grant checks warn, only the owner, hash and search_path halt).

-- WHAT
--   intercompany_receiver_loan_ready(link, bill, amount) RETURNS text, a registered SECURITY DEFINER (owner migration_admin), STABLE: it reads and
--   writes nothing else and takes no lock. The PAYER (the session company, a signed-in member with an intercompany write role) is about to clear
--   its bill against its loan account (payerLoanClearService.ts, "Clear against the intercompany loan"); its allocation message would then be
--   refused by the receiver's clearing (P4-D) for a reason only the RECEIVER's rows know. This answers ONE coarse word from those rows and no row
--   data, no figure, no id. The payer refuses on anything but 'ready' with one generic sentence; the word is for its log.
--   Answers, the first failure wins:
--     not_found                  no session company or signed-in user, not a member with a write role, a NULL / non-positive input, or the link is
--                                not ACTIVE joining the session company's bill (p_bill, a supplier_invoice) to the partner's customer_invoice on an
--                                ACTIVE GROUP LOAN connection of the pair (the payer checked all of this itself first: one answer for all)
--     receiver_flag_off          the partner does not have the dark flag intercompany_loan_clearing: its company_feature_overrides row, else the
--                                flag's is_global; plan membership is NOT read (fails closed: the flag is dark and enabled by override only)
--     receiver_loan_not_set_up   the partner's side names no loan account that is active, not a header and a loan class (intercompany_is_loan_class)
--     loan_class_mismatch        the payer side's loan account is not a loan class, or both loan accounts are of the same type
--     invoice_gone               the partner's invoice is missing, deleted or cancelled
--     invoice_not_open           its status is not open (approved, sent, partially_paid, overdue: AR_OPEN_STATUSES)
--     currency                   it is not in rand
--     wrong_customer             it is not on the partner side's customer (COALESCE(client_id, customer_id))
--     invoice_pre_cutover        the pair has no cut-over (intercompany_pair_cutovers, asked of the session company's current groups: the rule
--                                P4-D's clearing and E use) or the invoice is dated before it
--     exceeds_open               the amount is more than the invoice's open amount less the partner's DRAFT receipts on it, less (fix round 1,
--                                C) what THIS payer's own allocation messages to that invoice claim and the partner has not cleared: a pending,
--                                failed or dismissed LOAN one (its payment credited the payer's loan account: cashLegIsLoanAccount, fix round
--                                2 MED-1) whose payer side still stands (intercompany_allocation_payer_standing), and an accepted one whose
--                                clearing receipt the partner voided (its journal chain even, P4-D's rule). An accepted one whose receipt
--                                stands is in the invoice's amount_paid already (P4-D posts and allocates it): not counted. A BANK-paid one
--                                (cashLegIsLoanAccount false) claims nothing: P4-D does not accept it while the side's loan account differs
--                                from the account the payment credited (cash_not_through_loan; P4-E limit 19 names when it can), and the
--                                partner's receipt of that cash, if any, is already in amount_paid. The accepted arm reads no flag: an accepted
--                                message is one P4-D cleared against the loan, whatever its payload says.
--     ready                      none of the above
--   ADVISORY: the receiver's clearing re-judges everything under its own locks; this only stops the payer posting a clearing the partner cannot
--   take today. A manual receiver contra on the invoice (no stamp) shows here as a smaller open amount.
--
--   intercompany_allocation_payer_standing(message) RETURNS boolean, STABLE INVOKER, EXECUTE for migration_admin only (the two definers here run
--   as it): the PAYER side of an allocation message still stands: its payment_allocations row exists, its payment (the sender's) is processed or
--   reconciled, and the journal the message recorded is the payment's standing one (its own, else its batch's) with an odd reversal chain. The
--   payer-side tail of intercompany_allocation_message_live (1027: allocation_gone, payment_not_posted, journal_reversed), without the receiver
--   session it requires, so the payer's own questions can ask it.
--
--   intercompany_connection_allocation_held(connection) RETURNS boolean, a registered SECURITY DEFINER (owner migration_admin), STABLE, no lock:
--   (fix round 1, B) for a signed-in member with an intercompany write role of a company on the connection, whether an allocation message on
--   it still holds the relationship (P4-E (j).8: unlink, settlement mode, loan accounts): ACCEPTED, or a pending / failed / dismissed
--   (restorable) LOAN one (cashLegIsLoanAccount, fix round 2 MED-1) while its payer side stands. A BANK-paid one holds nothing (P4-D does not
--   accept it while the side's loan account differs from the credited account: cash_not_through_loan; P4-E limit 19), nor does one the payer
--   voided, unapplied or reversed (it is no longer live). A FAILED loan message
--   holds whatever the receiver's refusal was (wrong_customer, pre_cutover_invoice, loan_account_unusable, ...): the safer reading, because
--   every one of those is the receiver's own state, which it can put right and then accept the message; the remedy is the payer's void or the
--   receiver's reject. NULL for anyone else (the caller holds on NULL: fail closed). One boolean, no row data.

-- DEFINER REGISTRY (930): registered in app_definer_reviews AFTER the owner is set (the hash covers the owner). OLD COLOUR: nothing in the previous
-- release calls it.

-- Rollback (code first):
--   DROP FUNCTION IF EXISTS public.intercompany_receiver_loan_ready(uuid, uuid, numeric);
--   DROP FUNCTION IF EXISTS public.intercompany_connection_allocation_held(uuid);
--   DROP FUNCTION IF EXISTS public.intercompany_allocation_payer_standing(uuid);   (last: both definers call it)
--   DELETE FROM app_definer_reviews WHERE signature IN ('intercompany_receiver_loan_ready(uuid,uuid,numeric)', 'intercompany_connection_allocation_held(uuid)');

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- ── The payer side of an allocation message still stands (fix round 1, B and C) ─

CREATE OR REPLACE FUNCTION public.intercompany_allocation_payer_standing(p_message uuid)
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
     WHERE m.id = p_message AND m.kind = 'allocation' AND m.source_doc_type = 'payment_allocation' AND m.source_journal_entry_id IS NOT NULL
       AND m.source_journal_entry_id = COALESCE(p.gl_journal_entry_id,
             (SELECT b.gl_journal_entry_id FROM public.supplier_payment_batches b WHERE b.id = p.batch_id AND b.company_id = m.from_company_id))
       AND COALESCE(public.intercompany_journal_chain_length(m.source_journal_entry_id, m.from_company_id), 0) % 2 = 1)
$$;
REVOKE ALL ON FUNCTION public.intercompany_allocation_payer_standing(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.intercompany_allocation_payer_standing(uuid) TO migration_admin;

-- ── The connection hold (fix round 1, B) ────────────────────────────────────

CREATE OR REPLACE FUNCTION public.intercompany_connection_allocation_held(p_connection uuid)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_co uuid := app.current_company_id();
BEGIN
  IF v_co IS NULL OR auth.uid() IS NULL OR p_connection IS NULL
     OR NOT (v_co IN (SELECT auth.user_companies())) OR NOT public.intercompany_user_can_write(v_co)
     OR NOT EXISTS (SELECT 1 FROM public.intercompany_connections c WHERE c.id = p_connection AND v_co IN (c.company_low_id, c.company_high_id)) THEN
    RETURN NULL;
  END IF;
  RETURN EXISTS (
    SELECT 1 FROM public.intercompany_messages m
     WHERE m.connection_id = p_connection AND m.kind = 'allocation'
       AND (m.status = 'accepted'
         OR (m.status IN ('pending', 'failed', 'dismissed') AND (m.payload #>> '{payment,cashLegIsLoanAccount}') = 'true'
             AND public.intercompany_allocation_payer_standing(m.id))));
END;
$$;
ALTER FUNCTION public.intercompany_connection_allocation_held(uuid) OWNER TO migration_admin;
REVOKE ALL ON FUNCTION public.intercompany_connection_allocation_held(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.intercompany_connection_allocation_held(uuid) TO app_user;

-- ── The receiver-readiness preflight ────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.intercompany_receiver_loan_ready(p_link uuid, p_bill uuid, p_amount numeric)
RETURNS text
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_co uuid := app.current_company_id();
  v_flag boolean;
  v_rloan uuid;
  v_rcustomer uuid;
  v_rtype text;
  v_ptype text;
  v_cutover date;
  v_pending numeric;
  v_claimed numeric;
  k RECORD;
  ci RECORD;
BEGIN
  IF v_co IS NULL OR auth.uid() IS NULL OR p_link IS NULL OR p_bill IS NULL OR p_amount IS NULL OR p_amount <= 0
     OR NOT (v_co IN (SELECT auth.user_companies())) OR NOT public.intercompany_user_can_write(v_co) THEN
    RETURN 'not_found';
  END IF;
  -- the payer's link: active, joining ITS bill to the partner's customer invoice, on an active group loan connection of the two
  SELECT l.connection_id, c.company_low_id, c.company_high_id,
         CASE WHEN l.company_a_id = v_co THEN l.company_b_id ELSE l.company_a_id END AS partner,
         CASE WHEN l.company_a_id = v_co THEN l.doc_b_id ELSE l.doc_a_id END AS invoice
    INTO k
    FROM public.intercompany_document_links l
    JOIN public.intercompany_connections c ON c.id = l.connection_id AND c.status = 'active' AND c.kind = 'group' AND c.settlement_mode = 'loan'
   WHERE l.id = p_link AND l.status = 'active'
     AND ((l.company_a_id = v_co AND l.doc_a_type = 'supplier_invoice' AND l.doc_a_id = p_bill AND l.doc_b_type = 'customer_invoice')
       OR (l.company_b_id = v_co AND l.doc_b_type = 'supplier_invoice' AND l.doc_b_id = p_bill AND l.doc_a_type = 'customer_invoice'))
     AND ((c.company_low_id = v_co AND c.company_high_id = CASE WHEN l.company_a_id = v_co THEN l.company_b_id ELSE l.company_a_id END)
       OR (c.company_high_id = v_co AND c.company_low_id = CASE WHEN l.company_a_id = v_co THEN l.company_b_id ELSE l.company_a_id END));
  IF NOT FOUND THEN RETURN 'not_found'; END IF;
  -- the partner's dark flag: its override, else the flag's is_global (no plan read: fail closed)
  SELECT COALESCE(o.enabled, ff.is_global, false) INTO v_flag
    FROM public.feature_flags ff
    LEFT JOIN public.company_feature_overrides o ON o.feature_id = ff.id AND o.company_id = k.partner
   WHERE ff.code = 'intercompany_loan_clearing';
  IF v_flag IS NOT TRUE THEN RETURN 'receiver_flag_off'; END IF;
  -- the partner side's loan account: active, a leaf, a loan class
  SELECT s.loan_account_id, s.customer_id INTO v_rloan, v_rcustomer
    FROM public.intercompany_connection_sides s WHERE s.connection_id = k.connection_id AND s.company_id = k.partner;
  SELECT ga.account_type INTO v_rtype
    FROM public.gl_accounts ga
   WHERE ga.id = v_rloan AND ga.company_id = k.partner AND ga.is_active IS NOT FALSE
     AND NOT EXISTS (SELECT 1 FROM public.gl_accounts ch WHERE ch.parent_account_id = ga.id AND ch.company_id = ga.company_id)
     AND public.intercompany_is_loan_class(ga.id, ga.company_id);
  IF v_rtype IS NULL THEN RETURN 'receiver_loan_not_set_up'; END IF;
  SELECT ga.account_type INTO v_ptype
    FROM public.intercompany_connection_sides s
    JOIN public.gl_accounts ga ON ga.id = s.loan_account_id AND ga.company_id = v_co
   WHERE s.connection_id = k.connection_id AND s.company_id = v_co AND public.intercompany_is_loan_class(ga.id, ga.company_id);
  IF v_ptype IS NULL OR v_ptype = v_rtype THEN RETURN 'loan_class_mismatch'; END IF;
  -- the partner's invoice
  SELECT i.status, i.deleted_at, i.invoice_date, COALESCE(i.client_id, i.customer_id) AS customer,
         upper(COALESCE(NULLIF(i.currency_code, ''), 'ZAR')) AS currency, i.total_amount, COALESCE(i.amount_paid, 0) AS paid
    INTO ci
    FROM public.customer_invoices i WHERE i.id = k.invoice AND i.company_id = k.partner;
  IF NOT FOUND OR ci.deleted_at IS NOT NULL OR ci.status = 'cancelled' THEN RETURN 'invoice_gone'; END IF;
  IF ci.status IS NULL OR ci.status NOT IN ('approved', 'sent', 'partially_paid', 'overdue') THEN RETURN 'invoice_not_open'; END IF;
  IF ci.currency <> 'ZAR' THEN RETURN 'currency'; END IF;
  IF v_rcustomer IS NULL OR ci.customer IS DISTINCT FROM v_rcustomer THEN RETURN 'wrong_customer'; END IF;
  -- the pair's cut-over, the rule the receiver's clearing applies (asked of the session company's current groups, as P4-D's pairCutover does)
  SELECT pc.cutover INTO v_cutover
    FROM public.company_group_members gm
    CROSS JOIN LATERAL public.intercompany_pair_cutovers(gm.group_id) pc
   WHERE gm.company_id = v_co AND gm.left_date IS NULL AND pc.company_low_id = k.company_low_id AND pc.company_high_id = k.company_high_id
   LIMIT 1;
  IF v_cutover IS NULL OR ci.invoice_date IS NULL OR ci.invoice_date < v_cutover THEN RETURN 'invoice_pre_cutover'; END IF;
  -- the open amount, less what the partner's draft receipts already claim on it
  SELECT COALESCE(sum(a.amount_allocated), 0) INTO v_pending
    FROM public.customer_payment_allocations a
    JOIN public.customer_payments p ON p.id = a.payment_id AND p.company_id = k.partner AND p.status = 'draft'
   WHERE a.invoice_id = k.invoice;
  -- (fix round 1, C) and what this payer's own messages to that invoice claim that the partner has not cleared (see the header)
  SELECT COALESCE(sum(pg_catalog.round((m.payload ->> 'amount')::numeric, 2)), 0) INTO v_claimed
    FROM public.intercompany_messages m
   WHERE m.from_company_id = v_co AND m.to_company_id = k.partner AND m.kind = 'allocation' AND m.source_doc_type = 'payment_allocation'
     AND (m.payload #>> '{issuerDocument,id}') = k.invoice::text AND pg_catalog.jsonb_typeof(m.payload -> 'amount') = 'number'
     AND ((m.status IN ('pending', 'failed', 'dismissed') AND (m.payload #>> '{payment,cashLegIsLoanAccount}') = 'true'
           AND public.intercompany_allocation_payer_standing(m.id))
       OR (m.status = 'accepted' AND NOT EXISTS (
             SELECT 1 FROM public.customer_payments r
              WHERE m.target_doc_type = 'customer_payment' AND r.id = m.target_doc_id AND r.company_id = k.partner
                AND COALESCE(public.intercompany_journal_chain_length(r.gl_journal_entry_id, r.company_id), 0) % 2 = 1)));
  IF pg_catalog.round(p_amount, 2) > pg_catalog.round(ci.total_amount - ci.paid - v_pending - v_claimed, 2) THEN RETURN 'exceeds_open'; END IF;
  RETURN 'ready';
END;
$$;
ALTER FUNCTION public.intercompany_receiver_loan_ready(uuid, uuid, numeric) OWNER TO migration_admin;
REVOKE ALL ON FUNCTION public.intercompany_receiver_loan_ready(uuid, uuid, numeric) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.intercompany_receiver_loan_ready(uuid, uuid, numeric) TO app_user;

-- ── The definer registry (930), after the owner is set ──────────────────────

INSERT INTO public.app_definer_reviews (signature, writes, body_md5)
SELECT v.signature, v.writes, public.app_definer_hash(v.fn::regprocedure)
  FROM (VALUES
    ('intercompany_receiver_loan_ready(uuid,uuid,numeric)', 'public.intercompany_receiver_loan_ready(uuid, uuid, numeric)',
     'nothing (STABLE, no lock): for the PAYER of a linked bill (a signed-in member of the session company with an intercompany write role) only, a read of the ACTIVE intercompany_document_links row joining its bill to the partner''s customer invoice on an active group loan intercompany_connections row, then of the PARTNER''s rows: feature_flags / company_feature_overrides (its intercompany_loan_clearing override, else is_global), its intercompany_connection_sides row and loan account (gl_accounts, and through intercompany_is_loan_class the bank tables), the payer side''s loan account type, the partner''s customer_invoices row, company_group_members and intercompany_pair_cutovers (the pair''s cut-over), customer_payment_allocations / customer_payments (its draft receipts on the invoice), and this payer''s own intercompany_messages to that invoice (their loan-credit flag) with, through intercompany_allocation_payer_standing, their payment_allocations / supplier_payments / supplier_payment_batches rows and journal chain, and an accepted one''s clearing receipt (customer_payments, its journal chain); answers ONE coarse word (ready or a reason) and no row data, no figure, no id; not_found for anyone else'),
    ('intercompany_connection_allocation_held(uuid)', 'public.intercompany_connection_allocation_held(uuid)',
     'nothing (STABLE, no lock): for a signed-in member with an intercompany write role of a company on the connection only, a read of the intercompany_connections row and of the connection''s allocation intercompany_messages (their status and loan-credit flag), and, through intercompany_allocation_payer_standing, their payment_allocations / supplier_payments / supplier_payment_batches rows and the recorded journal''s reversal chain; answers ONE boolean (held or not) and no row data; NULL for anyone else')
  ) AS v(signature, fn, writes)
ON CONFLICT (signature) DO UPDATE SET writes = EXCLUDED.writes, body_md5 = EXCLUDED.body_md5;

-- DEPLOY-SAFE (the 1027 pattern, fix round 2 LOW-5): any role other than a superuser, the owner (or a member of it), app_user or migration_admin
-- (or a member of either; app_user is NOT exempt for the INVOKER helper) found able to EXECUTE one (a default privilege of the creating role,
-- e.g. Supabase's anon / authenticated / service_role) has it REVOKED, CASCADE (a grant it passed on goes with it); a revoke that fails for any
-- reason is a WARNING naming the role, never a halt, and so is a role that can still execute it after. The last block halts ONLY on what makes a
-- definer unsafe whatever the grants: its owner, its registry hash, and the search_path of all three; PUBLIC / app_user / migration_admin
-- grants that are not as intended are WARNINGS (fail closed: a missing app_user grant refuses the feature, it opens nothing).
DO $$
DECLARE
  g RECORD;
BEGIN
  FOR g IN
    SELECT r.rolname, f.sig
      FROM (VALUES ('public.intercompany_receiver_loan_ready(uuid, uuid, numeric)'), ('public.intercompany_connection_allocation_held(uuid)'),
                   ('public.intercompany_allocation_payer_standing(uuid)')) AS f(sig)
      JOIN pg_catalog.pg_proc p ON p.oid = f.sig::regprocedure
     CROSS JOIN pg_catalog.pg_roles r
     WHERE pg_catalog.has_function_privilege(r.oid, p.oid, 'EXECUTE')
       AND NOT (r.rolsuper OR r.oid = p.proowner OR pg_catalog.pg_has_role(r.oid, p.proowner, 'MEMBER')
                OR (f.sig <> 'public.intercompany_allocation_payer_standing(uuid)' AND pg_catalog.pg_has_role(r.oid, 'app_user', 'MEMBER'))
                OR pg_catalog.pg_has_role(r.oid, 'migration_admin', 'MEMBER'))
     ORDER BY r.rolname, f.sig
  LOOP
    BEGIN
      EXECUTE pg_catalog.format('REVOKE ALL ON FUNCTION %s FROM %I CASCADE', g.sig, g.rolname);
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING '1029: could not revoke EXECUTE on % from % (%): revoke it by hand', g.sig, g.rolname, SQLERRM;
    END;
    IF pg_catalog.has_function_privilege(g.rolname, g.sig, 'EXECUTE') THEN
      RAISE WARNING '1029: % can still execute % (through another grant or membership): revoke it by hand', g.rolname, g.sig;
    END IF;
  END LOOP;
END $$;

DO $$
DECLARE
  d RECORD;
BEGIN
  FOR d IN SELECT * FROM (VALUES ('public.intercompany_receiver_loan_ready(uuid, uuid, numeric)', 'intercompany_receiver_loan_ready(uuid,uuid,numeric)', true),
                                 ('public.intercompany_connection_allocation_held(uuid)', 'intercompany_connection_allocation_held(uuid)', true),
                                 ('public.intercompany_allocation_payer_standing(uuid)', NULL, false)) AS x(fn, sig, app) LOOP
    -- the halts: what makes the function unsafe whatever its grants
    IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_proc p WHERE p.oid = d.fn::regprocedure
                      AND p.proconfig @> ARRAY['search_path=pg_catalog, public, pg_temp']) THEN
      RAISE EXCEPTION '1029: % does not pin its search_path', d.fn;
    END IF;
    IF d.sig IS NOT NULL AND ((SELECT pg_catalog.pg_get_userbyid(p.proowner) FROM pg_catalog.pg_proc p WHERE p.oid = d.fn::regprocedure) <> 'migration_admin'
       OR NOT EXISTS (SELECT 1 FROM public.app_definer_reviews r WHERE r.signature = d.sig AND r.body_md5 = public.app_definer_hash(d.fn::regprocedure))) THEN
      RAISE EXCEPTION '1029: % is not owned by migration_admin, or its registry row does not hold its hash', d.fn;
    END IF;
    -- the grants: warnings (the REVOKE loop above already took back what it could)
    IF pg_catalog.has_function_privilege('public', d.fn, 'EXECUTE') THEN
      RAISE WARNING '1029: PUBLIC can still execute %: revoke it by hand', d.fn;
    END IF;
    IF pg_catalog.has_function_privilege('app_user', d.fn, 'EXECUTE') IS DISTINCT FROM d.app THEN
      RAISE WARNING '1029: app_user % execute %: % it by hand', CASE WHEN d.app THEN 'cannot' ELSE 'can still' END, d.fn,
        CASE WHEN d.app THEN 'grant' ELSE 'revoke' END;
    END IF;
    IF NOT pg_catalog.has_function_privilege('migration_admin', d.fn, 'EXECUTE') THEN
      RAISE WARNING '1029: migration_admin cannot execute %: grant it by hand', d.fn;
    END IF;
  END LOOP;
END $$;
