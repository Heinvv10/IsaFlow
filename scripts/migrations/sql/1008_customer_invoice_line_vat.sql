-- 1008_customer_invoice_line_vat.sql
-- Per-line VAT on customer invoices, the schema half (per-line VAT programme, 2026-11-19). A line may carry its own
-- VAT TYPE and the VAT it charges, so one invoice can mix standard, zero-rated and exempt supplies and each posts to
-- its own VAT201 field. This PR adds the columns and teaches the readers (GL posting, credit-note legs, PDF, detail
-- GET, VAT reports) to read them; NOTHING WRITES THEM YET. Writers come in the next PR.
--
-- WHAT.
--   customer_invoice_items.vat_type    TEXT NULL: the line's VAT type, in the ledger's spelling (VatType, gl.types).
--   customer_invoice_items.tax_amount  NUMERIC(15,2) NULL: the VAT the line charges, rounded on the line
--                                      (shared/vatLineAmounts). Both NULL or both set (CHECK below).
--   customer_invoices.amounts_are      TEXT NULL: 'exclusive' | 'inclusive', how the lines' UNIT PRICES were entered.
--                                      NULL reads as exclusive. A line's amount is its NET on every invoice.
-- A line is TYPED when vat_type and tax_amount are set; an invoice is typed when every line is. NULL is a legacy
-- document-rate invoice, which reads, prints and posts exactly as before. Nothing is backfilled.
-- The vat_type CHECK is the ledger's full list (gl.types VatType; tests/unit/services/ar/customerInvoiceLineVatCheck.test.ts
-- pins the two together), not the shorter list a screen offers (shared/vatTypes DOCUMENT_LINE_VAT_TYPES).
--
-- APPROVAL DIGEST. A line's VAT type reaches the journal and the VAT201: zero-rated and exempt both carry rate 0 yet
-- post to different fields, so an approval must not survive a change between them. The customer_invoice arm gains
-- cii.vat_type and trim_scale(cii.tax_amount) in the line array and its ORDER BY, and ci.amounts_are in the header.
-- Since migration 951 the live approval_document_digest is a wrapper (pay_run, else
-- approval_document_digest_pre_payroll_951), and _pre_payroll_951 holds 923's body: that function is replaced below,
-- 923's body verbatim but for these three inputs. The wrapper is not touched. Neither is SECURITY DEFINER (LANGUAGE sql
-- STABLE); CREATE OR REPLACE keeps the owner, grants and search_path, so no app_definer_reviews row (930) applies.
--
-- RE-BIND (874's procedure). Every customer invoice digest changes (three more NULL elements on a legacy invoice), so
-- every stored one would read as stale from this deploy. A pending or approved customer_invoice request whose stored
-- digest equals the invoice's digest under the OLD definition, computed here just before the replace, is bound to the
-- content as it stands: it is moved to the new definition's digest of that same content. The three new inputs are NULL
-- on every row when this runs, so the content an approval vouched for is unchanged. A request that was already stale
-- (or bound nothing) is left as it was and still needs re-approval; rejected and withdrawn ones clear nothing either
-- way. Counts are reported by RAISE NOTICE. Every other type's digest must not move: a guard refuses the migration if
-- one does. An open invoice page holds a shown digest (invoicePdfModel) made from the old approval digest; its Approve
-- or autosave answers STALE once and the reload carries the new one, as after 874.
--
-- AFTER 951 AND 923: the first DO block refuses to run unless the wrapper delegates to _pre_payroll_951 and that holds
-- 923's body (874's line coding and 923's payment originator). The snapshot and the re-bind read every company's
-- documents, so the role must bypass RLS (923's check). Every table the digests read is locked first (923's order and
-- modes), so no edit or request can commit between the "before" snapshot and the re-bind.
--
-- Locks: ADD COLUMN takes ACCESS EXCLUSIVE on customer_invoice_items and customer_invoices for a catalogue-only change
-- (nullable, no default); ADD CONSTRAINT validates against all-NULL columns. Should either column already exist with
-- data that breaks a CHECK, the ADD CONSTRAINT fails and the migration rolls back whole. Bounded below.
--
-- OLD COLOUR. Old code never names the new columns: its writers leave them NULL (legacy), its readers ignore them.
-- Rollback (code first, only while no line is typed): re-create _pre_payroll_951 from 923's body, re-bind as above,
-- then drop the three CHECKs and the three columns.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

DO $$
BEGIN
  IF NOT COALESCE((SELECT r.rolsuper OR r.rolbypassrls FROM pg_catalog.pg_roles r WHERE r.rolname = current_user), false) THEN
    RAISE EXCEPTION 'migration 1008: run as a role that bypasses RLS - the re-bind must read every company''s documents';
  END IF;
END $$;

LOCK TABLE public.customer_invoices, public.customer_invoice_items, public.supplier_invoices,
           public.supplier_invoice_items, public.credit_notes IN SHARE MODE;
LOCK TABLE public.approval_requests, public.supplier_payment_batches IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE public.supplier_payments, public.payment_allocations, public.suppliers, public.gl_accounts IN SHARE MODE;

DO $$
BEGIN
  IF pg_catalog.to_regprocedure('public.approval_document_digest_pre_payroll_951(uuid,text,uuid)') IS NULL
     OR pg_catalog.pg_get_functiondef('public.approval_document_digest(uuid,text,uuid)'::pg_catalog.regprocedure)
          NOT LIKE '%approval_document_digest_pre_payroll_951(%' THEN
    RAISE EXCEPTION 'migration 1008: apply migration 951 first - 1008 replaces the digest 951''s wrapper delegates to';
  END IF;
  IF pg_catalog.pg_get_functiondef('public.approval_document_digest_pre_payroll_951(uuid,text,uuid)'::pg_catalog.regprocedure)
        NOT LIKE '%cii.gl_account_id, cii.project_id, cii.currency_code%'
     OR pg_catalog.pg_get_functiondef('public.approval_document_digest_pre_payroll_951(uuid,text,uuid)'::pg_catalog.regprocedure)
        NOT LIKE '%ga.bank_account_number, ga.bank_branch_code%' THEN
    RAISE EXCEPTION 'migration 1008: approval_document_digest_pre_payroll_951 is not 923''s body - 1008 replaces it';
  END IF;
END $$;

ALTER TABLE public.customer_invoice_items ADD COLUMN IF NOT EXISTS vat_type TEXT NULL;
ALTER TABLE public.customer_invoice_items ADD COLUMN IF NOT EXISTS tax_amount NUMERIC(15,2) NULL;
ALTER TABLE public.customer_invoices ADD COLUMN IF NOT EXISTS amounts_are TEXT NULL;

ALTER TABLE public.customer_invoice_items DROP CONSTRAINT IF EXISTS customer_invoice_items_vat_type_check;
ALTER TABLE public.customer_invoice_items ADD CONSTRAINT customer_invoice_items_vat_type_check
  CHECK (vat_type IS NULL OR vat_type IN ('standard', 'zero_rated', 'exempt', 'capital_goods', 'export', 'imported',
                                          'reverse_charge', 'bad_debt', 'no_vat'));
ALTER TABLE public.customer_invoice_items DROP CONSTRAINT IF EXISTS customer_invoice_items_vat_type_tax_amount_pair;
ALTER TABLE public.customer_invoice_items ADD CONSTRAINT customer_invoice_items_vat_type_tax_amount_pair
  CHECK ((vat_type IS NULL) = (tax_amount IS NULL));
ALTER TABLE public.customer_invoices DROP CONSTRAINT IF EXISTS customer_invoices_amounts_are_check;
ALTER TABLE public.customer_invoices ADD CONSTRAINT customer_invoices_amounts_are_check
  CHECK (amounts_are IS NULL OR amounts_are IN ('exclusive', 'inclusive'));

COMMENT ON COLUMN public.customer_invoice_items.vat_type IS
  'The line''s VAT type (ledger spelling, gl.types VatType). Set with tax_amount or not at all. NULL: a legacy document-rate line (migration 1008). Approval content.';
COMMENT ON COLUMN public.customer_invoice_items.tax_amount IS
  'The VAT the line charges, rounded on the line (shared/vatLineAmounts). Set with vat_type or not at all (migration 1008). Approval content.';
COMMENT ON COLUMN public.customer_invoices.amounts_are IS
  'exclusive | inclusive: how the lines'' unit prices were entered; a line''s amount is its net either way. NULL reads as exclusive (migration 1008). Approval content.';

-- 923's snapshot, every type _pre_payroll_951 digests, so the guard below can prove the other types did not move.
DROP TABLE IF EXISTS pg_temp.r1008_before;
CREATE TEMP TABLE r1008_before ON COMMIT DROP AS
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
  FROM pg_temp.r1008_before b
  WHERE b.document_type <> 'customer_invoice'
    AND b.digest IS DISTINCT FROM public.approval_document_digest(b.company_id, b.document_type, b.id);
  IF v_changed > 0 THEN
    RAISE EXCEPTION 'migration 1008: approval_document_digest changed for % non-invoice document(s)', v_changed;
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
  FROM pg_temp.r1008_before b
  WHERE ar.document_type = 'customer_invoice' AND ar.status IN ('pending', 'approved')
    AND b.document_type = 'customer_invoice' AND b.id = ar.document_id AND b.company_id = ar.company_id
    AND ar.document_digest = b.digest;
  GET DIAGNOSTICS v_rebound = ROW_COUNT;

  RAISE NOTICE 'migration 1008: customer_invoice approval_requests re-bound %, left stale %', v_rebound, v_requests - v_rebound;
END $$;
