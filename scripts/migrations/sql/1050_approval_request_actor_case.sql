-- 1050 (wave 7 AQ, W18): approval_request_decide and approval_request_raise read the actor id without case.
--
-- WHY: 872's decide compared v_row.requested_by::text = p_decided_by exactly. requested_by is a uuid, so its text is
-- lower case, and an upper-cased spelling of the requester's own id was "not self". It was refused anyway, but by the
-- role lookup (cu.user_id = p_actor, RA008), which missed the same spelling; the self-approval, author and roster checks
-- never saw it. Nothing in the app sends an upper-cased id (GoTrue issues lower case, the TypeScript now lowers it too);
-- this is the SQL floor, so the self check holds on its own and not by the accident of a second exact comparison.
--
-- WHAT: each function lowers its actor parameter ONCE, into v_decided_by / v_requested_by, and every use reads that:
-- assert_caller, assert_write_role, the self test, the membership role, the
-- past-requester and content-author tests (uuid text is already lower case), the roster snapshot, other members, the
-- decided_by / requested_by written and the sole-approver audit row's user_id. Bodies are 872's otherwise, line for line.
-- auth.uid() returns the JWT sub claim verbatim (it does not lower it); approval_request_subject() casts it to uuid, so
-- the subject check was never case-sensitive. A JWT whose sub is upper case (none is issued) still fails closed on the
-- sole-approver path: 708's approval_company_other_members compares auth.uid() to the (now lowered) id exactly (42501).
-- Only the actor INPUT is lowered; every stored column is compared exactly. company_users.user_id is TEXT and its key
-- is case-sensitive, so lower() on it would match a case-twin row (breaker round 1); requested_by, past_requesters and
-- content_authors are uuids, whose text is canonical lower case, so the lowered input meets them as stored.
-- rebind and lock are not changed, on purpose: no case can be raised there that 1050 has to catch. Rebind's actor reaches
-- assert_write_role exactly, so an upper-cased one is refused RA008 before any write (fails closed); rebind compares
-- requested_by as a uuid; the app sends it lower-cased (approvalRequestWrites.ts). Lock takes no actor parameter.
--
-- DEFINER REGISTRY (930): both functions are SECURITY DEFINER; their app_definer_reviews rows are re-registered with the
-- new body hash, AFTER the replace (CREATE OR REPLACE keeps owner and grants; asserted below).
--
-- OLD COLOUR: the previous release calls both by the same signatures with the session's own (lower-case) id; lower() of
-- a lower-case id is itself, so it gets exactly 872's answers. Expand-only: no table, column or grant changes.
--
-- Rollback: restore 872's two bodies, then re-register them:
--   sed -n '/^CREATE OR REPLACE FUNCTION public.approval_request_raise(/,/^\$\$;/p' scripts/migrations/sql/872_approval_request_definer_writes.sql | psql ...
--   sed -n '/^CREATE OR REPLACE FUNCTION public.approval_request_decide(/,/^\$\$;/p' scripts/migrations/sql/872_approval_request_definer_writes.sql | psql ...
--   UPDATE app_definer_reviews SET body_md5 = app_definer_hash(signature::regprocedure)
--    WHERE signature IN ('approval_request_raise(uuid,text,uuid,uuid,text)', 'approval_request_decide(uuid,uuid,text,text,text,text)');

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- The owners before, to prove the replace kept them.
SELECT pg_catalog.set_config('w7aq.owners', (
  SELECT pg_catalog.string_agg(p.oid::pg_catalog.regprocedure::pg_catalog.text || '=' || pg_catalog.pg_get_userbyid(p.proowner), ',' ORDER BY p.oid)
    FROM pg_catalog.pg_proc p
   WHERE p.oid IN ('public.approval_request_raise(uuid,text,uuid,uuid,text)'::pg_catalog.regprocedure,
                   'public.approval_request_decide(uuid,uuid,text,text,text,text)'::pg_catalog.regprocedure)), true);

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
  -- 1050 (W18): the requester as every stored id spells it. Every use below reads this.
  v_requested_by pg_catalog.text := pg_catalog.lower(p_requested_by);
BEGIN
  IF public.approval_request_session_actor() = 'impersonation' THEN
    RAISE EXCEPTION 'This action cannot be taken while impersonating another user. End the impersonation and act as yourself.'
      USING ERRCODE = 'RA003';
  END IF;
  PERFORM public.approval_request_assert_caller(p_company_id, v_requested_by, true);
  SELECT f.* INTO v_doc FROM public.approval_request_document_facts(p_company_id, p_document_type, p_document_id) f
  WHERE public.approval_request_caller_sees(p_company_id);
  IF NOT FOUND THEN
    RAISE EXCEPTION 'No % % exists for this company', p_document_type, p_document_id USING ERRCODE = 'RA006';
  END IF;
  PERFORM public.approval_request_assert_write_role(p_company_id, v_requested_by, true);
  v_rule := public.approval_request_bindable_rule(p_company_id, p_document_type, p_document_id, v_doc.amount, p_rule_id);
  IF v_rule.id IS NULL THEN
    RETURN;
  END IF;
  RETURN QUERY
    INSERT INTO public.approval_requests (company_id, rule_id, document_type, document_id, document_reference, amount,
      requested_by, required_role, document_digest, content_authors, approver_roster)
    VALUES (p_company_id, v_rule.id, p_document_type, p_document_id, v_doc.reference, v_doc.amount,
      v_requested_by::pg_catalog.uuid, v_rule.approver_role, v_doc.digest,
      public.approval_document_authors(p_company_id, p_document_type, p_document_id),
      (SELECT public.approval_roster_snapshot(p_company_id, v_requested_by)
       WHERE EXISTS (SELECT 1 FROM public.approval_enforcement ae
                     WHERE ae.company_id = p_company_id AND ae.document_type = p_document_type)))
    RETURNING *;
END
$$;

CREATE OR REPLACE FUNCTION public.approval_request_decide(
  p_company_id pg_catalog.uuid, p_request_id pg_catalog.uuid, p_decision pg_catalog.text,
  p_decided_by pg_catalog.text, p_notes pg_catalog.text, p_expected_digest pg_catalog.text
) RETURNS SETOF public.approval_requests
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_actor pg_catalog.text := public.approval_request_session_actor();
  -- 1050 (W18): the decider as every stored id spells it (uuid text is lower case). Every comparison below reads this.
  v_decided_by pg_catalog.text := pg_catalog.lower(p_decided_by);
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
  PERFORM public.approval_request_assert_caller(p_company_id, v_decided_by, false);
  IF NOT public.approval_request_caller_sees(p_company_id) THEN
    RETURN;
  END IF;
  -- withWriteAccess gates approve AND reject (a withdrawal included).
  PERFORM public.approval_request_assert_write_role(p_company_id, v_decided_by, false);

  SELECT ar.* INTO v_row FROM public.approval_requests ar
  WHERE ar.id = p_request_id AND ar.company_id = p_company_id AND ar.status = 'pending'
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN;
  END IF;
  v_is_self := v_row.requested_by::pg_catalog.text = v_decided_by;

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
    -- EXACT on the stored side (breaker round 1): company_users.user_id is TEXT and its key is case-sensitive, so
    -- lower(cu.user_id) would also match a case-twin row ('ABC...' beside 'abc...') and could take the twin's role.
    FROM public.company_users cu WHERE cu.company_id = p_company_id AND cu.user_id = v_decided_by;
    v_enforced := EXISTS (SELECT 1 FROM public.approval_enforcement ae
                          WHERE ae.company_id = v_row.company_id AND ae.document_type = v_row.document_type);

    -- contentAuthorRefusal: an author of the content never approves.
    IF p_decision = 'approved' AND NOT v_is_self THEN
      v_live_authors := public.approval_document_authors(v_row.company_id, v_row.document_type, v_row.document_id)::pg_catalog.text[];
      IF v_live_authors IS NULL THEN
        IF v_decided_by = ANY (v_row.past_requesters::pg_catalog.text[]) THEN
          RAISE EXCEPTION 'You cannot approve an approval request you raised for an earlier version of this document'
            USING ERRCODE = 'RA001';
        END IF;
      ELSIF v_decided_by = ANY (v_live_authors || COALESCE(v_row.content_authors::pg_catalog.text[], '{}'::pg_catalog.text[])) THEN
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
         OR v_row.approver_roster IS DISTINCT FROM public.approval_roster_snapshot(p_company_id, v_decided_by) THEN
        RAISE EXCEPTION 'You cannot approve an approval request you raised yourself — the company members or roles changed since it was raised'
          USING ERRCODE = 'RA001';
      END IF;
      IF EXISTS (
        SELECT 1 FROM public.approval_company_other_members(p_company_id, v_decided_by) m
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

  UPDATE public.approval_requests ar SET
    status = p_decision,
    decided_by = v_decided_by::pg_catalog.uuid,
    decided_at = pg_catalog.now(),
    decision_notes = p_notes
  WHERE ar.id = p_request_id AND ar.company_id = p_company_id AND ar.status = 'pending'
  RETURNING ar.* INTO v_row;
  IF NOT FOUND THEN
    RETURN;
  END IF;
  IF v_is_self AND p_decision = 'approved' THEN
    INSERT INTO public.audit_log (company_id, user_id, action, entity_type, entity_id, entity_ref, changes)
    VALUES (p_company_id, v_decided_by, 'approve', 'approval_request', v_row.id, v_row.document_reference,
      pg_catalog.jsonb_build_object('fields', '[]'::pg_catalog.jsonb, 'metadata',
        pg_catalog.jsonb_build_object(
          'selfApproval', 'sole_approver', 'requiredRole', v_demanded,
          'approverRoster', COALESCE(v_row.approver_roster::pg_catalog.text, 'null'),
          'documentType', v_row.document_type, 'documentId', v_row.document_id::pg_catalog.text)
        || CASE WHEN v_row.document_digest IS NOT NULL
                THEN pg_catalog.jsonb_build_object('documentDigest', v_row.document_digest)
                ELSE '{}'::pg_catalog.jsonb END));
  END IF;
  RETURN NEXT v_row;
END
$$;

INSERT INTO public.app_definer_reviews (signature, writes, body_md5)
SELECT v.signature, v.writes, public.app_definer_hash(v.signature::pg_catalog.regprocedure)
  FROM (VALUES
    ('approval_request_decide(uuid,uuid,text,text,text,text)', 'approval_requests, audit_log (R-035)'),
    ('approval_request_raise(uuid,text,uuid,uuid,text)', 'approval_requests (R-035)')
  ) AS v(signature, writes)
ON CONFLICT (signature) DO UPDATE SET writes = EXCLUDED.writes, body_md5 = EXCLUDED.body_md5;

-- The halts: an owner changed, a registry row not holding the hash, PUBLIC execute, app_user unable to execute, not a
-- definer, a search_path not pinned.
DO $$
DECLARE
  d RECORD;
BEGIN
  IF (SELECT pg_catalog.string_agg(p.oid::pg_catalog.regprocedure::pg_catalog.text || '=' || pg_catalog.pg_get_userbyid(p.proowner), ',' ORDER BY p.oid)
        FROM pg_catalog.pg_proc p
       WHERE p.oid IN ('public.approval_request_raise(uuid,text,uuid,uuid,text)'::pg_catalog.regprocedure,
                       'public.approval_request_decide(uuid,uuid,text,text,text,text)'::pg_catalog.regprocedure))
     IS DISTINCT FROM pg_catalog.current_setting('w7aq.owners') THEN
    RAISE EXCEPTION '1050: the replace changed an owner';
  END IF;
  FOR d IN SELECT * FROM (VALUES
      ('approval_request_decide(uuid,uuid,text,text,text,text)'),
      ('approval_request_raise(uuid,text,uuid,uuid,text)')) AS x(sig) LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_proc p WHERE p.oid = d.sig::pg_catalog.regprocedure AND p.prosecdef
                     AND p.proconfig @> ARRAY['search_path=pg_catalog, public, pg_temp']) THEN
      RAISE EXCEPTION '1050: % is not a definer pinning its search_path', d.sig;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.app_definer_reviews r
                    WHERE r.signature = d.sig AND r.body_md5 = public.app_definer_hash(d.sig::pg_catalog.regprocedure)) THEN
      RAISE EXCEPTION '1050: the registry row of % does not hold its hash', d.sig;
    END IF;
    IF pg_catalog.has_function_privilege('public', d.sig, 'EXECUTE') THEN
      RAISE EXCEPTION '1050: PUBLIC can execute %', d.sig;
    END IF;
    IF NOT pg_catalog.has_function_privilege('app_user', d.sig, 'EXECUTE') THEN
      RAISE EXCEPTION '1050: app_user cannot execute %', d.sig;
    END IF;
  END LOOP;
END $$;
