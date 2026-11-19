-- 1009_customer_invoice_digest_line_vat.sql
-- The per-line VAT columns of migration 1008 become APPROVAL CONTENT. A line's VAT type reaches the journal and the
-- VAT201: zero-rated and exempt both carry rate 0 yet post to different fields, so an approval must not survive a
-- change between them. The customer_invoice arm gains cii.vat_type and trim_scale(cii.tax_amount) in the line array and
-- its ORDER BY, and ci.amounts_are in the header. Since migration 951 the live approval_document_digest is a wrapper
-- (pay_run, else approval_document_digest_pre_payroll_951), and _pre_payroll_951 holds 923's body: that function is
-- replaced below, 923's body verbatim but for these three inputs. The wrapper is not touched. Neither is SECURITY
-- DEFINER (LANGUAGE sql STABLE); CREATE OR REPLACE keeps the owner, grants and search_path, so no app_definer_reviews
-- row (930) applies.
--
-- APART FROM 1008 (PR #1648 review M1): there the ADD COLUMNs hold ACCESS EXCLUSIVE on both invoice tables to that
-- file's COMMIT; the snapshot and re-bind below read every company's documents, and under those locks every read of an
-- invoice by the live app waited for them. The runner commits each file on its own (migrationFiles.applyOne). Here only
-- 923's locks are taken, SHARE on the document tables (readers carry on, writers wait), and no statement needs more
-- than it first takes: CREATE OR REPLACE FUNCTION locks the function, the UPDATE of approval_requests takes ROW
-- EXCLUSIVE under the SHARE ROW EXCLUSIVE already held, the rest read. Nothing upgrades a lock.
--   IF 1008 APPLIES AND THIS FILE FAILS, the deploy stops before switching colour. The old colour keeps serving: the
-- columns exist, all NULL; nothing it runs names them; the digest is still 923's body over the old inputs, so stored
-- approvals still match; and the new colour never went live. The next deploy applies this file. Safe.
--
-- RE-BIND (874's procedure). Every customer invoice digest changes (three more NULL elements on a legacy invoice), so
-- every stored one would read as stale from this deploy. A pending or approved customer_invoice request whose stored
-- digest equals the invoice's digest under the OLD definition, computed here just before the replace, is bound to the
-- content as it stands: it is moved to the new definition's digest of that same content. The three new inputs are NULL
-- on every row when this runs, so the content an approval vouched for is unchanged. A request that was already stale
-- (or bound nothing) is left as it was and still needs re-approval; rejected and withdrawn ones clear nothing either
-- way. Counts are reported by RAISE NOTICE. Every other type's digest must not move: a guard refuses the file if one
-- does. Run again (the body already this file's), it changes nothing: the snapshot is the new digest.
--
-- SHOWN AND DRAFT DIGESTS (review Q5). An open invoice page holds a shown digest and a draft digest (ar/invoicePdfModel)
-- made from the approval digest and the PDF model, which this release also extends (amounts_are; a line's vat_type and
-- tax_amount). During the blue/green window the two colours compute different ones, and after the switch every page
-- opened before it answers STALE_VIEW once on Approve (and once on a draft autosave); the reload carries the new one.
--
-- PREREQUISITES. 1008's columns; the 951 wrapper delegating to _pre_payroll_951; and _pre_payroll_951's body (md5 of
-- pg_proc.prosrc) being EXACTLY 923's, 35edbb1603da73e43e78bab0c10e0a4a (first run), or this file's own,
-- b41e524b5beb1d5d384bcff0b11c1eba (a re-run), and nothing else (review M3: two substrings matched the new body too).
-- Derived from the repo's SQL text: prosrc is the text between `AS $$` and `$$;` of
-- `CREATE OR REPLACE FUNCTION public.approval_document_digest(` in 923 (951 copied it through pg_get_functiondef, which
-- re-emits prosrc verbatim) and of the function below; tests/integration/invoice-line-vat-migration.int.test.ts
-- recomputes both from the files and compares them with these and with Postgres' own md5(prosrc).
--
-- NOT LOCKED (review M4, as 923): gl_journal_entries / gl_journal_lines, which the manual_journal arm reads. A journal
-- edit committing between the snapshot and the guard makes the guard see a moved manual_journal digest and abort the
-- file: fail-safe, a spurious deploy failure that a re-run clears.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

DO $$
BEGIN
  IF NOT COALESCE((SELECT r.rolsuper OR r.rolbypassrls FROM pg_catalog.pg_roles r WHERE r.rolname = current_user), false) THEN
    RAISE EXCEPTION 'migration 1009: run as a role that bypasses RLS - the re-bind must read every company''s documents';
  END IF;
END $$;

LOCK TABLE public.customer_invoices, public.customer_invoice_items, public.supplier_invoices,
           public.supplier_invoice_items, public.credit_notes IN SHARE MODE;
LOCK TABLE public.approval_requests, public.supplier_payment_batches IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE public.supplier_payments, public.payment_allocations, public.suppliers, public.gl_accounts IN SHARE MODE;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_attribute
                 WHERE attrelid = 'public.customer_invoice_items'::pg_catalog.regclass AND attname = 'vat_type' AND NOT attisdropped)
     OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_attribute
                    WHERE attrelid = 'public.customer_invoices'::pg_catalog.regclass AND attname = 'amounts_are' AND NOT attisdropped) THEN
    RAISE EXCEPTION 'migration 1009: apply migration 1008 first - the digest reads its columns';
  END IF;
  IF pg_catalog.to_regprocedure('public.approval_document_digest_pre_payroll_951(uuid,text,uuid)') IS NULL
     OR pg_catalog.pg_get_functiondef('public.approval_document_digest(uuid,text,uuid)'::pg_catalog.regprocedure)
          NOT LIKE '%approval_document_digest_pre_payroll_951(%' THEN
    RAISE EXCEPTION 'migration 1009: apply migration 951 first - 1009 replaces the digest 951''s wrapper delegates to';
  END IF;
  IF (SELECT pg_catalog.md5(p.prosrc) FROM pg_catalog.pg_proc p
      WHERE p.oid = 'public.approval_document_digest_pre_payroll_951(uuid,text,uuid)'::pg_catalog.regprocedure)
     NOT IN ('35edbb1603da73e43e78bab0c10e0a4a', 'b41e524b5beb1d5d384bcff0b11c1eba') THEN
    RAISE EXCEPTION 'migration 1009: approval_document_digest_pre_payroll_951 is neither 923''s body nor 1009''s - 1009 replaces it';
  END IF;
END $$;

-- 923's snapshot, every type _pre_payroll_951 digests, so the guard below can prove the other types did not move.
DROP TABLE IF EXISTS pg_temp.r1009_before;
CREATE TEMP TABLE r1009_before ON COMMIT DROP AS
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

-- 923's approval_document_digest, verbatim, under 951's name, but for ci.amounts_are in the customer_invoice header and
-- cii.vat_type, trim_scale(cii.tax_amount) in its line array and ORDER BY.
CREATE OR REPLACE FUNCTION public.approval_document_digest_pre_payroll_951(
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
        trim_scale(ci.total_amount), trim_scale(ci.functional_total), ci.project_id, ci.amounts_are,
        COALESCE((
          SELECT jsonb_agg(jsonb_build_array(
                   cii.description, trim_scale(cii.quantity), trim_scale(cii.unit_price),
                   trim_scale(cii.amount), trim_scale(cii.tax_rate), cii.gl_account_id,
                   cii.project_id, cii.currency_code, cii.cc1_id, cii.cc2_id, cii.bu_id,
                   cii.vat_type, trim_scale(cii.tax_amount))
                 ORDER BY cii.created_at, cii.description, cii.quantity, cii.unit_price,
                          cii.amount, cii.tax_rate, cii.gl_account_id, cii.project_id, cii.currency_code,
                          cii.cc1_id, cii.cc2_id, cii.bu_id, cii.vat_type, cii.tax_amount, cii.id)
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
  FROM pg_temp.r1009_before b
  WHERE b.document_type <> 'customer_invoice'
    AND b.digest IS DISTINCT FROM public.approval_document_digest(b.company_id, b.document_type, b.id);
  IF v_changed > 0 THEN
    RAISE EXCEPTION 'migration 1009: approval_document_digest changed for % non-invoice document(s)', v_changed;
  END IF;
END $$;

-- The re-bind: a stored digest equal to its invoice's old-definition digest moves to the new one.
DO $$
DECLARE
  v_requests pg_catalog.int8;
  v_rebound pg_catalog.int8;
BEGIN
  SELECT count(*) INTO v_requests FROM public.approval_requests ar
  WHERE ar.document_type = 'customer_invoice' AND ar.status IN ('pending', 'approved');

  UPDATE public.approval_requests ar
  SET document_digest = public.approval_document_digest(ar.company_id, 'customer_invoice', ar.document_id)
  FROM pg_temp.r1009_before b
  WHERE ar.document_type = 'customer_invoice' AND ar.status IN ('pending', 'approved')
    AND b.document_type = 'customer_invoice' AND b.id = ar.document_id AND b.company_id = ar.company_id
    AND ar.document_digest = b.digest;
  GET DIAGNOSTICS v_rebound = ROW_COUNT;

  RAISE NOTICE 'migration 1009: customer_invoice approval_requests re-bound %, left stale %', v_rebound, v_requests - v_rebound;
END $$;
