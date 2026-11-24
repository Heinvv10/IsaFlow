-- 1029: Intercompany P4-E, the PAYER's question "can the partner clear what I am about to clear?". Plan: docs/plans/2026-11-24-intercompany-p4e-payer-loan-clearing.md
-- (section (j) binding, item 5; parent: docs/plans/2026-11-17-intercompany-mirror-posting.md, P4). Applies on top of 1028; idempotent (CREATE OR
-- REPLACE, ON CONFLICT). Forward only: no table, column or index changes, no change to any guard or to an existing function.

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
--     exceeds_open               the amount is more than the invoice's open amount less the partner's DRAFT receipts on it
--     ready                      none of the above
--   ADVISORY: the receiver's clearing re-judges everything under its own locks; this only stops the payer posting a clearing the partner cannot
--   take today. A manual receiver contra on the invoice (no stamp) shows here as a smaller open amount.

-- DEFINER REGISTRY (930): registered in app_definer_reviews AFTER the owner is set (the hash covers the owner). OLD COLOUR: nothing in the previous
-- release calls it.

-- Rollback (code first):
--   DROP FUNCTION IF EXISTS public.intercompany_receiver_loan_ready(uuid, uuid, numeric);
--   DELETE FROM app_definer_reviews WHERE signature = 'intercompany_receiver_loan_ready(uuid,uuid,numeric)';

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

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
  IF pg_catalog.round(p_amount, 2) > pg_catalog.round(ci.total_amount - ci.paid - v_pending, 2) THEN RETURN 'exceeds_open'; END IF;
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
     'nothing (STABLE, no lock): for the PAYER of a linked bill (a signed-in member of the session company with an intercompany write role) only, a read of the ACTIVE intercompany_document_links row joining its bill to the partner''s customer invoice on an active group loan intercompany_connections row, then of the PARTNER''s rows: feature_flags / company_feature_overrides (its intercompany_loan_clearing override, else is_global), its intercompany_connection_sides row and loan account (gl_accounts, and through intercompany_is_loan_class the bank tables), the payer side''s loan account type, the partner''s customer_invoices row, company_group_members and intercompany_pair_cutovers (the pair''s cut-over), customer_payment_allocations / customer_payments (its draft receipts on the invoice); answers ONE coarse word (ready or a reason) and no row data, no figure, no id; not_found for anyone else')
  ) AS v(signature, fn, writes)
ON CONFLICT (signature) DO UPDATE SET writes = EXCLUDED.writes, body_md5 = EXCLUDED.body_md5;

-- DEPLOY-SAFE (the 1027 pattern): any role other than a superuser, the owner (or a member of it), app_user or migration_admin (or a member of
-- either) found able to EXECUTE it (a default privilege of the creating role, e.g. Supabase's anon / authenticated / service_role) has it REVOKED;
-- a revoke the migration role cannot make is a WARNING naming the role, never a halt. Strict below: PUBLIC, app_user, the owner and the hash.
DO $$
DECLARE
  g RECORD;
BEGIN
  FOR g IN
    SELECT r.rolname, f.sig
      FROM (VALUES ('public.intercompany_receiver_loan_ready(uuid, uuid, numeric)')) AS f(sig)
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
      RAISE WARNING '1029: could not revoke EXECUTE on % from % (%): revoke it by hand', g.sig, g.rolname, SQLERRM;
    END;
    IF pg_catalog.has_function_privilege(g.rolname, g.sig, 'EXECUTE') THEN
      RAISE WARNING '1029: % can still execute % (through another grant or membership): revoke it by hand', g.rolname, g.sig;
    END IF;
  END LOOP;
END $$;

DO $$
BEGIN
  IF pg_catalog.has_function_privilege('public', 'public.intercompany_receiver_loan_ready(uuid, uuid, numeric)', 'EXECUTE')
     OR NOT pg_catalog.has_function_privilege('app_user', 'public.intercompany_receiver_loan_ready(uuid, uuid, numeric)', 'EXECUTE') THEN
    RAISE EXCEPTION '1029: PUBLIC can execute intercompany_receiver_loan_ready, or app_user cannot';
  END IF;
  IF (SELECT pg_catalog.pg_get_userbyid(p.proowner) FROM pg_catalog.pg_proc p
       WHERE p.oid = 'public.intercompany_receiver_loan_ready(uuid, uuid, numeric)'::regprocedure) <> 'migration_admin'
     OR NOT EXISTS (SELECT 1 FROM public.app_definer_reviews r WHERE r.signature = 'intercompany_receiver_loan_ready(uuid,uuid,numeric)'
                     AND r.body_md5 = public.app_definer_hash('public.intercompany_receiver_loan_ready(uuid, uuid, numeric)'::regprocedure)) THEN
    RAISE EXCEPTION '1029: intercompany_receiver_loan_ready is not owned by migration_admin, or its registry row does not hold its hash';
  END IF;
END $$;
