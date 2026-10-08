-- 873: the approval digest covers the CC1 / CC2 / BU a document posts.
--
-- Migration 870 gave customer_invoice_items, supplier_invoice_items and
-- credit_notes (a note's header is its one posting line) cc1_id / cc2_id /
-- bu_id, and #663 copies them onto the revenue / expense leg of the journal.
-- approval_document_digest (869) did not hash them, so a document could be
-- retagged to another FNO, project or business unit after it was approved and
-- still post on that approval: neither DOCUMENT_CHANGED nor the backstops
-- (712 / 862 / 865) saw a change.
--
-- 1. The digest: 869's body verbatim, plus the three columns on the
--    customer_invoice and supplier_invoice line arrays (in the array AND the
--    ORDER BY, after every existing column and before the id, as 869 orders
--    lines) and on both credit-note arms. supplier_payment and payment_batch
--    carry no dimensions (bank allocation refuses them on a settlement), and
--    manual_journal already hashes its lines' cc1/cc2/bu: those arms are
--    unchanged, and a guard below proves it.
-- 2. Re-binding: extending an array moves EVERY digest of those four types,
--    dimensions or not. Only a document that carries NO dimension — every
--    cc1_id / cc2_id / bu_id NULL on its header and every line — is known to
--    post what was approved: the columns did not exist before 870, and an
--    approval of such a document covered everything it posts. A pending or
--    approved request of one, whose stored digest is the document's digest as
--    869 computed it, is re-bound to the new digest and keeps clearing. A
--    document carrying ANY dimension may have been tagged after it was
--    approved — the defect this migration closes, which 869's digest cannot
--    tell apart from a tag approved with it — so its requests are left stale
--    and it needs re-approval. A request already stale stays stale.
--    The document tables and approval_requests are locked first (SHARE /
--    SHARE ROW EXCLUSIVE), so no edit or request can commit between the
--    "before" snapshot and the re-bind: an edit landing in that window would
--    otherwise be re-bound as if it had been approved.
--
-- Re-runnable: on a second run the "before" digest is already 873's, so no
-- stored digest differs from the new one and nothing is re-bound.
--
-- apply-migrations.ts wraps the file in BEGIN/COMMIT; fail fast rather than
-- queue behind a long reader on approval_requests.
SET LOCAL lock_timeout = '5s';

-- ── 0. 870 first ─────────────────────────────────────────────────────────────
DO $$
DECLARE
  v_have pg_catalog.int8;
BEGIN
  SELECT count(*) INTO v_have
  FROM information_schema.columns
  WHERE table_schema = 'public'
    AND table_name IN ('customer_invoice_items', 'supplier_invoice_items', 'credit_notes')
    AND column_name IN ('cc1_id', 'cc2_id', 'bu_id');
  IF v_have <> 9 THEN
    RAISE EXCEPTION 'migration 873: the document dimension columns are missing (% of 9) — apply 870_dimensions_cc_bu_capture first', v_have;
  END IF;
END $$;

-- ── Hold every writer of what the snapshot reads, until COMMIT ───────────────
-- SHARE lets readers through and stops writers; approval_requests takes SHARE
-- ROW EXCLUSIVE, which this transaction's own UPDATE below can join without
-- upgrading against a peer's SHARE. The 5 s lock_timeout bounds the wait.
LOCK TABLE public.customer_invoices, public.customer_invoice_items, public.supplier_invoices,
           public.supplier_invoice_items, public.credit_notes IN SHARE MODE;
LOCK TABLE public.approval_requests IN SHARE ROW EXCLUSIVE MODE;

-- ── Before: every request a re-bind could keep, and every unchanged arm ─────
DROP TABLE IF EXISTS pg_temp.r873_bound;
CREATE TEMP TABLE r873_bound ON COMMIT DROP AS
  SELECT ar.id AS request_id,
         public.approval_document_digest(ar.company_id, ar.document_type, ar.document_id) AS old_digest
  FROM public.approval_requests ar
  WHERE ar.status IN ('pending', 'approved')
    AND ar.document_type IN ('customer_invoice', 'supplier_invoice', 'customer_credit_note', 'supplier_credit_note')
    AND ar.company_id IS NOT NULL AND ar.document_digest IS NOT NULL
    -- No dimension anywhere on the document (see 2. above).
    AND NOT EXISTS (
      SELECT 1 FROM public.customer_invoice_items cii
      JOIN public.customer_invoices ci ON ci.id = cii.invoice_id AND ci.company_id = ar.company_id
      WHERE ar.document_type = 'customer_invoice' AND cii.invoice_id = ar.document_id
        AND (cii.cc1_id IS NOT NULL OR cii.cc2_id IS NOT NULL OR cii.bu_id IS NOT NULL))
    AND NOT EXISTS (
      SELECT 1 FROM public.supplier_invoice_items sii
      JOIN public.supplier_invoices si ON si.id = sii.supplier_invoice_id AND si.company_id = ar.company_id
      WHERE ar.document_type = 'supplier_invoice' AND sii.supplier_invoice_id = ar.document_id
        AND (sii.cc1_id IS NOT NULL OR sii.cc2_id IS NOT NULL OR sii.bu_id IS NOT NULL))
    AND NOT EXISTS (
      SELECT 1 FROM public.credit_notes cn
      WHERE ar.document_type IN ('customer_credit_note', 'supplier_credit_note')
        AND cn.id = ar.document_id AND cn.company_id = ar.company_id
        AND (cn.cc1_id IS NOT NULL OR cn.cc2_id IS NOT NULL OR cn.bu_id IS NOT NULL));

DROP TABLE IF EXISTS pg_temp.r873_unchanged;
CREATE TEMP TABLE r873_unchanged ON COMMIT DROP AS
  SELECT sp.company_id, 'supplier_payment'::TEXT AS document_type, sp.id,
         public.approval_document_digest(sp.company_id, 'supplier_payment', sp.id) AS digest
  FROM public.supplier_payments sp
  WHERE sp.batch_id IS NULL
    AND (sp.status IN ('draft', 'approved')
         OR EXISTS (SELECT 1 FROM public.approval_requests ar
                    WHERE ar.document_type = 'supplier_payment' AND ar.document_id = sp.id))
  UNION ALL
  SELECT b.company_id, 'payment_batch', b.id,
         public.approval_document_digest(b.company_id, 'payment_batch', b.id)
  FROM public.supplier_payment_batches b
  WHERE b.status IN ('draft', 'approved')
     OR EXISTS (SELECT 1 FROM public.approval_requests ar
                WHERE ar.document_type = 'payment_batch' AND ar.document_id = b.id)
  UNION ALL
  SELECT je.company_id, 'manual_journal', je.id,
         public.approval_document_digest(je.company_id, 'manual_journal', je.id)
  FROM public.gl_journal_entries je
  WHERE (je.status = 'draft' AND je.approval_document_type IS NOT NULL)
     OR EXISTS (SELECT 1 FROM public.approval_requests ar
                WHERE ar.document_type = 'manual_journal' AND ar.document_id = je.id);

-- ── 1. The digest ────────────────────────────────────────────────────────────
-- 869's definition, every arm verbatim but for the dimension columns. What
-- each arm covers and deliberately leaves out is documented there (and in 708,
-- 862, 865 and 867). The dimensions sit on the line (or, for a note, the
-- header that is its line); trim_scale() and sha256 over UTF-8 as before.
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
                   cii.currency_code, cii.cc1_id, cii.cc2_id, cii.bu_id)
                 ORDER BY cii.created_at, cii.description, cii.quantity, cii.unit_price,
                          cii.amount, cii.tax_rate, cii.gl_account_id, cii.currency_code,
                          cii.cc1_id, cii.cc2_id, cii.bu_id, cii.id)
          FROM public.customer_invoice_items cii
          WHERE cii.invoice_id = ci.id
        ), '[]'::jsonb)
      )::TEXT, 'UTF8')), 'hex')
      FROM public.customer_invoices ci
      WHERE ci.id = p_document_id AND ci.company_id = p_company_id AND ci.deleted_at IS NULL
    )
    WHEN 'supplier_payment' THEN (
      SELECT encode(sha256(convert_to(
        public.approval_supplier_payment_content(sp.company_id, sp.id)::TEXT, 'UTF8')), 'hex')
      FROM public.supplier_payments sp
      WHERE sp.id = p_document_id AND sp.company_id = p_company_id AND sp.batch_id IS NULL
    )
    WHEN 'payment_batch' THEN (
      SELECT encode(sha256(convert_to(jsonb_build_array(
        b.batch_date, b.payment_method, b.bank_account_id, trim_scale(b.total_amount),
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

-- ── 2. Re-bind what vouched for an untagged document's identical content ────
UPDATE public.approval_requests ar
SET document_digest = public.approval_document_digest(ar.company_id, ar.document_type, ar.document_id)
FROM pg_temp.r873_bound b
WHERE ar.id = b.request_id
  AND ar.document_digest = b.old_digest
  AND ar.document_digest IS DISTINCT FROM public.approval_document_digest(ar.company_id, ar.document_type, ar.document_id);

-- ── 3. The arms this did not mean to touch ──────────────────────────────────
DO $$
DECLARE
  v_changed pg_catalog.int8;
BEGIN
  SELECT count(*) INTO v_changed
  FROM pg_temp.r873_unchanged u
  WHERE u.digest IS DISTINCT FROM public.approval_document_digest(u.company_id, u.document_type, u.id);
  IF v_changed > 0 THEN
    RAISE EXCEPTION 'migration 873: approval_document_digest changed for % supplier payment / batch / manual journal(s)', v_changed;
  END IF;
END $$;
