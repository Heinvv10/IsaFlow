-- 1013: Intercompany P2 (invoice + credit-note mirror). Plan: docs/plans/2026-11-17-intercompany-mirror-posting.md (P2).
-- Applies on top of 1000 / 1002; idempotent (CREATE OR REPLACE, IF NOT EXISTS, DROP ... IF EXISTS), adds columns, drops none.
--
-- WHAT
--   1. A document message is WRITTEN BY THE DATABASE, never by the sender: intercompany_send_for_source(doc type, doc id) (definer) reads the
--      session company's APPROVED customer invoice / credit note, its lines, the company's name and VAT number and the currency (NULL = ZAR),
--      builds the payload itself (intercompany_build_payload: the parser's rules, cents-exact, the header VAT split over the lines by largest
--      remainder), writes the sender's group row (a 'sale' row, ZAR, a credit note negative) and the message with that row's id, and
--      refuses a document the receiver's parser would refuse (reason 'unmirrorable'). The messages guard refuses a document message
--      written by app_user / app_service. So no payload field (line VAT, due date, notes, PDF, credited invoice, group reference) is the
--      sender's to choose. intercompany_message_source_changed lets the receiver see that the source changed after the send.
--   2. A sender's CANCELLATION of a document reaches its message AND its group row: intercompany_withdraw_for_source (definer, write role)
--      WITHDRAWS a message not yet handled (status 'withdrawn', not acceptable, never auto-accepted) and only stamps `source_cancelled_at`
--      on one the receiver already accepted (the receiver's data is never touched); it acts only when the ledger agrees (the journal the
--      message was sent with has been reversed: the status column alone is writable and proves nothing); the group row goes back to
--      unmatched and the eliminations generated from it are reversed. The messages guard takes these system updates only from
--      migration_admin with the transaction-local flag app.intercompany_system_update (the flag alone proves nothing).
--   3. The auto-accept worker's own definer path, intercompany_auto_accept_queue(limit, claim):
--        the worker has no user and no company, and intercompany_in_one_group is false without a signed-in user (it is no membership
--        oracle), so the one cross-tenant READ it needs is this function. It returns ids only; a message whose RECEIVER side has
--        auto_accept on (and switched on BEFORE the message was created: sides.auto_accept_since) on an ACTIVE GROUP connection whose
--        companies still share a current active group (intercompany_shared_group), never a message a person restored or retried
--        (manual_only), with one write-role user of the receiver in good standing (the allow-list withAuth applies). At most 10 per
--        receiver per call, so one pair cannot starve the others. With claim it stamps an attempt (auto_attempts, auto_next_attempt_at,
--        exponential back-off up to an hour, at most 8 attempts), so a message that keeps deferring never blocks the head of the queue.
--        Executable by app_service and migration_admin only.
--   4. intercompany_sync_group_row (definer, write role): the sender's side of intercompany_transactions is matched ONLY on the receiver's
--      LEDGER: the bill's journal is posted, standing, the bill's own, in the receiver's fiscal period of the sender's date, not another
--      row's target, for the connection's supplier, with expense lines (and payable / input VAT only) netting to the sender's amount; any
--      miss is a variance with its reason (variance_reason); an unapproved bill, or a cancelled sender document, is unmatched. Anything but
--      matched reverses the eliminations generated from the row. Accepting a message creates a draft and eliminates nothing.
--      intercompany_transaction_parties_immutable lets target_journal_entry_id and variance_reason be written only by migration_admin.
--
-- DEFINER REGISTRY (930): intercompany_send_for_source, intercompany_message_source_changed, intercompany_auto_accept_queue,
-- intercompany_withdraw_for_source and intercompany_sync_group_row are registered in app_definer_reviews (owner migration_admin, search_path
-- pinned, pg_temp last). The builder and the two helpers are SECURITY INVOKER and executable by migration_admin only.
-- OLD COLOUR: nothing in the previous release reads these columns or calls these functions. LOCKS: new columns (no default rewrite),
-- function bodies, one status CHECK replaced.
--
-- Rollback (code first):
--   DROP FUNCTION IF EXISTS public.intercompany_auto_accept_queue(integer, boolean), public.intercompany_withdraw_for_source(text, uuid),
--     public.intercompany_sync_group_row(text, uuid), public.intercompany_send_for_source(text, uuid), public.intercompany_message_source_changed(uuid),
--     public.intercompany_build_payload(text, uuid, uuid), public.intercompany_release_group_row(uuid), public.intercompany_journal_chain_length(uuid, uuid),
--     public.intercompany_clean_text(text, integer), public.intercompany_auto_accept_exhausted();
--   DROP TRIGGER IF EXISTS trg_intercompany_sides_auto_since ON intercompany_connection_sides; DROP FUNCTION IF EXISTS public.intercompany_sides_auto_since();
--   (the 1002 body of intercompany_messages_guard and the 999r body of intercompany_transaction_parties_immutable return by re-applying them)
--   ALTER TABLE intercompany_messages DROP COLUMN IF EXISTS source_cancelled_at, DROP COLUMN IF EXISTS manual_only,
--     DROP COLUMN IF EXISTS auto_attempts, DROP COLUMN IF EXISTS auto_next_attempt_at, DROP COLUMN IF EXISTS source_journal_entry_id;
--   ALTER TABLE intercompany_transactions DROP COLUMN IF EXISTS variance_reason;
--   ALTER TABLE intercompany_connection_sides DROP COLUMN IF EXISTS auto_accept_since;
--   DELETE FROM app_definer_reviews WHERE signature IN ('intercompany_auto_accept_queue(integer,boolean)', 'intercompany_withdraw_for_source(text,uuid)',
--     'intercompany_sync_group_row(text,uuid)', 'intercompany_send_for_source(text,uuid)', 'intercompany_message_source_changed(uuid)',
--     'intercompany_auto_accept_exhausted()');

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- ── 1. Columns ──────────────────────────────────────────────────────────────

-- No app role is granted these: they are set by the guard and the definers below.
ALTER TABLE intercompany_messages
  ADD COLUMN IF NOT EXISTS source_cancelled_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS manual_only BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS auto_attempts INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS auto_next_attempt_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS source_journal_entry_id UUID;
-- Why a group row is a variance (written by intercompany_sync_group_row only: the parties trigger below refuses a request's write).
ALTER TABLE intercompany_transactions ADD COLUMN IF NOT EXISTS variance_reason TEXT;
ALTER TABLE intercompany_connection_sides ADD COLUMN IF NOT EXISTS auto_accept_since TIMESTAMPTZ;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.intercompany_messages'::regclass AND conname = 'intercompany_messages_status_check'
               AND pg_get_constraintdef(oid) NOT LIKE '%withdrawn%') THEN
    ALTER TABLE intercompany_messages DROP CONSTRAINT intercompany_messages_status_check;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.intercompany_messages'::regclass AND conname = 'intercompany_messages_status_check') THEN
    ALTER TABLE intercompany_messages ADD CONSTRAINT intercompany_messages_status_check
      CHECK (status IN ('pending', 'accepted', 'rejected', 'dismissed', 'failed', 'withdrawn'));
  END IF;
END $$;

-- A side that has auto-accept on today was switched on at its last change.
UPDATE intercompany_connection_sides SET auto_accept_since = updated_at WHERE auto_accept AND auto_accept_since IS NULL;

-- auto_accept_since is the moment auto-accept was switched ON; the worker takes only messages created after it, so switching it on
-- never drains a backlog. Set by the database, whatever was sent (no app role has a column grant on it).
CREATE OR REPLACE FUNCTION public.intercompany_sides_auto_since()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF NOT NEW.auto_accept THEN
    NEW.auto_accept_since := NULL;
  ELSIF TG_OP = 'INSERT' OR NOT OLD.auto_accept OR OLD.auto_accept_since IS NULL THEN
    NEW.auto_accept_since := clock_timestamp();
  ELSE
    NEW.auto_accept_since := OLD.auto_accept_since;
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.intercompany_sides_auto_since() FROM PUBLIC;
DROP TRIGGER IF EXISTS trg_intercompany_sides_auto_since ON intercompany_connection_sides;
CREATE TRIGGER trg_intercompany_sides_auto_since BEFORE INSERT OR UPDATE ON intercompany_connection_sides
  FOR EACH ROW EXECUTE FUNCTION public.intercompany_sides_auto_since();
ALTER TABLE intercompany_connection_sides ENABLE ALWAYS TRIGGER trg_intercompany_sides_auto_since;

-- ── 2. The DATABASE writes a document message, the sender never does ────────

DROP FUNCTION IF EXISTS public.intercompany_payload_problem(text, uuid, uuid, jsonb);

-- Text as the receiver's parser takes it: trimmed (all whitespace), cut at p_max characters, NULL when nothing is left.
CREATE OR REPLACE FUNCTION public.intercompany_clean_text(p_text text, p_max integer)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog, public, pg_temp
AS $$ SELECT NULLIF(pg_catalog.left(pg_catalog.regexp_replace(COALESCE(p_text, ''), '^\s+|\s+$', '', 'g'), p_max), '') $$;
REVOKE ALL ON FUNCTION public.intercompany_clean_text(text, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.intercompany_clean_text(text, integer) TO app_user, app_service, migration_admin;

-- The number of POSTED journals in the reversal chain that starts at p_je (the journal, its reversal, the reversal's reversal, ...), 0 when
-- p_je is not a posted journal of p_company. ODD = the ledger carries the document, EVEN = the chain is out (it has been reversed).
CREATE OR REPLACE FUNCTION public.intercompany_journal_chain_length(p_je uuid, p_company uuid)
RETURNS integer
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog, public, pg_temp
AS $$
  WITH RECURSIVE chain(id) AS (
    SELECT je.id FROM public.gl_journal_entries je WHERE je.id = p_je AND je.company_id = p_company AND je.status = 'posted'
    UNION
    SELECT r.id FROM public.gl_journal_entries r JOIN chain ON r.reversal_of_id = chain.id WHERE r.company_id = p_company AND r.status = 'posted'
  )
  SELECT count(*)::integer FROM chain
$$;
REVOKE ALL ON FUNCTION public.intercompany_journal_chain_length(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.intercompany_journal_chain_length(uuid, uuid) TO migration_admin;

-- The payload of a document message, built from the SENDER's books and nothing else: (payload, problem, journal). problem is NULL, or
-- 'not_found' / 'not_approved' / 'unmirrorable: <why>' (a document the receiver's parser would refuse: a negative line, a header that is not
-- its lines, a VAT more than a cent from its rate). SECURITY INVOKER and executable by migration_admin only: it reads whatever company it is
-- told to, so it is reached through intercompany_send_for_source / intercompany_message_source_changed, which name the session company.
-- The rules are the parser's (mirrorPayload.ts parseMirrorPayload), cents-exact; a header VAT is split over the lines by largest remainder.
CREATE OR REPLACE FUNCTION public.intercompany_build_payload(p_kind text, p_source uuid, p_company uuid)
RETURNS TABLE (payload jsonb, problem text, journal_entry_id uuid)
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  d RECORD;
  v_name text;
  v_vat text;
  v_lines jsonb;
  v_n bigint;
  v_sum_c bigint;
  v_sum_v bigint;
  v_bad bigint;
  v_sub bigint;
  v_tax bigint;
  v_tot bigint;
  v_pdf jsonb;
  v_payload jsonb;
BEGIN
  SELECT COALESCE(public.intercompany_clean_text(co.name, 200), ''), public.intercompany_clean_text(co.vat_number, 50)
    INTO v_name, v_vat FROM public.companies co WHERE co.id = p_company;

  IF p_kind = 'invoice' THEN
    SELECT ci.invoice_number AS num, to_char(ci.invoice_date, 'YYYY-MM-DD') AS dt, to_char(ci.due_date, 'YYYY-MM-DD') AS due,
           upper(COALESCE(NULLIF(btrim(ci.currency_code), ''), 'ZAR')) AS cur, ci.subtotal, ci.tax_amount, ci.total_amount, ci.notes, ci.status,
           ci.gl_journal_entry_id AS je, ci.source_document_id AS doc, ci.rendered_pdf_storage_path AS pth, ci.rendered_pdf_sha256 AS sha
      INTO d FROM public.customer_invoices ci WHERE ci.id = p_source AND ci.company_id = p_company AND ci.deleted_at IS NULL;
    IF NOT FOUND THEN RETURN QUERY SELECT NULL::jsonb, 'not_found'::text, NULL::uuid; RETURN; END IF;
    IF d.status NOT IN ('approved', 'sent', 'partially_paid', 'paid', 'overdue') THEN RETURN QUERY SELECT NULL::jsonb, 'not_approved'::text, d.je; RETURN; END IF;
    v_sub := round(COALESCE(d.subtotal, 0) * 100)::bigint; v_tax := round(COALESCE(d.tax_amount, 0) * 100)::bigint; v_tot := round(COALESCE(d.total_amount, 0) * 100)::bigint;

    -- A line is sent as quantity x price when that multiplies out to its amount (to the cent; quantity is numeric(10,2) and prices are numeric(15,2),
    -- so the parser's bounds hold); a discounted line is one unit at the line's amount. A line's VAT is its amount at its rate, and the cents the header VAT
    -- is above or below the sum of those go one each to the lines with the largest (below: smallest) fractional cent, round and round.
    WITH it AS (
      SELECT row_number() OVER (ORDER BY i.line_position NULLS LAST, i.created_at, i.id) AS n,
             i.description AS descr, i.quantity AS q, i.unit_price AS up, COALESCE(i.tax_rate, 0) AS r,
             round(COALESCE(i.amount, 0) * 100)::bigint AS c, round(COALESCE(i.tax_rate, 0) * 100)::bigint AS r100
        FROM public.customer_invoice_items i WHERE i.invoice_id = p_source),
    base AS (SELECT it.*, (it.c * it.r100) AS u, floor((it.c * it.r100)::numeric / 10000)::bigint AS b FROM it),
    tot AS (SELECT count(*) AS cnt, COALESCE(sum(base.b), 0)::bigint AS sb FROM base),
    adj AS (
      SELECT base.*, tot.cnt, v_tax - tot.sb AS rest,
             row_number() OVER (ORDER BY (base.u - base.b * 10000) DESC, base.n ASC) AS rk_up,
             row_number() OVER (ORDER BY (base.u - base.b * 10000) ASC, base.n DESC) AS rk_down
        FROM base CROSS JOIN tot),
    fin AS (
      SELECT adj.*, adj.b + CASE WHEN adj.rest > 0 THEN adj.rest / adj.cnt + CASE WHEN adj.rk_up <= adj.rest % adj.cnt THEN 1 ELSE 0 END
                                 WHEN adj.rest < 0 THEN -((-adj.rest) / adj.cnt) - CASE WHEN adj.rk_down <= (-adj.rest) % adj.cnt THEN 1 ELSE 0 END
                                 ELSE 0 END AS vat,
             COALESCE(round(adj.q * adj.up * 100)::bigint = adj.c AND adj.up >= 0 AND adj.q > 0, false) AS mult
        FROM adj)
    SELECT jsonb_agg(jsonb_build_object(
             'description', COALESCE(public.intercompany_clean_text(f.descr, 1000), '(no description)'),
             'quantity', CASE WHEN f.mult THEN f.q ELSE 1 END,
             'unitPrice', CASE WHEN f.mult THEN f.up ELSE (f.c::numeric / 100)::numeric(16, 2) END,
             'taxRate', f.r, 'taxAmount', (f.vat::numeric / 100)::numeric(16, 2), 'lineTotal', (f.c::numeric / 100)::numeric(16, 2)) ORDER BY f.n),
           count(*), COALESCE(sum(f.c), 0), COALESCE(sum(f.vat), 0),
           count(*) FILTER (WHERE NOT (f.c >= 0 AND f.r BETWEEN 0 AND 100 AND f.vat >= 0 AND abs(f.vat * 10000 - f.c * f.r100) <= 10000))
      INTO v_lines, v_n, v_sum_c, v_sum_v, v_bad FROM fin f;
    IF v_n = 0 OR v_n > 500 THEN RETURN QUERY SELECT NULL::jsonb, 'unmirrorable: needs between 1 and 500 lines'::text, d.je; RETURN; END IF;
    IF v_bad > 0 THEN RETURN QUERY SELECT NULL::jsonb, 'unmirrorable: a line is negative, its tax rate is outside 0 to 100, or its VAT is not its amount at its rate'::text, d.je; RETURN; END IF;
    IF v_sum_c <> v_sub THEN RETURN QUERY SELECT NULL::jsonb, 'unmirrorable: the line totals do not add up to the subtotal'::text, d.je; RETURN; END IF;
    IF v_sum_v <> v_tax THEN RETURN QUERY SELECT NULL::jsonb, 'unmirrorable: the line VAT does not add up to the document VAT'::text, d.je; RETURN; END IF;
    -- The sender's sealed PDF: only the one the sealing wrote for THIS invoice, <company>/<its captured document>.pdf, with the hash that document has.
    v_pdf := CASE WHEN d.pth = lower(p_company::text) || '/' || d.doc::text || '.pdf' AND d.sha ~ '^[0-9a-f]{64}$' AND EXISTS (
                    SELECT 1 FROM public.captured_documents cd
                     WHERE cd.id = d.doc AND cd.company_id = p_company AND cd.storage_path = d.pth AND cd.raw_bytes_sha256 = d.sha)
                  THEN jsonb_build_object('path', d.pth, 'sha256', d.sha) END;
    v_payload := jsonb_build_object(
      'version', 1, 'kind', 'invoice', 'number', d.num, 'date', d.dt, 'dueDate', d.due, 'currency', d.cur,
      'subtotal', (v_sub::numeric / 100)::numeric(16, 2), 'taxAmount', (v_tax::numeric / 100)::numeric(16, 2), 'total', (v_tot::numeric / 100)::numeric(16, 2),
      'senderName', v_name, 'senderVatNumber', v_vat, 'notes', public.intercompany_clean_text(d.notes, 2000),
      'lines', v_lines, 'pdf', v_pdf, 'creditsInvoiceNumber', NULL, 'groupTransactionId', NULL);
  ELSIF p_kind = 'credit_note' THEN
    SELECT COALESCE(cn.credit_note_number, 'CN-' || left(cn.id::text, 8)) AS num, to_char(cn.credit_date, 'YYYY-MM-DD') AS dt,
           upper(COALESCE(NULLIF(btrim(cn.currency), ''), 'ZAR')) AS cur, cn.subtotal, cn.tax_amount, cn.total_amount, cn.tax_rate, cn.reason, cn.status,
           cn.gl_journal_entry_id AS je, ci.invoice_number AS credits
      INTO d FROM public.credit_notes cn
      LEFT JOIN public.customer_invoices ci ON ci.id = cn.customer_invoice_id AND ci.company_id = cn.company_id
     WHERE cn.id = p_source AND cn.company_id = p_company AND cn.type = 'customer';
    IF NOT FOUND THEN RETURN QUERY SELECT NULL::jsonb, 'not_found'::text, NULL::uuid; RETURN; END IF;
    IF d.status NOT IN ('approved', 'partially_applied', 'applied') THEN RETURN QUERY SELECT NULL::jsonb, 'not_approved'::text, d.je; RETURN; END IF;
    v_sub := round(COALESCE(d.subtotal, 0) * 100)::bigint; v_tax := round(COALESCE(d.tax_amount, 0) * 100)::bigint; v_tot := round(COALESCE(d.total_amount, 0) * 100)::bigint;
    IF v_sub < 0 OR v_tax < 0 OR COALESCE(d.tax_rate, 0) NOT BETWEEN 0 AND 100 THEN
      RETURN QUERY SELECT NULL::jsonb, 'unmirrorable: a total or the tax rate is negative or out of range'::text, d.je; RETURN;
    END IF;
    v_payload := jsonb_build_object(
      'version', 1, 'kind', 'credit_note', 'number', d.num, 'date', d.dt, 'dueDate', NULL, 'currency', d.cur,
      'subtotal', (v_sub::numeric / 100)::numeric(16, 2), 'taxAmount', (v_tax::numeric / 100)::numeric(16, 2), 'total', (v_tot::numeric / 100)::numeric(16, 2),
      'senderName', v_name, 'senderVatNumber', v_vat, 'notes', public.intercompany_clean_text(d.reason, 2000),
      'lines', jsonb_build_array(jsonb_build_object(
        'description', COALESCE(public.intercompany_clean_text(d.reason, 1000), 'Credit note ' || d.num), 'quantity', 1,
        'unitPrice', (v_sub::numeric / 100)::numeric(16, 2), 'taxRate', COALESCE(d.tax_rate, 0), 'taxAmount', (v_tax::numeric / 100)::numeric(16, 2),
        'lineTotal', (v_sub::numeric / 100)::numeric(16, 2))),
      'pdf', NULL, 'creditsInvoiceNumber', public.intercompany_clean_text(d.credits, 50), 'groupTransactionId', NULL);
  ELSE
    RETURN QUERY SELECT NULL::jsonb, 'not_found'::text, NULL::uuid; RETURN;
  END IF;

  IF COALESCE(length(d.num), 0) < 1 OR length(d.num) > 50 THEN RETURN QUERY SELECT NULL::jsonb, 'unmirrorable: the document number is missing or too long'::text, d.je; RETURN; END IF;
  IF v_sub + v_tax <> v_tot THEN RETURN QUERY SELECT NULL::jsonb, 'unmirrorable: the total is not the subtotal plus VAT'::text, d.je; RETURN; END IF;
  IF octet_length(v_payload::text) > 262144 THEN RETURN QUERY SELECT NULL::jsonb, 'unmirrorable: the document is too large to send'::text, d.je; RETURN; END IF;
  RETURN QUERY SELECT v_payload, NULL::text, d.je;
END;
$$;
REVOKE ALL ON FUNCTION public.intercompany_build_payload(text, uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.intercompany_build_payload(text, uuid, uuid) TO migration_admin;

-- The ONE way a document message is written (the messages guard refuses the sender's own INSERT of one). For the session company, a signed-in
-- user with a write role, and an APPROVED customer invoice / customer credit note of that company whose customer is the partner on an ACTIVE
-- connection with a cut-over on or before its date: the database builds the payload (above), the group row of a GROUP pair (the sender's
-- side of the elimination feed: one 'sale' row, a credit note negative, ZAR only) and the message, and returns (message id, NULL, NULL), or
-- (NULL, reason, detail): 'no_connection' (the common answer: one indexed query), 'no_cutover', 'before_cutover', 'forbidden',
-- 'already_sent', 'not_found', 'not_approved', 'unmirrorable' (detail: why). Nothing the caller passes is in the message but the two names.
CREATE OR REPLACE FUNCTION public.intercompany_send_for_source(p_doc_type text, p_doc_id uuid)
RETURNS TABLE (message_id uuid, reason text, detail text)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_co uuid := app.current_company_id();
  v_kind text := CASE p_doc_type WHEN 'customer_invoice' THEN 'invoice' WHEN 'credit_note' THEN 'credit_note' END;
  r RECORD;
  b RECORD;
  v_group uuid;
  v_gtx uuid;
  v_msg uuid;
  v_payload jsonb;
BEGIN
  IF v_kind IS NULL OR v_co IS NULL THEN RETURN QUERY SELECT NULL::uuid, 'not_found'::text, NULL::text; RETURN; END IF;
  IF v_kind = 'invoice' THEN
    SELECT c.id AS connection_id, c.kind AS connection_kind, c.cutover_date AS cutover, d.invoice_date AS dt,
           CASE WHEN c.company_low_id = v_co THEN c.company_high_id ELSE c.company_low_id END AS partner
      INTO r FROM public.customer_invoices d
      JOIN public.intercompany_connection_sides s ON s.company_id = d.company_id AND s.customer_id = COALESCE(d.client_id, d.customer_id)
      JOIN public.intercompany_connections c ON c.id = s.connection_id AND c.status = 'active'
     WHERE d.id = p_doc_id AND d.company_id = v_co AND d.deleted_at IS NULL LIMIT 1;
  ELSE
    SELECT c.id AS connection_id, c.kind AS connection_kind, c.cutover_date AS cutover, d.credit_date AS dt,
           CASE WHEN c.company_low_id = v_co THEN c.company_high_id ELSE c.company_low_id END AS partner
      INTO r FROM public.credit_notes d
      JOIN public.intercompany_connection_sides s ON s.company_id = d.company_id AND s.customer_id = d.client_id
      JOIN public.intercompany_connections c ON c.id = s.connection_id AND c.status = 'active'
     WHERE d.id = p_doc_id AND d.company_id = v_co AND d.type = 'customer' LIMIT 1;
  END IF;
  IF NOT FOUND THEN RETURN QUERY SELECT NULL::uuid, 'no_connection'::text, NULL::text; RETURN; END IF;
  IF r.cutover IS NULL THEN RETURN QUERY SELECT NULL::uuid, 'no_cutover'::text, NULL::text; RETURN; END IF;
  IF r.dt < r.cutover THEN RETURN QUERY SELECT NULL::uuid, 'before_cutover'::text, NULL::text; RETURN; END IF;
  IF NOT public.intercompany_user_can_write(v_co) THEN
    RETURN QUERY SELECT NULL::uuid, 'forbidden'::text, NULL::text; RETURN;
  END IF;
  IF EXISTS (SELECT 1 FROM public.intercompany_messages m
              WHERE m.from_company_id = v_co AND m.source_doc_type = p_doc_type AND m.source_doc_id = p_doc_id AND m.kind = v_kind) THEN
    RETURN QUERY SELECT NULL::uuid, 'already_sent'::text, NULL::text; RETURN;
  END IF;
  SELECT * INTO b FROM public.intercompany_build_payload(v_kind, p_doc_id, v_co);
  IF b.problem IS NOT NULL THEN
    RETURN QUERY SELECT NULL::uuid, split_part(b.problem, ':', 1),
                        CASE WHEN strpos(b.problem, ':') > 0 THEN btrim(substr(b.problem, strpos(b.problem, ':') + 1)) END;
    RETURN;
  END IF;
  v_payload := b.payload;

  IF r.connection_kind = 'group' AND v_payload->>'currency' = 'ZAR' THEN
    SELECT g.id INTO v_group
      FROM public.company_group_members me
      JOIN public.company_groups g ON g.id = me.group_id AND g.is_active IS NOT FALSE
     WHERE me.company_id = v_co AND me.left_date IS NULL AND public.rls_intercompany_parties_ok(g.id, v_co, r.partner, NULL, NULL)
     ORDER BY g.created_at, g.id LIMIT 1;
    IF v_group IS NOT NULL THEN
      -- The elimination feed is secondary: a row that cannot be written leaves the message without a reference (and the sender's log has the warning).
      BEGIN
        INSERT INTO public.intercompany_transactions (group_id, source_company_id, target_company_id, source_journal_entry_id,
                                                     transaction_type, amount, currency, description, transaction_date)
        VALUES (v_group, v_co, r.partner, (SELECT je.id FROM public.gl_journal_entries je WHERE je.id = b.journal_entry_id AND je.company_id = v_co),
                'sale', CASE WHEN v_kind = 'credit_note' THEN -(v_payload->>'subtotal')::numeric ELSE (v_payload->>'subtotal')::numeric END, 'ZAR',
                CASE WHEN v_kind = 'invoice' THEN 'Invoice ' ELSE 'Credit note ' END || (v_payload->>'number') || ' (mirrored)', (v_payload->>'date')::date)
        RETURNING id INTO v_gtx;
      EXCEPTION WHEN OTHERS THEN
        RAISE WARNING 'intercompany group row not written (SQLSTATE %)', SQLSTATE;
        v_gtx := NULL;
      END;
    END IF;
  END IF;
  v_payload := v_payload || jsonb_build_object('groupTransactionId', v_gtx);

  INSERT INTO public.intercompany_messages (connection_id, from_company_id, to_company_id, kind, source_doc_type, source_doc_id, payload, source_journal_entry_id)
  VALUES (r.connection_id, v_co, r.partner, v_kind, p_doc_type, p_doc_id, v_payload, b.journal_entry_id)
  ON CONFLICT (from_company_id, source_doc_type, source_doc_id, kind) DO NOTHING
  RETURNING id INTO v_msg;
  IF v_msg IS NULL THEN
    IF v_gtx IS NOT NULL THEN DELETE FROM public.intercompany_transactions WHERE id = v_gtx AND source_company_id = v_co; END IF;
    RETURN QUERY SELECT NULL::uuid, 'already_sent'::text, NULL::text; RETURN;
  END IF;
  RETURN QUERY SELECT v_msg, NULL::text, NULL::text;
END;
$$;
ALTER FUNCTION public.intercompany_send_for_source(text, uuid) OWNER TO migration_admin;
REVOKE ALL ON FUNCTION public.intercompany_send_for_source(text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.intercompany_send_for_source(text, uuid) TO app_user;

-- Whether the sender's source document is no longer what its message carries (its books changed after the send: edited lines, a changed
-- number, a re-dated invoice). For the receiver of the message only: the same builder, compared with the payload but for the group reference.
-- NULL when the caller is not the receiver. A source that is no longer approved reads as changed (the inbox shows a cancelled one on its own).
CREATE OR REPLACE FUNCTION public.intercompany_message_source_changed(p_message uuid)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_co uuid := app.current_company_id();
  m RECORD;
  b RECORD;
BEGIN
  IF v_co IS NULL OR auth.uid() IS NULL OR NOT (v_co IN (SELECT auth.user_companies())) THEN RETURN NULL; END IF;
  SELECT x.kind, x.from_company_id, x.source_doc_id, x.payload INTO m FROM public.intercompany_messages x
   WHERE x.id = p_message AND x.to_company_id = v_co AND x.kind IN ('invoice', 'credit_note');
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT * INTO b FROM public.intercompany_build_payload(m.kind, m.source_doc_id, m.from_company_id);
  RETURN b.payload IS NULL OR (b.payload - 'groupTransactionId') IS DISTINCT FROM (m.payload - 'groupTransactionId');
END;
$$;
ALTER FUNCTION public.intercompany_message_source_changed(uuid) OWNER TO migration_admin;
REVOKE ALL ON FUNCTION public.intercompany_message_source_changed(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.intercompany_message_source_changed(uuid) TO app_user, app_service;

-- ── 3. Messages guard (the 1002 body, plus the three changes above) ─────────

CREATE OR REPLACE FUNCTION public.intercompany_messages_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  conn intercompany_connections%ROWTYPE;
  v_system text := CASE WHEN current_user = 'migration_admin' THEN pg_catalog.current_setting('app.intercompany_system_update', true) END;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT * INTO conn FROM intercompany_connections WHERE id = NEW.connection_id FOR SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'no such connection' USING ERRCODE = '23503';
    END IF;
    IF conn.status <> 'active' THEN
      RAISE EXCEPTION 'a message is sent only on an active connection' USING ERRCODE = '23514';
    END IF;
    IF NOT ((NEW.from_company_id = conn.company_low_id AND NEW.to_company_id = conn.company_high_id)
         OR (NEW.from_company_id = conn.company_high_id AND NEW.to_company_id = conn.company_low_id)) THEN
      RAISE EXCEPTION 'a message goes between the connection''s two companies' USING ERRCODE = '23514';
    END IF;
    IF conn.kind = 'group' AND NOT public.intercompany_in_one_group(conn.company_low_id, conn.company_high_id) THEN
      RAISE EXCEPTION 'a group message needs both companies to be current members of one group' USING ERRCODE = '23514';
    END IF;
    -- A document message is written by intercompany_send_for_source (migration_admin), which builds its payload from the sender's books.
    -- The sender writing one itself is how a payload carries what the sender's books do not (VAT, a due date, a note, a group reference).
    IF NEW.kind IN ('invoice', 'credit_note') AND current_user IN ('app_user', 'app_service') THEN
      RAISE EXCEPTION 'a document message is written by the database from the sender''s document, not by the sender' USING ERRCODE = '42501';
    END IF;
    IF NOT public.intercompany_user_can_write(NEW.from_company_id) THEN
      RAISE EXCEPTION 'a message is sent by a user with a write role in the sending company' USING ERRCODE = '42501';
    END IF;
    -- A message that carries a document names one of the SENDER's (the session company), of the type its kind needs: nobody
    -- can send, and the receiver then mirror-link, another company's invoice.
    IF NEW.kind IN ('invoice', 'credit_note', 'interest_invoice')
       AND NOT public.intercompany_message_doc_exists(NEW.kind, 'source', NEW.source_doc_type, NEW.source_doc_id, NEW.from_company_id) THEN
      RAISE EXCEPTION 'a document message names a source document of the sending company that fits its kind' USING ERRCODE = '23514';
    END IF;
    NEW.status := 'pending';
    NEW.target_doc_type := NULL;
    NEW.target_doc_id := NULL;
    NEW.reason := NULL;
    NEW.error := NULL;
    NEW.handled_by := NULL;
    NEW.handled_at := NULL;
    NEW.handled_via := NULL;
    NEW.manual_only := false;
    NEW.source_cancelled_at := NULL;
    NEW.auto_attempts := 0;
    NEW.auto_next_attempt_at := NULL;
    NEW.created_at := clock_timestamp();
    NEW.updated_at := clock_timestamp();
    RETURN NEW;
  END IF;

  -- The system paths (migration_admin inside a registered definer, with the transaction-local flag; the flag alone proves nothing
  -- because any session can set it): the sender's cancellation of a document (a message not yet handled is WITHDRAWN, a message
  -- the receiver already accepted is only stamped), and the auto-accept queue's claim (attempt counters). Nothing else changes.
  IF v_system IS NOT NULL AND v_system <> '' THEN
    IF NEW.id IS DISTINCT FROM OLD.id OR NEW.connection_id IS DISTINCT FROM OLD.connection_id
       OR NEW.from_company_id IS DISTINCT FROM OLD.from_company_id OR NEW.to_company_id IS DISTINCT FROM OLD.to_company_id
       OR NEW.kind IS DISTINCT FROM OLD.kind OR NEW.source_doc_type IS DISTINCT FROM OLD.source_doc_type
       OR NEW.source_doc_id IS DISTINCT FROM OLD.source_doc_id OR NEW.payload IS DISTINCT FROM OLD.payload
       OR NEW.created_at IS DISTINCT FROM OLD.created_at OR NEW.target_doc_type IS DISTINCT FROM OLD.target_doc_type
       OR NEW.target_doc_id IS DISTINCT FROM OLD.target_doc_id OR NEW.reason IS DISTINCT FROM OLD.reason
       OR NEW.error IS DISTINCT FROM OLD.error OR NEW.handled_by IS DISTINCT FROM OLD.handled_by
       OR NEW.handled_at IS DISTINCT FROM OLD.handled_at OR NEW.handled_via IS DISTINCT FROM OLD.handled_via
       OR NEW.manual_only IS DISTINCT FROM OLD.manual_only OR NEW.source_journal_entry_id IS DISTINCT FROM OLD.source_journal_entry_id THEN
      RAISE EXCEPTION 'a system update of a message changes only its withdrawal and its attempt counters' USING ERRCODE = '23514';
    END IF;
    IF v_system = 'withdraw' THEN
      IF NOT (OLD.source_cancelled_at IS NULL AND NEW.source_cancelled_at IS NOT NULL
              AND ((OLD.status IN ('pending', 'failed', 'dismissed') AND NEW.status = 'withdrawn')
                   OR (OLD.status = 'accepted' AND NEW.status = 'accepted'))
              AND NEW.auto_attempts IS NOT DISTINCT FROM OLD.auto_attempts
              AND NEW.auto_next_attempt_at IS NOT DISTINCT FROM OLD.auto_next_attempt_at) THEN
        RAISE EXCEPTION 'a withdrawal withdraws a message not yet handled, or stamps an accepted one' USING ERRCODE = '23514';
      END IF;
    ELSIF v_system = 'claim' THEN
      IF NEW.status IS DISTINCT FROM OLD.status OR NEW.source_cancelled_at IS DISTINCT FROM OLD.source_cancelled_at THEN
        RAISE EXCEPTION 'a claim changes only the attempt counters' USING ERRCODE = '23514';
      END IF;
    ELSE
      RAISE EXCEPTION 'unknown system update' USING ERRCODE = '23514';
    END IF;
    NEW.updated_at := clock_timestamp();
    RETURN NEW;
  END IF;

  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.connection_id IS DISTINCT FROM OLD.connection_id
     OR NEW.from_company_id IS DISTINCT FROM OLD.from_company_id OR NEW.to_company_id IS DISTINCT FROM OLD.to_company_id
     OR NEW.kind IS DISTINCT FROM OLD.kind OR NEW.source_doc_type IS DISTINCT FROM OLD.source_doc_type
     OR NEW.source_doc_id IS DISTINCT FROM OLD.source_doc_id OR NEW.payload IS DISTINCT FROM OLD.payload
     OR NEW.source_journal_entry_id IS DISTINCT FROM OLD.source_journal_entry_id OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'a message changes only its handling' USING ERRCODE = '23514';
  END IF;
  IF OLD.status IN ('accepted', 'rejected', 'withdrawn') THEN
    RAISE EXCEPTION 'a handled message is final' USING ERRCODE = '23514';
  END IF;
  IF NEW.status = 'withdrawn' OR NEW.source_cancelled_at IS DISTINCT FROM OLD.source_cancelled_at
     OR NEW.manual_only IS DISTINCT FROM OLD.manual_only OR NEW.auto_attempts IS DISTINCT FROM OLD.auto_attempts
     OR NEW.auto_next_attempt_at IS DISTINCT FROM OLD.auto_next_attempt_at THEN
    RAISE EXCEPTION 'a message is withdrawn only by the sender cancelling its document' USING ERRCODE = '23514';
  END IF;
  IF OLD.status = 'dismissed' AND NEW.status <> 'pending' AND NEW.status <> 'dismissed' THEN
    RAISE EXCEPTION 'a dismissed message can only be restored' USING ERRCODE = '23514';
  END IF;
  -- Accepting, rejecting and restoring act on a live relationship; a dismissal does not need one.
  -- (FOR SHARE: a revocation that comes at the same moment waits for this transaction, instead of revoking under it.)
  IF (NEW.status IN ('accepted', 'rejected') OR (OLD.status = 'dismissed' AND NEW.status = 'pending'))
     AND NOT EXISTS (SELECT 1 FROM intercompany_connections WHERE id = OLD.connection_id AND status = 'active' FOR SHARE) THEN
    RAISE EXCEPTION 'a message is accepted, rejected or restored only on an active connection' USING ERRCODE = '23514';
  END IF;
  IF NOT public.intercompany_user_can_write(OLD.to_company_id) THEN
    RAISE EXCEPTION 'a message is handled by a user with a write role in the receiving company' USING ERRCODE = '42501';
  END IF;
  -- A message that creates a document is accepted with that document: it exists in the receiver's company and is of the type
  -- its kind needs. Any target a handler sets (accepting or not) is held to the same rule. (The check is false for a NULL type
  -- or id, so a missing target is refused too.) A kind that creates no document carries no target: whatever was sent is cleared.
  IF NEW.kind IN ('invoice', 'credit_note', 'interest_invoice') THEN
    IF (NEW.status = 'accepted' OR NEW.target_doc_type IS DISTINCT FROM OLD.target_doc_type OR NEW.target_doc_id IS DISTINCT FROM OLD.target_doc_id)
       AND NOT public.intercompany_message_doc_exists(NEW.kind, 'target', NEW.target_doc_type, NEW.target_doc_id, OLD.to_company_id) THEN
      RAISE EXCEPTION 'a message targets a document of the receiving company that fits its kind, and an accepted one names it' USING ERRCODE = '23514';
    END IF;
    IF NEW.status = 'accepted' AND EXISTS (
         SELECT 1 FROM intercompany_messages m
          WHERE m.to_company_id = OLD.to_company_id AND m.id <> OLD.id AND m.status = 'accepted'
            AND m.target_doc_type = NEW.target_doc_type AND m.target_doc_id = NEW.target_doc_id) THEN
      RAISE EXCEPTION 'a document is the target of one accepted message per receiving company' USING ERRCODE = '23514';
    END IF;
  ELSE
    NEW.target_doc_type := NULL;
    NEW.target_doc_id := NULL;
  END IF;
  NEW.updated_at := clock_timestamp();
  -- A message a person put back (restored from a dismissal, or a failed one retried) is that person's to handle: the worker
  -- never takes it again.
  IF NEW.status = 'pending' AND OLD.status <> 'pending' THEN
    NEW.manual_only := true;
  END IF;
  IF NEW.status = 'pending' THEN
    NEW.handled_by := NULL;
    NEW.handled_at := NULL;
    NEW.handled_via := NULL;
  ELSE
    NEW.handled_by := auth.uid();
    NEW.handled_at := clock_timestamp();
    -- 'auto' only for a receiver whose side has auto-accept on an active group connection; anything else is a person's act.
    NEW.handled_via := CASE WHEN pg_catalog.current_setting('app.intercompany_handled_via', true) = 'auto'
        AND EXISTS (SELECT 1 FROM intercompany_connection_sides s JOIN intercompany_connections c ON c.id = s.connection_id
                     WHERE s.connection_id = OLD.connection_id AND s.company_id = OLD.to_company_id AND s.auto_accept
                       AND c.kind = 'group' AND c.status = 'active')
      THEN 'auto' ELSE 'user' END;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_intercompany_messages_guard ON intercompany_messages;
CREATE TRIGGER trg_intercompany_messages_guard BEFORE INSERT OR UPDATE ON intercompany_messages
  FOR EACH ROW EXECUTE FUNCTION public.intercompany_messages_guard();
ALTER TABLE intercompany_messages ENABLE ALWAYS TRIGGER trg_intercompany_messages_guard;
REVOKE ALL ON FUNCTION public.intercompany_messages_guard() FROM PUBLIC;

-- ── 4. The sender's cancellation reaches its message and its group row ──────

-- Puts a group row back to what a document that is not (or no longer) eliminable is: unmatched, nothing matched, no target journal, and the
-- elimination (draft or posted) that was generated from it reversed, because it no longer stands. Only a row that is not already unmatched,
-- or whose eliminations still stand, changes. SECURITY INVOKER, executable by migration_admin only: it is called from the two definers below.
CREATE OR REPLACE FUNCTION public.intercompany_release_group_row(p_row uuid)
RETURNS void
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  UPDATE public.intercompany_transactions
     SET match_status = 'unmatched', variance_amount = 0, variance_reason = NULL, matched_at = NULL, matched_by = NULL, target_journal_entry_id = NULL
   WHERE id = p_row AND (match_status <> 'unmatched' OR variance_amount <> 0 OR variance_reason IS NOT NULL OR matched_at IS NOT NULL
                         OR matched_by IS NOT NULL OR target_journal_entry_id IS NOT NULL);
  UPDATE public.consolidation_adjustments SET status = 'reversed', updated_at = clock_timestamp()
   WHERE source_intercompany_id = p_row AND status IN ('draft', 'posted');
END;
$$;
REVOKE ALL ON FUNCTION public.intercompany_release_group_row(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.intercompany_release_group_row(uuid) TO migration_admin;

-- Called after a customer invoice / customer credit note is cancelled. Acts only for the session company and a signed-in user of it with a
-- write role, and only when the document is cancelled in that company's books AND the ledger agrees: a message sent with a journal is
-- withdrawn only when that journal's reversal chain is out (the cancel really reversed it; the status column alone proves nothing, any writer
-- can flip it and flip it back). A message not yet handled is WITHDRAWN, an accepted one is only stamped (the receiver's data is never
-- touched), and the group row behind either goes back to unmatched with its eliminations reversed, so cancelled revenue is not eliminated.
CREATE OR REPLACE FUNCTION public.intercompany_withdraw_for_source(p_source_type text, p_source_id uuid)
RETURNS integer
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_co uuid := app.current_company_id();
  m RECORD;
  n integer := 0;
BEGIN
  IF v_co IS NULL OR NOT public.intercompany_user_can_write(v_co) THEN RETURN 0; END IF;
  IF p_source_type = 'customer_invoice' THEN
    IF NOT EXISTS (SELECT 1 FROM public.customer_invoices WHERE id = p_source_id AND company_id = v_co AND status = 'cancelled') THEN RETURN 0; END IF;
  ELSIF p_source_type = 'credit_note' THEN
    IF NOT EXISTS (SELECT 1 FROM public.credit_notes WHERE id = p_source_id AND company_id = v_co AND type = 'customer' AND status = 'cancelled') THEN RETURN 0; END IF;
  ELSE
    RETURN 0;
  END IF;
  FOR m IN SELECT x.id, x.status, x.source_journal_entry_id AS je, (x.payload->>'groupTransactionId')::uuid AS gtx
             FROM public.intercompany_messages x
            WHERE x.from_company_id = v_co AND x.source_doc_type = p_source_type AND x.source_doc_id = p_source_id
              AND x.kind IN ('invoice', 'credit_note') AND x.source_cancelled_at IS NULL AND x.status IN ('pending', 'failed', 'dismissed', 'accepted')
            FOR UPDATE
  LOOP
    -- The ledger's word: the journal the message was sent with has been reversed (an even, non-zero chain of posted journals).
    IF m.je IS NOT NULL AND (public.intercompany_journal_chain_length(m.je, v_co) = 0 OR public.intercompany_journal_chain_length(m.je, v_co) % 2 <> 0) THEN
      CONTINUE;
    END IF;
    PERFORM pg_catalog.set_config('app.intercompany_system_update', 'withdraw', true);
    UPDATE public.intercompany_messages
       SET status = CASE WHEN m.status IN ('pending', 'failed', 'dismissed') THEN 'withdrawn' ELSE m.status END, source_cancelled_at = clock_timestamp()
     WHERE id = m.id;
    PERFORM pg_catalog.set_config('app.intercompany_system_update', '', true);
    IF m.gtx IS NOT NULL AND EXISTS (SELECT 1 FROM public.intercompany_transactions it WHERE it.id = m.gtx AND it.source_company_id = v_co) THEN
      PERFORM public.intercompany_release_group_row(m.gtx);
    END IF;
    n := n + 1;
  END LOOP;
  RETURN n;
END;
$$;
ALTER FUNCTION public.intercompany_withdraw_for_source(text, uuid) OWNER TO migration_admin;
REVOKE ALL ON FUNCTION public.intercompany_withdraw_for_source(text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.intercompany_withdraw_for_source(text, uuid) TO app_user, app_service;

-- ── 5. The sender's elimination row follows the receiver's APPROVED document ─

-- A recorded transaction keeps everything but its matching; the target journal is the one thing that is set later (to a journal of
-- the target company, when the receiver approves) or cleared (when its document is cancelled or deleted and the row goes unmatched),
-- and only by intercompany_sync_group_row (migration_admin): a writer of a party updating the row directly still cannot (999r).
CREATE OR REPLACE FUNCTION public.intercompany_transaction_parties_immutable()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF NEW.group_id IS DISTINCT FROM OLD.group_id
     OR NEW.source_company_id IS DISTINCT FROM OLD.source_company_id OR NEW.target_company_id IS DISTINCT FROM OLD.target_company_id
     OR NEW.source_journal_entry_id IS DISTINCT FROM OLD.source_journal_entry_id
     OR NEW.amount IS DISTINCT FROM OLD.amount OR NEW.currency IS DISTINCT FROM OLD.currency
     OR NEW.transaction_type IS DISTINCT FROM OLD.transaction_type OR NEW.transaction_date IS DISTINCT FROM OLD.transaction_date
     OR NEW.description IS DISTINCT FROM OLD.description OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'intercompany_transactions: a recorded transaction keeps its group, parties, journals, amount, currency, type, date, description and creation time; matching changes only its status'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.target_journal_entry_id IS DISTINCT FROM OLD.target_journal_entry_id THEN
    -- Only the registered definer below (migration_admin) sets or clears it; a writer of a party updating the row directly cannot.
    IF current_user <> 'migration_admin' THEN
      RAISE EXCEPTION 'intercompany_transactions: a recorded transaction keeps its group, parties, journals, amount, currency, type, date, description and creation time; matching changes only its status'
        USING ERRCODE = '23514';
    END IF;
    IF NEW.target_journal_entry_id IS NOT NULL AND (OLD.target_journal_entry_id IS NOT NULL OR NOT EXISTS (
         SELECT 1 FROM public.gl_journal_entries je WHERE je.id = NEW.target_journal_entry_id AND je.company_id = NEW.target_company_id)) THEN
      RAISE EXCEPTION 'intercompany_transactions: the target journal is set once, to a journal of the target company' USING ERRCODE = '23514';
    END IF;
    IF NEW.target_journal_entry_id IS NULL AND NEW.match_status IS DISTINCT FROM 'unmatched' THEN
      RAISE EXCEPTION 'intercompany_transactions: the target journal is cleared only with an unmatch' USING ERRCODE = '23514';
    END IF;
  END IF;
  -- variance_reason is the definer's account of why a row is not matched: no request's caller writes it.
  IF NEW.variance_reason IS DISTINCT FROM OLD.variance_reason AND current_user <> 'migration_admin' THEN
    RAISE EXCEPTION 'intercompany_transactions: the variance reason is written by the database, not by a request' USING ERRCODE = '23514';
  END IF;
  -- matched_by, when it changes, is whoever matched it (a request's caller cannot sign another user's name) and is
  -- cleared only by an unmatch: together with match_status back to 'unmatched'.
  IF NEW.matched_by IS DISTINCT FROM OLD.matched_by AND current_user = 'app_user'
     AND ((NEW.matched_by IS NULL AND NEW.match_status IS DISTINCT FROM 'unmatched')
          OR (NEW.matched_by IS NOT NULL AND (auth.uid() IS NULL OR NEW.matched_by::pg_catalog.text <> auth.uid()))) THEN
    RAISE EXCEPTION 'intercompany_transactions: matched_by is the user who matched it, and is cleared only by an unmatch' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;


-- Called after the receiver's bill / supplier credit note is approved, cancelled or deleted. For the session company only, a signed-in user of
-- it with a write role, and only for a document that is the target of an accepted message to that company with a group row. It sets the row
-- from what the receiver's LEDGER says, not from the columns of the bill (any writer can set those):
--   unmatched : the document is not approved (cancelled, deleted, no journal), or the SENDER's document is cancelled (its message was withdrawn
--               or stamped; the row must not eliminate revenue that was cancelled);
--   matched   : the bill's journal is POSTED, still stands, is the receiver's own, is the bill's (its source and description), is in the
--               receiver's fiscal period of the sender's date, is not the target of another row, the supplier is the connection's own, and the
--               journal's expense lines (it has no other kind but payable and input VAT) net to the sender's amount;
--   variance  : any of those fails, with variance_reason saying which.
-- Anything but matched also reverses the eliminations generated from the row. Returns the row's status, or NULL when there is nothing to do.
CREATE OR REPLACE FUNCTION public.intercompany_sync_group_row(p_doc_type text, p_doc_id uuid)
RETURNS text
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_co uuid := app.current_company_id();
  m RECORD;
  d RECORD;
  t RECORD;
  j RECORD;
  v_src_status text;
  v_period RECORD;
  v_expense numeric := 0;
  v_other bigint := 0;
  v_status text;
  v_reason text;
  v_variance numeric := 0;
  v_side_supplier uuid;
  v_target uuid;
BEGIN
  IF v_co IS NULL OR NOT public.intercompany_user_can_write(v_co) THEN RETURN NULL; END IF;
  SELECT x.connection_id, x.from_company_id, x.source_doc_type, x.source_doc_id, x.source_cancelled_at, (x.payload->>'groupTransactionId')::uuid AS gtx INTO m
    FROM public.intercompany_messages x
   WHERE x.to_company_id = v_co AND x.status = 'accepted' AND x.target_doc_type = p_doc_type AND x.target_doc_id = p_doc_id
     AND x.kind IN ('invoice', 'credit_note') AND x.payload->>'groupTransactionId' IS NOT NULL
   LIMIT 1;
  IF NOT FOUND THEN RETURN NULL; END IF;
  IF p_doc_type = 'supplier_invoice' THEN
    SELECT si.invoice_number AS num, si.supplier_id AS supplier, si.gl_journal_entry_id AS je, 'auto_supplier_invoice' AS src, 'Supplier invoice ' || si.invoice_number AS descr,
           (si.deleted_at IS NULL AND si.status IN ('approved', 'partially_paid', 'paid')) AS ok INTO d
      FROM public.supplier_invoices si WHERE si.id = p_doc_id AND si.company_id = v_co;
  ELSIF p_doc_type = 'credit_note' THEN
    SELECT cn.credit_note_number AS num, cn.supplier_id AS supplier, cn.gl_journal_entry_id AS je, 'auto_credit_note' AS src, 'Credit note ' || cn.credit_note_number AS descr,
           (cn.status IN ('approved', 'partially_applied', 'applied')) AS ok INTO d
      FROM public.credit_notes cn WHERE cn.id = p_doc_id AND cn.company_id = v_co AND cn.type = 'supplier';
  ELSE
    RETURN NULL;
  END IF;
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT it.amount, it.transaction_date, it.match_status, it.target_journal_entry_id INTO t FROM public.intercompany_transactions it
   WHERE it.id = m.gtx AND it.target_company_id = v_co AND it.source_company_id = m.from_company_id
   FOR UPDATE;
  IF NOT FOUND THEN RETURN NULL; END IF;

  v_src_status := CASE m.source_doc_type
    WHEN 'customer_invoice' THEN (SELECT ci.status FROM public.customer_invoices ci WHERE ci.id = m.source_doc_id AND ci.company_id = m.from_company_id)
    WHEN 'credit_note' THEN (SELECT cn.status FROM public.credit_notes cn WHERE cn.id = m.source_doc_id AND cn.company_id = m.from_company_id) END;

  IF NOT (COALESCE(d.ok, false) AND d.je IS NOT NULL) THEN
    v_status := 'unmatched';
  ELSIF m.source_cancelled_at IS NOT NULL OR v_src_status IS NULL OR v_src_status = 'cancelled' THEN
    v_status := 'unmatched';
  ELSE
    SELECT je.company_id, je.status, je.source, je.description, je.entry_date INTO j FROM public.gl_journal_entries je WHERE je.id = d.je;
    SELECT s.supplier_id INTO v_side_supplier FROM public.intercompany_connection_sides s WHERE s.connection_id = m.connection_id AND s.company_id = v_co;
    SELECT fp.start_date, fp.end_date INTO v_period FROM public.fiscal_periods fp
     WHERE fp.company_id = v_co AND t.transaction_date BETWEEN fp.start_date AND fp.end_date ORDER BY fp.start_date DESC LIMIT 1;
    IF j.company_id IS DISTINCT FROM v_co OR j.status IS DISTINCT FROM 'posted' THEN
      v_reason := 'the bill''s journal is not a posted journal of this company';
    ELSIF j.source IS DISTINCT FROM d.src OR j.description IS DISTINCT FROM d.descr THEN
      v_reason := 'the journal is not the one that posting this document wrote';
    ELSIF public.intercompany_journal_chain_length(d.je, v_co) % 2 = 0 THEN
      v_reason := 'the bill''s journal has been reversed';
    ELSIF EXISTS (SELECT 1 FROM public.intercompany_transactions o WHERE o.target_journal_entry_id = d.je AND o.id <> m.gtx) THEN
      v_reason := 'the journal is already matched to another transaction';
    ELSIF v_side_supplier IS NULL OR d.supplier IS DISTINCT FROM v_side_supplier THEN
      v_reason := 'the supplier is not the one this connection is with';
    ELSIF v_period.start_date IS NULL OR j.entry_date NOT BETWEEN v_period.start_date AND v_period.end_date THEN
      v_reason := 'the journal is not in the fiscal period of the sender''s date';
    END IF;
    IF v_reason IS NULL THEN
      SELECT COALESCE(sum(jl.debit - jl.credit) FILTER (WHERE ga.account_type = 'expense'), 0),
             count(*) FILTER (WHERE ga.account_type <> 'expense' AND COALESCE(ga.account_subtype, '') NOT IN ('payable', 'vat_input', 'vat_input_late_claim'))
        INTO v_expense, v_other
        FROM public.gl_journal_lines jl JOIN public.gl_accounts ga ON ga.id = jl.gl_account_id WHERE jl.journal_entry_id = d.je;
      v_variance := abs(t.amount - v_expense);
      IF v_other > 0 THEN
        v_reason := 'the journal has lines that are not expense, payable or input VAT';
      ELSIF v_variance <> 0 THEN
        v_reason := 'the expense in the journal is not the sender''s amount';
      END IF;
    END IF;
    v_status := CASE WHEN v_reason IS NULL THEN 'matched' ELSE 'variance' END;
  END IF;

  IF v_status = 'unmatched' THEN
    PERFORM public.intercompany_release_group_row(m.gtx);
    RETURN v_status;
  END IF;
  v_target := CASE WHEN j.company_id = v_co THEN d.je END;
  IF t.target_journal_entry_id IS NOT NULL AND t.target_journal_entry_id IS DISTINCT FROM v_target THEN
    UPDATE public.intercompany_transactions SET match_status = 'unmatched', variance_amount = 0, variance_reason = NULL, matched_at = NULL, matched_by = NULL,
           target_journal_entry_id = NULL WHERE id = m.gtx;
  END IF;
  UPDATE public.intercompany_transactions
     SET match_status = v_status, variance_amount = v_variance, variance_reason = v_reason, matched_at = clock_timestamp(), matched_by = auth.uid()::uuid,
         target_journal_entry_id = COALESCE(target_journal_entry_id, v_target)
   WHERE id = m.gtx;
  IF v_status <> 'matched' THEN
    UPDATE public.consolidation_adjustments SET status = 'reversed', updated_at = clock_timestamp() WHERE source_intercompany_id = m.gtx AND status IN ('draft', 'posted');
  END IF;
  RETURN v_status;
END;
$$;
ALTER FUNCTION public.intercompany_sync_group_row(text, uuid) OWNER TO migration_admin;
REVOKE ALL ON FUNCTION public.intercompany_sync_group_row(text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.intercompany_sync_group_row(text, uuid) TO app_user, app_service;

-- ── 6. The auto-accept queue ────────────────────────────────────────────────

DROP FUNCTION IF EXISTS public.intercompany_auto_accept_queue(integer);
CREATE OR REPLACE FUNCTION public.intercompany_auto_accept_queue(p_limit integer DEFAULT 50, p_claim boolean DEFAULT true)
RETURNS TABLE (message_id uuid, to_company_id uuid, actor_user_id text, attempt integer)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF p_claim THEN PERFORM pg_catalog.set_config('app.intercompany_system_update', 'claim', true); END IF;
  RETURN QUERY
  WITH eligible AS (
    SELECT m.id AS mid, m.to_company_id AS co, w.user_id AS uid, m.auto_attempts AS att, m.created_at AS cat, m.auto_next_attempt_at AS nxt,
           row_number() OVER (PARTITION BY m.to_company_id ORDER BY COALESCE(m.auto_next_attempt_at, m.created_at), m.created_at, m.id) AS rn
      FROM public.intercompany_messages m
      JOIN public.intercompany_connections c
        ON c.id = m.connection_id AND c.status = 'active' AND c.kind = 'group'
      JOIN public.intercompany_connection_sides s
        ON s.connection_id = m.connection_id AND s.company_id = m.to_company_id AND s.auto_accept
       AND s.auto_accept_since IS NOT NULL AND m.created_at >= s.auto_accept_since
      JOIN public.companies rc
        ON rc.id = m.to_company_id
       AND rc.status IS DISTINCT FROM 'suspended' AND rc.status IS DISTINCT FROM 'deleted' AND rc.suspended_at IS NULL
      CROSS JOIN LATERAL (
        SELECT cu.user_id
          FROM public.company_users cu
          JOIN public.users u ON u.id = cu.user_id
         WHERE cu.company_id = m.to_company_id
           AND cu.role = ANY (ARRAY['owner', 'admin', 'manager'])
           AND u.is_active IS TRUE AND u.status = 'active' AND u.suspended_at IS NULL
         ORDER BY CASE cu.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END, cu.created_at, cu.user_id
         LIMIT 1
      ) w
     WHERE m.status = 'pending' AND m.kind IN ('invoice', 'credit_note') AND NOT m.manual_only
       AND m.auto_attempts < 8 AND (m.auto_next_attempt_at IS NULL OR m.auto_next_attempt_at <= clock_timestamp())
       AND public.intercompany_shared_group(c.company_low_id, c.company_high_id)
  ), picked AS (
    SELECT e.* FROM eligible e WHERE e.rn <= 10
     ORDER BY COALESCE(e.nxt, e.cat), e.cat, e.mid
     LIMIT LEAST(GREATEST(COALESCE(p_limit, 50), 1), 200)
  ), claimed AS (
    UPDATE public.intercompany_messages m
       SET auto_attempts = m.auto_attempts + 1,
           auto_next_attempt_at = clock_timestamp() + LEAST(power(2, m.auto_attempts)::integer, 60) * interval '1 minute'
      FROM picked p WHERE p_claim AND m.id = p.mid
    RETURNING m.id AS cid
  )
  SELECT p.mid, p.co, p.uid, p.att + CASE WHEN p_claim THEN 1 ELSE 0 END FROM picked p
   ORDER BY COALESCE(p.nxt, p.cat), p.cat, p.mid;
  IF p_claim THEN PERFORM pg_catalog.set_config('app.intercompany_system_update', '', true); END IF;
END;
$$;
ALTER FUNCTION public.intercompany_auto_accept_queue(integer, boolean) OWNER TO migration_admin;
REVOKE ALL ON FUNCTION public.intercompany_auto_accept_queue(integer, boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.intercompany_auto_accept_queue(integer, boolean) FROM app_user;
GRANT EXECUTE ON FUNCTION public.intercompany_auto_accept_queue(integer, boolean) TO app_service, migration_admin;

-- How many pending messages the queue has given up on (every attempt used, never a restored one): they sit pending for a person, and the
-- worker reports them as stuck. A count only; app_service and migration_admin.
CREATE OR REPLACE FUNCTION public.intercompany_auto_accept_exhausted()
RETURNS integer
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT count(*)::integer FROM public.intercompany_messages m
   WHERE m.status = 'pending' AND m.kind IN ('invoice', 'credit_note') AND NOT m.manual_only AND m.auto_attempts >= 8
$$;
ALTER FUNCTION public.intercompany_auto_accept_exhausted() OWNER TO migration_admin;
REVOKE ALL ON FUNCTION public.intercompany_auto_accept_exhausted() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.intercompany_auto_accept_exhausted() TO app_service, migration_admin;

-- ── 7. The definer registry (930) ───────────────────────────────────────────

DELETE FROM public.app_definer_reviews WHERE signature = 'intercompany_auto_accept_queue(integer)';
INSERT INTO public.app_definer_reviews (signature, writes, body_md5)
SELECT v.signature, v.writes, public.app_definer_hash(v.fn::regprocedure)
  FROM (VALUES
    ('intercompany_auto_accept_queue(integer,boolean)', 'public.intercompany_auto_accept_queue(integer, boolean)',
     'intercompany_messages.auto_attempts and auto_next_attempt_at only (the claim, through the messages guard system path, when p_claim); otherwise a read of intercompany_messages, intercompany_connections, intercompany_connection_sides, companies, company_users, users: the pending invoice / credit-note messages whose receiver side switched auto_accept on before they were created, on an active group connection that still shares a current active group, never a restored one, at most 10 per receiver, with the receiver company and one write-role user in good standing; executable by app_service and migration_admin only'),
    ('intercompany_withdraw_for_source(text,uuid)', 'public.intercompany_withdraw_for_source(text, uuid)',
     'intercompany_messages.status = ''withdrawn'' (a message not yet handled) and source_cancelled_at (also an accepted one), through the messages guard system path, for the messages the session company (a write-role user) sent for a customer invoice / credit note that is cancelled in its books AND whose sent-with journal has been reversed; and the group row behind each (intercompany_transactions back to unmatched, target journal cleared) with consolidation_adjustments.status = ''reversed'' for the eliminations generated from it; nothing for any other company or an uncancelled document'),
    ('intercompany_sync_group_row(text,uuid)', 'public.intercompany_sync_group_row(text, uuid)',
     'intercompany_transactions.match_status, variance_amount, variance_reason, matched_at, matched_by and target_journal_entry_id of the one group row behind an accepted message to the session company (a write-role user) whose target is the given supplier invoice / supplier credit note of that company: matched only on the receiver''s posted, standing, own journal that nets to the sender''s amount, variance with a reason otherwise, unmatched while the document is not approved or the sender''s document is cancelled; and consolidation_adjustments.status = ''reversed'' for the eliminations generated from a row that is not matched'),
    ('intercompany_send_for_source(text,uuid)', 'public.intercompany_send_for_source(text, uuid)',
     'intercompany_messages (one invoice / credit_note message, its payload built from the session company''s approved customer invoice or customer credit note) and intercompany_transactions (the sender''s one ''sale'' group row, for a group connection, ZAR) for the session company (a write-role user) and a document of that company whose customer is the partner on an active connection past its cut-over; nothing for any other company or an unapproved document'),
    ('intercompany_auto_accept_exhausted()', 'public.intercompany_auto_accept_exhausted()',
     'nothing: a count of pending invoice / credit-note messages whose every auto-accept attempt is used; executable by app_service and migration_admin only'),
    ('intercompany_message_source_changed(uuid)', 'public.intercompany_message_source_changed(uuid)',
     'nothing: a read of the sender''s approved document through the payload builder, compared with the stored payload, for the receiver of that message only')
  ) AS v(signature, fn, writes)
ON CONFLICT (signature) DO UPDATE SET writes = EXCLUDED.writes, body_md5 = EXCLUDED.body_md5;

DO $$
BEGIN
  IF pg_catalog.has_function_privilege('public', 'public.intercompany_auto_accept_queue(integer, boolean)', 'EXECUTE')
     OR pg_catalog.has_function_privilege('app_user', 'public.intercompany_auto_accept_queue(integer, boolean)', 'EXECUTE')
     OR pg_catalog.has_function_privilege('public', 'public.intercompany_withdraw_for_source(text, uuid)', 'EXECUTE')
     OR pg_catalog.has_function_privilege('public', 'public.intercompany_sync_group_row(text, uuid)', 'EXECUTE')
     OR pg_catalog.has_function_privilege('public', 'public.intercompany_send_for_source(text, uuid)', 'EXECUTE')
     OR pg_catalog.has_function_privilege('public', 'public.intercompany_message_source_changed(uuid)', 'EXECUTE')
     OR pg_catalog.has_function_privilege('app_user', 'public.intercompany_build_payload(text, uuid, uuid)', 'EXECUTE')
     OR pg_catalog.has_function_privilege('app_service', 'public.intercompany_build_payload(text, uuid, uuid)', 'EXECUTE')
     OR pg_catalog.has_function_privilege('app_user', 'public.intercompany_auto_accept_exhausted()', 'EXECUTE')
     OR pg_catalog.has_function_privilege('public', 'public.intercompany_auto_accept_exhausted()', 'EXECUTE')
     OR pg_catalog.has_function_privilege('app_user', 'public.intercompany_release_group_row(uuid)', 'EXECUTE')
     OR pg_catalog.has_function_privilege('app_user', 'public.intercompany_journal_chain_length(uuid, uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION '1013: a role it must not reach can execute an intercompany P2 definer function';
  END IF;
END $$;
