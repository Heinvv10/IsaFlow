-- 872: R-035 N1 — approval_requests is written ONLY through SECURITY DEFINER
-- functions that re-check, in SQL, the authority the TypeScript checks.
--
-- Before this, app_user held INSERT/UPDATE/DELETE on approval_requests. The
-- insert guard (862) bound listed types to pending rows raised by the session
-- user, but nothing stopped `UPDATE approval_requests SET status='approved'`,
-- an INSERT already approved for a type outside the guard (supplier_invoice),
-- a DELETE, or a rewrite of required_role / rule_id / decided_by — and every
-- gate (712, 862, 865, 867, 869, approvalGate.ts) trusts an approved row.
--
-- The app's writes (census, by table, in the PR): requestApproval's INSERT,
-- rebindPendingRequest's UPDATE, decideRequest's UPDATE, and the decide row
-- lock (SELECT … FOR UPDATE needs UPDATE privilege). Each now calls one of:
--   approval_request_raise   — insert a pending request
--   approval_request_rebind  — re-bind a pending request (upwards only)
--   approval_request_decide  — approve / reject (withdrawal is a self-reject)
--   approval_request_lock    — the decide path's row lock
-- There is no cancel/withdraw write in the app (665 is the only canceller).
--
-- Each function repeats what the TypeScript checks, with the SAME SQL
-- definitions the TypeScript reads (approval_document_digest,
-- approval_document_authors, approval_roster_snapshot,
-- approval_company_other_members, approval_required_rank,
-- approval_rule_strictest_rank, approval_payment_batch_strictest_rank, the
-- gate-amount functions), so a direct call can do no more than the app does.
-- The TypeScript keeps its own checks and messages; a refusal here raises a
-- distinct SQLSTATE the TypeScript maps back onto the same error types:
--   RA001 SELF_APPROVAL_FORBIDDEN   RA002 APPROVER_ROLE_REQUIRED
--   RA003 IMPERSONATION_FORBIDDEN   RA004 DOCUMENT_CHANGED
--   RA005 EXPECTED_DIGEST_REQUIRED  RA006 document not found
--   RA007 no rule requires approval RA009 forged (no TS twin: a 500)
--
-- BOUNDARY (state it, do not oversell it): the actor checks read
-- request.jwt.claims, an ordinary GUC, and the app logs in as a superuser and
-- drops to app_user with SET LOCAL ROLE — raw SQL in such a session can
-- set_config the claims or RESET ROLE. This binds application code paths that
-- did not choose their own claims or role, not an attacker already running
-- SQL. That is N3 (docs/design/r035-n3-caller-set-claims.md).
--
-- The 862 insert guard stays. It is SECURITY INVOKER and skips a role that
-- bypasses RLS, so an INSERT made by approval_request_raise (current_user is
-- the definer's owner) passes through it unchecked; raise does the checking.

-- ── 1. Helpers (not granted to app_user; the definers call them as owner) ──

-- actorRank (gl/approvalAuthority.ts) in SQL: an unrecognised actor role
-- carries no authority. approval_required_rank (862) is requiredRank.
CREATE OR REPLACE FUNCTION public.approval_actor_rank(p_role pg_catalog.text)
RETURNS pg_catalog.int4
LANGUAGE sql IMMUTABLE
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT CASE p_role
    WHEN 'super_admin' THEN 8 WHEN 'owner' THEN 7 WHEN 'system' THEN 6 WHEN 'admin' THEN 5
    WHEN 'manager' THEN 4 WHEN 'accountant' THEN 3 WHEN 'bookkeeper' THEN 2
    WHEN 'storeman' THEN 1 WHEN 'technician' THEN 1 WHEN 'user' THEN 1 WHEN 'viewer' THEN 0
    ELSE 0
  END
$$;

-- Whether the role that CALLED the definer bypasses RLS. Inside a SECURITY
-- DEFINER function current_user is the owner; the caller's SET ROLE survives
-- in the `role` setting ('none' = the session user). The 862 guard exempts
-- such a role (a script, a migration, a test fixture run as the owner), and
-- the definers keep that exemption for the requester binding only.
CREATE OR REPLACE FUNCTION public.approval_request_caller_bypasses()
RETURNS pg_catalog.bool
LANGUAGE sql STABLE
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1 FROM pg_catalog.pg_roles r
    WHERE r.rolname = CASE pg_catalog.current_setting('role')
                        WHEN 'none' THEN session_user::pg_catalog.text
                        ELSE pg_catalog.current_setting('role') END
      AND (r.rolbypassrls OR r.rolsuper))
$$;

-- auth.uid() as a uuid when it is a canonical one (any case), else NULL: a
-- refusal, never a cast error (862's rule).
CREATE OR REPLACE FUNCTION public.approval_request_subject()
RETURNS pg_catalog.uuid
LANGUAGE plpgsql STABLE
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_subject pg_catalog.text := auth.uid();
BEGIN
  IF v_subject ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    RETURN v_subject::pg_catalog.uuid;
  END IF;
  RETURN NULL;
END
$$;

-- currentSessionActor() (src/lib/auth/impersonationSessions.ts) in SQL.
CREATE OR REPLACE FUNCTION public.approval_request_session_actor()
RETURNS pg_catalog.text
LANGUAGE sql STABLE
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT CASE
    WHEN c.session_id IS NULL OR c.session_id = '' THEN 'unknown'
    WHEN EXISTS (SELECT 1 FROM public.impersonation_sessions s WHERE s.session_id = c.session_id) THEN 'impersonation'
    ELSE 'self' END
  FROM (SELECT NULLIF(pg_catalog.current_setting('request.jwt.claims', true), '')::pg_catalog.jsonb
                 ->> 'session_id' AS session_id) c
$$;

-- The request transaction is the caller's own: the JWT subject is the actor
-- named, and the company is the one withAuth set (RLS WITH CHECK on the table
-- demanded the same of a direct write). p_allow_bypass skips both for a caller
-- that bypasses RLS — 862's exemption, kept for raise and rebind only.
CREATE OR REPLACE FUNCTION public.approval_request_assert_caller(
  p_company_id pg_catalog.uuid, p_actor pg_catalog.text, p_allow_bypass pg_catalog.bool
) RETURNS void
LANGUAGE plpgsql STABLE
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF p_allow_bypass AND public.approval_request_caller_bypasses() THEN
    RETURN;
  END IF;
  IF p_actor IS NULL OR public.approval_request_subject() IS NULL
     OR p_actor !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     OR public.approval_request_subject() IS DISTINCT FROM p_actor::pg_catalog.uuid THEN
    RAISE EXCEPTION 'R035_APPROVAL_REQUEST_FORGED: an approval request may only be written by the session''s own user'
      USING ERRCODE = 'RA009';
  END IF;
  IF app.current_company_id() IS DISTINCT FROM p_company_id THEN
    RAISE EXCEPTION 'R035_APPROVAL_REQUEST_FORGED: an approval request may only be written for the request''s own company'
      USING ERRCODE = 'RA009';
  END IF;
END
$$;

-- What tenant_isolation's USING clause lets the caller see: the company is
-- one the JWT subject is a member of. A definer's owner bypasses RLS, so each
-- writer asks this itself and answers as the invisible row would (the subject
-- compared without case, as the 862 guard compares it).
CREATE OR REPLACE FUNCTION public.approval_request_caller_sees(p_company_id pg_catalog.uuid)
RETURNS pg_catalog.bool
LANGUAGE sql STABLE
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT public.approval_request_caller_bypasses() OR EXISTS (
    SELECT 1 FROM public.company_users cu
    WHERE cu.company_id = p_company_id AND pg_catalog.lower(cu.user_id) = pg_catalog.lower(auth.uid()))
$$;

-- findDocument (gl/approvalDocuments.ts) in SQL, statement for statement: the
-- amount a rule is matched on, the reference, the digest. No row: no such
-- document of that type in this company.
CREATE OR REPLACE FUNCTION public.approval_request_document_facts(
  p_company_id pg_catalog.uuid, p_document_type pg_catalog.text, p_document_id pg_catalog.uuid
) RETURNS TABLE (amount pg_catalog.numeric, reference pg_catalog.text, digest pg_catalog.text)
LANGUAGE plpgsql STABLE
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  CASE p_document_type
    WHEN 'customer_invoice' THEN
      RETURN QUERY SELECT public.approval_customer_invoice_gate_amount(d.total_amount, d.functional_total),
             d.invoice_number::pg_catalog.text, public.approval_document_digest(d.company_id, 'customer_invoice', d.id)
      FROM public.customer_invoices d
      WHERE d.id = p_document_id AND d.company_id = p_company_id AND d.deleted_at IS NULL;
    WHEN 'supplier_invoice' THEN
      RETURN QUERY SELECT public.approval_supplier_invoice_gate_amount(d.total_amount, d.functional_total),
             d.invoice_number::pg_catalog.text, public.approval_document_digest(d.company_id, 'supplier_invoice', d.id)
      FROM public.supplier_invoices d
      WHERE d.id = p_document_id AND d.company_id = p_company_id AND d.deleted_at IS NULL;
    WHEN 'credit_note' THEN
      RETURN QUERY SELECT COALESCE(d.total_amount, 0)::pg_catalog.numeric, d.credit_note_number::pg_catalog.text,
             public.approval_document_digest(d.company_id, 'credit_note', d.id)
      FROM public.credit_notes d WHERE d.id = p_document_id AND d.company_id = p_company_id;
    WHEN 'customer_credit_note' THEN
      RETURN QUERY SELECT public.approval_credit_note_gate_amount(d.total_amount, d.subtotal, d.tax_amount),
             d.credit_note_number::pg_catalog.text, public.approval_document_digest(d.company_id, 'customer_credit_note', d.id)
      FROM public.credit_notes d WHERE d.id = p_document_id AND d.company_id = p_company_id AND d.type = 'customer';
    WHEN 'supplier_credit_note' THEN
      RETURN QUERY SELECT public.approval_credit_note_gate_amount(d.total_amount, d.subtotal, d.tax_amount),
             d.credit_note_number::pg_catalog.text, public.approval_document_digest(d.company_id, 'supplier_credit_note', d.id)
      FROM public.credit_notes d WHERE d.id = p_document_id AND d.company_id = p_company_id AND d.type = 'supplier';
    WHEN 'supplier_payment' THEN
      RETURN QUERY SELECT public.approval_supplier_payment_gate_amount(d.total_amount), d.payment_number::pg_catalog.text,
             public.approval_document_digest(d.company_id, 'supplier_payment', d.id)
      FROM public.supplier_payments d
      WHERE d.id = p_document_id AND d.company_id = p_company_id AND d.batch_id IS NULL;
    WHEN 'payment_batch' THEN
      RETURN QUERY SELECT public.approval_payment_batch_gate_amount(d.company_id, d.id), d.batch_number::pg_catalog.text,
             public.approval_document_digest(d.company_id, 'payment_batch', d.id)
      FROM public.supplier_payment_batches d WHERE d.id = p_document_id AND d.company_id = p_company_id;
    WHEN 'payment' THEN
      RETURN QUERY SELECT COALESCE(d.total_amount, 0)::pg_catalog.numeric, d.payment_number::pg_catalog.text,
             public.approval_document_digest(d.company_id, 'payment', d.id)
      FROM public.customer_payments d WHERE d.id = p_document_id AND d.company_id = p_company_id;
      IF NOT FOUND THEN
        RETURN QUERY SELECT COALESCE(d.total_amount, 0)::pg_catalog.numeric, d.payment_number::pg_catalog.text,
               public.approval_document_digest(d.company_id, 'payment', d.id)
        FROM public.supplier_payments d WHERE d.id = p_document_id AND d.company_id = p_company_id;
      END IF;
    WHEN 'manual_journal' THEN
      RETURN QUERY SELECT public.approval_manual_journal_gate_amount(d.company_id, d.id), d.entry_number::pg_catalog.text,
             public.approval_document_digest(d.company_id, 'manual_journal', d.id)
      FROM public.gl_journal_entries d WHERE d.id = p_document_id AND d.company_id = p_company_id;
    WHEN 'journal_entry' THEN
      RETURN QUERY SELECT COALESCE((
               SELECT SUM(jl.debit) FROM public.gl_journal_lines jl
               WHERE jl.journal_entry_id = je.id AND jl.company_id = p_company_id), 0)::pg_catalog.numeric,
             je.entry_number::pg_catalog.text, public.approval_document_digest(je.company_id, 'journal_entry', je.id)
      FROM public.gl_journal_entries je WHERE je.id = p_document_id AND je.company_id = p_company_id;
    ELSE
      RETURN;
  END CASE;
END
$$;

-- The rule a request may be bound to: this company's, active, of the type
-- (or, for a batch, a member's supplier_payment rule — strictestBatchRule),
-- and as strict as the strictest rule matching the document NOW — the choice
-- checkApproval makes, compared by rank because a tie may fall either way.
-- NULL: the rule is gone or inactive (the caller decides what that means).
CREATE OR REPLACE FUNCTION public.approval_request_bindable_rule(
  p_company_id pg_catalog.uuid, p_document_type pg_catalog.text, p_document_id pg_catalog.uuid,
  p_amount pg_catalog.numeric, p_rule_id pg_catalog.uuid
) RETURNS public.approval_rules
LANGUAGE plpgsql STABLE
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_rule public.approval_rules;
  v_strictest pg_catalog.int4;
BEGIN
  SELECT r.* INTO v_rule FROM public.approval_rules r
  WHERE r.id = p_rule_id AND r.company_id = p_company_id AND r.is_active = true;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  v_strictest := CASE WHEN p_document_type = 'payment_batch'
                      THEN public.approval_payment_batch_strictest_rank(p_company_id, p_document_id)
                      ELSE public.approval_rule_strictest_rank(p_company_id, p_document_type, p_amount) END;
  IF v_strictest IS NULL THEN
    RAISE EXCEPTION 'No active approval rule requires approval for % %', p_document_type, p_document_id
      USING ERRCODE = 'RA007';
  END IF;
  IF NOT (v_rule.document_type = p_document_type
          OR (p_document_type = 'payment_batch' AND v_rule.document_type = 'supplier_payment'))
     OR public.approval_required_rank(v_rule.approver_role) <> v_strictest THEN
    RAISE EXCEPTION 'R035_APPROVAL_REQUEST_FORGED: a request must be bound to the strictest rule governing the document'
      USING ERRCODE = 'RA009';
  END IF;
  RETURN v_rule;
END
$$;

-- ── 2. The writers ────────────────────────────────────────────────────────

-- requestApproval's INSERT. Every column but the document's identity, the
-- rule and the requester is computed here. No row: the rule went inactive
-- (the TypeScript answers ApprovalRuleNotFoundError, as before). A second
-- pending row still raises 23505 from uq_approval_requests_pending.
CREATE OR REPLACE FUNCTION public.approval_request_raise(
  p_company_id pg_catalog.uuid, p_document_type pg_catalog.text, p_document_id pg_catalog.uuid,
  p_rule_id pg_catalog.uuid, p_requested_by pg_catalog.text
) RETURNS SETOF public.approval_requests
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_doc record;
  v_rule public.approval_rules;
BEGIN
  IF public.approval_request_session_actor() = 'impersonation' THEN
    RAISE EXCEPTION 'This action cannot be taken while impersonating another user. End the impersonation and act as yourself.'
      USING ERRCODE = 'RA003';
  END IF;
  PERFORM public.approval_request_assert_caller(p_company_id, p_requested_by, true);
  SELECT f.* INTO v_doc FROM public.approval_request_document_facts(p_company_id, p_document_type, p_document_id) f
  WHERE public.approval_request_caller_sees(p_company_id);
  IF NOT FOUND THEN
    RAISE EXCEPTION 'No % % exists for this company', p_document_type, p_document_id USING ERRCODE = 'RA006';
  END IF;
  v_rule := public.approval_request_bindable_rule(p_company_id, p_document_type, p_document_id, v_doc.amount, p_rule_id);
  IF v_rule.id IS NULL THEN
    RETURN;
  END IF;
  RETURN QUERY
    INSERT INTO public.approval_requests (company_id, rule_id, document_type, document_id, document_reference, amount,
      requested_by, required_role, document_digest, content_authors, approver_roster)
    VALUES (p_company_id, v_rule.id, p_document_type, p_document_id, v_doc.reference, v_doc.amount,
      p_requested_by::pg_catalog.uuid, v_rule.approver_role, v_doc.digest,
      public.approval_document_authors(p_company_id, p_document_type, p_document_id),
      (SELECT public.approval_roster_snapshot(p_company_id, p_requested_by)
       WHERE EXISTS (SELECT 1 FROM public.approval_enforcement ae
                     WHERE ae.company_id = p_company_id AND ae.document_type = p_document_type)))
    RETURNING *;
END
$$;

-- rebindPendingRequest's UPDATE. p_rule_id NULL keeps the binding; a rule
-- may only move the request UPWARDS from what it demands now (669's ratchet).
-- The content always follows the document; when its digest moved the request
-- is re-stamped as raised by p_requested_by. No row: nothing pending to
-- re-bind, or the rule went inactive — nothing written.
CREATE OR REPLACE FUNCTION public.approval_request_rebind(
  p_company_id pg_catalog.uuid, p_request_id pg_catalog.uuid, p_rule_id pg_catalog.uuid, p_requested_by pg_catalog.text
) RETURNS SETOF public.approval_requests
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_row public.approval_requests;
  v_doc record;
  v_rule public.approval_rules;
  v_current pg_catalog.text;
  v_changed pg_catalog.bool;
BEGIN
  IF public.approval_request_session_actor() = 'impersonation' THEN
    RAISE EXCEPTION 'This action cannot be taken while impersonating another user. End the impersonation and act as yourself.'
      USING ERRCODE = 'RA003';
  END IF;
  PERFORM public.approval_request_assert_caller(p_company_id, p_requested_by, true);
  IF NOT public.approval_request_caller_sees(p_company_id) THEN
    RETURN;
  END IF;
  SELECT ar.* INTO v_row FROM public.approval_requests ar
  WHERE ar.id = p_request_id AND ar.company_id = p_company_id AND ar.status = 'pending'
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN;
  END IF;
  SELECT f.* INTO v_doc FROM public.approval_request_document_facts(p_company_id, v_row.document_type, v_row.document_id) f;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'No % % exists for this company', v_row.document_type, v_row.document_id USING ERRCODE = 'RA006';
  END IF;
  IF p_rule_id IS NOT NULL THEN
    v_rule := public.approval_request_bindable_rule(p_company_id, v_row.document_type, v_row.document_id, v_doc.amount, p_rule_id);
    IF v_rule.id IS NULL THEN
      RETURN;
    END IF;
    SELECT COALESCE(v_row.required_role, rl.approver_role, 'admin') INTO v_current
    FROM (SELECT 1) one
    LEFT JOIN public.approval_rules rl ON rl.id = v_row.rule_id AND rl.company_id = v_row.company_id;
    IF public.approval_required_rank(v_rule.approver_role) < public.approval_required_rank(v_current) THEN
      RAISE EXCEPTION 'R035_APPROVAL_REQUEST_FORGED: a pending request may only be re-bound to a stricter rule'
        USING ERRCODE = 'RA009';
    END IF;
  END IF;
  v_changed := v_row.document_digest IS DISTINCT FROM v_doc.digest;
  RETURN QUERY
    UPDATE public.approval_requests ar SET
      rule_id = COALESCE(v_rule.id, ar.rule_id),
      required_role = COALESCE(v_rule.approver_role, ar.required_role),
      amount = v_doc.amount,
      document_reference = v_doc.reference,
      document_digest = v_doc.digest,
      content_authors = CASE WHEN v_changed
                             THEN public.approval_document_authors(ar.company_id, ar.document_type, ar.document_id)
                             ELSE ar.content_authors END,
      past_requesters = CASE WHEN v_changed AND ar.requested_by <> p_requested_by::pg_catalog.uuid
                             THEN pg_catalog.array_append(ar.past_requesters, ar.requested_by) ELSE ar.past_requesters END,
      requested_by = CASE WHEN v_changed THEN p_requested_by::pg_catalog.uuid ELSE ar.requested_by END,
      requested_at = CASE WHEN v_changed THEN pg_catalog.now() ELSE ar.requested_at END,
      approver_roster = CASE WHEN v_changed THEN (
        SELECT public.approval_roster_snapshot(p_company_id, p_requested_by)
        WHERE EXISTS (SELECT 1 FROM public.approval_enforcement ae
                      WHERE ae.company_id = p_company_id AND ae.document_type = ar.document_type)
      ) ELSE ar.approver_roster END
    WHERE ar.id = p_request_id AND ar.company_id = p_company_id AND ar.status = 'pending'
    RETURNING ar.*;
END
$$;

-- decideRequest's row lock (approvalRequestLock.ts). A missing, foreign or
-- decided id locks nothing, as before. lock_timeout is the caller's.
CREATE OR REPLACE FUNCTION public.approval_request_lock(
  p_company_id pg_catalog.uuid, p_request_id pg_catalog.uuid
) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF NOT public.approval_request_caller_bypasses() AND app.current_company_id() IS DISTINCT FROM p_company_id THEN
    RAISE EXCEPTION 'R035_APPROVAL_REQUEST_FORGED: a request may only be locked for the request''s own company'
      USING ERRCODE = 'RA009';
  END IF;
  PERFORM 1 FROM public.approval_requests ar
  WHERE ar.id = p_request_id AND ar.company_id = p_company_id AND ar.status = 'pending'
    AND public.approval_request_caller_sees(p_company_id)
  FOR UPDATE;
END
$$;

-- decideRequest's UPDATE, with assertDecidingSession, assertMayDecide and
-- assertDocumentUnchanged repeated in their order (gl/approvalAuthority.ts,
-- approvalAuthors.ts, approvalSelfApproval.ts, approvalDecideDocument.ts).
-- Identities are compared as TEXT where the TypeScript compares strings.
-- The sole-approver audit row stays the TypeScript's (logAuditOrThrow).
-- No row: the request is gone, foreign or already decided (404, as before).
CREATE OR REPLACE FUNCTION public.approval_request_decide(
  p_company_id pg_catalog.uuid, p_request_id pg_catalog.uuid, p_decision pg_catalog.text,
  p_decided_by pg_catalog.text, p_notes pg_catalog.text, p_expected_digest pg_catalog.text
) RETURNS SETOF public.approval_requests
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_actor pg_catalog.text := public.approval_request_session_actor();
  v_row public.approval_requests;
  v_is_self pg_catalog.bool;
  v_rule_id pg_catalog.uuid;
  v_rule_role pg_catalog.text;
  v_demanded pg_catalog.text;
  v_decider_role pg_catalog.text;
  v_enforced pg_catalog.bool;
  v_live_authors pg_catalog.text[];
  v_doc record;
  v_expected pg_catalog.text := NULLIF(p_expected_digest, '');
BEGIN
  -- assertDecidingSession: a Login-as session, or one that cannot be ruled
  -- out as one, decides nothing — approve or reject.
  IF v_actor <> 'self' THEN
    RAISE EXCEPTION '%', CASE v_actor
      WHEN 'impersonation' THEN 'Approval decisions cannot be made while impersonating another user. End the impersonation and decide as yourself.'
      ELSE 'Approval decisions are refused: this session cannot confirm it is not an impersonation.' END
      USING ERRCODE = 'RA003';
  END IF;
  IF p_decision IS NULL OR p_decision NOT IN ('approved', 'rejected') THEN
    RAISE EXCEPTION 'R035_APPROVAL_REQUEST_FORGED: a decision is approved or rejected' USING ERRCODE = 'RA009';
  END IF;
  PERFORM public.approval_request_assert_caller(p_company_id, p_decided_by, false);
  IF NOT public.approval_request_caller_sees(p_company_id) THEN
    RETURN;
  END IF;

  SELECT ar.* INTO v_row FROM public.approval_requests ar
  WHERE ar.id = p_request_id AND ar.company_id = p_company_id AND ar.status = 'pending'
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN;
  END IF;
  v_is_self := v_row.requested_by::pg_catalog.text = p_decided_by;

  -- Rejecting your own request is a withdrawal: no authority needed.
  IF NOT (v_is_self AND p_decision = 'rejected') THEN
    SELECT rl.id, rl.approver_role INTO v_rule_id, v_rule_role
    FROM public.approval_rules rl WHERE rl.id = v_row.rule_id AND rl.company_id = p_company_id;
    v_rule_role := COALESCE(v_rule_role, 'admin');
    -- The ratchet (669): the higher of the snapshot and the bound rule's live role.
    v_demanded := CASE WHEN v_row.required_role IS NOT NULL
                         AND public.approval_required_rank(v_row.required_role) > public.approval_required_rank(v_rule_role)
                       THEN v_row.required_role ELSE v_rule_role END;
    SELECT cu.role::pg_catalog.text INTO v_decider_role
    FROM public.company_users cu WHERE cu.company_id = p_company_id AND cu.user_id = p_decided_by;
    v_enforced := EXISTS (SELECT 1 FROM public.approval_enforcement ae
                          WHERE ae.company_id = v_row.company_id AND ae.document_type = v_row.document_type);

    -- contentAuthorRefusal: an author of the content never approves.
    IF p_decision = 'approved' AND NOT v_is_self THEN
      v_live_authors := public.approval_document_authors(v_row.company_id, v_row.document_type, v_row.document_id)::pg_catalog.text[];
      IF v_live_authors IS NULL THEN
        IF p_decided_by = ANY (v_row.past_requesters::pg_catalog.text[]) THEN
          RAISE EXCEPTION 'You cannot approve an approval request you raised for an earlier version of this document'
            USING ERRCODE = 'RA001';
        END IF;
      ELSIF p_decided_by = ANY (v_live_authors || COALESCE(v_row.content_authors::pg_catalog.text[], '{}'::pg_catalog.text[])) THEN
        RAISE EXCEPTION 'You cannot approve this request: you authored the content it covers.' USING ERRCODE = 'RA001';
      END IF;
    END IF;

    -- K-043 with the sole-approver exception (Q2).
    IF v_is_self THEN
      IF v_decider_role IS NULL THEN
        RAISE EXCEPTION 'You cannot approve an approval request you raised yourself while another member can approve it'
          USING ERRCODE = 'RA001';
      END IF;
      IF NOT v_enforced THEN
        RAISE EXCEPTION 'You cannot approve an approval request you raised yourself unless approval enforcement is on for this document type'
          USING ERRCODE = 'RA001';
      END IF;
      IF v_row.approver_roster IS NULL
         OR v_row.approver_roster IS DISTINCT FROM public.approval_roster_snapshot(p_company_id, p_decided_by) THEN
        RAISE EXCEPTION 'You cannot approve an approval request you raised yourself — the company members or roles changed since it was raised'
          USING ERRCODE = 'RA001';
      END IF;
      IF EXISTS (
        SELECT 1 FROM public.approval_company_other_members(p_company_id, p_decided_by) m
        WHERE m.is_active IS TRUE AND m.suspended_at IS NULL
          AND (m.status IS NULL OR pg_catalog.lower(m.status) = 'active')
          AND public.approval_actor_rank(m.role) >= public.approval_required_rank(v_demanded)
      ) THEN
        RAISE EXCEPTION 'You cannot approve an approval request you raised yourself while another member can approve it'
          USING ERRCODE = 'RA001';
      END IF;
    END IF;

    IF v_row.rule_id IS NOT NULL AND v_rule_id IS NULL THEN
      RAISE EXCEPTION 'This approval names a rule that does not belong to this company and cannot be decided'
        USING ERRCODE = 'RA002';
    END IF;
    IF v_decider_role IS NULL THEN
      RAISE EXCEPTION 'You have no role in this company and cannot decide approvals' USING ERRCODE = 'RA002';
    END IF;
    IF public.approval_actor_rank(v_decider_role) < public.approval_required_rank(v_demanded) THEN
      RAISE EXCEPTION 'This approval requires the % role', v_demanded USING ERRCODE = 'RA002';
    END IF;
  END IF;

  -- assertDocumentUnchanged: the document exists, and the digest the approver
  -- was shown, the one raised for and the live one all agree.
  IF p_decision = 'approved' THEN
    SELECT f.* INTO v_doc FROM public.approval_request_document_facts(p_company_id, v_row.document_type, v_row.document_id) f;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'No % % exists for this company', v_row.document_type, v_row.document_id USING ERRCODE = 'RA006';
    END IF;
    IF v_row.document_digest IS NOT NULL AND v_expected IS NULL THEN
      RAISE EXCEPTION 'Approving request % requires expectedDigest — the document digest you were shown.', p_request_id
        USING ERRCODE = 'RA005';
    END IF;
    IF v_expected IS DISTINCT FROM v_row.document_digest OR v_row.document_digest IS DISTINCT FROM v_doc.digest THEN
      RAISE EXCEPTION 'The document changed after approval request % was raised. Submit it for approval again.', p_request_id
        USING ERRCODE = 'RA004';
    END IF;
  END IF;

  RETURN QUERY
    UPDATE public.approval_requests ar SET
      status = p_decision,
      decided_by = p_decided_by::pg_catalog.uuid,
      decided_at = pg_catalog.now(),
      decision_notes = p_notes
    WHERE ar.id = p_request_id AND ar.company_id = p_company_id AND ar.status = 'pending'
    RETURNING ar.*;
END
$$;

-- ── 3. Privileges ─────────────────────────────────────────────────────────
-- Helpers: nobody but the owner (the definers call them as owner).
REVOKE ALL ON FUNCTION public.approval_actor_rank(pg_catalog.text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.approval_request_caller_bypasses() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.approval_request_subject() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.approval_request_session_actor() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.approval_request_assert_caller(pg_catalog.uuid, pg_catalog.text, pg_catalog.bool) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.approval_request_caller_sees(pg_catalog.uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.approval_request_document_facts(pg_catalog.uuid, pg_catalog.text, pg_catalog.uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.approval_request_bindable_rule(pg_catalog.uuid, pg_catalog.text, pg_catalog.uuid, pg_catalog.numeric, pg_catalog.uuid) FROM PUBLIC;
-- Writers: app_user only.
REVOKE ALL ON FUNCTION public.approval_request_raise(pg_catalog.uuid, pg_catalog.text, pg_catalog.uuid, pg_catalog.uuid, pg_catalog.text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.approval_request_rebind(pg_catalog.uuid, pg_catalog.uuid, pg_catalog.uuid, pg_catalog.text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.approval_request_lock(pg_catalog.uuid, pg_catalog.uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.approval_request_decide(pg_catalog.uuid, pg_catalog.uuid, pg_catalog.text, pg_catalog.text, pg_catalog.text, pg_catalog.text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.approval_request_raise(pg_catalog.uuid, pg_catalog.text, pg_catalog.uuid, pg_catalog.uuid, pg_catalog.text) TO app_user;
GRANT EXECUTE ON FUNCTION public.approval_request_rebind(pg_catalog.uuid, pg_catalog.uuid, pg_catalog.uuid, pg_catalog.text) TO app_user;
GRANT EXECUTE ON FUNCTION public.approval_request_lock(pg_catalog.uuid, pg_catalog.uuid) TO app_user;
GRANT EXECUTE ON FUNCTION public.approval_request_decide(pg_catalog.uuid, pg_catalog.uuid, pg_catalog.text, pg_catalog.text, pg_catalog.text, pg_catalog.text) TO app_user;

-- Default privileges differ by environment (a schema default may hand new
-- functions to other roles): strip EXECUTE from every grantee but the owner,
-- and app_user on the four writers, whatever granted it.
DO $$
DECLARE
  v_fn pg_catalog.regprocedure;
  v_grantee pg_catalog.text;
BEGIN
  FOR v_fn IN
    SELECT p.oid::pg_catalog.regprocedure FROM pg_catalog.pg_proc p
    JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND (p.proname LIKE 'approval\_request\_%' OR p.proname = 'approval_actor_rank')
      AND p.proname <> 'approval_request_insert_guard'
  LOOP
    FOR v_grantee IN
      SELECT DISTINCT CASE a.grantee WHEN 0 THEN 'PUBLIC' ELSE pg_catalog.quote_ident(r.rolname) END
      FROM pg_catalog.pg_proc p, pg_catalog.aclexplode(p.proacl) a
      LEFT JOIN pg_catalog.pg_roles r ON r.oid = a.grantee
      WHERE p.oid = v_fn AND a.grantee <> p.proowner
        AND NOT (r.rolname = 'app_user'
                 AND p.proname IN ('approval_request_raise', 'approval_request_rebind',
                                   'approval_request_lock', 'approval_request_decide'))
    LOOP
      EXECUTE pg_catalog.format('REVOKE ALL ON FUNCTION %s FROM %s', v_fn, v_grantee);
    END LOOP;
  END LOOP;
END $$;

-- The table: every write privilege of every role but the owner, enumerated
-- from the ACL rather than named — app_user, PUBLIC, platform_admin and
-- migration_admin on the fixture; whatever else an environment granted
-- (no src path writes the table as platform_admin or migration_admin).
-- Table-level and column-level grants both: a column grant survives a
-- table-level REVOKE. TRIGGER too: a trigger another role attached would run
-- inside the definers' writes as their owner, and could rewrite the row.
-- SELECT is untouched — every gate reads the table.
DO $$
DECLARE
  v_grantee pg_catalog.text;
  v_col pg_catalog.text;
BEGIN
  FOR v_grantee IN
    SELECT DISTINCT CASE a.grantee WHEN 0 THEN 'PUBLIC' ELSE pg_catalog.quote_ident(r.rolname) END
    FROM pg_catalog.pg_class c, pg_catalog.aclexplode(c.relacl) a
    LEFT JOIN pg_catalog.pg_roles r ON r.oid = a.grantee
    WHERE c.oid = 'public.approval_requests'::pg_catalog.regclass
      AND a.grantee <> c.relowner
      AND a.privilege_type IN ('INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'TRIGGER')
  LOOP
    EXECUTE pg_catalog.format('REVOKE INSERT, UPDATE, DELETE, TRUNCATE, TRIGGER ON public.approval_requests FROM %s CASCADE', v_grantee);
  END LOOP;
  FOR v_grantee, v_col IN
    SELECT DISTINCT CASE a.grantee WHEN 0 THEN 'PUBLIC' ELSE pg_catalog.quote_ident(r.rolname) END,
           pg_catalog.quote_ident(att.attname)
    FROM pg_catalog.pg_attribute att, pg_catalog.aclexplode(att.attacl) a
    LEFT JOIN pg_catalog.pg_roles r ON r.oid = a.grantee
    WHERE att.attrelid = 'public.approval_requests'::pg_catalog.regclass AND att.attacl IS NOT NULL
      AND a.privilege_type IN ('INSERT', 'UPDATE')
  LOOP
    EXECUTE pg_catalog.format('REVOKE INSERT (%s), UPDATE (%s) ON public.approval_requests FROM %s CASCADE',
                              v_col, v_col, v_grantee);
  END LOOP;
END $$;

-- ── 4. Assertions: refuse to ship it any other way ────────────────────────
DO $$
DECLARE
  v_owner pg_catalog.oid := (SELECT c.relowner FROM pg_catalog.pg_class c
                             WHERE c.oid = 'public.approval_requests'::pg_catalog.regclass);
  v_role pg_catalog.text;
  v_priv pg_catalog.text;
  v_fn pg_catalog.text;
BEGIN
  -- No role but the owner and superusers may write, by grant or by column.
  -- A role that inherits the owner's or pg_write_all_data's rights is not a
  -- grant this migration can revoke: refuse rather than ship it silently.
  FOR v_role IN
    SELECT r.rolname FROM pg_catalog.pg_roles r
    WHERE NOT r.rolsuper AND r.oid <> v_owner AND r.rolname !~ '^pg_'
    UNION ALL SELECT 'public'
  LOOP
    FOREACH v_priv IN ARRAY ARRAY['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'TRIGGER'] LOOP
      IF pg_catalog.has_table_privilege(v_role, 'public.approval_requests', v_priv) THEN
        RAISE EXCEPTION 'migration 872: % still holds % on approval_requests', v_role, v_priv;
      END IF;
    END LOOP;
    FOREACH v_priv IN ARRAY ARRAY['INSERT', 'UPDATE'] LOOP
      IF pg_catalog.has_any_column_privilege(v_role, 'public.approval_requests', v_priv) THEN
        RAISE EXCEPTION 'migration 872: % still holds column % on approval_requests', v_role, v_priv;
      END IF;
    END LOOP;
  END LOOP;
  IF NOT pg_catalog.has_table_privilege('app_user', 'public.approval_requests', 'SELECT') THEN
    RAISE EXCEPTION 'migration 872: app_user lost SELECT on approval_requests';
  END IF;

  -- The functions: the owner (and superusers) and, for the four writers,
  -- app_user — nobody else.
  FOR v_fn, v_role IN
    SELECT p.oid::pg_catalog.regprocedure::pg_catalog.text, r.rolname
    FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
    CROSS JOIN (SELECT rolname, oid FROM pg_catalog.pg_roles WHERE NOT rolsuper AND rolname !~ '^pg_'
                UNION ALL SELECT 'public', 0) r
    WHERE n.nspname = 'public' AND r.oid <> p.proowner
      AND (p.proname LIKE 'approval\_request\_%' OR p.proname = 'approval_actor_rank')
      AND p.proname <> 'approval_request_insert_guard'
      AND NOT (r.rolname = 'app_user'
               AND p.proname IN ('approval_request_raise', 'approval_request_rebind',
                                 'approval_request_lock', 'approval_request_decide'))
  LOOP
    IF pg_catalog.has_function_privilege(v_role, v_fn, 'EXECUTE') THEN
      RAISE EXCEPTION 'migration 872: % may still execute %', v_role, v_fn;
    END IF;
  END LOOP;

  FOREACH v_fn IN ARRAY ARRAY[
      'public.approval_request_raise(pg_catalog.uuid,pg_catalog.text,pg_catalog.uuid,pg_catalog.uuid,pg_catalog.text)',
      'public.approval_request_rebind(pg_catalog.uuid,pg_catalog.uuid,pg_catalog.uuid,pg_catalog.text)',
      'public.approval_request_lock(pg_catalog.uuid,pg_catalog.uuid)',
      'public.approval_request_decide(pg_catalog.uuid,pg_catalog.uuid,pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.text)'] LOOP
    -- FORCE RLS on approval_requests binds the definer's owner too: one
    -- without BYPASSRLS would find no row and write nothing.
    IF NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_roles r ON r.oid = p.proowner
      WHERE p.oid = v_fn::pg_catalog.regprocedure AND p.prosecdef AND (r.rolbypassrls OR r.rolsuper)
    ) THEN
      RAISE EXCEPTION 'migration 872: % must be SECURITY DEFINER with an owner that bypasses RLS', v_fn;
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_proc p
      WHERE p.oid = v_fn::pg_catalog.regprocedure
        AND p.proconfig[pg_catalog.array_upper(p.proconfig, 1)] ~ '^search_path=.*pg_temp$'
    ) THEN
      RAISE EXCEPTION 'migration 872: % must pin search_path with pg_temp last', v_fn;
    END IF;
    IF pg_catalog.has_function_privilege('public', v_fn, 'EXECUTE')
       OR NOT pg_catalog.has_function_privilege('app_user', v_fn, 'EXECUTE') THEN
      RAISE EXCEPTION 'migration 872: % must be executable by app_user and not by PUBLIC', v_fn;
    END IF;
  END LOOP;
END $$;

-- The same, AS app_user, by outcome: every write is refused before any row
-- is read (plpgsql, one savepoint per probe — a caught 42501 still aborts).
SET LOCAL ROLE app_user;
DO $$
DECLARE
  v_sql pg_catalog.text;
BEGIN
  FOREACH v_sql IN ARRAY ARRAY[
      'INSERT INTO public.approval_requests (document_type, document_id, requested_by) SELECT ''x'', gen_random_uuid(), gen_random_uuid() WHERE false',
      'UPDATE public.approval_requests SET status = ''approved'' WHERE false',
      'DELETE FROM public.approval_requests WHERE false',
      'SELECT 1 FROM public.approval_requests WHERE false FOR UPDATE'] LOOP
    BEGIN
      EXECUTE v_sql;
      RAISE EXCEPTION 'migration 872: app_user may still run: %', v_sql USING ERRCODE = 'RA999';
    EXCEPTION WHEN insufficient_privilege THEN
      NULL; -- refused, as intended
    END;
  END LOOP;
  IF NOT pg_catalog.has_table_privilege('public.approval_requests', 'SELECT') THEN
    RAISE EXCEPTION 'migration 872: app_user cannot read approval_requests';
  END IF;
END $$;
RESET ROLE;
