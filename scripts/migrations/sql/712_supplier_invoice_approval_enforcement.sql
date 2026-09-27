-- 712: R-035 PR2 — approval enforcement on SUPPLIER INVOICES.
--
-- Three pieces:
--   1. WHO AUTHORED the content an approval vouches for. supplier_invoices
--      gains content_edited_by/_at, written by every edit path whose change
--      moves the approval digest (detail PUT, MCP update_supplier_invoice,
--      account merge); approval_requests gains content_author, the author as
--      it stood when the request was raised or re-stamped. The decide path
--      refuses both, and the current requester (Hein, 2026-09-27: only the
--      real authors — a past requester who did not author the current content
--      may approve).
--   2. approval_document_author() — the one definition of "author": the last
--      editor, or the creator of content nobody has edited since.
--   3. A backstop trigger: a supplier invoice may not ENTER the AP population
--      (insert into, or move from draft / pending_approval / cancelled to, any
--      other status) while enforcement is on for the company, an active rule
--      matches it, and no APPROVED request for its CURRENT digest, decided at
--      or after enforcement was switched on, exists. The TypeScript gate
--      (approvalGate.ts) refuses first with a 409 and ranks the approver; this
--      is the fail-closed floor for writers the census misses (raw INSERTs,
--      scripts, future code), surfacing as a 500 and a rollback. It checks
--      existence only; the rank ratchet lives in the TypeScript gate.
--
-- The import exemption (decision Q1): the Sage import, the Sage migration
-- commit and the AP take-on bring in bills approved in the source system, and
-- set the transaction-local GUC `isaflow.approval_gate_exempt` = 'import' for
-- the duration of their write (withApprovalGateExempt). A census test pins
-- those setters (tests/unit/services/gl/approvalGateExemptCensus.test.ts).

-- ── 1. The author ─────────────────────────────────────────────────────────
-- users.id is varchar but every user id is a uuid (created_by is UUID NOT NULL).
ALTER TABLE supplier_invoices ADD COLUMN IF NOT EXISTS content_edited_by UUID;
ALTER TABLE supplier_invoices ADD COLUMN IF NOT EXISTS content_edited_at TIMESTAMPTZ;
ALTER TABLE approval_requests ADD COLUMN IF NOT EXISTS content_author UUID;

-- ── 2. One definition of "author" ──────────────────────────────────────────
-- NULL for a type with no editor tracking yet: the decide path then keeps
-- PR1's past-requester refusal for it (fail closed until its own PR).
CREATE OR REPLACE FUNCTION public.approval_document_author(
  p_company_id pg_catalog.uuid, p_document_type pg_catalog.text, p_document_id pg_catalog.uuid
) RETURNS pg_catalog.text
LANGUAGE sql STABLE
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT CASE p_document_type
    WHEN 'supplier_invoice' THEN (
      SELECT COALESCE(si.content_edited_by, si.created_by)::pg_catalog.text
      FROM public.supplier_invoices si
      WHERE si.id = p_document_id AND si.company_id = p_company_id AND si.deleted_at IS NULL
    )
  END
$$;

-- Pending requests raised before this migration: bind them to the author as it
-- stands now, which is the content their approver will see.
UPDATE approval_requests ar
SET content_author = public.approval_document_author(ar.company_id, ar.document_type, ar.document_id)::UUID
WHERE ar.status = 'pending' AND ar.document_type = 'supplier_invoice'
  AND ar.content_author IS NULL AND ar.company_id IS NOT NULL;

-- ── 3. The backstop ────────────────────────────────────────────────────────
-- AFTER, not BEFORE: the digest function reads the stored row, and only an
-- AFTER trigger sees the row this statement wrote (an UPDATE that changes the
-- content and the status together must be judged on the NEW content).
-- SECURITY DEFINER: under withAuth this runs as app_user, and a caller whose
-- RLS context hides approval_enforcement (a job with no claims) would read
-- "not enforced" and pass — the owner must bypass RLS, asserted below.
-- The rule match mirrors checkApproval (approvalMatching.ts): 'any', and any
-- operator it cannot evaluate, match (fail closed); a NULL threshold is 0.
CREATE OR REPLACE FUNCTION public.supplier_invoice_approval_gate()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_enabled_at pg_catalog.timestamptz;
  v_amount pg_catalog.numeric;
BEGIN
  IF COALESCE(NEW.status, '') IN ('draft', 'pending_approval', 'cancelled') THEN RETURN NULL; END IF;
  IF TG_OP = 'UPDATE' AND COALESCE(OLD.status, '') NOT IN ('draft', 'pending_approval', 'cancelled') THEN
    RETURN NULL;
  END IF;
  IF COALESCE(pg_catalog.current_setting('isaflow.approval_gate_exempt', true), '') = 'import' THEN
    RETURN NULL;
  END IF;

  SELECT ae.enabled_at INTO v_enabled_at
  FROM public.approval_enforcement ae
  WHERE ae.company_id = NEW.company_id AND ae.document_type = 'supplier_invoice';
  IF NOT FOUND THEN RETURN NULL; END IF;

  v_amount := COALESCE(NEW.functional_total, NEW.total_amount, 0);
  IF NOT EXISTS (
    SELECT 1 FROM public.approval_rules r
    WHERE r.company_id = NEW.company_id AND r.document_type = 'supplier_invoice' AND r.is_active = true
      AND CASE r.condition_operator
            WHEN 'greater_than' THEN v_amount > COALESCE(r.condition_value, 0)
            WHEN 'greater_equal' THEN v_amount >= COALESCE(r.condition_value, 0)
            ELSE true
          END
  ) THEN
    RETURN NULL;
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.approval_requests ar
    WHERE ar.company_id = NEW.company_id AND ar.document_type = 'supplier_invoice'
      AND ar.document_id = NEW.id AND ar.status = 'approved'
      AND ar.decided_at >= v_enabled_at
      AND ar.document_digest = public.approval_document_digest(NEW.company_id, 'supplier_invoice', NEW.id)
  ) THEN
    RETURN NULL;
  END IF;

  RAISE EXCEPTION 'R035_APPROVAL_REQUIRED: supplier invoice % cannot enter the AP population without an approval for its current content', NEW.id
    USING HINT = 'Raise an approval request and have it approved, then approve the invoice.';
END
$$;

REVOKE ALL ON FUNCTION public.supplier_invoice_approval_gate() FROM PUBLIC;

DROP TRIGGER IF EXISTS trg_supplier_invoice_approval_gate ON supplier_invoices;
CREATE TRIGGER trg_supplier_invoice_approval_gate
  AFTER INSERT OR UPDATE OF status ON supplier_invoices
  FOR EACH ROW EXECUTE FUNCTION public.supplier_invoice_approval_gate();

DO $$
BEGIN
  -- FORCE RLS on approval_enforcement / approval_requests binds the definer's
  -- owner too: an owner without BYPASSRLS would see no enforcement row and let
  -- every bill through. Refuse to ship it that way.
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_roles r ON r.oid = p.proowner
    WHERE p.oid = 'public.supplier_invoice_approval_gate()'::pg_catalog.regprocedure
      AND (r.rolbypassrls OR r.rolsuper)
  ) THEN
    RAISE EXCEPTION 'migration 712: the owner of supplier_invoice_approval_gate must bypass RLS';
  END IF;
END $$;
