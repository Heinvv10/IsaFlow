-- 712: R-035 PR2 — approval enforcement on SUPPLIER INVOICES.
--
-- Four pieces:
--   1. WHO AUTHORED the content an approval vouches for. supplier_invoices
--      gains content_authors (append-only) / content_edited_at, added to by
--      every edit path whose change moves the approval digest (detail PUT,
--      MCP update_supplier_invoice, account merge, supplier merge);
--      approval_requests gains content_authors, the authors as they stood when
--      the request was raised or re-stamped. The decide path refuses all of
--      them, and the current requester (Hein, 2026-09-27: only the real
--      authors — a past requester who authored none of the current content
--      may approve).
--   2. approval_document_authors() — the one definition of "the authors": the
--      creator plus every digest-moving editor (approval_add_author appends).
--   3. approval_supplier_invoice_gate_amount() — the amount a rule sees, the
--      larger of what posts and the ZAR value — and
--      approval_supplier_invoice_rule_matches(), the SQL copy of rule matching.
--   4. A backstop trigger: a supplier invoice may not ENTER the AP population
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

-- ── 1. The authors ────────────────────────────────────────────────────────
-- Everyone who authored the current content (review MEDIUM-1: "last editor"
-- let someone else's small edit strip the creator's authorship, and an account
-- merge re-attributed a bill wholesale). Append-only: each user whose edit
-- moved the approval digest is added, nobody is ever removed.
-- users.id is varchar but every user id is a uuid (created_by is UUID NOT NULL).
ALTER TABLE supplier_invoices ADD COLUMN IF NOT EXISTS content_authors UUID[] NOT NULL DEFAULT '{}';
ALTER TABLE supplier_invoices ADD COLUMN IF NOT EXISTS content_edited_at TIMESTAMPTZ;
-- The authors as they stood when the request was raised or re-stamped.
ALTER TABLE approval_requests ADD COLUMN IF NOT EXISTS content_authors UUID[];

-- Add one author, once. Every stamping path writes through this.
CREATE OR REPLACE FUNCTION public.approval_add_author(
  p_authors pg_catalog.uuid[], p_user pg_catalog.uuid
) RETURNS pg_catalog.uuid[]
LANGUAGE sql IMMUTABLE
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT CASE WHEN p_user IS NULL OR p_user = ANY (COALESCE(p_authors, '{}')) THEN COALESCE(p_authors, '{}')
              ELSE pg_catalog.array_append(COALESCE(p_authors, '{}'), p_user) END
$$;

-- ── 2. One definition of "the authors" ─────────────────────────────────────
-- The creator plus every digest-moving editor. A system or agent creator (a
-- uuid no member holds) refuses nobody. NULL for a type with no editor
-- tracking yet: the decide path then keeps PR1's past-requester refusal for
-- it (fail closed until its own PR).
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
  END
$$;

-- Pending requests raised before this migration: bind them to the authors as
-- they stand now, which is the content their approver will see.
UPDATE approval_requests ar
SET content_authors = public.approval_document_authors(ar.company_id, ar.document_type, ar.document_id)
WHERE ar.status = 'pending' AND ar.document_type = 'supplier_invoice'
  AND ar.content_authors IS NULL AND ar.company_id IS NOT NULL;

-- ── 3. The amount a rule sees, and whether an active rule governs it ───────
-- The amount an approval must cover is the LARGER of what posts and what the
-- bill is worth in ZAR. approveSupplierInvoice books total_amount into the
-- ledger; functional_total is the ZAR value of a foreign bill. Matching on the
-- functional figure alone let an exchange rate steer the rule (review HIGH-1:
-- a R500 000 ZAR bill at 0.0001 carried R50 and matched nothing, then posted
-- R500 000); matching on total_amount alone let a USD 5 000 bill (R92 500)
-- slip under a R50 000 rule. The same function feeds the TypeScript gate
-- (approvalDocuments.findDocument), this backstop and the preview.
CREATE OR REPLACE FUNCTION public.approval_supplier_invoice_gate_amount(
  p_total pg_catalog.numeric, p_functional pg_catalog.numeric
) RETURNS pg_catalog.numeric
LANGUAGE sql IMMUTABLE
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT GREATEST(COALESCE(p_total, 0), COALESCE(p_functional, p_total, 0))
$$;


-- Mirrors checkApproval (approvalMatching.ts): 'any', and any operator it
-- cannot evaluate, match (fail closed); a NULL threshold is 0. One SQL copy,
-- read by the backstop below and by the enforcement preview
-- (approvalEnforcementPreview.ts).
CREATE OR REPLACE FUNCTION public.approval_supplier_invoice_rule_matches(
  p_company_id pg_catalog.uuid, p_amount pg_catalog.numeric
) RETURNS pg_catalog.bool
LANGUAGE sql STABLE
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.approval_rules r
    WHERE r.company_id = p_company_id AND r.document_type = 'supplier_invoice' AND r.is_active = true
      AND CASE r.condition_operator
            WHEN 'greater_than' THEN p_amount > COALESCE(r.condition_value, 0)
            WHEN 'greater_equal' THEN p_amount >= COALESCE(r.condition_value, 0)
            ELSE true
          END
  )
$$;

-- ── 4. The backstop ────────────────────────────────────────────────────────
-- AFTER, not BEFORE: the digest function reads the stored row, and only an
-- AFTER trigger sees the row this statement wrote (an UPDATE that changes the
-- content and the status together must be judged on the NEW content).
-- SECURITY DEFINER: under withAuth this runs as app_user, and a caller whose
-- RLS context hides approval_enforcement (a job with no claims) would read
-- "not enforced" and pass — the owner must bypass RLS, asserted below.
CREATE OR REPLACE FUNCTION public.supplier_invoice_approval_gate()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_enabled_at pg_catalog.timestamptz;
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

  IF NOT public.approval_supplier_invoice_rule_matches(
    NEW.company_id, public.approval_supplier_invoice_gate_amount(NEW.total_amount, NEW.functional_total)) THEN
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
