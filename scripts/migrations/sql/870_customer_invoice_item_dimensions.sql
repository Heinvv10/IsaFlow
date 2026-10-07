-- 870_customer_invoice_item_dimensions.sql
-- A customer invoice line may name its own revenue account, project (job / production) and cost
-- centre, so revenue posts by line and Project Profitability sees it (Hein, 2026-10-07).
--
-- customer_invoice_items already had gl_account_id (written by quote conversion and recurring
-- transactions, never read by posting, no FK). This adds project_id and cost_center_id beside it,
-- nullable, each under a foreign key. The posting rules live in
-- src/modules/accounting/services/ar/invoiceRevenueLines.ts; a line naming none of the three posts
-- to default_revenue untagged, exactly as before, so no existing invoice changes.
--
-- The FKs are single-column: they prove the row exists, NOT that it is the invoice's company (the
-- line has no company_id). Tenancy is the application's check (ar/invoiceLineCodingGuard.ts), at
-- write time and again at posting. What the FKs buy is that a delete cannot strand a line:
--   - cost_centres: deleteCostCentre already maps 23503 onto its counted "in use" message, and
--     costCentreUsageGuard now counts these lines, so the operator gets the count, not a 500;
--   - projects: nothing deletes a project today.
--
-- gl_account_id gets NO foreign key here, on purpose. Any FK onto gl_accounts joins the account
-- merge's catalogue sweep (gl/accountMergeReferences.ts) and must be named in its exclusion list,
-- which accountMergeExecuteDb pins against the live catalogue — so this file would have to reach
-- every database those tests read before the code could. The merge re-points these lines itself
-- (accountMergeDocumentRows), and a line naming a deleted account is refused at posting as not
-- this company's (invoiceLineCodingGuard), so the gap fails closed.
--
-- APPROVAL DIGEST. A line's project and cost centre reach the journal, so they are approval
-- content: retagging a line after its approval must stale it (security review, 2026-10-07). The
-- customer_invoice arm of approval_document_digest gains cii.project_id and cii.cost_center_id,
-- in the line array and the ORDER BY, as the supplier arm carries sii.project_id/cost_center_id.
--
-- MERGES ONLY AFTER PR #660. Migration 869 (#660) redefines the WHOLE function (it adds the
-- manual_journal arm), so the CREATE OR REPLACE below is 869's complete body plus this change.
-- Were 870 applied first, 869 would then replace the function without these two columns and the
-- bypass would return silently — so the first DO block refuses to run until 869's objects exist.
-- If #660 changes 869's digest before it merges, re-copy its body here.
--
-- Every customer invoice digest changes (two more elements per line, NULL today), so requests
-- are RE-BOUND as 708 did for its pending supplier-invoice requests: a pending or approved
-- customer_invoice request whose stored digest equals the invoice's digest computed just before
-- the replace is moved to the new digest. Same content — project_id and cost_center_id are NULL
-- on every line when this first runs — so an approval keeps clearing exactly what it cleared,
-- and a request that was already stale stays stale. Every other type's digest must not move.
--
-- Locks: ADD COLUMN takes ACCESS EXCLUSIVE on customer_invoice_items for a catalogue-only change
-- (nullable, no default); each ADD CONSTRAINT takes SHARE ROW EXCLUSIVE on both tables (the new
-- columns are all NULL, so validating them scans nothing that can fail). The digest replace and
-- the request re-bind read every open document once. Bounded below; either firing rolls back.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

ALTER TABLE customer_invoice_items ADD COLUMN IF NOT EXISTS project_id UUID;
ALTER TABLE customer_invoice_items ADD COLUMN IF NOT EXISTS cost_center_id UUID;

CREATE INDEX IF NOT EXISTS idx_cii_project_id
  ON customer_invoice_items (project_id) WHERE project_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_cii_cost_center_id
  ON customer_invoice_items (cost_center_id) WHERE cost_center_id IS NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                 WHERE conname = 'customer_invoice_items_project_id_fkey'
                   AND conrelid = 'customer_invoice_items'::regclass) THEN
    ALTER TABLE customer_invoice_items
      ADD CONSTRAINT customer_invoice_items_project_id_fkey
      FOREIGN KEY (project_id) REFERENCES projects(id);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                 WHERE conname = 'customer_invoice_items_cost_center_id_fkey'
                   AND conrelid = 'customer_invoice_items'::regclass) THEN
    ALTER TABLE customer_invoice_items
      ADD CONSTRAINT customer_invoice_items_cost_center_id_fkey
      FOREIGN KEY (cost_center_id) REFERENCES cost_centres(id);
  END IF;
END $$;

-- ── Approval digest ────────────────────────────────────────────────────────
DO $$
BEGIN
  IF pg_catalog.to_regprocedure('public.approval_manual_journal_gate_amount(uuid,uuid)') IS NULL
     OR pg_catalog.pg_get_functiondef('public.approval_document_digest(uuid,text,uuid)'::pg_catalog.regprocedure)
        NOT LIKE '%WHEN ''manual_journal''%' THEN
    RAISE EXCEPTION 'migration 870: apply migration 869 (PR #660, manual journal approval) first — 870 replaces 869''s approval_document_digest';
  END IF;
END $$;

-- Every document whose digest anything could still be compared against, as 869 snapshots them.
DROP TABLE IF EXISTS pg_temp.r870_before;
CREATE TEMP TABLE r870_before ON COMMIT DROP AS
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
  WHERE b.status IN ('draft', 'approved')
     OR EXISTS (SELECT 1 FROM public.approval_requests ar
                WHERE ar.document_type = 'payment_batch' AND ar.document_id = b.id)
  UNION ALL
  SELECT je.company_id, 'manual_journal', je.id,
         public.approval_document_digest(je.company_id, 'manual_journal', je.id)
  FROM public.gl_journal_entries je
  WHERE je.approval_document_type IS NOT NULL
     OR EXISTS (SELECT 1 FROM public.approval_requests ar
                WHERE ar.document_type = 'manual_journal' AND ar.document_id = je.id);

-- 869's function, verbatim, but for the customer_invoice line array and its ORDER BY.
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
                   sii.vat_classification)
                 ORDER BY sii.created_at, sii.description, sii.gl_account_id, sii.quantity,
                          sii.unit_price, sii.tax_rate, sii.tax_amount, sii.line_total,
                          sii.project_id, sii.cost_center_id, sii.vat_classification, sii.id)
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
        trim_scale(cn.total_amount), cn.project_id, cn.cost_center_id
      )::TEXT, 'UTF8')), 'hex')
      FROM public.credit_notes cn
      WHERE cn.id = p_document_id AND cn.company_id = p_company_id AND cn.type = 'customer'
    )
    WHEN 'supplier_credit_note' THEN (
      SELECT encode(sha256(convert_to(jsonb_build_array(
        cn.type, cn.credit_note_number, cn.client_id, cn.customer_invoice_id,
        cn.supplier_id, cn.supplier_invoice_id, cn.credit_date, cn.currency,
        trim_scale(cn.subtotal), trim_scale(cn.tax_rate), trim_scale(cn.tax_amount),
        trim_scale(cn.total_amount), cn.project_id, cn.cost_center_id
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
                   cii.project_id, cii.cost_center_id, cii.currency_code)
                 ORDER BY cii.created_at, cii.description, cii.quantity, cii.unit_price,
                          cii.amount, cii.tax_rate, cii.gl_account_id, cii.project_id,
                          cii.cost_center_id, cii.currency_code, cii.id)
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

DO $$
DECLARE
  v_changed pg_catalog.int8;
BEGIN
  SELECT count(*) INTO v_changed
  FROM pg_temp.r870_before b
  WHERE b.document_type <> 'customer_invoice'
    AND b.digest IS DISTINCT FROM public.approval_document_digest(b.company_id, b.document_type, b.id);
  IF v_changed > 0 THEN
    RAISE EXCEPTION 'migration 870: approval_document_digest changed for % non-invoice document(s)', v_changed;
  END IF;
END $$;

-- Re-bind (708's precedent): a request bound to the invoice's content as it stood a moment ago
-- is bound to the same content under the new definition. Decided-and-rejected and withdrawn
-- requests are left as they are; they clear nothing either way.
UPDATE public.approval_requests ar
SET document_digest = public.approval_document_digest(ar.company_id, 'customer_invoice', ar.document_id)
FROM pg_temp.r870_before b
WHERE ar.document_type = 'customer_invoice' AND ar.status IN ('pending', 'approved')
  AND b.document_type = 'customer_invoice' AND b.id = ar.document_id AND b.company_id = ar.company_id
  AND ar.document_digest = b.digest;
