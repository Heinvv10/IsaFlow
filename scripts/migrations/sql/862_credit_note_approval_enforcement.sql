-- 862: R-035 PR3 — approval enforcement on CREDIT NOTES.
--
-- Two document types (Hein, 2026-10-06): `customer_credit_note` and
-- `supplier_credit_note`, each with its own rules and its own Enforce switch.
-- Both live in credit_notes; the type follows credit_notes.type. The legacy
-- `credit_note` type is left alone — its rules and requests govern neither new
-- type and it never becomes enforceable.
--
-- Pieces:
--   1. approval_enforcement accepts every R-035 type, so PR4–PR6 need not
--      touch the constraint again. It is not the gate:
--      ENFORCEABLE_DOCUMENT_TYPES (gl/approvalEnforcement.ts) is, and the API
--      refuses to enable a type outside it.
--   2. WHO AUTHORED a note's content: credit_notes.content_authors /
--      content_edited_at, as 712 added them to supplier_invoices.
--   3. approval_credit_note_gate_amount() — the amount a rule sees — and
--      approval_rule_matches(), the type-parameterised SQL copy of rule
--      matching. approval_supplier_invoice_rule_matches is NOT re-pointed.
--   4. approval_document_digest() and approval_document_authors() gain the two
--      credit-note branches. Their supplier_invoice branches are copied
--      verbatim from 708 / 712, and a guard below refuses the migration if any
--      bill's digest changed across the replace.
--   5. A backstop trigger: a note may not leave draft or cancelled for a
--      posted status (insert as, or move to, approved / partially_applied /
--      applied) while enforcement is on for its type, an active rule of that
--      type matches it, and no APPROVED request for its CURRENT digest, decided
--      at or after enforcement was switched on, exists. The TypeScript gate in
--      approveCreditNote refuses first with a 409 and ranks the approver; this
--      is the fail-closed floor for raw writers, as 712's is for bills.

-- ── 1. Every R-035 type may carry an enforcement row ───────────────────────
ALTER TABLE approval_enforcement DROP CONSTRAINT IF EXISTS approval_enforcement_document_type_check;
ALTER TABLE approval_enforcement ADD CONSTRAINT approval_enforcement_document_type_check CHECK (document_type IN (
  'customer_invoice', 'supplier_invoice', 'payment', 'journal_entry', 'credit_note',
  'customer_credit_note', 'supplier_credit_note', 'supplier_payment', 'payment_batch', 'manual_journal'));

-- ── 2. The authors ────────────────────────────────────────────────────────
-- Append-only, through approval_add_author (712). Credit notes have no
-- content-edit route; the one digest-moving edit is the customer merge
-- (customerMergeService.moveDocuments), which stamps the merging user.
ALTER TABLE credit_notes ADD COLUMN IF NOT EXISTS content_authors UUID[] NOT NULL DEFAULT '{}';
ALTER TABLE credit_notes ADD COLUMN IF NOT EXISTS content_edited_at TIMESTAMPTZ;

-- ── 3. The amount a rule sees, and whether an active rule governs it ───────
-- approveCreditNote posts subtotal, tax and total as SEPARATE legs (customer:
-- DR revenue subtotal, DR VAT tax, CR receivable total; supplier the mirror),
-- and nothing makes them foot. A rule must therefore see the LARGEST leg: a
-- note of total 100 carrying subtotal 1 000 + tax 150 posts R1 150 to revenue.
-- ABS because a negative figure inverts the posting rather than shrinking it.
CREATE OR REPLACE FUNCTION public.approval_credit_note_gate_amount(
  p_total pg_catalog.numeric, p_subtotal pg_catalog.numeric, p_tax pg_catalog.numeric
) RETURNS pg_catalog.numeric
LANGUAGE sql IMMUTABLE
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT GREATEST(ABS(COALESCE(p_total, 0)), ABS(COALESCE(p_subtotal, 0) + COALESCE(p_tax, 0)))
$$;

-- approval_supplier_invoice_rule_matches (712) with the type a parameter:
-- 'any', and any operator checkApproval cannot evaluate, match (fail closed);
-- a NULL threshold is 0. Read by the credit-note backstop and the enforcement
-- preview. The supplier-invoice trigger keeps its own function.
CREATE OR REPLACE FUNCTION public.approval_rule_matches(
  p_company_id pg_catalog.uuid, p_document_type pg_catalog.text, p_amount pg_catalog.numeric
) RETURNS pg_catalog.bool
LANGUAGE sql STABLE
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.approval_rules r
    WHERE r.company_id = p_company_id AND r.document_type = p_document_type AND r.is_active = true
      AND CASE r.condition_operator
            WHEN 'greater_than' THEN p_amount > COALESCE(r.condition_value, 0)
            WHEN 'greater_equal' THEN p_amount >= COALESCE(r.condition_value, 0)
            ELSE true
          END
  )
$$;

-- ── 4. The content and the authors ─────────────────────────────────────────
-- Every supplier invoice whose digest anything could still be compared
-- against: referenced by a request, or not yet in the AP population.
DROP TABLE IF EXISTS pg_temp.r035_si_digest_before;
CREATE TEMP TABLE r035_si_digest_before ON COMMIT DROP AS
  SELECT si.company_id, si.id, public.approval_document_digest(si.company_id, 'supplier_invoice', si.id) AS digest
  FROM public.supplier_invoices si
  WHERE si.status IN ('draft', 'pending_approval')
     OR EXISTS (SELECT 1 FROM public.approval_requests ar
                WHERE ar.document_type = 'supplier_invoice' AND ar.document_id = si.id);

-- The credit-note branches hash the note ONLY when credit_notes.type is the
-- type asked for (else NULL, which never clears): a request raised as the
-- other type would otherwise be judged by that type's — possibly laxer — rules
-- and still bind this note's content. Not filtered by status: a cancelled or
-- posted note keeps its digest, as a posted bill does.
-- Covered: every column approveCreditNote, the FIFO application or the
-- subledgers read — both counterparties and both links (a note carrying the
-- other side's columns must not shed them), the date, currency and figures,
-- and the dimensions. Credit notes have no lines.
-- Deliberately NOT covered: reason (narrative), status, applied_amount, the
-- approval / cancellation bookkeeping (approved_*, cancelled_*, cancel_reason,
-- gl_journal_entry_id), external_* references, the actor_* stamps, timestamps
-- and content_authors — none changes what is posted or owed. As for bills, the
-- system accounts the posting resolves (default_revenue, receivable, …) are a
-- chart-of-accounts setting, not note content: a documented limit.
-- trim_scale() makes 100 and 100.00 the same value; sha256 over UTF-8.
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
  END
$$;

-- The supplier-invoice branch is live on prod: an approval already given for
-- a bill must clear exactly as it did before this replace.
DO $$
DECLARE
  v_changed pg_catalog.int8;
BEGIN
  SELECT count(*) INTO v_changed
  FROM pg_temp.r035_si_digest_before b
  WHERE b.digest IS DISTINCT FROM public.approval_document_digest(b.company_id, 'supplier_invoice', b.id);
  IF v_changed > 0 THEN
    RAISE EXCEPTION 'migration 862: approval_document_digest changed for % supplier invoice(s)', v_changed;
  END IF;
END $$;

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
  END
$$;

-- ── 5. The backstop ────────────────────────────────────────────────────────
-- AFTER, not BEFORE, and SECURITY DEFINER with an owner that bypasses RLS —
-- both for 712's reasons: the digest reads the stored row (an UPDATE moving
-- content and status together is judged on the NEW content), and a caller
-- whose RLS context hides approval_enforcement must not read "not enforced".
-- Every relation and function is schema-qualified; pg_temp is searched last.
CREATE OR REPLACE FUNCTION public.credit_note_approval_gate()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_type pg_catalog.text;
  v_enabled_at pg_catalog.timestamptz;
BEGIN
  IF COALESCE(NEW.status, '') IN ('draft', 'cancelled') THEN RETURN NULL; END IF;
  IF TG_OP = 'UPDATE' AND COALESCE(OLD.status, '') NOT IN ('draft', 'cancelled') THEN
    RETURN NULL;
  END IF;
  IF COALESCE(pg_catalog.current_setting('isaflow.approval_gate_exempt', true), '') = 'import' THEN
    RETURN NULL;
  END IF;

  v_type := CASE NEW.type WHEN 'customer' THEN 'customer_credit_note'
                          WHEN 'supplier' THEN 'supplier_credit_note' END;
  SELECT ae.enabled_at INTO v_enabled_at
  FROM public.approval_enforcement ae
  WHERE ae.company_id = NEW.company_id AND ae.document_type = v_type;
  IF NOT FOUND THEN RETURN NULL; END IF;

  IF NOT public.approval_rule_matches(
    NEW.company_id, v_type,
    public.approval_credit_note_gate_amount(NEW.total_amount, NEW.subtotal, NEW.tax_amount)) THEN
    RETURN NULL;
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.approval_requests ar
    WHERE ar.company_id = NEW.company_id AND ar.document_type = v_type
      AND ar.document_id = NEW.id AND ar.status = 'approved'
      AND ar.decided_at >= v_enabled_at
      AND ar.document_digest = public.approval_document_digest(NEW.company_id, v_type, NEW.id)
  ) THEN
    RETURN NULL;
  END IF;

  RAISE EXCEPTION 'R035_APPROVAL_REQUIRED: credit note % cannot be posted without an approval for its current content', NEW.id
    USING HINT = 'Raise an approval request and have it approved, then approve the credit note.';
END
$$;

REVOKE ALL ON FUNCTION public.credit_note_approval_gate() FROM PUBLIC;

DROP TRIGGER IF EXISTS trg_credit_note_approval_gate ON credit_notes;
CREATE TRIGGER trg_credit_note_approval_gate
  AFTER INSERT OR UPDATE OF status ON credit_notes
  FOR EACH ROW EXECUTE FUNCTION public.credit_note_approval_gate();

DO $$
BEGIN
  -- FORCE RLS on approval_enforcement / approval_requests binds the definer's
  -- owner too: an owner without BYPASSRLS would see no enforcement row and let
  -- every note through. Refuse to ship it that way.
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_roles r ON r.oid = p.proowner
    WHERE p.oid = 'public.credit_note_approval_gate()'::pg_catalog.regprocedure
      AND (r.rolbypassrls OR r.rolsuper)
  ) THEN
    RAISE EXCEPTION 'migration 862: the owner of credit_note_approval_gate must bypass RLS';
  END IF;
END $$;
