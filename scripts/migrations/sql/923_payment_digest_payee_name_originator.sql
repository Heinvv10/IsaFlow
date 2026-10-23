-- 923_payment_digest_payee_name_originator.sql
-- The supplier_payment and payment_batch approval digest gains what the bank file and the Netcash send
-- use but it did not cover (breaker finding F1 on #806, 2026-10-23):
--   * the payee's NAME: the EFT file's beneficiary name (eft-generate) and the Netcash account holder
--     (netcash/submit). Added to the payee's bank tuple in approval_supplier_payment_content as
--     upper(btrim(name)) (Hein, 2026-10-23): a change of case or of leading / trailing spaces is the
--     same name and keeps the approval; any other rename stales it. COLLATE "C" so only ASCII letters
--     fold: under a linguistic collation upper() maps dotless i to I and long s to S, so a name that
--     differs in the file would read as the same one (breaker, 2026-10-23).
--   * the paying account's bank_account_number and bank_branch_code (gl_accounts, read for the batch's
--     or the payment's own company only, as eft-generate reads the file's originator). Added to the
--     payment_batch arm after the account id, and to the supplier_payment arm beside the content.
--     Raw columns: the file strips non-digits, so a reformat stales an approval it could have kept.
-- So a rename or an originator edit after approval is refused at file, send and process: 409
-- APPROVAL_STALE under enforcement (the gate and the 867 triggers compare this digest), 409
-- BATCH_CHANGED_SINCE_APPROVAL without it (migration 922's approved_digest is this digest).
-- approval_supplier_payment_content has no other caller; every other type's digest is 874's, verbatim,
-- and a guard below refuses the migration if any of them moved.
--
-- RE-STAMP (Hein, 2026-10-23). Every payment and batch digest changes, so every stored one would read
-- as stale from this deploy. Each stored digest that equals its document's digest under the OLD
-- definition, computed here just before the replace, is provably bound to the content as it stands:
-- it is moved to the new definition's digest of that same content. One that does not match was
-- already stale (or bound nothing) and is left as it was, so it still needs re-approval:
--   * approval_requests.document_digest, pending and approved supplier_payment / payment_batch requests;
--   * supplier_payment_batches.approved_digest (922).
-- Counts are reported by RAISE NOTICE. What the re-stamp cannot know: the old digest did not cover
-- the name or the originator, so whether either changed between an approval and this deploy is not
-- recorded anywhere. They are taken as they stand at deploy, as they were trusted until now.
--
-- AUTHORS (Hein, 2026-10-23: whoever changes what an approval covers may not approve it). A rename
-- the digest sees joins the payee's bank_details_setters (application code, ap/supplierPaymentAuthors).
-- The paying account gets its own: gl_accounts.bank_details_setters (migration 922b), written only by the bank-accounts
-- PUT when the number or branch code changes (a new number restarts it, as for a payee), and derived
-- LIVE by approval_supplier_payment_authors into every payment paid from the account — its own
-- bank_account_id, or its batch's for a member — whatever its status, payments created later
-- included, as the payee's setters are. Every list is NULL today, so no author list moves; a guard
-- below refuses the migration if one does.
--
-- AFTER 874, 922 and 922b: the snapshot reads 874's live digest and 922's column, the authors read
-- 922b's; the first DO block refuses to run on anything older. Every table the digests read is locked first (874's order and
-- modes, then the payment tables, batches before payees as the app takes them), so no edit can
-- commit between the "before" snapshot and the re-stamp. Bounded; either timeout rolls back.
-- CREATE OR REPLACE keeps the three functions' owner, grants and search_path; none is a definer.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

-- The snapshot and the re-stamp read every company's payments, payees and accounts. Under a role that
-- RLS binds they would read none, and every approval would be left stale (or the guard below would
-- see nothing to compare): refuse instead (871's check).
DO $$
BEGIN
  IF NOT COALESCE((SELECT r.rolsuper OR r.rolbypassrls FROM pg_catalog.pg_roles r WHERE r.rolname = current_user), false) THEN
    RAISE EXCEPTION 'migration 923: run as a role that bypasses RLS - the re-stamp must read every company''s documents';
  END IF;
END $$;

LOCK TABLE public.customer_invoices, public.customer_invoice_items, public.supplier_invoices,
           public.supplier_invoice_items, public.credit_notes IN SHARE MODE;
LOCK TABLE public.approval_requests, public.supplier_payment_batches IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE public.supplier_payments, public.payment_allocations, public.suppliers, public.gl_accounts IN SHARE MODE;

DO $$
BEGIN
  IF pg_catalog.pg_get_functiondef('public.approval_document_digest(uuid,text,uuid)'::pg_catalog.regprocedure)
        NOT LIKE '%cii.gl_account_id, cii.project_id, cii.currency_code%' THEN
    RAISE EXCEPTION 'migration 923: apply migration 874 first - 923 replaces 874''s approval_document_digest';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_attribute
                 WHERE attrelid = 'public.supplier_payment_batches'::pg_catalog.regclass
                   AND attname = 'approved_digest' AND NOT attisdropped) THEN
    RAISE EXCEPTION 'migration 923: apply migration 922 first - 923 re-stamps supplier_payment_batches.approved_digest';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_attribute
                 WHERE attrelid = 'public.gl_accounts'::pg_catalog.regclass
                   AND attname = 'bank_details_setters' AND NOT attisdropped) THEN
    RAISE EXCEPTION 'migration 923: apply migration 922b first - 923''s authors read gl_accounts.bank_details_setters';
  END IF;
END $$;

-- 874's snapshot, every type, so the guard below can prove the other types did not move; a batch
-- with a stored approval digest (922) is in it whatever its status.
DROP TABLE IF EXISTS pg_temp.r923_before;
CREATE TEMP TABLE r923_before ON COMMIT DROP AS
  SELECT si.company_id, 'supplier_invoice'::TEXT AS document_type, si.id,
         public.approval_document_digest(si.company_id, 'supplier_invoice', si.id) AS digest
  FROM public.supplier_invoices si
  WHERE si.status IN ('draft', 'pending_approval')
     OR EXISTS (SELECT 1 FROM public.approval_requests ar
                WHERE ar.document_type = 'supplier_invoice' AND ar.document_id = si.id)
  UNION ALL
  SELECT cn.company_id, t.document_type, cn.id,
         public.approval_document_digest(cn.company_id, t.document_type, cn.id)
  FROM public.credit_notes cn
  CROSS JOIN (VALUES ('customer_credit_note'), ('supplier_credit_note')) AS t(document_type)
  WHERE cn.status = 'draft'
     OR EXISTS (SELECT 1 FROM public.approval_requests ar
                WHERE ar.document_type = t.document_type AND ar.document_id = cn.id)
  UNION ALL
  SELECT ci.company_id, 'customer_invoice', ci.id,
         public.approval_document_digest(ci.company_id, 'customer_invoice', ci.id)
  FROM public.customer_invoices ci
  WHERE ci.status IN ('draft', 'pending_approval')
     OR EXISTS (SELECT 1 FROM public.approval_requests ar
                WHERE ar.document_type = 'customer_invoice' AND ar.document_id = ci.id)
  UNION ALL
  SELECT sp.company_id, 'supplier_payment', sp.id,
         public.approval_document_digest(sp.company_id, 'supplier_payment', sp.id)
  FROM public.supplier_payments sp
  WHERE sp.batch_id IS NULL
    AND (sp.status IN ('draft', 'approved')
         OR EXISTS (SELECT 1 FROM public.approval_requests ar
                    WHERE ar.document_type = 'supplier_payment' AND ar.document_id = sp.id))
  UNION ALL
  SELECT b.company_id, 'payment_batch', b.id,
         public.approval_document_digest(b.company_id, 'payment_batch', b.id)
  FROM public.supplier_payment_batches b
  WHERE b.status IN ('draft', 'approved') OR b.approved_digest IS NOT NULL
     OR EXISTS (SELECT 1 FROM public.approval_requests ar
                WHERE ar.document_type = 'payment_batch' AND ar.document_id = b.id)
  UNION ALL
  SELECT je.company_id, 'manual_journal', je.id,
         public.approval_document_digest(je.company_id, 'manual_journal', je.id)
  FROM public.gl_journal_entries je
  WHERE je.approval_document_type IS NOT NULL
     OR EXISTS (SELECT 1 FROM public.approval_requests ar
                WHERE ar.document_type = 'manual_journal' AND ar.document_id = je.id);

-- 867's function, verbatim, but for upper(btrim(s.name) COLLATE "C") at the end of the payee's bank tuple.
CREATE OR REPLACE FUNCTION public.approval_supplier_payment_content(
  p_company_id pg_catalog.uuid, p_payment_id pg_catalog.uuid
) RETURNS pg_catalog.jsonb
LANGUAGE sql STABLE
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT jsonb_build_array(
    sp.supplier_id, sp.payment_date, trim_scale(sp.total_amount), sp.payment_method, sp.bank_account_id,
    sp.reference, sp.project_id, sp.cost_center_id,
    (SELECT jsonb_build_array(s.bank_name, s.bank_account_number, s.bank_branch_code,
                              s.bank_account_type, s.bank_account_holder, upper(btrim(s.name) COLLATE "C"))
     FROM public.suppliers s WHERE s.id = sp.supplier_id AND s.company_id = sp.company_id),
    COALESCE((
      SELECT jsonb_agg(jsonb_build_array(pa.invoice_id, trim_scale(pa.amount_allocated))
                       ORDER BY pa.invoice_id, pa.amount_allocated)
      FROM public.payment_allocations pa WHERE pa.payment_id = sp.id
    ), '[]'::jsonb))
  FROM public.supplier_payments sp
  WHERE sp.id = p_payment_id AND sp.company_id = p_company_id
$$;

-- 874's function, verbatim, but for the paying account's number and branch in the supplier_payment
-- and payment_batch arms.
CREATE OR REPLACE FUNCTION public.approval_document_digest(
  p_company_id pg_catalog.uuid, p_document_type pg_catalog.text, p_document_id pg_catalog.uuid
) RETURNS pg_catalog.text
LANGUAGE sql STABLE
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT CASE p_document_type
    WHEN 'supplier_invoice' THEN (
      SELECT encode(sha256(convert_to(jsonb_build_array(
        si.supplier_id, si.invoice_number, si.invoice_date,
        si.currency, si.currency_code, trim_scale(si.exchange_rate),
        trim_scale(si.subtotal), trim_scale(si.tax_rate), trim_scale(si.tax_amount),
        trim_scale(si.total_amount), trim_scale(si.functional_total),
        si.project_id, si.cost_center_id, si.is_drc,
        COALESCE((
          SELECT jsonb_agg(jsonb_build_array(
                   sii.gl_account_id, sii.description, trim_scale(sii.quantity),
                   trim_scale(sii.unit_price), trim_scale(sii.tax_rate), trim_scale(sii.tax_amount),
                   trim_scale(sii.line_total), sii.project_id, sii.cost_center_id,
                   sii.vat_classification, sii.cc1_id, sii.cc2_id, sii.bu_id)
                 ORDER BY sii.created_at, sii.description, sii.gl_account_id, sii.quantity,
                          sii.unit_price, sii.tax_rate, sii.tax_amount, sii.line_total,
                          sii.project_id, sii.cost_center_id, sii.vat_classification,
                          sii.cc1_id, sii.cc2_id, sii.bu_id, sii.id)
          FROM public.supplier_invoice_items sii
          WHERE sii.supplier_invoice_id = si.id
        ), '[]'::jsonb)
      )::TEXT, 'UTF8')), 'hex')
      FROM public.supplier_invoices si
      WHERE si.id = p_document_id AND si.company_id = p_company_id AND si.deleted_at IS NULL
    )
    WHEN 'customer_credit_note' THEN (
      SELECT encode(sha256(convert_to(jsonb_build_array(
        cn.type, cn.credit_note_number, cn.client_id, cn.customer_invoice_id,
        cn.supplier_id, cn.supplier_invoice_id, cn.credit_date, cn.currency,
        trim_scale(cn.subtotal), trim_scale(cn.tax_rate), trim_scale(cn.tax_amount),
        trim_scale(cn.total_amount), cn.project_id, cn.cost_center_id,
        cn.cc1_id, cn.cc2_id, cn.bu_id
      )::TEXT, 'UTF8')), 'hex')
      FROM public.credit_notes cn
      WHERE cn.id = p_document_id AND cn.company_id = p_company_id AND cn.type = 'customer'
    )
    WHEN 'supplier_credit_note' THEN (
      SELECT encode(sha256(convert_to(jsonb_build_array(
        cn.type, cn.credit_note_number, cn.client_id, cn.customer_invoice_id,
        cn.supplier_id, cn.supplier_invoice_id, cn.credit_date, cn.currency,
        trim_scale(cn.subtotal), trim_scale(cn.tax_rate), trim_scale(cn.tax_amount),
        trim_scale(cn.total_amount), cn.project_id, cn.cost_center_id,
        cn.cc1_id, cn.cc2_id, cn.bu_id
      )::TEXT, 'UTF8')), 'hex')
      FROM public.credit_notes cn
      WHERE cn.id = p_document_id AND cn.company_id = p_company_id AND cn.type = 'supplier'
    )
    WHEN 'customer_invoice' THEN (
      SELECT encode(sha256(convert_to(jsonb_build_array(
        ci.customer_id, ci.client_id, ci.invoice_number, ci.invoice_date,
        ci.currency_code, trim_scale(ci.exchange_rate),
        trim_scale(ci.subtotal), trim_scale(ci.tax_rate), trim_scale(ci.tax_amount),
        trim_scale(ci.total_amount), trim_scale(ci.functional_total), ci.project_id,
        COALESCE((
          SELECT jsonb_agg(jsonb_build_array(
                   cii.description, trim_scale(cii.quantity), trim_scale(cii.unit_price),
                   trim_scale(cii.amount), trim_scale(cii.tax_rate), cii.gl_account_id,
                   cii.project_id, cii.currency_code, cii.cc1_id, cii.cc2_id, cii.bu_id)
                 ORDER BY cii.created_at, cii.description, cii.quantity, cii.unit_price,
                          cii.amount, cii.tax_rate, cii.gl_account_id, cii.project_id, cii.currency_code,
                          cii.cc1_id, cii.cc2_id, cii.bu_id, cii.id)
          FROM public.customer_invoice_items cii
          WHERE cii.invoice_id = ci.id
        ), '[]'::jsonb)
      )::TEXT, 'UTF8')), 'hex')
      FROM public.customer_invoices ci
      WHERE ci.id = p_document_id AND ci.company_id = p_company_id AND ci.deleted_at IS NULL
    )
    WHEN 'supplier_payment' THEN (
      SELECT encode(sha256(convert_to(jsonb_build_array(
        public.approval_supplier_payment_content(sp.company_id, sp.id),
        (SELECT jsonb_build_array(ga.bank_account_number, ga.bank_branch_code)
         FROM public.gl_accounts ga WHERE ga.id = sp.bank_account_id AND ga.company_id = sp.company_id)
      )::TEXT, 'UTF8')), 'hex')
      FROM public.supplier_payments sp
      WHERE sp.id = p_document_id AND sp.company_id = p_company_id AND sp.batch_id IS NULL
    )
    WHEN 'payment_batch' THEN (
      SELECT encode(sha256(convert_to(jsonb_build_array(
        b.batch_date, b.payment_method, b.bank_account_id, trim_scale(b.total_amount),
        (SELECT jsonb_build_array(ga.bank_account_number, ga.bank_branch_code)
         FROM public.gl_accounts ga WHERE ga.id = b.bank_account_id AND ga.company_id = b.company_id),
        COALESCE((
          SELECT jsonb_agg(m.content ORDER BY m.content::TEXT)
          FROM (SELECT public.approval_supplier_payment_content(sp.company_id, sp.id) AS content
                FROM public.supplier_payments sp
                WHERE sp.batch_id = b.id AND sp.company_id = b.company_id) m
        ), '[]'::jsonb)
      )::TEXT, 'UTF8')), 'hex')
      FROM public.supplier_payment_batches b
      WHERE b.id = p_document_id AND b.company_id = p_company_id
    )
    WHEN 'manual_journal' THEN (
      SELECT encode(sha256(convert_to(jsonb_build_array(
        je.entry_date, je.description, je.reference, je.project_id, je.cost_center_id,
        je.is_intercompany, je.intercompany_company_id,
        COALESCE((
          SELECT jsonb_agg(jsonb_build_array(
                   jl.gl_account_id, trim_scale(jl.debit), trim_scale(jl.credit), jl.description, jl.vat_type,
                   jl.cc1_id, jl.cc2_id, jl.bu_id, jl.project_id, jl.cost_center_id)
                 ORDER BY jl.created_at, jl.gl_account_id, jl.debit, jl.credit, jl.description, jl.vat_type,
                          jl.cc1_id, jl.cc2_id, jl.bu_id, jl.project_id, jl.cost_center_id, jl.id)
          FROM public.gl_journal_lines jl
          WHERE jl.journal_entry_id = je.id
        ), '[]'::jsonb)
      )::TEXT, 'UTF8')), 'hex')
      FROM public.gl_journal_entries je
      WHERE je.id = p_document_id AND je.company_id = p_company_id
    )
  END
$$;

DO $$
DECLARE
  v_changed pg_catalog.int8;
BEGIN
  SELECT count(*) INTO v_changed
  FROM pg_temp.r923_before b
  WHERE b.document_type NOT IN ('supplier_payment', 'payment_batch')
    AND b.digest IS DISTINCT FROM public.approval_document_digest(b.company_id, b.document_type, b.id);
  IF v_changed > 0 THEN
    RAISE EXCEPTION 'migration 923: approval_document_digest changed for % non-payment document(s)', v_changed;
  END IF;
END $$;

-- 867's authors function, verbatim, but for the paying account's setters beside the payee's.
DROP TABLE IF EXISTS pg_temp.r923_authors_before;
CREATE TEMP TABLE r923_authors_before ON COMMIT DROP AS
  SELECT b.company_id, b.document_type, b.id,
         public.approval_document_authors(b.company_id, b.document_type, b.id) AS authors
  FROM pg_temp.r923_before b
  WHERE b.document_type IN ('supplier_payment', 'payment_batch');

CREATE OR REPLACE FUNCTION public.approval_supplier_payment_authors(
  p_company_id pg_catalog.uuid, p_payment_id pg_catalog.uuid
) RETURNS pg_catalog.uuid[]
LANGUAGE sql STABLE
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT b.base || ARRAY(
    SELECT DISTINCT d.author FROM public.payment_allocations pa
    CROSS JOIN LATERAL unnest(public.approval_document_authors(sp.company_id, 'supplier_invoice', pa.invoice_id)) d(author)
    WHERE pa.payment_id = sp.id AND d.author IS NOT NULL AND d.author <> ALL (b.base)
    ORDER BY d.author)
  FROM public.supplier_payments sp
  LEFT JOIN public.suppliers s ON s.id = sp.supplier_id AND s.company_id = sp.company_id
  LEFT JOIN public.gl_accounts ga ON ga.company_id = sp.company_id
    AND ga.id = COALESCE(sp.bank_account_id, (SELECT pb.bank_account_id FROM public.supplier_payment_batches pb
                                              WHERE pb.id = sp.batch_id AND pb.company_id = sp.company_id))
  CROSS JOIN LATERAL (SELECT public.approval_add_author(sp.content_authors, sp.created_by) AS own) o
  CROSS JOIN LATERAL (SELECT o.own || ARRAY(
    SELECT DISTINCT x.author FROM unnest(COALESCE(s.bank_details_setters, '{}') || COALESCE(ga.bank_details_setters, '{}')) x(author)
    WHERE x.author IS NOT NULL AND x.author <> ALL (o.own) ORDER BY x.author) AS base) b
  WHERE sp.id = p_payment_id AND sp.company_id = p_company_id
$$;

DO $$
DECLARE
  v_changed pg_catalog.int8;
BEGIN
  SELECT count(*) INTO v_changed
  FROM pg_temp.r923_authors_before a
  WHERE a.authors IS DISTINCT FROM public.approval_document_authors(a.company_id, a.document_type, a.id);
  IF v_changed > 0 THEN
    RAISE EXCEPTION 'migration 923: approval_document_authors changed for % payment document(s)', v_changed;
  END IF;
END $$;

-- The re-stamp: a stored digest equal to its document's old-definition digest moves to the new one.
-- Rejected and withdrawn requests are left as they are; they clear nothing either way.
DO $$
DECLARE
  v_requests pg_catalog.int8;
  v_requests_restamped pg_catalog.int8;
  v_batches pg_catalog.int8;
  v_batches_restamped pg_catalog.int8;
BEGIN
  SELECT count(*) INTO v_requests FROM public.approval_requests ar
  WHERE ar.document_type IN ('supplier_payment', 'payment_batch') AND ar.status IN ('pending', 'approved');

  UPDATE public.approval_requests ar
  SET document_digest = public.approval_document_digest(ar.company_id, ar.document_type, ar.document_id)
  FROM pg_temp.r923_before b
  WHERE ar.document_type IN ('supplier_payment', 'payment_batch') AND ar.status IN ('pending', 'approved')
    AND b.document_type = ar.document_type AND b.id = ar.document_id AND b.company_id = ar.company_id
    AND ar.document_digest = b.digest;
  GET DIAGNOSTICS v_requests_restamped = ROW_COUNT;

  SELECT count(*) INTO v_batches FROM public.supplier_payment_batches sb WHERE sb.approved_digest IS NOT NULL;

  UPDATE public.supplier_payment_batches sb
  SET approved_digest = public.approval_document_digest(sb.company_id, 'payment_batch', sb.id)
  FROM pg_temp.r923_before b
  WHERE b.document_type = 'payment_batch' AND b.id = sb.id AND b.company_id = sb.company_id
    AND sb.approved_digest = b.digest;
  GET DIAGNOSTICS v_batches_restamped = ROW_COUNT;

  RAISE NOTICE 'migration 923: approval_requests re-stamped %, left stale %', v_requests_restamped, v_requests - v_requests_restamped;
  RAISE NOTICE 'migration 923: supplier_payment_batches re-stamped %, left stale %', v_batches_restamped, v_batches - v_batches_restamped;
END $$;
