-- 869: R-035 PR6 — approval enforcement on MANUAL JOURNALS (`manual_journal`).
--
-- A manual journal is a gl_journal_entries row a PERSON composed (Hein,
-- 2026-10-06, decision 2: journals gate the human-composed paths only).
-- gl_journal_entries also carries every system posting — invoice, payment,
-- bank, payroll, depreciation, VAT journals — so, unlike 712 / 862 / 865 /
-- 867, no trigger can gate every draft -> posted move on the table: a rule
-- such as "every journal needs an accountant" would stop the whole ledger.
-- Instead the gate is wired into the human-composed entry points in
-- TypeScript (gl/manualJournalApproval.ts, census-pinned), and this
-- migration adds:
--   1. approval_enforcement accepts 'manual_journal'.
--   2. THE MARKER: gl_journal_entries.approval_document_type. The gated paths
--      write 'manual_journal' on the journals they create or post — and ONLY
--      while manual_journal enforcement is on for the company, so with it off
--      (every company today, and isaflow_dev, which golden path g runs on)
--      nothing writes or reads this column. Once written it never clears (§5).
--   3. WHO AUTHORED a journal: gl_journal_entries.content_authors (the
--      creator is created_by; stamped only by the account merge, which
--      re-points a draft's lines, and by a recurring run, which unions in its
--      template's authors — both only while enforced), and
--      recurring_journals.content_authors (every user whose edit changed what
--      the template posts).
--   4. The amount a rule sees, approval_manual_journal_gate_amount(), and the
--      manual_journal branches of approval_document_digest() and
--      approval_document_authors(). Every earlier branch is 867's verbatim; a
--      guard refuses the migration if any earlier digest or author list moved.
--   5. The backstop: a MARKED journal may not enter 'posted' without a cleared
--      approval, and its marker may not be removed. An unmarked journal — every
--      system posting, and a journal raw SQL inserts or posts without the
--      marker — passes: the TypeScript gates are the control; this guards
--      marked journals against a raw status flip (a documented limit).
--   6. approval_request_insert_guard() (862) binds manual_journal requests too.
--
-- The legacy `journal_entry` type stays as it is for old rows; new rules of it
-- are refused by the API (gl/approvalDocumentTypes.ts), as PR3 did for
-- `credit_note`.

-- ── 1. The type may carry an enforcement row ──────────────────────────────
ALTER TABLE approval_enforcement DROP CONSTRAINT IF EXISTS approval_enforcement_document_type_check;
ALTER TABLE approval_enforcement ADD CONSTRAINT approval_enforcement_document_type_check CHECK (document_type IN (
  'customer_invoice', 'supplier_invoice', 'payment', 'journal_entry', 'credit_note',
  'customer_credit_note', 'supplier_credit_note', 'supplier_payment', 'payment_batch', 'manual_journal'));

-- ── 2. The marker ─────────────────────────────────────────────────────────
-- Nullable, no default: adding it rewrites nothing. The CHECK is NOT VALID so
-- adding it scans nothing either (every existing row is NULL); it binds every
-- write from here on.
ALTER TABLE gl_journal_entries ADD COLUMN IF NOT EXISTS approval_document_type TEXT;
ALTER TABLE gl_journal_entries DROP CONSTRAINT IF EXISTS gl_journal_entries_approval_document_type_check;
ALTER TABLE gl_journal_entries ADD CONSTRAINT gl_journal_entries_approval_document_type_check
  CHECK (approval_document_type IS NULL OR approval_document_type = 'manual_journal') NOT VALID;

-- ── 3. The authors ────────────────────────────────────────────────────────
-- Append-only, through approval_add_author (712). A constant default adds the
-- column without a rewrite.
ALTER TABLE gl_journal_entries ADD COLUMN IF NOT EXISTS content_authors UUID[] NOT NULL DEFAULT '{}';
-- The recurring journal template: every user whose PUT changed what it posts
-- (its name, description or next run date — the minted journal's description
-- and date). Its creator is created_by. Both are unioned into each journal the
-- template mints while enforcement is on. The template's lines cannot be
-- edited after creation.
ALTER TABLE recurring_journals ADD COLUMN IF NOT EXISTS content_authors UUID[] NOT NULL DEFAULT '{}';

-- ── 4. The amount a rule sees ──────────────────────────────────────────────
-- A journal carries no total: its size is what it moves. A balanced journal's
-- debits equal its credits, so this is SUM(debit) — the figure findDocument
-- has always matched `journal_entry` on — taken as the LARGER side, so a draft
-- whose sides do not (yet) agree is never read at its smaller one, and in
-- absolute terms: gl_journal_lines CHECKs debit and credit >= 0 today, and a
-- negative figure inverts a posting rather than shrinking it, so no future
-- relaxation of those CHECKs may lower what a rule sees. Lines are found by
-- journal; the header pins the company.
CREATE OR REPLACE FUNCTION public.approval_manual_journal_gate_amount(
  p_company_id pg_catalog.uuid, p_entry_id pg_catalog.uuid
) RETURNS pg_catalog.numeric
LANGUAGE sql STABLE
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT GREATEST(COALESCE(SUM(ABS(jl.debit)), 0), COALESCE(SUM(ABS(jl.credit)), 0))
  FROM public.gl_journal_lines jl
  JOIN public.gl_journal_entries je ON je.id = jl.journal_entry_id
  WHERE jl.journal_entry_id = p_entry_id AND je.company_id = p_company_id
$$;

-- ── 5. The content and the authors ─────────────────────────────────────────
-- Every earlier document whose digest or authors anything could still be
-- compared against: referenced by a request, or not yet posted / paid.
DROP TABLE IF EXISTS pg_temp.r035_pr6_before;
CREATE TEMP TABLE r035_pr6_before ON COMMIT DROP AS
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
                WHERE ar.document_type = 'customer_invoice' AND ar.document_id = ci.id)
  UNION ALL
  SELECT sp.company_id, 'supplier_payment', sp.id,
         public.approval_document_digest(sp.company_id, 'supplier_payment', sp.id),
         public.approval_document_authors(sp.company_id, 'supplier_payment', sp.id)
  FROM public.supplier_payments sp
  WHERE sp.batch_id IS NULL
    AND (sp.status IN ('draft', 'approved')
         OR EXISTS (SELECT 1 FROM public.approval_requests ar
                    WHERE ar.document_type = 'supplier_payment' AND ar.document_id = sp.id))
  UNION ALL
  SELECT b.company_id, 'payment_batch', b.id,
         public.approval_document_digest(b.company_id, 'payment_batch', b.id),
         public.approval_document_authors(b.company_id, 'payment_batch', b.id)
  FROM public.supplier_payment_batches b
  WHERE b.status IN ('draft', 'approved')
     OR EXISTS (SELECT 1 FROM public.approval_requests ar
                WHERE ar.document_type = 'payment_batch' AND ar.document_id = b.id);

-- What a manual journal IS: the header a person types (date, description,
-- reference, the dimensions, the intercompany flag and counterparty) and every
-- line — account, debit, credit, narrative, VAT code and every dimension the
-- line carries. Lines are ordered by created_at, then by every hashed column,
-- then by id: createJournalEntry inserts them in one transaction, so their
-- created_at values tie and the order falls to content; line ids and
-- created_at VALUES are never hashed, so identical lines re-inserted digest
-- identically (Q9). Deliberately NOT covered: status, entry_number (assigned
-- at insert), source, fiscal_period_id (derived from the date), the posting /
-- reversal bookkeeping (posted_*, reversed_*, reversal_of_id, late_claim_of_id,
-- late_claim_base), the evidence flags and links (source_document_*,
-- needs_evidence, evidenced_at, extraction_confidence), external_* refs, the
-- actor stamps (created_by, posting_agent, actor_*), timestamps,
-- content_authors and the marker itself — none changes what posts. There is no
-- draft-journal edit route; the account merge re-points a draft's lines (Q10:
-- that stales its approval, and the merger becomes an author), and the s16(3)
-- late-claim split rewrites them as part of posting, after the status flip the
-- backstop judges (gl/vatLateClaimSplit.ts). trim_scale() makes 100 and 100.00
-- the same value; sha256 over UTF-8.
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

-- A manual journal's authors (Hein, rulings through PR4 and PR5: whoever sets
-- the amount is an author): its creator — the person who composed it, the
-- importer of a GL import, the uploader of a receipt, the runner of a
-- recurring template — and every stamped author (§3: the template's creator
-- and editors, unioned in at mint; whoever merged an account a draft line
-- named). Every earlier branch is 867's, verbatim.
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
    WHEN 'manual_journal' THEN (
      SELECT public.approval_add_author(je.content_authors, je.created_by)
      FROM public.gl_journal_entries je
      WHERE je.id = p_document_id AND je.company_id = p_company_id
    )
  END
$$;

-- Supplier-invoice enforcement is live on prod, and credit-note,
-- customer-invoice and payment enforcement are merged: an approval already
-- given must clear exactly as it did before this replace, and refuse the same
-- approvers.
DO $$
DECLARE
  v_changed pg_catalog.int8;
BEGIN
  SELECT count(*) INTO v_changed
  FROM pg_temp.r035_pr6_before b
  WHERE b.digest IS DISTINCT FROM public.approval_document_digest(b.company_id, b.document_type, b.id)
     OR b.authors IS DISTINCT FROM public.approval_document_authors(b.company_id, b.document_type, b.id);
  IF v_changed > 0 THEN
    RAISE EXCEPTION 'migration 869: approval_document_digest or _authors changed for % existing document(s)', v_changed;
  END IF;
END $$;

-- ── 6. The backstop ────────────────────────────────────────────────────────
-- AFTER, SECURITY DEFINER with an owner that bypasses RLS, schema-qualified,
-- pg_temp last — 712's reasons: the digest reads the stored lines, and a
-- caller whose RLS context hides approval_enforcement must not read "not
-- enforced". The check is 862's ratchet, term for term with the TypeScript
-- gate (approvalGate.ts): an approval clears only when decided at or after
-- enforcement was switched on, for the CURRENT digest, bound to a role ranking
-- at or above what the strictest rule matching today demands.
--
-- It fires only for a MARKED journal (the triggers' WHEN clauses), so the
-- system postings that make up most of the ledger never call it:
--   * entering 'posted' — an INSERT so, or an UPDATE from any other status —
--     is refused without a cleared approval while enforcement is on. A marked
--     draft moving to 'reversed' (no ledger effect) passes; leaving 'posted'
--     is never checked.
--   * the marker never changes once set: a raw UPDATE clearing it and then
--     flipping the status would otherwise walk round the check.
-- Per journal header, never per line: a GL import posts journal by journal,
-- and each check digests one journal once.
--
-- KNOWN LIMIT (documented in gl/.claude.md): raw SQL that inserts or posts an
-- UNMARKED journal is not caught — the marker is what tells a manual journal
-- from a system one, and only the gated paths write it. The TypeScript gates
-- are the control.
CREATE OR REPLACE FUNCTION public.manual_journal_approval_gate()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_enabled_at pg_catalog.timestamptz;
  v_demanded pg_catalog.int4;
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.approval_document_type IS NOT NULL
     AND NEW.approval_document_type IS DISTINCT FROM OLD.approval_document_type THEN
    RAISE EXCEPTION 'R035_APPROVAL_MARKER: journal % is a manual journal and stays one', NEW.id
      USING HINT = 'The approval marker on a journal cannot be removed or changed.';
  END IF;
  IF COALESCE(NEW.approval_document_type, '') <> 'manual_journal' OR COALESCE(NEW.status, '') <> 'posted' THEN
    RETURN NULL;
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.status IS NOT DISTINCT FROM 'posted' THEN RETURN NULL; END IF;

  SELECT ae.enabled_at INTO v_enabled_at
  FROM public.approval_enforcement ae
  WHERE ae.company_id = NEW.company_id AND ae.document_type = 'manual_journal';
  IF NOT FOUND THEN RETURN NULL; END IF;

  v_demanded := public.approval_rule_strictest_rank(
    NEW.company_id, 'manual_journal', public.approval_manual_journal_gate_amount(NEW.company_id, NEW.id));
  IF v_demanded IS NULL THEN RETURN NULL; END IF;

  IF EXISTS (
    SELECT 1 FROM public.approval_requests ar
    LEFT JOIN public.approval_rules rl ON rl.id = ar.rule_id AND rl.company_id = ar.company_id
    WHERE ar.company_id = NEW.company_id AND ar.document_type = 'manual_journal'
      AND ar.document_id = NEW.id AND ar.status = 'approved'
      AND ar.decided_at >= v_enabled_at
      AND ar.document_digest = public.approval_document_digest(NEW.company_id, 'manual_journal', NEW.id)
      AND COALESCE(ar.required_role, rl.approver_role) IS NOT NULL
      AND public.approval_required_rank(COALESCE(ar.required_role, rl.approver_role)) >= v_demanded
  ) THEN
    RETURN NULL;
  END IF;

  RAISE EXCEPTION 'R035_APPROVAL_REQUIRED: manual journal % cannot be posted without an approval for its current content', NEW.id
    USING HINT = 'Raise an approval request and have it approved, then post the journal.';
END
$$;

REVOKE ALL ON FUNCTION public.manual_journal_approval_gate() FROM PUBLIC;

DROP TRIGGER IF EXISTS trg_manual_journal_approval_gate_ins ON gl_journal_entries;
CREATE TRIGGER trg_manual_journal_approval_gate_ins
  AFTER INSERT ON gl_journal_entries
  FOR EACH ROW WHEN (NEW.approval_document_type IS NOT NULL)
  EXECUTE FUNCTION public.manual_journal_approval_gate();

DROP TRIGGER IF EXISTS trg_manual_journal_approval_gate_upd ON gl_journal_entries;
CREATE TRIGGER trg_manual_journal_approval_gate_upd
  AFTER UPDATE OF status, approval_document_type ON gl_journal_entries
  FOR EACH ROW WHEN (OLD.approval_document_type IS NOT NULL OR NEW.approval_document_type IS NOT NULL)
  EXECUTE FUNCTION public.manual_journal_approval_gate();

DO $$
BEGIN
  -- FORCE RLS on approval_enforcement / approval_requests / gl_journal_lines
  -- binds the definer's owner too: an owner without BYPASSRLS would see no
  -- enforcement row and let every journal through. Refuse to ship it that way.
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_roles r ON r.oid = p.proowner
    WHERE p.oid = 'public.manual_journal_approval_gate()'::pg_catalog.regprocedure
      AND (r.rolbypassrls OR r.rolsuper)
  ) THEN
    RAISE EXCEPTION 'migration 869: the owner of manual_journal_approval_gate must bypass RLS';
  END IF;
END $$;

-- ── 7. A request is inserted only as requestApproval writes it ────────────
-- 862's guard, verbatim but for the type list, which gains manual_journal:
-- the unattended creators (receipt-to-journal, GL import, the recurring runs)
-- raise as the session's own user through raiseUnattendedApproval, so they
-- write nothing it refuses. OUT OF SCOPE, as 862, 865 and 867 record for every
-- type (follow-up for Hein): the UPDATE half (N1) and the subject itself (N3).
-- supplier_invoice stays outside the list.
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
                                         'supplier_payment', 'payment_batch', 'manual_journal']::pg_catalog.text[]))
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
