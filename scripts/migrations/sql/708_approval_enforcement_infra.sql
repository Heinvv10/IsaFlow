-- 708: R-035 PR1 — shared infrastructure for enforcing approval rules on
-- posting paths. NOTHING here enforces anything yet: no posting path reads
-- `approval_enforcement` until a later PR adds its document type to
-- ENFORCEABLE_DOCUMENT_TYPES (src/modules/accounting/services/gl/approvalGate.ts).
--
-- Four pieces:
--   1. approval_requests.document_digest — WHAT was approved. An approval
--      binds to the content of the document when the request was raised (or
--      last re-bound), so an edit after approval makes it stale.
--   2. approval_enforcement — per company AND per document type opt-in,
--      default off (Hein, 2026-09-26). Presence of a row means enforced.
--   3. approval_document_digest() — the ONE definition of that content, so
--      the TypeScript read path and a later DB trigger cannot disagree.
--   4. approval_company_other_members() — the roster the sole-approver
--      self-approval rule needs, which app_user cannot read under RLS.

-- ── 1. The digest an approval is bound to ──────────────────────────────────
ALTER TABLE approval_requests ADD COLUMN IF NOT EXISTS document_digest TEXT;

-- ── 2. Opt-in, per company and per document type ───────────────────────────
CREATE TABLE IF NOT EXISTS approval_enforcement (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id     UUID NOT NULL REFERENCES companies(id),
  document_type  TEXT NOT NULL CHECK (document_type IN (
                   'customer_invoice', 'supplier_invoice', 'payment', 'journal_entry', 'credit_note')),
  enabled_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- users.id is character varying(255), not uuid.
  enabled_by     TEXT NOT NULL,
  CONSTRAINT approval_enforcement_company_type_uq UNIQUE (company_id, document_type)
);

ALTER TABLE approval_enforcement ENABLE ROW LEVEL SECURITY;
ALTER TABLE approval_enforcement FORCE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'approval_enforcement' AND policyname = 'tenant_isolation'
  ) THEN
    CREATE POLICY tenant_isolation ON approval_enforcement
      TO app_user
      USING (company_id IN (SELECT auth.user_companies()))
      WITH CHECK (company_id = app.current_company_id());
  END IF;
END $$;

-- ── 3. The content an approval covers ──────────────────────────────────────
-- Supplier invoices only for now; every other type returns NULL, and a NULL
-- digest never clears the gate. Covered: every header column the posting
-- (approveSupplierInvoice + buildExpenseLines), the AP subledger or the VAT201
-- reads, and every line column buildExpenseLines or the VAT201 reads.
-- Deliberately NOT covered:
--   * line ids and created_at — the draft edit deletes and re-inserts every
--     line, so identical content must hash identically (Q9);
--   * 3-way match state (line_match_status, *_variance_pct, match_computed_at,
--     match_status) — written by the matcher, not by an editor;
--   * status, payment and approval bookkeeping, timestamps, notes, reference,
--     due_date, payment_terms — none changes what is posted or owed.
-- Lines are aggregated content-sorted, so their storage order is irrelevant.
-- trim_scale() makes 100 and 100.00 the same value.
CREATE OR REPLACE FUNCTION public.approval_document_digest(
  p_company_id pg_catalog.uuid, p_document_type pg_catalog.text, p_document_id pg_catalog.uuid
) RETURNS pg_catalog.text
LANGUAGE sql STABLE
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT CASE p_document_type
    WHEN 'supplier_invoice' THEN (
      SELECT md5(jsonb_build_array(
        si.supplier_id, si.invoice_number, si.invoice_date,
        si.currency, si.currency_code, trim_scale(si.exchange_rate),
        trim_scale(si.subtotal), trim_scale(si.tax_rate), trim_scale(si.tax_amount),
        trim_scale(si.total_amount), trim_scale(si.functional_total),
        si.project_id, si.cost_center_id, si.is_drc,
        COALESCE((
          SELECT jsonb_agg(l.line ORDER BY l.line::TEXT)
          FROM (
            SELECT jsonb_build_array(
              sii.gl_account_id, sii.description, trim_scale(sii.quantity),
              trim_scale(sii.unit_price), trim_scale(sii.tax_rate), trim_scale(sii.tax_amount),
              trim_scale(sii.line_total), sii.project_id, sii.cost_center_id,
              sii.vat_classification
            ) AS line
            FROM public.supplier_invoice_items sii
            WHERE sii.supplier_invoice_id = si.id
          ) l
        ), '[]'::jsonb)
      )::TEXT)
      FROM public.supplier_invoices si
      WHERE si.id = p_document_id AND si.company_id = p_company_id
    )
  END
$$;

-- Pending supplier-invoice requests raised before this migration carry no
-- digest. Bind them to the content as it stands now — what their approver will
-- see — rather than refusing every one of them DOCUMENT_CHANGED. Decided rows
-- stay NULL: an approval recorded without a digest never clears the gate.
UPDATE approval_requests ar
SET document_digest = public.approval_document_digest(ar.company_id, ar.document_type, ar.document_id)
WHERE ar.status = 'pending' AND ar.document_type = 'supplier_invoice'
  AND ar.document_digest IS NULL AND ar.company_id IS NOT NULL;

-- ── 4. Who else could approve (sole-approver self-approval, decision Q2) ────
-- withAuth runs as app_user, and under RLS app_user reads only its own users
-- row (users_self_read) and, below admin, only its own company_users row. A
-- count taken as app_user would therefore find nobody else and ALLOW every
-- self-approval. SECURITY DEFINER reads past that, so it must refuse anything
-- but the request that is asking:
--   * the subject must be the JWT subject withAuth set (request.jwt.claims),
--   * the company must be the one withAuth set (app.current_company_id), and
--   * the subject must be a visible member of it.
-- The last check doubles as the fail-closed guard: "cannot see" (an owner
-- without BYPASSRLS under FORCE RLS) RAISES instead of looking like "nobody
-- else". plpgsql with explicit RAISEs, not a SQL CASE — a privilege guard
-- must not be a branch a planner can fold away. search_path is pinned with
-- pg_temp LAST and every relation and type is schema-qualified: pg_temp
-- shadows relations AND types. Only the columns the rank and account-standing
-- checks need are returned; the rank ladder stays in TypeScript (APPROVER_RANK).
CREATE OR REPLACE FUNCTION public.approval_company_other_members(
  p_company_id pg_catalog.uuid, p_user_id pg_catalog.text
) RETURNS TABLE (
  role pg_catalog.text, is_active pg_catalog.bool, status pg_catalog.text, suspended_at pg_catalog.timestamptz
)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF auth.uid() IS NULL OR auth.uid() IS DISTINCT FROM p_user_id THEN
    RAISE EXCEPTION 'approval_company_other_members: may only be asked on behalf of the caller'
      USING ERRCODE = '42501';
  END IF;
  IF app.current_company_id() IS NULL OR app.current_company_id() IS DISTINCT FROM p_company_id THEN
    RAISE EXCEPTION 'approval_company_other_members: answers only for the request''s own company'
      USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.company_users cu JOIN public.users u ON u.id = cu.user_id
    WHERE cu.company_id = p_company_id AND cu.user_id = p_user_id
  ) THEN
    RAISE EXCEPTION 'approval_company_other_members: cannot see the caller''s own membership in this company'
      USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
    SELECT cu.role::pg_catalog.text, u.is_active, u.status::pg_catalog.text, u.suspended_at
    FROM public.company_users cu
    LEFT JOIN public.users u ON u.id = cu.user_id
    WHERE cu.company_id = p_company_id AND cu.user_id <> p_user_id;
END
$$;

REVOKE ALL ON FUNCTION public.approval_company_other_members(UUID, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.approval_company_other_members(UUID, TEXT) TO app_user;

DO $$
BEGIN
  IF has_function_privilege('public', 'public.approval_company_other_members(uuid, text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'migration 708: PUBLIC can still execute approval_company_other_members';
  END IF;
  IF NOT has_function_privilege('app_user', 'public.approval_company_other_members(uuid, text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'migration 708: app_user cannot execute approval_company_other_members';
  END IF;
  -- FORCE RLS on company_users/users binds the definer's owner too: an owner
  -- without BYPASSRLS would see nothing (the function then refuses every
  -- self-approval — closed, but broken). Refuse to ship it that way.
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_roles r ON r.oid = p.proowner
    WHERE p.oid = 'public.approval_company_other_members(uuid, text)'::pg_catalog.regprocedure
      AND (r.rolbypassrls OR r.rolsuper)
  ) THEN
    RAISE EXCEPTION 'migration 708: the owner of approval_company_other_members must bypass RLS';
  END IF;
END $$;
