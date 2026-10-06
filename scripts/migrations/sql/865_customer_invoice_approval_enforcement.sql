-- 865: R-035 PR4 — approval enforcement on CUSTOMER INVOICES.
--
-- `customer_invoice` is one of the five types approval_enforcement admitted
-- from the start (708), so its CHECK is left alone. ENFORCEABLE_DOCUMENT_TYPES
-- (gl/approvalEnforcement.ts) is the gate; the API refuses a type outside it.
--
-- Pieces:
--   1. WHO AUTHORED an invoice's content: customer_invoices.content_authors /
--      content_edited_at, as 712 added them to supplier_invoices and 862 to
--      credit_notes.
--   2. approval_customer_invoice_gate_amount() — the amount a rule sees.
--   3. approval_document_digest() and approval_document_authors() gain the
--      customer_invoice branch. Every earlier branch (supplier_invoice from
--      708 / 712, both credit-note types from 862) is copied verbatim, and a
--      guard below refuses the migration if any of their digests or authors
--      changed across the replace.
--   4. A backstop trigger: an invoice may not ENTER the AR population (insert
--      as, or move from draft / pending_approval / cancelled to, any other
--      status) while enforcement is on, an active customer_invoice rule
--      matches it, and no APPROVED request for its CURRENT digest, decided at
--      or after enforcement was switched on, at a rank at or above the
--      strictest rule matching today (the ratchet, 862's), exists. The
--      TypeScript gate in approveCustomerInvoice refuses first with a 409;
--      this is the fail-closed floor for every other writer — raw SQL, scripts,
--      and the two services that move an invoice into the population without
--      approving it, when they act on a DRAFT invoice under enforcement:
--      confirmCustomerPayment (its savepoint rolls the whole confirm back; the
--      customer-payments-action route answers 409) and approveWriteOff of the
--      whole balance (a 500 and a rollback). Paystack receipts never reach it
--      for a draft: their allocation plan refuses drafts and banks the receipt
--      unapplied. Unlike 862's, it honours the import GUC: the Sage staging
--      import, the Sage migration commit and the AR take-on bring in invoices
--      issued in the source system (decision Q1), and the census
--      (approvalGateExemptCensus.test.ts) pins who sets it. The GUC is an
--      ordinary setting, so a session issuing raw SQL can set it itself — the
--      N3 class below, not closable from a trigger.
--   5. approval_request_insert_guard() (862) binds customer_invoice requests
--      too: pending, undecided, no past requesters, raised by the session's
--      own user.
--
-- Upstream authors (review F1): an invoice minted from a template, a quote, a
-- sales order or time entries carries content someone else wrote, and those
-- authors are refused as its approvers. The templates gain content_authors
-- (below), unioned into the invoice's content_authors at mint
-- (ar/customerInvoiceUpstreamAuthors.ts); a conversion's authors are derived
-- by approval_document_authors from the link the converter already writes. KNOWN LIMIT, follow-up for Hein: a SUPPLIER invoice minted from a
-- recurring_transaction_templates row gets no upstream authors — stamping
-- them would change the live supplier-invoice enforcement; a template's
-- author may still approve the bill someone else's run minted.

-- ── 1. The authors ────────────────────────────────────────────────────────
-- Append-only, through approval_add_author (712). The digest-moving edits are
-- the detail PUT (customerInvoiceDraftEdit) and the customer merge
-- (customerMergeService.moveDocuments); both stamp the acting user.
ALTER TABLE customer_invoices ADD COLUMN IF NOT EXISTS content_authors UUID[] NOT NULL DEFAULT '{}';
ALTER TABLE customer_invoices ADD COLUMN IF NOT EXISTS content_edited_at TIMESTAMPTZ;
-- The templates an invoice is minted from: everyone whose edit changed what
-- the template bills (the recurring-invoices PUT, the recurring-transactions
-- update, the customer merge re-pointing its client). Their creator is
-- created_by. Both are unioned into each invoice the template mints.
ALTER TABLE recurring_invoices ADD COLUMN IF NOT EXISTS content_authors UUID[] NOT NULL DEFAULT '{}';
ALTER TABLE recurring_transaction_templates ADD COLUMN IF NOT EXISTS content_authors UUID[] NOT NULL DEFAULT '{}';

-- ── 2. The amount a rule sees ──────────────────────────────────────────────
-- approveCustomerInvoice books total_amount, UNCONVERTED, into the ledger
-- (DR receivable total, CR revenue subtotal, CR VAT tax — a balanced journal,
-- and migration 692 keeps every leg non-negative, so the total is the largest
-- leg); functional_total is the rand value of a foreign invoice. A rule sees
-- the LARGER of the two, for 712's reason: on the functional figure alone an
-- exchange rate steers the rule (a R500 000 invoice at 0.0001 carries R50 and
-- matches nothing, then posts R500 000); on the total alone a USD 5 000
-- invoice (R92 500) slips under a R50 000 rule. ABS because a negative figure
-- inverts the posting rather than shrinking it. The same function feeds the
-- TypeScript gate (findDocument), this backstop and the preview.
CREATE OR REPLACE FUNCTION public.approval_customer_invoice_gate_amount(
  p_total pg_catalog.numeric, p_functional pg_catalog.numeric
) RETURNS pg_catalog.numeric
LANGUAGE sql IMMUTABLE
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT GREATEST(ABS(COALESCE(p_total, 0)), ABS(COALESCE(p_functional, p_total, 0)))
$$;

-- ── 3. The content and the authors ─────────────────────────────────────────
-- Every earlier document whose digest or authors anything could still be
-- compared against: referenced by a request, or not yet posted.
DROP TABLE IF EXISTS pg_temp.r035_pr4_before;
CREATE TEMP TABLE r035_pr4_before ON COMMIT DROP AS
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
                WHERE ar.document_type = t.document_type AND ar.document_id = cn.id);

-- The customer_invoice branch hashes what the invoice IS and what its posting
-- reads: both customer links (a document carrying either must not shed it),
-- the number, date, currency and rate, every header figure, the project, and
-- every line's description, quantity, price, amount, VAT rate, account and
-- currency. postCustomerInvoiceToGL posts from the header; the lines are the
-- document the customer receives, which an approver vouches for as well.
-- Lines are ordered by created_at and then by every hashed column, so line ids
-- and created_at VALUES are never hashed: the detail PUT deletes and
-- re-inserts every line in one transaction, and identical content re-inserted
-- that way digests identically (Q9). A soft-deleted invoice digests to NULL.
-- Deliberately NOT covered: status, notes, internal_notes, due_date,
-- billing_period_*, amount_paid / balance, the payment, email, portal, PDF,
-- VAT-declared-elsewhere and external_* bookkeeping, approved_* / created_by /
-- actor_* stamps, gl_journal_entry_id, source_document_id, timestamps,
-- content_authors, and a line's time_entry_id — none changes what is posted
-- or what the customer is asked to pay. As for bills, the system accounts the
-- posting resolves (receivable, default_revenue, vat_output) are a
-- chart-of-accounts setting, not invoice content: a documented limit.
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
  END
$$;

-- customer_invoices.created_by is VARCHAR: an app-created invoice carries the
-- creator's uuid, a legacy or system row may carry anything. Only a canonical
-- uuid (any case) is cast — never a bare ::uuid, which would make a single
-- such row raise 22P02 on every raise or decide that reads its authors.
-- An invoice CONVERTED from someone else's content carries that content's
-- authors too (review F1), DERIVED here from the links the converters already
-- write — the quote's created_by (customer_quotes.converted_invoice_id), the
-- sales order's (customer_sales_orders.invoice_id) and the users who logged
-- the billed time (time_entries.invoice_id, set by both time billing paths),
-- each company-scoped, NULLs dropped, de-duplicated. Derived, not stamped: the
-- converting services write nothing new, so they run unchanged on a database
-- without this migration. A recurring template has no such link, so its
-- authors are written into content_authors at mint instead.
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
          SELECT q.created_by FROM public.customer_quotes q
          WHERE q.converted_invoice_id = ci.id AND q.company_id = ci.company_id
          UNION
          SELECT so.created_by FROM public.customer_sales_orders so
          WHERE so.invoice_id = ci.id AND so.company_id = ci.company_id
          UNION
          SELECT te.user_id FROM public.time_entries te
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
  END
$$;

-- Supplier-invoice enforcement is live on prod and credit-note enforcement is
-- merged: an approval already given for a bill or a note must clear exactly as
-- it did before this replace, and refuse exactly the same approvers.
DO $$
DECLARE
  v_changed pg_catalog.int8;
BEGIN
  SELECT count(*) INTO v_changed
  FROM pg_temp.r035_pr4_before b
  WHERE b.digest IS DISTINCT FROM public.approval_document_digest(b.company_id, b.document_type, b.id)
     OR b.authors IS DISTINCT FROM public.approval_document_authors(b.company_id, b.document_type, b.id);
  IF v_changed > 0 THEN
    RAISE EXCEPTION 'migration 865: approval_document_digest or _authors changed for % existing document(s)', v_changed;
  END IF;
END $$;

-- ── 4. The backstop ────────────────────────────────────────────────────────
-- AFTER, not BEFORE, and SECURITY DEFINER with an owner that bypasses RLS —
-- 712's reasons: the digest reads the stored row (an UPDATE moving content and
-- status together is judged on the NEW content), and a caller whose RLS
-- context hides approval_enforcement must not read "not enforced". Every
-- relation and function is schema-qualified; pg_temp is searched last. The
-- rank ratchet is 862's, term for term with the TypeScript gate
-- (approvalGate.ts): an approval clears only when the role it was bound to —
-- its snapshot, or for a row predating the snapshot its rule's live role —
-- ranks at or above what the strictest rule matching today demands. A row
-- bound to no role proves no rank and clears nothing.
-- Not filtered on deleted_at: a soft-deleted invoice entering the population
-- is refused like any other (its digest is NULL, so nothing clears it).
CREATE OR REPLACE FUNCTION public.customer_invoice_approval_gate()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_enabled_at pg_catalog.timestamptz;
  v_demanded pg_catalog.int4;
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
  WHERE ae.company_id = NEW.company_id AND ae.document_type = 'customer_invoice';
  IF NOT FOUND THEN RETURN NULL; END IF;

  v_demanded := public.approval_rule_strictest_rank(
    NEW.company_id, 'customer_invoice',
    public.approval_customer_invoice_gate_amount(NEW.total_amount, NEW.functional_total));
  IF v_demanded IS NULL THEN RETURN NULL; END IF;

  IF EXISTS (
    SELECT 1 FROM public.approval_requests ar
    LEFT JOIN public.approval_rules rl ON rl.id = ar.rule_id AND rl.company_id = ar.company_id
    WHERE ar.company_id = NEW.company_id AND ar.document_type = 'customer_invoice'
      AND ar.document_id = NEW.id AND ar.status = 'approved'
      AND ar.decided_at >= v_enabled_at
      AND ar.document_digest = public.approval_document_digest(NEW.company_id, 'customer_invoice', NEW.id)
      AND COALESCE(ar.required_role, rl.approver_role) IS NOT NULL
      AND public.approval_required_rank(COALESCE(ar.required_role, rl.approver_role)) >= v_demanded
  ) THEN
    RETURN NULL;
  END IF;

  RAISE EXCEPTION 'R035_APPROVAL_REQUIRED: customer invoice % cannot enter the AR population without an approval for its current content', NEW.id
    USING HINT = 'Raise an approval request and have it approved, then approve the invoice.';
END
$$;

REVOKE ALL ON FUNCTION public.customer_invoice_approval_gate() FROM PUBLIC;

DROP TRIGGER IF EXISTS trg_customer_invoice_approval_gate ON customer_invoices;
CREATE TRIGGER trg_customer_invoice_approval_gate
  AFTER INSERT OR UPDATE OF status ON customer_invoices
  FOR EACH ROW EXECUTE FUNCTION public.customer_invoice_approval_gate();

DO $$
BEGIN
  -- FORCE RLS on approval_enforcement / approval_requests binds the definer's
  -- owner too: an owner without BYPASSRLS would see no enforcement row and let
  -- every invoice through. Refuse to ship it that way.
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_roles r ON r.oid = p.proowner
    WHERE p.oid = 'public.customer_invoice_approval_gate()'::pg_catalog.regprocedure
      AND (r.rolbypassrls OR r.rolsuper)
  ) THEN
    RAISE EXCEPTION 'migration 865: the owner of customer_invoice_approval_gate must bypass RLS';
  END IF;
END $$;

-- ── 5. A request is inserted only as requestApproval writes it ────────────
-- 862's guard, verbatim but for the type list, which gains customer_invoice:
-- app_user may not INSERT an already-approved customer-invoice request, one
-- naming another requester, one carrying a decision, or one with past
-- requesters. requestApproval (the human raise) and raiseUnattendedApproval
-- (the recurring runs, raising as the session user) write none of those.
-- OUT OF SCOPE, as 862 records for every type (follow-up for Hein): the UPDATE
-- half (round 2 N1: insert pending, then raw-UPDATE to approved) and the
-- subject itself (round 3 N3: request.jwt.claims is a GUC a raw-SQL session
-- can set), and with it the import GUC isaflow.approval_gate_exempt, which a
-- raw-SQL app_user session can set_config itself to pass both invoice
-- backstops (PR4 review REPRO 2). All need the request and decide paths — and
-- the import exemption — behind SECURITY DEFINER functions with app_user's
-- direct INSERT/UPDATE revoked — a change to the live supplier-invoice
-- enforcement, so not made here. supplier_invoice stays outside the list for
-- the same reason.
CREATE OR REPLACE FUNCTION public.approval_request_insert_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_subject pg_catalog.text;
  v_uid pg_catalog.uuid;
BEGIN
  IF NOT (NEW.document_type = ANY (ARRAY['customer_credit_note', 'supplier_credit_note', 'customer_invoice']::pg_catalog.text[]))
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
