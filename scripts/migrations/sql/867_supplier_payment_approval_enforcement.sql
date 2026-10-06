-- 867: R-035 PR5 — approval enforcement on SUPPLIER PAYMENTS and BATCH EFT.
--
-- Two document types (Hein, 2026-10-06; decision Q4: payments gate the
-- INSTRUCTION to pay, never the record of money already moved):
--   * `supplier_payment` — a single payment instruction: a supplier_payments
--     row with batch_id NULL;
--   * `payment_batch` — a supplier_payment_batches row. ONE approvable
--     document: its lines are its member supplier_payments and their
--     payment_allocations, its digest covers every line's payee, payee bank
--     details and amount, and changing any line voids the approval. A member
--     is approved and paid only through its batch.
-- The legacy `payment` type is left alone: its rules govern neither type.
--
-- Pieces:
--   1. approval_enforcement accepts the two types.
--   2. WHO AUTHORED a payment's or batch's content: content_authors /
--      content_edited_at on both tables, stamped by the digest-moving edits —
--      a supplier merge and a change to the payee's bank details. The creator
--      is created_by; creating stamps nothing.
--   3. The amount a rule sees: approval_supplier_payment_gate_amount() and
--      approval_payment_batch_gate_amount().
--   4. approval_document_digest() and approval_document_authors() gain both
--      branches. Every earlier branch (supplier_invoice 708 / 712, both
--      credit-note types 862, customer_invoice 865) is copied verbatim, and a
--      guard refuses the migration if any of their digests or authors changed.
--   5. Two backstop triggers, one per table (see §5).
--   6. approval_request_insert_guard() (862) binds both types too.

-- ── 1. The payment types may carry an enforcement row ─────────────────────
ALTER TABLE approval_enforcement DROP CONSTRAINT IF EXISTS approval_enforcement_document_type_check;
ALTER TABLE approval_enforcement ADD CONSTRAINT approval_enforcement_document_type_check CHECK (document_type IN (
  'customer_invoice', 'supplier_invoice', 'payment', 'journal_entry', 'credit_note',
  'customer_credit_note', 'supplier_credit_note', 'supplier_payment', 'payment_batch'));

-- ── 2. The authors ────────────────────────────────────────────────────────
-- Append-only, through approval_add_author (712). Payments have no content
-- edit route; what moves a payment's digest without it is the supplier merge
-- (re-points supplier_id: supplier-merge.ts, duplicateMergeService) and an
-- edit of the payee's bank details (supplierWriteService.updateSupplier, the
-- supplier take-on overwrite) — whoever changes WHERE the money goes may not
-- approve sending it. Each stamps every unpaid payment it moves and the batch
-- of every member it moves. Golden path d creates a payment and writes neither.
ALTER TABLE supplier_payments ADD COLUMN IF NOT EXISTS content_authors UUID[] NOT NULL DEFAULT '{}';
ALTER TABLE supplier_payments ADD COLUMN IF NOT EXISTS content_edited_at TIMESTAMPTZ;
ALTER TABLE supplier_payment_batches ADD COLUMN IF NOT EXISTS content_authors UUID[] NOT NULL DEFAULT '{}';
ALTER TABLE supplier_payment_batches ADD COLUMN IF NOT EXISTS content_edited_at TIMESTAMPTZ;

-- ── 3. The amount a rule sees ──────────────────────────────────────────────
-- processSupplierPayment posts total_amount (DR AP / CR bank). ABS because the
-- one negative kind (a refund) inverts the posting rather than shrinking it.
CREATE OR REPLACE FUNCTION public.approval_supplier_payment_gate_amount(p_total pg_catalog.numeric)
RETURNS pg_catalog.numeric
LANGUAGE sql IMMUTABLE
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT ABS(COALESCE(p_total, 0))
$$;

-- processBatch posts the batch's STORED total_amount in one journal and bumps
-- every member's bills by their allocations; nothing makes the stored total
-- equal the members' sum. A rule sees the LARGER of the two.
CREATE OR REPLACE FUNCTION public.approval_payment_batch_gate_amount(
  p_company_id pg_catalog.uuid, p_batch_id pg_catalog.uuid
) RETURNS pg_catalog.numeric
LANGUAGE sql STABLE
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT GREATEST(
    ABS(COALESCE((SELECT b.total_amount FROM public.supplier_payment_batches b
                  WHERE b.id = p_batch_id AND b.company_id = p_company_id), 0)),
    ABS(COALESCE((SELECT SUM(sp.total_amount) FROM public.supplier_payments sp
                  WHERE sp.batch_id = p_batch_id AND sp.company_id = p_company_id), 0)))
$$;

-- ── 4. The content and the authors ─────────────────────────────────────────
-- Every earlier document whose digest or authors anything could still be
-- compared against: referenced by a request, or not yet posted.
DROP TABLE IF EXISTS pg_temp.r035_pr5_before;
CREATE TEMP TABLE r035_pr5_before ON COMMIT DROP AS
  SELECT si.company_id, 'supplier_invoice'::TEXT AS document_type, si.id,
         public.approval_document_digest(si.company_id, 'supplier_invoice', si.id) AS digest,
         public.approval_document_authors(si.company_id, 'supplier_invoice', si.id) AS authors
  FROM public.supplier_invoices si
  WHERE si.status IN ('draft', 'pending_approval')
     OR EXISTS (SELECT 1 FROM public.approval_requests ar
                WHERE ar.document_type = 'supplier_invoice' AND ar.document_id = si.id)
  UNION ALL
  SELECT cn.company_id, t.document_type, cn.id,
         public.approval_document_digest(cn.company_id, t.document_type, cn.id),
         public.approval_document_authors(cn.company_id, t.document_type, cn.id)
  FROM public.credit_notes cn
  CROSS JOIN (VALUES ('customer_credit_note'), ('supplier_credit_note')) AS t(document_type)
  WHERE cn.status = 'draft'
     OR EXISTS (SELECT 1 FROM public.approval_requests ar
                WHERE ar.document_type = t.document_type AND ar.document_id = cn.id)
  UNION ALL
  SELECT ci.company_id, 'customer_invoice', ci.id,
         public.approval_document_digest(ci.company_id, 'customer_invoice', ci.id),
         public.approval_document_authors(ci.company_id, 'customer_invoice', ci.id)
  FROM public.customer_invoices ci
  WHERE ci.status IN ('draft', 'pending_approval')
     OR EXISTS (SELECT 1 FROM public.approval_requests ar
                WHERE ar.document_type = 'customer_invoice' AND ar.document_id = ci.id);

-- What a payment IS: the payee, date, amount, method, the company's paying
-- account, the reference, the dimensions, the payee's bank details READ LIVE
-- from suppliers (they are not copied onto the payment and are what the money
-- follows — eft-generate and netcash read them at send time, so an edit after
-- approval re-routes the money and must void the approval, fail closed), and
-- every allocation (which bills, how much: processSupplierPayment pays them),
-- ordered by content so row ids and re-insertion never matter (Q9).
-- One definition for both types: a batch hashes each member line through it.
-- Deliberately NOT covered: status, payment_number (set once at insert),
-- description, the approval / processing / journal bookkeeping, timestamps,
-- content_authors, settles_provisional_je_id, and the payee's name, email
-- and other non-bank details. As for bills, the system accounts the posting
-- resolves (payable, the default bank) are a chart-of-accounts setting — a
-- documented limit. trim_scale() makes 100 and 100.00 the same value.
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
                              s.bank_account_type, s.bank_account_holder)
     FROM public.suppliers s WHERE s.id = sp.supplier_id AND s.company_id = sp.company_id),
    COALESCE((
      SELECT jsonb_agg(jsonb_build_array(pa.invoice_id, trim_scale(pa.amount_allocated))
                       ORDER BY pa.invoice_id, pa.amount_allocated)
      FROM public.payment_allocations pa WHERE pa.payment_id = sp.id
    ), '[]'::jsonb))
  FROM public.supplier_payments sp
  WHERE sp.id = p_payment_id AND sp.company_id = p_company_id
$$;

-- Who set what a payment pays (Hein, 2026-10-06: whoever sets the amount or
-- the destination of the money is an author): its creator, every stamped
-- editor (§2), and the authors of every bill it allocates to — DERIVED here
-- from payment_allocations through approval_document_authors' own
-- supplier_invoice branch, so the bill's capturer may not approve paying it.
-- Company-scoped (the bill branch is), NULLs dropped, de-duplicated.
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
  CROSS JOIN LATERAL (SELECT public.approval_add_author(sp.content_authors, sp.created_by) AS base) b
  WHERE sp.id = p_payment_id AND sp.company_id = p_company_id
$$;

-- The dispatcher. `supplier_payment` names a single payment only: a batch
-- member digests to NULL under it (never clears) and is found only through
-- its batch. `payment_batch` hashes the header the batch journal reads
-- (date, method, paying account, stored total) and every member line through
-- approval_supplier_payment_content, ordered by content (member ids excluded).
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
                   cii.currency_code)
                 ORDER BY cii.created_at, cii.description, cii.quantity, cii.unit_price,
                          cii.amount, cii.tax_rate, cii.gl_account_id, cii.currency_code, cii.id)
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
  END
$$;

-- A batch's authors: its creator, its stamped editors, and every member
-- line's authors (approval_supplier_payment_authors — the member's creator,
-- editors and the authors of the bills it pays). Every earlier branch is
-- 865's, verbatim.
CREATE OR REPLACE FUNCTION public.approval_document_authors(
  p_company_id pg_catalog.uuid, p_document_type pg_catalog.text, p_document_id pg_catalog.uuid
) RETURNS pg_catalog.uuid[]
LANGUAGE sql STABLE
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT CASE p_document_type
    WHEN 'supplier_invoice' THEN (
      SELECT public.approval_add_author(si.content_authors, si.created_by)
      FROM public.supplier_invoices si
      WHERE si.id = p_document_id AND si.company_id = p_company_id AND si.deleted_at IS NULL
    )
    WHEN 'customer_credit_note' THEN (
      SELECT public.approval_add_author(cn.content_authors, cn.created_by)
      FROM public.credit_notes cn
      WHERE cn.id = p_document_id AND cn.company_id = p_company_id AND cn.type = 'customer'
    )
    WHEN 'supplier_credit_note' THEN (
      SELECT public.approval_add_author(cn.content_authors, cn.created_by)
      FROM public.credit_notes cn
      WHERE cn.id = p_document_id AND cn.company_id = p_company_id AND cn.type = 'supplier'
    )
    WHEN 'customer_invoice' THEN (
      SELECT b.base || ARRAY(
        SELECT d.author FROM (
          SELECT qa.author FROM public.customer_quotes q
          CROSS JOIN LATERAL unnest(q.content_authors || ARRAY[q.created_by]) qa(author)
          WHERE q.converted_invoice_id = ci.id AND q.company_id = ci.company_id
          UNION
          SELECT sa.author FROM public.customer_sales_orders so
          CROSS JOIN LATERAL unnest(so.content_authors || ARRAY[so.created_by]) sa(author)
          WHERE so.invoice_id = ci.id AND so.company_id = ci.company_id
          UNION
          SELECT qa.author FROM public.customer_sales_orders so
          JOIN public.customer_quotes q ON (q.id = so.quote_id OR q.converted_order_id = so.id)
            AND q.company_id = ci.company_id
          CROSS JOIN LATERAL unnest(q.content_authors || ARRAY[q.created_by]) qa(author)
          WHERE so.invoice_id = ci.id AND so.company_id = ci.company_id
          UNION
          SELECT ta.author FROM public.time_entries te
          CROSS JOIN LATERAL unnest(te.content_authors) ta(author)
          WHERE te.invoice_id = ci.id AND te.company_id = ci.company_id
        ) d(author)
        WHERE d.author IS NOT NULL AND d.author <> ALL (b.base)
        ORDER BY d.author)
      FROM public.customer_invoices ci
      CROSS JOIN LATERAL (
        SELECT public.approval_add_author(ci.content_authors,
          CASE WHEN ci.created_by ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
               THEN ci.created_by::pg_catalog.uuid END) AS base
      ) b
      WHERE ci.id = p_document_id AND ci.company_id = p_company_id AND ci.deleted_at IS NULL
    )
    WHEN 'supplier_payment' THEN (
      SELECT public.approval_supplier_payment_authors(sp.company_id, sp.id)
      FROM public.supplier_payments sp
      WHERE sp.id = p_document_id AND sp.company_id = p_company_id AND sp.batch_id IS NULL
    )
    WHEN 'payment_batch' THEN (
      SELECT b2.base || ARRAY(
        SELECT DISTINCT m.author FROM public.supplier_payments sp
        CROSS JOIN LATERAL unnest(public.approval_supplier_payment_authors(sp.company_id, sp.id)) m(author)
        WHERE sp.batch_id = b.id AND sp.company_id = b.company_id
          AND m.author IS NOT NULL AND m.author <> ALL (b2.base)
        ORDER BY m.author)
      FROM public.supplier_payment_batches b
      CROSS JOIN LATERAL (SELECT public.approval_add_author(b.content_authors, b.created_by) AS base) b2
      WHERE b.id = p_document_id AND b.company_id = p_company_id
    )
  END
$$;

-- Supplier-invoice enforcement is live on prod and credit-note and
-- customer-invoice enforcement are merged: an approval already given must
-- clear exactly as it did before this replace, and refuse the same approvers.
DO $$
DECLARE
  v_changed pg_catalog.int8;
BEGIN
  SELECT count(*) INTO v_changed
  FROM pg_temp.r035_pr5_before b
  WHERE b.digest IS DISTINCT FROM public.approval_document_digest(b.company_id, b.document_type, b.id)
     OR b.authors IS DISTINCT FROM public.approval_document_authors(b.company_id, b.document_type, b.id);
  IF v_changed > 0 THEN
    RAISE EXCEPTION 'migration 867: approval_document_digest or _authors changed for % existing document(s)', v_changed;
  END IF;
END $$;

-- ── 5. The backstops ───────────────────────────────────────────────────────
-- AFTER, SECURITY DEFINER with an owner that bypasses RLS, schema-qualified,
-- pg_temp last — 712's reasons. The rank ratchet is 862's, term for term with
-- the TypeScript gate (approvalGate.ts): an approval clears only when decided
-- at or after enforcement was switched on, for the CURRENT digest, bound to a
-- role ranking at or above what the strictest rule matching today demands.
--
-- One check, for whichever document governs the row: a single payment is its
-- own `supplier_payment`; a batch MEMBER (batch_id set) is governed by its
-- BATCH's `payment_batch` approval, so a raw UPDATE cannot approve or pay a
-- member outside a cleared batch.
CREATE OR REPLACE FUNCTION public.payment_approval_cleared(
  p_company_id pg_catalog.uuid, p_document_type pg_catalog.text, p_document_id pg_catalog.uuid,
  p_amount pg_catalog.numeric
) RETURNS pg_catalog.bool
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_enabled_at pg_catalog.timestamptz;
  v_demanded pg_catalog.int4;
BEGIN
  SELECT ae.enabled_at INTO v_enabled_at
  FROM public.approval_enforcement ae
  WHERE ae.company_id = p_company_id AND ae.document_type = p_document_type;
  IF NOT FOUND THEN RETURN true; END IF;

  v_demanded := public.approval_rule_strictest_rank(p_company_id, p_document_type, p_amount);
  IF v_demanded IS NULL THEN RETURN true; END IF;

  RETURN EXISTS (
    SELECT 1 FROM public.approval_requests ar
    LEFT JOIN public.approval_rules rl ON rl.id = ar.rule_id AND rl.company_id = ar.company_id
    WHERE ar.company_id = p_company_id AND ar.document_type = p_document_type
      AND ar.document_id = p_document_id AND ar.status = 'approved'
      AND ar.decided_at >= v_enabled_at
      AND ar.document_digest = public.approval_document_digest(p_company_id, p_document_type, p_document_id)
      AND COALESCE(ar.required_role, rl.approver_role) IS NOT NULL
      AND public.approval_required_rank(COALESCE(ar.required_role, rl.approver_role)) >= v_demanded);
END
$$;

REVOKE ALL ON FUNCTION public.payment_approval_cleared(pg_catalog.uuid, pg_catalog.text, pg_catalog.uuid, pg_catalog.numeric) FROM PUBLIC;

-- supplier_payments: fires whenever a row ENTERS approved / processed /
-- reconciled — an INSERT so, or an UPDATE into one from any other status —
-- and on approved -> processed too: processSupplierPayment and processBatch
-- re-check the approval where the money moves (an approval taken before
-- enforcement, or a bank-detail change since, must not be paid), and the
-- floor checks the same transition. processed <-> reconciled (applying or
-- unapplying cash already paid) is not an instruction and passes.
-- Exempt (Q4: the money has already moved): an INSERT of a SINGLE payment
-- while the transaction-local `isaflow.approval_gate_exempt` is 'bank_feed'
-- (the four bank-feed creators, inside withApprovalGateExemptBankFeed — a
-- census pins exactly those) or 'import' (scripts/import-sage-britech.ts may
-- set it for its raw 'processed' rows; it does not today, so under
-- enforcement it is refused). Never an UPDATE, never a batch member. The GUC
-- is an ordinary setting, so a raw-SQL session can set it itself — the N3
-- class 865 records, open for every type.
CREATE OR REPLACE FUNCTION public.supplier_payment_approval_gate()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF COALESCE(NEW.status, '') NOT IN ('approved', 'processed', 'reconciled') THEN RETURN NULL; END IF;
  IF TG_OP = 'UPDATE' AND (OLD.status IS NOT DISTINCT FROM NEW.status
      OR (OLD.status IN ('processed', 'reconciled') AND NEW.status IN ('processed', 'reconciled'))) THEN
    RETURN NULL;
  END IF;
  IF TG_OP = 'INSERT' AND NEW.batch_id IS NULL
     AND COALESCE(pg_catalog.current_setting('isaflow.approval_gate_exempt', true), '') IN ('bank_feed', 'import') THEN
    RETURN NULL;
  END IF;

  IF NEW.batch_id IS NULL THEN
    IF public.payment_approval_cleared(NEW.company_id, 'supplier_payment', NEW.id,
         public.approval_supplier_payment_gate_amount(NEW.total_amount)) THEN
      RETURN NULL;
    END IF;
    RAISE EXCEPTION 'R035_APPROVAL_REQUIRED: supplier payment % cannot be approved or paid without an approval for its current content', NEW.id
      USING HINT = 'Raise an approval request and have it approved, then approve or process the payment.';
  END IF;
  IF public.payment_approval_cleared(NEW.company_id, 'payment_batch', NEW.batch_id,
       public.approval_payment_batch_gate_amount(NEW.company_id, NEW.batch_id)) THEN
    RETURN NULL;
  END IF;
  RAISE EXCEPTION 'R035_APPROVAL_REQUIRED: batch member % cannot be approved or paid without an approval of batch % for its current content', NEW.id, NEW.batch_id
    USING HINT = 'Raise an approval request for the batch and have it approved, then approve or process the batch.';
END
$$;

-- supplier_payment_batches: fires whenever a batch ENTERS approved or
-- processed. No exemption: no importer or bank feed writes batches.
CREATE OR REPLACE FUNCTION public.payment_batch_approval_gate()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF COALESCE(NEW.status, '') NOT IN ('approved', 'processed') THEN RETURN NULL; END IF;
  IF TG_OP = 'UPDATE' AND OLD.status IS NOT DISTINCT FROM NEW.status THEN RETURN NULL; END IF;
  IF public.payment_approval_cleared(NEW.company_id, 'payment_batch', NEW.id,
       public.approval_payment_batch_gate_amount(NEW.company_id, NEW.id)) THEN
    RETURN NULL;
  END IF;
  RAISE EXCEPTION 'R035_APPROVAL_REQUIRED: payment batch % cannot be approved or paid without an approval for its current content', NEW.id
    USING HINT = 'Raise an approval request for the batch and have it approved, then approve or process the batch.';
END
$$;

REVOKE ALL ON FUNCTION public.supplier_payment_approval_gate() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.payment_batch_approval_gate() FROM PUBLIC;

DROP TRIGGER IF EXISTS trg_supplier_payment_approval_gate ON supplier_payments;
CREATE TRIGGER trg_supplier_payment_approval_gate
  AFTER INSERT OR UPDATE OF status ON supplier_payments
  FOR EACH ROW EXECUTE FUNCTION public.supplier_payment_approval_gate();

DROP TRIGGER IF EXISTS trg_payment_batch_approval_gate ON supplier_payment_batches;
CREATE TRIGGER trg_payment_batch_approval_gate
  AFTER INSERT OR UPDATE OF status ON supplier_payment_batches
  FOR EACH ROW EXECUTE FUNCTION public.payment_batch_approval_gate();

DO $$
DECLARE
  v_fn pg_catalog.text;
BEGIN
  -- FORCE RLS on approval_enforcement / approval_requests / supplier_payments
  -- binds the definer's owner too: an owner without BYPASSRLS would see no
  -- enforcement row and let every payment through. Refuse to ship it that way.
  FOREACH v_fn IN ARRAY ARRAY['public.supplier_payment_approval_gate()', 'public.payment_batch_approval_gate()',
      'public.payment_approval_cleared(pg_catalog.uuid,pg_catalog.text,pg_catalog.uuid,pg_catalog.numeric)'] LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_roles r ON r.oid = p.proowner
      WHERE p.oid = v_fn::pg_catalog.regprocedure AND (r.rolbypassrls OR r.rolsuper)
    ) THEN
      RAISE EXCEPTION 'migration 867: the owner of % must bypass RLS', v_fn;
    END IF;
  END LOOP;
END $$;

-- ── 6. A request is inserted only as requestApproval writes it ────────────
-- 862's guard, verbatim but for the type list, which gains supplier_payment
-- and payment_batch. OUT OF SCOPE, as 862 and 865 record for every type
-- (follow-up for Hein): the UPDATE half (N1), the subject itself (N3) and
-- with it both exemption GUCs. supplier_invoice stays outside the list.
CREATE OR REPLACE FUNCTION public.approval_request_insert_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_subject pg_catalog.text;
  v_uid pg_catalog.uuid;
BEGIN
  IF NOT (NEW.document_type = ANY (ARRAY['customer_credit_note', 'supplier_credit_note', 'customer_invoice',
                                         'supplier_payment', 'payment_batch']::pg_catalog.text[]))
     OR EXISTS (
       SELECT 1 FROM pg_catalog.pg_roles r
       WHERE r.rolname = current_user AND (r.rolbypassrls OR r.rolsuper)) THEN
    RETURN NEW;
  END IF;
  -- Only a canonical uuid is cast (any case); anything else leaves v_uid NULL,
  -- which no requested_by (NOT NULL) equals: a refusal, never a cast error.
  v_subject := auth.uid();
  IF v_subject ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    v_uid := v_subject::pg_catalog.uuid;
  END IF;
  IF COALESCE(NEW.status, '') <> 'pending'
     OR NEW.requested_by IS DISTINCT FROM v_uid
     OR NEW.decided_by IS NOT NULL
     OR NEW.decided_at IS NOT NULL
     OR pg_catalog.cardinality(COALESCE(NEW.past_requesters, '{}')) > 0 THEN
    RAISE EXCEPTION 'R035_APPROVAL_REQUEST_FORGED: a % approval request may only be inserted pending, undecided and raised by the session''s own user', NEW.document_type
      USING HINT = 'Raise the request through IsaFlow, then have an eligible approver decide it.';
  END IF;
  RETURN NEW;
END
$$;
