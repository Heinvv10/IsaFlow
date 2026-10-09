-- 881: R-035 N1b (B) — approval_rules and approval_enforcement are written
-- only through SECURITY DEFINER functions.
--
-- 872 made approval_requests definer-only, but every approval decision also
-- trusts two tables app_user could still write by raw SQL:
--   - approval_rules: deactivate a rule, lower its amount or its approver
--     role, then post — or insert a lax rule beside a strict one;
--   - approval_enforcement: delete the switch row — the gates read "no row"
--     as "not enforced".
-- This repeats, in SQL, every check the TypeScript runs before it writes
-- either table (approvalService createRule/updateRule/deleteRule,
-- approvalRuleGuards, approvalRuleInput, approvalDocumentTypes,
-- approvalEnforcement enable/disable, the supplier bank-detail baseline) and
-- the routes' withWriteAccess role gate; writes the audit rows itself; then
-- takes every write privilege on both tables away from every role but the
-- owner. WHO MAY DO WHAT IS UNCHANGED: each function refuses exactly what the
-- TypeScript refuses (the parity suite r035-n1b-rules-parity pins it per
-- refusal class), and the TypeScript keeps its own checks, error types and
-- messages, running first.
--
-- The definers rank the actor by company_users.role, as the TypeScript does:
-- they are exactly as strong as that table. Until N1b C (migration 883) an
-- admin could raise their own role there by raw SQL (cu_admin_write) and then
-- pass these checks as an owner (adversarial review of PR #690, REPRO 1).
--
-- Refusals (SQLSTATE; MESSAGE; DETAIL carries the value the TS message names):
--   RB001 rank below the rule (DETAIL: the rule's role)       → ApprovalRuleAuthorityError
--   RB002 weakening needs a higher rank (DETAIL: rule's role) → ApprovalRuleAuthorityError(weakening)
--   RB003 legacy document type (DETAIL: the type)             → ApprovalRuleLegacyTypeError
--   RB004 document type a rule cannot govern                  → ApprovalDocumentTypeInvalidError
--   RB005 name                                                → ApprovalNameInvalidError
--   RB006 approver role (DETAIL)                              → ApprovalRoleInvalidError
--   RB007 operator (DETAIL)                                   → ApprovalOperatorInvalidError
--   RB008 field (DETAIL)                                      → ApprovalFieldInvalidError
--   RB009 amount                                              → ApprovalAmountInvalidError
--   RB010 type not enforceable (DETAIL)                       → ApprovalEnforcementUnavailableError
--   RB011 switching off weakens a rule (DETAIL: its role)     → ApprovalEnforcementAuthorityError
--   RB012 bank control: not a person's own session (DETAIL: impersonation|unknown)
--   RB013 bank control: below the verifier role (DETAIL: that role) → SupplierBankVerificationError
--   RB020 forged actor or company (the app never sends one)   → a 500
--   RA008 the role gate (872's helper; the route refuses first) → a 500 from this path

-- ── 1. Helpers (owner only; the definers call them as owner) ──────────────

-- The caller is the session's own user acting in the company withAuth set.
CREATE OR REPLACE FUNCTION public.approval_rule_assert_caller(p_company_id pg_catalog.uuid, p_actor pg_catalog.text)
RETURNS void
LANGUAGE plpgsql STABLE
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF p_actor IS NULL OR public.approval_request_subject() IS NULL
     OR p_actor !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     OR public.approval_request_subject() IS DISTINCT FROM p_actor::pg_catalog.uuid THEN
    RAISE EXCEPTION 'R035_APPROVAL_RULE_FORGED: approval rules and switches may only be written by the session''s own user'
      USING ERRCODE = 'RB020';
  END IF;
  IF app.current_company_id() IS DISTINCT FROM p_company_id THEN
    RAISE EXCEPTION 'R035_APPROVAL_RULE_FORGED: approval rules and switches may only be written for the request''s own company'
      USING ERRCODE = 'RB020';
  END IF;
  -- The routes' gate: withWriteAccess with the default roles (writeRoles.ts).
  PERFORM public.approval_request_assert_write_role(p_company_id, p_actor, false);
END
$$;

-- The actor's company role exactly as withAuth reads it (companyRole).
CREATE OR REPLACE FUNCTION public.approval_rule_actor_role(p_company_id pg_catalog.uuid, p_actor pg_catalog.text)
RETURNS pg_catalog.text
LANGUAGE sql STABLE
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT cu.role::pg_catalog.text FROM public.company_users cu
  WHERE cu.company_id = p_company_id AND cu.user_id = p_actor
$$;

-- mayWeakenAtLevel (approvalRuleGuards.ts): a rank strictly above the level,
-- or at-or-above at owner level (nobody in a company ranks above the owner).
CREATE OR REPLACE FUNCTION public.approval_rule_may_weaken(p_actor_role pg_catalog.text, p_rule_role pg_catalog.text)
RETURNS pg_catalog.bool
LANGUAGE sql IMMUTABLE
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT CASE WHEN public.approval_required_rank(p_rule_role) = 7
              THEN public.approval_actor_rank(p_actor_role) >= public.approval_required_rank(p_rule_role)
              ELSE public.approval_actor_rank(p_actor_role) > public.approval_required_rank(p_rule_role) END
$$;

-- String.prototype.trim(): WhiteSpace and LineTerminator, both ends.
CREATE OR REPLACE FUNCTION public.approval_rule_js_trim(p_text pg_catalog.text)
RETURNS pg_catalog.text
LANGUAGE sql IMMUTABLE
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT pg_catalog.regexp_replace(p_text,
    '^[\u0009-\u000D    -     　﻿]+|[\u0009-\u000D    -     　﻿]+$',
    '', 'g')
$$;

-- isRuleName (approvalRuleOptions.ts): 1..100 characters once trimmed —
-- counted as JavaScript counts them, in UTF-16 code units — no control
-- character (Cc), and at least one visible character. LIMIT (named, not
-- chased): "visible" excludes whitespace, Cc, every format character (Cf)
-- and the five blank fillers exactly, but combining marks (M) only by their
-- main blocks — Postgres regex has no \p{M} — so a name made only of a rarer
-- combining mark passes here and is refused in TypeScript, and a name made
-- only of an UNASSIGNED code point inside one of those blocks is refused here
-- and accepted in TypeScript (r035-n1b-rules-lists sweeps the BMP and allows
-- exactly these two). A rule name is display text, not a security boundary
-- (approvalRuleOptions.ts says so).
CREATE OR REPLACE FUNCTION public.approval_rule_name_ok(p_name pg_catalog.text)
RETURNS pg_catalog.bool
LANGUAGE plpgsql IMMUTABLE
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v pg_catalog.text := public.approval_rule_js_trim(p_name);
BEGIN
  IF v IS NULL OR v = '' THEN RETURN false; END IF;
  IF pg_catalog.length(v) + pg_catalog.regexp_count(v, '[\U00010000-\U0010FFFF]') > 100 THEN RETURN false; END IF;
  IF v ~ '[\u0001-\u001F\u007F-\u009F]' THEN RETURN false; END IF;
  RETURN v ~ ('[^\u0009-\u000D    -     　﻿'
           || '\u0001-\u001F\u007F-\u009F'
           || '­؀-؅؜۝܏࢐࢑࣢᠎​-‏‪-‮⁠-⁤⁦-⁯'
           || '￹-￻\U000110BD\U000110CD\U00013430-\U0001343F\U0001BCA0-\U0001BCA3\U0001D173-\U0001D17A\U000E0001\U000E0020-\U000E007F'
           || '̀-ͯ҃-҉᪰-᫿᷀-᷿⃐-⃿︀-️︠-︯\U000E0100-\U000E01EF'
           || 'ᅟᅠㅤﾠ⠀]');
END
$$;

-- isRuleAmount: 0 .. 9 999 999 999 999.99 in whole cents (NaN refused).
CREATE OR REPLACE FUNCTION public.approval_rule_amount_ok(p_value pg_catalog.numeric)
RETURNS pg_catalog.bool
LANGUAGE sql IMMUTABLE
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT p_value IS NOT NULL AND p_value <> 'NaN'::pg_catalog.numeric
     AND p_value >= 0 AND p_value <= 9999999999999.99 AND p_value = pg_catalog.round(p_value, 2)
$$;

-- assertRuleInput, in its order: name, approver role, operator, field, amount
-- (isActive is a boolean by signature). A NULL argument is "not sent".
CREATE OR REPLACE FUNCTION public.approval_rule_assert_input(
  p_name pg_catalog.text, p_approver_role pg_catalog.text, p_operator pg_catalog.text,
  p_field pg_catalog.text, p_value pg_catalog.numeric
) RETURNS void
LANGUAGE plpgsql IMMUTABLE
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF p_name IS NOT NULL AND NOT public.approval_rule_name_ok(p_name) THEN
    RAISE EXCEPTION 'name must be 1 to 100 characters of visible text, with no control characters' USING ERRCODE = 'RB005';
  END IF;
  IF p_approver_role IS NOT NULL AND p_approver_role <> ALL (ARRAY['super_admin', 'owner', 'system', 'admin', 'manager',
       'accountant', 'bookkeeper', 'storeman', 'technician', 'user', 'viewer']::pg_catalog.text[]) THEN
    RAISE EXCEPTION 'approverRole must be one of: super_admin, owner, system, admin, manager, accountant, bookkeeper, storeman, technician, user, viewer (got %)',
      p_approver_role USING ERRCODE = 'RB006', DETAIL = p_approver_role;
  END IF;
  IF p_operator IS NOT NULL AND p_operator <> ALL (ARRAY['any', 'greater_than', 'greater_equal']::pg_catalog.text[]) THEN
    RAISE EXCEPTION 'conditionOperator must be one of: any, greater_than, greater_equal (got %)', p_operator
      USING ERRCODE = 'RB007', DETAIL = p_operator;
  END IF;
  IF p_field IS NOT NULL AND p_field <> ALL (ARRAY['total', 'amount']::pg_catalog.text[]) THEN
    RAISE EXCEPTION 'conditionField must be one of: total, amount (got %)', p_field USING ERRCODE = 'RB008', DETAIL = p_field;
  END IF;
  IF p_value IS NOT NULL AND NOT public.approval_rule_amount_ok(p_value) THEN
    RAISE EXCEPTION 'conditionValue must be a number from 0 to 9999999999999.99 with at most 2 decimals' USING ERRCODE = 'RB009';
  END IF;
END
$$;

-- assertMayDemand: nobody may set a rule to a rank above their own.
CREATE OR REPLACE FUNCTION public.approval_rule_assert_may_demand(p_actor_role pg_catalog.text, p_rule_role pg_catalog.text)
RETURNS void
LANGUAGE plpgsql IMMUTABLE
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF p_rule_role IS NOT NULL
     AND public.approval_actor_rank(p_actor_role) < public.approval_required_rank(p_rule_role) THEN
    RAISE EXCEPTION 'This rule requires the % role; you do not hold it, so you cannot create, change or delete it', p_rule_role
      USING ERRCODE = 'RB001', DETAIL = p_rule_role;
  END IF;
END
$$;

-- weakensRule: true when the change makes the rule demand less — a lower
-- role, off, gone, or matching an amount set that no longer covers every
-- amount it covered. A NULL argument is "not sent" (the stored value holds).
CREATE OR REPLACE FUNCTION public.approval_rule_weakens(
  p_before public.approval_rules, p_delete pg_catalog.bool, p_approver_role pg_catalog.text,
  p_is_active pg_catalog.bool, p_operator pg_catalog.text, p_value pg_catalog.numeric
) RETURNS pg_catalog.bool
LANGUAGE plpgsql IMMUTABLE
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_rule_role pg_catalog.text := COALESCE(p_before.approver_role, 'admin');
  v_was_op pg_catalog.text := p_before.condition_operator;
  v_was_value pg_catalog.numeric := COALESCE(p_before.condition_value, 0);
  v_next_op pg_catalog.text := COALESCE(p_operator, p_before.condition_operator);
  v_next_value pg_catalog.numeric := COALESCE(p_value, p_before.condition_value, 0);
  -- lowerBound: greater_than → (value, exclusive), greater_equal → (value, inclusive), else (-∞, inclusive).
  v_was_bounded pg_catalog.bool := v_was_op IN ('greater_than', 'greater_equal');
  v_next_bounded pg_catalog.bool := v_next_op IN ('greater_than', 'greater_equal');
BEGIN
  IF p_delete THEN RETURN true; END IF;
  IF p_approver_role IS NOT NULL
     AND public.approval_required_rank(p_approver_role) < public.approval_required_rank(v_rule_role) THEN
    RETURN true;
  END IF;
  IF p_is_active IS FALSE THEN RETURN true; END IF;
  IF NOT COALESCE(v_next_bounded, false) THEN RETURN false; END IF;      -- next starts at -∞: covers everything
  IF NOT COALESCE(v_was_bounded, false) THEN RETURN true; END IF;        -- was -∞, now a finite bound
  RETURN v_next_value > v_was_value
      OR (v_next_value = v_was_value AND v_was_op = 'greater_equal' AND v_next_op = 'greater_than');
END
$$;

-- auditRuleChange's `fields`: one entry per audited column that differs,
-- in AUDITED_FIELDS order, each value as String() renders it.
CREATE OR REPLACE FUNCTION public.approval_rule_audit_fields(p_before public.approval_rules, p_after public.approval_rules)
RETURNS pg_catalog.jsonb
LANGUAGE sql IMMUTABLE
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('field', f.field, 'old', f.old, 'new', f.new, 'label', f.field)
                                       ORDER BY f.ord), '[]'::pg_catalog.jsonb)
  FROM (VALUES
    (1, 'name', p_before.name, p_after.name),
    (2, 'document_type', p_before.document_type, p_after.document_type),
    (3, 'condition_field', p_before.condition_field, p_after.condition_field),
    (4, 'condition_operator', p_before.condition_operator, p_after.condition_operator),
    (5, 'condition_value', p_before.condition_value::pg_catalog.text, p_after.condition_value::pg_catalog.text),
    (6, 'approver_role', p_before.approver_role, p_after.approver_role),
    (7, 'is_active', p_before.is_active::pg_catalog.text, p_after.is_active::pg_catalog.text),
    (8, 'priority', p_before.priority::pg_catalog.text, p_after.priority::pg_catalog.text)
  ) AS f(ord, field, old, new)
  WHERE f.old IS DISTINCT FROM f.new
$$;

-- The email logAuditOrThrow records: withAuth's user.email, which is the
-- JWT claims' `email` when it is a string.
CREATE OR REPLACE FUNCTION public.approval_rule_actor_email()
RETURNS pg_catalog.text
LANGUAGE sql STABLE
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT CASE WHEN pg_catalog.jsonb_typeof(c -> 'email') = 'string' THEN c ->> 'email' END
  FROM (SELECT NULLIF(pg_catalog.current_setting('request.jwt.claims', true), '')::pg_catalog.jsonb AS c) x
$$;

-- auditRuleChange: the row logAuditOrThrow wrote, in the same transaction.
CREATE OR REPLACE FUNCTION public.approval_rule_audit(
  p_company_id pg_catalog.uuid, p_actor pg_catalog.text, p_actor_role pg_catalog.text, p_action pg_catalog.text,
  p_rule_id pg_catalog.uuid, p_before public.approval_rules, p_after public.approval_rules
) RETURNS void
LANGUAGE sql VOLATILE
SET search_path = pg_catalog, public, pg_temp
AS $$
  INSERT INTO public.audit_log (company_id, user_id, user_email, action, entity_type, entity_id, entity_ref, changes)
  VALUES (p_company_id, p_actor, public.approval_rule_actor_email(), p_action, 'approval_rule', p_rule_id,
          COALESCE(p_after.name, p_before.name),
          pg_catalog.jsonb_build_object('fields', public.approval_rule_audit_fields(p_before, p_after),
                                        'metadata', pg_catalog.jsonb_build_object('actorRole', p_actor_role)))
$$;

-- ── 2. The rule writers ───────────────────────────────────────────────────

-- assertMayEditRule's row lock: FOR UPDATE needs UPDATE, which app_user no
-- longer holds. Locks the company's row and returns it as the lock read it
-- (the newest version, as the TypeScript's own FOR UPDATE did); no row when
-- the company has no such rule (the caller 404s).
CREATE OR REPLACE FUNCTION public.approval_rule_lock(p_company_id pg_catalog.uuid, p_rule_id pg_catalog.uuid, p_actor pg_catalog.text)
RETURNS SETOF public.approval_rules
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  PERFORM public.approval_rule_assert_caller(p_company_id, p_actor);
  RETURN QUERY SELECT r.* FROM public.approval_rules r WHERE r.id = p_rule_id AND r.company_id = p_company_id FOR UPDATE;
END
$$;

-- createRule: legacy type, offered type, input, assertMayDemand, INSERT, audit.
CREATE OR REPLACE FUNCTION public.approval_rule_create(
  p_company_id pg_catalog.uuid, p_actor pg_catalog.text, p_name pg_catalog.text, p_document_type pg_catalog.text,
  p_condition_field pg_catalog.text, p_condition_operator pg_catalog.text, p_condition_value pg_catalog.numeric,
  p_approver_role pg_catalog.text
) RETURNS SETOF public.approval_rules
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_role pg_catalog.text;
  v_row public.approval_rules;
BEGIN
  PERFORM public.approval_rule_assert_caller(p_company_id, p_actor);
  v_role := public.approval_rule_actor_role(p_company_id, p_actor);
  CASE p_document_type
    WHEN 'credit_note' THEN
      RAISE EXCEPTION 'Approval rules of type credit_note no longer govern any credit note. Create a customer_credit_note or supplier_credit_note rule instead.'
        USING ERRCODE = 'RB003', DETAIL = p_document_type;
    WHEN 'payment' THEN
      RAISE EXCEPTION 'Approval rules of type payment no longer govern any supplier payment. Create a supplier_payment or payment_batch rule instead.'
        USING ERRCODE = 'RB003', DETAIL = p_document_type;
    WHEN 'journal_entry' THEN
      RAISE EXCEPTION 'Approval rules of type journal_entry no longer govern any journal. Create a manual_journal rule instead.'
        USING ERRCODE = 'RB003', DETAIL = p_document_type;
    ELSE NULL;
  END CASE;
  IF p_document_type IS NULL OR p_document_type <> ALL (ARRAY['supplier_invoice', 'customer_credit_note', 'supplier_credit_note',
       'customer_invoice', 'supplier_payment', 'payment_batch', 'manual_journal']::pg_catalog.text[]) THEN
    RAISE EXCEPTION 'documentType must be one of: supplier_invoice, customer_credit_note, supplier_credit_note, customer_invoice, supplier_payment, payment_batch, manual_journal'
      USING ERRCODE = 'RB004';
  END IF;
  IF p_name IS NULL THEN
    RAISE EXCEPTION 'name must be 1 to 100 characters of visible text, with no control characters' USING ERRCODE = 'RB005';
  END IF;
  PERFORM public.approval_rule_assert_input(p_name, p_approver_role, p_condition_operator, p_condition_field, p_condition_value);
  PERFORM public.approval_rule_assert_may_demand(v_role, COALESCE(p_approver_role, 'admin'));
  INSERT INTO public.approval_rules (company_id, name, document_type, condition_field, condition_operator, condition_value, approver_role)
  VALUES (p_company_id, public.approval_rule_js_trim(p_name), p_document_type, COALESCE(p_condition_field, 'total'),
          COALESCE(p_condition_operator, 'greater_than'), COALESCE(p_condition_value, 0), COALESCE(p_approver_role, 'admin'))
  RETURNING * INTO v_row;
  PERFORM public.approval_rule_audit(p_company_id, p_actor, v_role, 'create', v_row.id, NULL, v_row);
  RETURN NEXT v_row;
END
$$;

-- updateRule: input, assertMayDemand on the incoming role, then
-- assertMayEditRule under the row lock (rank at or above the rule's current
-- role; strictly above — owner at owner level — when the change weakens it),
-- UPDATE (NULL = unchanged), audit. No row: nothing returned (a 404).
CREATE OR REPLACE FUNCTION public.approval_rule_update(
  p_company_id pg_catalog.uuid, p_rule_id pg_catalog.uuid, p_actor pg_catalog.text, p_name pg_catalog.text,
  p_condition_field pg_catalog.text, p_condition_operator pg_catalog.text, p_condition_value pg_catalog.numeric,
  p_approver_role pg_catalog.text, p_is_active pg_catalog.bool
) RETURNS SETOF public.approval_rules
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_role pg_catalog.text;
  v_before public.approval_rules;
  v_after public.approval_rules;
  v_rule_role pg_catalog.text;
BEGIN
  PERFORM public.approval_rule_assert_caller(p_company_id, p_actor);
  v_role := public.approval_rule_actor_role(p_company_id, p_actor);
  PERFORM public.approval_rule_assert_input(p_name, p_approver_role, p_condition_operator, p_condition_field, p_condition_value);
  PERFORM public.approval_rule_assert_may_demand(v_role, p_approver_role);
  SELECT * INTO v_before FROM public.approval_rules r WHERE r.id = p_rule_id AND r.company_id = p_company_id FOR UPDATE;
  IF NOT FOUND THEN RETURN; END IF;
  v_rule_role := COALESCE(v_before.approver_role, 'admin');
  IF public.approval_actor_rank(v_role) < public.approval_required_rank(v_rule_role) THEN
    RAISE EXCEPTION 'This rule requires the % role; you do not hold it, so you cannot create, change or delete it', v_rule_role
      USING ERRCODE = 'RB001', DETAIL = v_rule_role;
  END IF;
  IF public.approval_rule_weakens(v_before, false, p_approver_role, p_is_active, p_condition_operator, p_condition_value)
     AND NOT public.approval_rule_may_weaken(v_role, v_rule_role) THEN
    RAISE EXCEPTION 'Only a role above % can lower, deactivate, delete or narrow this %-level rule', v_rule_role, v_rule_role
      USING ERRCODE = 'RB002', DETAIL = v_rule_role;
  END IF;
  UPDATE public.approval_rules r SET
    name = COALESCE(public.approval_rule_js_trim(p_name), r.name),
    condition_field = COALESCE(p_condition_field, r.condition_field),
    condition_operator = COALESCE(p_condition_operator, r.condition_operator),
    condition_value = COALESCE(p_condition_value, r.condition_value),
    approver_role = COALESCE(p_approver_role, r.approver_role),
    is_active = COALESCE(p_is_active, r.is_active),
    updated_at = pg_catalog.now()
  WHERE r.id = p_rule_id AND r.company_id = p_company_id
  RETURNING * INTO v_after;
  PERFORM public.approval_rule_audit(p_company_id, p_actor, v_role, 'update', p_rule_id, v_before, v_after);
  RETURN NEXT v_after;
END
$$;

-- deleteRule: assertMayEditRule('delete') under the lock, DELETE, audit. No
-- row: nothing returned (a 404). A rule a request names is a 23503, as before.
CREATE OR REPLACE FUNCTION public.approval_rule_delete(p_company_id pg_catalog.uuid, p_rule_id pg_catalog.uuid, p_actor pg_catalog.text)
RETURNS SETOF pg_catalog.uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_role pg_catalog.text;
  v_before public.approval_rules;
  v_rule_role pg_catalog.text;
BEGIN
  PERFORM public.approval_rule_assert_caller(p_company_id, p_actor);
  v_role := public.approval_rule_actor_role(p_company_id, p_actor);
  SELECT * INTO v_before FROM public.approval_rules r WHERE r.id = p_rule_id AND r.company_id = p_company_id FOR UPDATE;
  IF NOT FOUND THEN RETURN; END IF;
  v_rule_role := COALESCE(v_before.approver_role, 'admin');
  IF public.approval_actor_rank(v_role) < public.approval_required_rank(v_rule_role) THEN
    RAISE EXCEPTION 'This rule requires the % role; you do not hold it, so you cannot create, change or delete it', v_rule_role
      USING ERRCODE = 'RB001', DETAIL = v_rule_role;
  END IF;
  IF NOT public.approval_rule_may_weaken(v_role, v_rule_role) THEN
    RAISE EXCEPTION 'Only a role above % can lower, deactivate, delete or narrow this %-level rule', v_rule_role, v_rule_role
      USING ERRCODE = 'RB002', DETAIL = v_rule_role;
  END IF;
  DELETE FROM public.approval_rules r WHERE r.id = p_rule_id AND r.company_id = p_company_id;
  PERFORM public.approval_rule_audit(p_company_id, p_actor, v_role, 'delete', p_rule_id, v_before, NULL);
  RETURN NEXT p_rule_id;
END
$$;

-- ── 3. The enforcement switch ─────────────────────────────────────────────

-- The role of the strictest ACTIVE rule of the type, or NULL (strictestActiveRuleRole).
CREATE OR REPLACE FUNCTION public.approval_enforcement_strictest_role(p_company_id pg_catalog.uuid, p_document_type pg_catalog.text)
RETURNS pg_catalog.text
LANGUAGE sql STABLE
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT COALESCE(r.approver_role, 'admin') FROM public.approval_rules r
  WHERE r.company_id = p_company_id AND r.document_type = p_document_type AND r.is_active = true
  ORDER BY public.approval_required_rank(COALESCE(r.approver_role, 'admin')) DESC
  LIMIT 1
$$;

-- supplierBankVerifierRole: the strictest active supplier_payment or
-- payment_batch rule's role, never below admin.
CREATE OR REPLACE FUNCTION public.approval_enforcement_bank_verifier_role(p_company_id pg_catalog.uuid)
RETURNS pg_catalog.text
LANGUAGE plpgsql STABLE
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_strictest pg_catalog.text := 'admin';
  v_type pg_catalog.text;
  v_role pg_catalog.text;
BEGIN
  FOREACH v_type IN ARRAY ARRAY['supplier_payment', 'payment_batch'] LOOP
    v_role := public.approval_enforcement_strictest_role(p_company_id, v_type);
    IF v_role IS NOT NULL AND public.approval_required_rank(v_role) > public.approval_required_rank(v_strictest) THEN
      v_strictest := v_role;
    END IF;
  END LOOP;
  RETURN v_strictest;
END
$$;

-- recordBankBaseline (ap/supplierBankBaseline.ts), now written here because
-- the audit row records its count: only the company's first switch-on;
-- suppliers share-locked in id order; every non-deleted supplier with bank
-- details, no verification history, and details the switcher did not set.
CREATE OR REPLACE FUNCTION public.approval_enforcement_bank_baseline(p_company_id pg_catalog.uuid, p_actor pg_catalog.text)
RETURNS pg_catalog.int4
LANGUAGE plpgsql VOLATILE
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_count pg_catalog.int4;
BEGIN
  IF EXISTS (SELECT 1 FROM public.supplier_bank_verifications v WHERE v.company_id = p_company_id)
     OR EXISTS (SELECT 1 FROM public.audit_log a WHERE a.company_id = p_company_id AND a.entity_type = 'approval_enforcement'
                  AND a.entity_ref = 'supplier_bank_details' AND a.action = 'create') THEN
    RETURN 0;
  END IF;
  PERFORM 1 FROM public.suppliers s WHERE s.company_id = p_company_id ORDER BY s.id FOR SHARE;
  WITH inserted AS (
    INSERT INTO public.supplier_bank_verifications (company_id, supplier_id, fingerprint, kind, verified_by)
    SELECT s.company_id, s.id,
           public.supplier_bank_fingerprint(s.bank_name, s.bank_account_number, s.bank_branch_code, s.bank_account_type, s.bank_account_holder),
           'baseline', p_actor
    FROM public.suppliers s
    WHERE s.company_id = p_company_id AND s.deleted_at IS NULL
      AND NOT (p_actor = ANY (COALESCE(s.bank_details_setters::pg_catalog.text[], '{}')))
      AND public.supplier_bank_details_present(s.bank_name, s.bank_account_number, s.bank_branch_code, s.bank_account_type, s.bank_account_holder)
      AND NOT EXISTS (SELECT 1 FROM public.supplier_bank_verifications v WHERE v.company_id = s.company_id AND v.supplier_id = s.id)
    RETURNING 1)
  SELECT pg_catalog.count(*)::pg_catalog.int4 INTO v_count FROM inserted;
  RETURN v_count;
END
$$;

-- enableEnforcement / disableEnforcement, for every coupled type (the two
-- payment types switch together), each changed row audited. Returns the rows
-- inserted or deleted, with the baseline count of a bank-control switch-on.
CREATE OR REPLACE FUNCTION public.approval_enforcement_set(
  p_company_id pg_catalog.uuid, p_document_type pg_catalog.text, p_enabled pg_catalog.bool, p_actor pg_catalog.text
) RETURNS TABLE (id pg_catalog.uuid, document_type pg_catalog.text, enabled_at pg_catalog.timestamptz,
                 enabled_by pg_catalog.text, baseline_suppliers pg_catalog.int4)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  v_role pg_catalog.text;
  v_bank pg_catalog.bool := p_document_type = 'supplier_bank_details';
  v_types pg_catalog.text[] := CASE WHEN p_document_type IN ('supplier_payment', 'payment_batch')
                                    THEN ARRAY['supplier_payment', 'payment_batch'] ELSE ARRAY[p_document_type] END;
  v_type pg_catalog.text;
  v_session pg_catalog.text;
  v_verifier pg_catalog.text;
  v_own pg_catalog.text;
  v_strictest pg_catalog.text;
  v_rule_role pg_catalog.text;
  v_row public.approval_enforcement;
  v_baseline pg_catalog.int4;
  v_extra pg_catalog.jsonb;
BEGIN
  PERFORM public.approval_rule_assert_caller(p_company_id, p_actor);
  IF p_enabled IS NULL THEN
    RAISE EXCEPTION 'enabled must be true or false' USING ERRCODE = 'RB020';
  END IF;
  v_role := public.approval_rule_actor_role(p_company_id, p_actor);
  IF p_enabled AND (p_document_type IS NULL OR p_document_type <> ALL (ARRAY['supplier_invoice', 'customer_credit_note',
       'supplier_credit_note', 'customer_invoice', 'supplier_payment', 'payment_batch', 'manual_journal',
       'supplier_bank_details']::pg_catalog.text[])) THEN
    RAISE EXCEPTION 'Approval enforcement is not available for % yet', p_document_type
      USING ERRCODE = 'RB010', DETAIL = COALESCE(p_document_type, '');
  END IF;
  IF v_bank THEN
    -- A person in their own session, enabling and disabling alike (assertVerifyingSession).
    v_session := public.approval_request_session_actor();
    IF v_session <> 'self' THEN
      RAISE EXCEPTION '%', CASE v_session WHEN 'impersonation'
          THEN 'Supplier bank details cannot be verified while impersonating another user. End the impersonation and act as yourself.'
          ELSE 'Supplier bank details can only be verified by a person signed in as themselves.' END
        USING ERRCODE = 'RB012', DETAIL = v_session;
    END IF;
    v_verifier := public.approval_enforcement_bank_verifier_role(p_company_id);
  END IF;

  IF p_enabled THEN
    IF v_bank THEN
      -- ownCompanyRole: the switcher's own role while a member in good standing.
      SELECT cu.role::pg_catalog.text INTO v_own
      FROM public.company_users cu JOIN public.users u ON u.id = cu.user_id
      WHERE cu.company_id = p_company_id AND cu.user_id = p_actor
        AND u.is_active IS TRUE AND u.suspended_at IS NULL
        AND (u.status IS NULL OR pg_catalog.lower(u.status) = 'active');
      IF v_own IS NULL OR public.approval_actor_rank(v_own) < public.approval_required_rank(v_verifier) THEN
        RAISE EXCEPTION 'Switching supplier bank verification on accepts every supplier''s current bank details as verified, so it needs the % role or above — the role that verifies them.', v_verifier
          USING ERRCODE = 'RB013', DETAIL = v_verifier;
      END IF;
    END IF;
    FOREACH v_type IN ARRAY v_types LOOP
      INSERT INTO public.approval_enforcement AS e (company_id, document_type, enabled_by)
      VALUES (p_company_id, v_type, p_actor)
      ON CONFLICT ON CONSTRAINT approval_enforcement_company_type_uq DO NOTHING
      RETURNING e.* INTO v_row;
      CONTINUE WHEN v_row.id IS NULL;
      v_baseline := CASE WHEN v_bank THEN public.approval_enforcement_bank_baseline(p_company_id, p_actor) END;
      v_extra := CASE WHEN v_bank THEN pg_catalog.jsonb_build_object('baselineSuppliers', v_baseline::pg_catalog.text)
                      ELSE '{}'::pg_catalog.jsonb END;
      INSERT INTO public.audit_log (company_id, user_id, user_email, action, entity_type, entity_id, entity_ref, changes)
      VALUES (p_company_id, p_actor, public.approval_rule_actor_email(), 'create', 'approval_enforcement', v_row.id, v_row.document_type,
              pg_catalog.jsonb_build_object('fields', '[]'::pg_catalog.jsonb, 'metadata',
                pg_catalog.jsonb_build_object('actorRole', v_role, 'enforcementId', v_row.id::pg_catalog.text) || v_extra));
      id := v_row.id; document_type := v_row.document_type; enabled_at := v_row.enabled_at; enabled_by := v_row.enabled_by;
      baseline_suppliers := v_baseline;
      RETURN NEXT;
      v_row := NULL;
    END LOOP;
    RETURN;
  END IF;

  -- Off: the authority to weaken the strictest active rule of ANY coupled
  -- type — or, for the bank control, the verifier role.
  IF v_bank THEN
    v_strictest := v_verifier;
  ELSE
    FOREACH v_type IN ARRAY v_types LOOP
      v_rule_role := public.approval_enforcement_strictest_role(p_company_id, v_type);
      IF v_rule_role IS NOT NULL AND (v_strictest IS NULL
          OR public.approval_required_rank(v_rule_role) > public.approval_required_rank(v_strictest)) THEN
        v_strictest := v_rule_role;
      END IF;
    END LOOP;
  END IF;
  IF v_strictest IS NOT NULL AND NOT public.approval_rule_may_weaken(v_role, v_strictest) THEN
    RAISE EXCEPTION '%', CASE WHEN v_bank
        THEN 'Switching supplier bank verification off lets unverified bank details be paid. Bank details are verified at the '
             || v_strictest || ' level, so only a role above ' || v_strictest || ' (or the owner, at owner level) may switch it off'
        ELSE 'Switching ' || p_document_type || ' approval enforcement off weakens an active ' || v_strictest
             || '-level rule: only a role above ' || v_strictest || ' (or the owner, for an owner-level rule) may do it' END
      USING ERRCODE = 'RB011', DETAIL = v_strictest;
  END IF;
  FOREACH v_type IN ARRAY v_types LOOP
    DELETE FROM public.approval_enforcement e WHERE e.company_id = p_company_id AND e.document_type = v_type
    RETURNING e.* INTO v_row;
    CONTINUE WHEN v_row.id IS NULL;
    INSERT INTO public.audit_log (company_id, user_id, user_email, action, entity_type, entity_id, entity_ref, changes)
    VALUES (p_company_id, p_actor, public.approval_rule_actor_email(), 'delete', 'approval_enforcement', v_row.id, v_row.document_type,
            pg_catalog.jsonb_build_object('fields', '[]'::pg_catalog.jsonb, 'metadata',
              pg_catalog.jsonb_build_object('actorRole', v_role, 'enforcementId', v_row.id::pg_catalog.text)
              || CASE WHEN v_strictest IS NOT NULL THEN pg_catalog.jsonb_build_object('strictestRuleRole', v_strictest)
                      ELSE '{}'::pg_catalog.jsonb END));
    id := v_row.id; document_type := v_row.document_type; enabled_at := v_row.enabled_at; enabled_by := v_row.enabled_by;
    baseline_suppliers := NULL;
    RETURN NEXT;
    v_row := NULL;
  END LOOP;
END
$$;

-- ── 4. Function privileges ────────────────────────────────────────────────
-- Strip EXECUTE from every grantee but the owner (PUBLIC's default, and any
-- default-ACL grant an environment adds) on EXACTLY the functions this
-- migration creates — named, never matched by prefix: approval_rule_matches
-- and approval_rule_strictest_rank (648/708) share the prefix, and the app
-- calls them as app_user. Then grant the five writers to app_user only.
DO $$
DECLARE
  v_fn pg_catalog.regprocedure;
  v_grantee pg_catalog.text;
BEGIN
  FOREACH v_fn IN ARRAY ARRAY[
    'public.approval_rule_assert_caller(pg_catalog.uuid,pg_catalog.text)',
    'public.approval_rule_actor_role(pg_catalog.uuid,pg_catalog.text)',
    'public.approval_rule_may_weaken(pg_catalog.text,pg_catalog.text)',
    'public.approval_rule_js_trim(pg_catalog.text)',
    'public.approval_rule_name_ok(pg_catalog.text)',
    'public.approval_rule_amount_ok(pg_catalog.numeric)',
    'public.approval_rule_assert_input(pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.numeric)',
    'public.approval_rule_assert_may_demand(pg_catalog.text,pg_catalog.text)',
    'public.approval_rule_weakens(public.approval_rules,pg_catalog.bool,pg_catalog.text,pg_catalog.bool,pg_catalog.text,pg_catalog.numeric)',
    'public.approval_rule_audit_fields(public.approval_rules,public.approval_rules)',
    'public.approval_rule_actor_email()',
    'public.approval_rule_audit(pg_catalog.uuid,pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.uuid,public.approval_rules,public.approval_rules)',
    'public.approval_rule_lock(pg_catalog.uuid,pg_catalog.uuid,pg_catalog.text)',
    'public.approval_rule_create(pg_catalog.uuid,pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.numeric,pg_catalog.text)',
    'public.approval_rule_update(pg_catalog.uuid,pg_catalog.uuid,pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.numeric,pg_catalog.text,pg_catalog.bool)',
    'public.approval_rule_delete(pg_catalog.uuid,pg_catalog.uuid,pg_catalog.text)',
    'public.approval_enforcement_strictest_role(pg_catalog.uuid,pg_catalog.text)',
    'public.approval_enforcement_bank_verifier_role(pg_catalog.uuid)',
    'public.approval_enforcement_bank_baseline(pg_catalog.uuid,pg_catalog.text)',
    'public.approval_enforcement_set(pg_catalog.uuid,pg_catalog.text,pg_catalog.bool,pg_catalog.text)']::pg_catalog.regprocedure[]
  LOOP
    EXECUTE pg_catalog.format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', v_fn);
    FOR v_grantee IN
      SELECT DISTINCT pg_catalog.quote_ident(r.rolname)
      FROM pg_catalog.pg_proc p, pg_catalog.aclexplode(COALESCE(p.proacl, pg_catalog.acldefault('f', p.proowner))) a
      JOIN pg_catalog.pg_roles r ON r.oid = a.grantee
      WHERE p.oid = v_fn AND a.grantee <> p.proowner
    LOOP
      EXECUTE pg_catalog.format('REVOKE ALL ON FUNCTION %s FROM %s', v_fn, v_grantee);
    END LOOP;
  END LOOP;
END $$;
GRANT EXECUTE ON FUNCTION
  public.approval_rule_lock(pg_catalog.uuid, pg_catalog.uuid, pg_catalog.text),
  public.approval_rule_create(pg_catalog.uuid, pg_catalog.text, pg_catalog.text, pg_catalog.text, pg_catalog.text, pg_catalog.text, pg_catalog.numeric, pg_catalog.text),
  public.approval_rule_update(pg_catalog.uuid, pg_catalog.uuid, pg_catalog.text, pg_catalog.text, pg_catalog.text, pg_catalog.text, pg_catalog.numeric, pg_catalog.text, pg_catalog.bool),
  public.approval_rule_delete(pg_catalog.uuid, pg_catalog.uuid, pg_catalog.text),
  public.approval_enforcement_set(pg_catalog.uuid, pg_catalog.text, pg_catalog.bool, pg_catalog.text)
TO app_user;

-- ── 5. The tables: every write privilege of every role but the owner ──────
-- Enumerated from the ACL (table- and column-level), as 872 does. SELECT
-- stays: every gate reads both tables.
DO $$
DECLARE
  v_table pg_catalog.text;
  v_grantee pg_catalog.text;
  v_col pg_catalog.text;
BEGIN
  FOREACH v_table IN ARRAY ARRAY['approval_rules', 'approval_enforcement'] LOOP
    FOR v_grantee IN
      SELECT DISTINCT CASE a.grantee WHEN 0 THEN 'PUBLIC' ELSE pg_catalog.quote_ident(r.rolname) END
      FROM pg_catalog.pg_class c, pg_catalog.aclexplode(c.relacl) a
      LEFT JOIN pg_catalog.pg_roles r ON r.oid = a.grantee
      WHERE c.oid = ('public.' || v_table)::pg_catalog.regclass
        AND a.grantee <> c.relowner
        AND a.privilege_type IN ('INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'TRIGGER')
    LOOP
      EXECUTE pg_catalog.format('REVOKE INSERT, UPDATE, DELETE, TRUNCATE, TRIGGER ON public.%I FROM %s CASCADE', v_table, v_grantee);
    END LOOP;
    FOR v_grantee, v_col IN
      SELECT DISTINCT CASE a.grantee WHEN 0 THEN 'PUBLIC' ELSE pg_catalog.quote_ident(r.rolname) END,
             pg_catalog.quote_ident(att.attname)
      FROM pg_catalog.pg_attribute att, pg_catalog.aclexplode(att.attacl) a
      LEFT JOIN pg_catalog.pg_roles r ON r.oid = a.grantee
      WHERE att.attrelid = ('public.' || v_table)::pg_catalog.regclass AND att.attacl IS NOT NULL
        AND a.privilege_type IN ('INSERT', 'UPDATE')
    LOOP
      EXECUTE pg_catalog.format('REVOKE INSERT (%s), UPDATE (%s) ON public.%I FROM %s CASCADE', v_col, v_col, v_table, v_grantee);
    END LOOP;
  END LOOP;
END $$;

-- ── 6. Assertions: refuse to ship it any other way ────────────────────────
-- The exemption is 872's (#680): only the role RUNNING this migration, when
-- it inherits the owner (the deploy role `postgres` on production, a member
-- of `migration_admin`). Any other member of the owner still refuses it.
DO $$
DECLARE
  v_table pg_catalog.text;
  v_owner pg_catalog.oid;
  v_role pg_catalog.text;
  v_priv pg_catalog.text;
  v_fn pg_catalog.text;
BEGIN
  FOREACH v_table IN ARRAY ARRAY['approval_rules', 'approval_enforcement'] LOOP
    v_owner := (SELECT c.relowner FROM pg_catalog.pg_class c WHERE c.oid = ('public.' || v_table)::pg_catalog.regclass);
    FOR v_role IN
      SELECT r.rolname FROM pg_catalog.pg_roles r
      WHERE NOT r.rolsuper AND r.oid <> v_owner AND r.rolname !~ '^pg_'
        AND NOT (r.rolname = session_user AND pg_catalog.pg_has_role(r.oid, v_owner, 'USAGE'))
      UNION ALL SELECT 'public'
    LOOP
      FOREACH v_priv IN ARRAY ARRAY['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'TRIGGER'] LOOP
        IF pg_catalog.has_table_privilege(v_role, 'public.' || v_table, v_priv) THEN
          RAISE EXCEPTION 'migration 881: % still holds % on %', v_role, v_priv, v_table;
        END IF;
      END LOOP;
      FOREACH v_priv IN ARRAY ARRAY['INSERT', 'UPDATE'] LOOP
        IF pg_catalog.has_any_column_privilege(v_role, 'public.' || v_table, v_priv) THEN
          RAISE EXCEPTION 'migration 881: % still holds column % on %', v_role, v_priv, v_table;
        END IF;
      END LOOP;
    END LOOP;
    FOREACH v_role IN ARRAY ARRAY['app_user', 'platform_admin'] LOOP
      IF NOT pg_catalog.has_table_privilege(v_role, 'public.' || v_table, 'SELECT') THEN
        RAISE EXCEPTION 'migration 881: % lost SELECT on %', v_role, v_table;
      END IF;
    END LOOP;
  END LOOP;

  -- The functions: the owner (and superusers, and the deploy role through
  -- the owner) and, for the five writers, app_user (or the deploy role
  -- through it) — nobody else.
  FOR v_fn, v_role IN
    SELECT p.oid::pg_catalog.regprocedure::pg_catalog.text, r.rolname
    FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
    CROSS JOIN (SELECT rolname, oid FROM pg_catalog.pg_roles WHERE NOT rolsuper AND rolname !~ '^pg_'
                UNION ALL SELECT 'public', 0) r
    WHERE p.oid = ANY (ARRAY[
        'public.approval_rule_assert_caller(pg_catalog.uuid,pg_catalog.text)',
        'public.approval_rule_actor_role(pg_catalog.uuid,pg_catalog.text)',
        'public.approval_rule_may_weaken(pg_catalog.text,pg_catalog.text)',
        'public.approval_rule_js_trim(pg_catalog.text)',
        'public.approval_rule_name_ok(pg_catalog.text)',
        'public.approval_rule_amount_ok(pg_catalog.numeric)',
        'public.approval_rule_assert_input(pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.numeric)',
        'public.approval_rule_assert_may_demand(pg_catalog.text,pg_catalog.text)',
        'public.approval_rule_weakens(public.approval_rules,pg_catalog.bool,pg_catalog.text,pg_catalog.bool,pg_catalog.text,pg_catalog.numeric)',
        'public.approval_rule_audit_fields(public.approval_rules,public.approval_rules)',
        'public.approval_rule_actor_email()',
        'public.approval_rule_audit(pg_catalog.uuid,pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.uuid,public.approval_rules,public.approval_rules)',
        'public.approval_rule_lock(pg_catalog.uuid,pg_catalog.uuid,pg_catalog.text)',
        'public.approval_rule_create(pg_catalog.uuid,pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.numeric,pg_catalog.text)',
        'public.approval_rule_update(pg_catalog.uuid,pg_catalog.uuid,pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.numeric,pg_catalog.text,pg_catalog.bool)',
        'public.approval_rule_delete(pg_catalog.uuid,pg_catalog.uuid,pg_catalog.text)',
        'public.approval_enforcement_strictest_role(pg_catalog.uuid,pg_catalog.text)',
        'public.approval_enforcement_bank_verifier_role(pg_catalog.uuid)',
        'public.approval_enforcement_bank_baseline(pg_catalog.uuid,pg_catalog.text)',
        'public.approval_enforcement_set(pg_catalog.uuid,pg_catalog.text,pg_catalog.bool,pg_catalog.text)']::pg_catalog.regprocedure[]::pg_catalog.oid[])
      AND r.oid <> p.proowner
      AND NOT (r.rolname = session_user AND pg_catalog.pg_has_role(r.oid, p.proowner, 'USAGE'))
      AND NOT ((r.rolname = 'app_user' OR (r.rolname = session_user AND pg_catalog.pg_has_role(r.oid, 'app_user', 'USAGE')))
               AND p.proname IN ('approval_rule_lock', 'approval_rule_create', 'approval_rule_update',
                                 'approval_rule_delete', 'approval_enforcement_set'))
  LOOP
    IF pg_catalog.has_function_privilege(v_role, v_fn, 'EXECUTE') THEN
      RAISE EXCEPTION 'migration 881: % may still execute %', v_role, v_fn;
    END IF;
  END LOOP;

  FOREACH v_fn IN ARRAY ARRAY[
      'public.approval_rule_lock(pg_catalog.uuid,pg_catalog.uuid,pg_catalog.text)',
      'public.approval_rule_create(pg_catalog.uuid,pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.numeric,pg_catalog.text)',
      'public.approval_rule_update(pg_catalog.uuid,pg_catalog.uuid,pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.numeric,pg_catalog.text,pg_catalog.bool)',
      'public.approval_rule_delete(pg_catalog.uuid,pg_catalog.uuid,pg_catalog.text)',
      'public.approval_enforcement_set(pg_catalog.uuid,pg_catalog.text,pg_catalog.bool,pg_catalog.text)'] LOOP
    -- FORCE RLS on both tables binds the definer's owner too: one without
    -- BYPASSRLS would find no row and write nothing.
    IF NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_roles r ON r.oid = p.proowner
      WHERE p.oid = v_fn::pg_catalog.regprocedure AND p.prosecdef AND (r.rolbypassrls OR r.rolsuper)
    ) THEN
      RAISE EXCEPTION 'migration 881: % must be SECURITY DEFINER with an owner that bypasses RLS', v_fn;
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_proc p
      WHERE p.oid = v_fn::pg_catalog.regprocedure
        AND p.proconfig[pg_catalog.array_upper(p.proconfig, 1)] ~ '^search_path=.*pg_temp$'
    ) THEN
      RAISE EXCEPTION 'migration 881: % must pin search_path with pg_temp last', v_fn;
    END IF;
    IF pg_catalog.has_function_privilege('public', v_fn, 'EXECUTE')
       OR NOT pg_catalog.has_function_privilege('app_user', v_fn, 'EXECUTE') THEN
      RAISE EXCEPTION 'migration 881: % must be executable by app_user and not by PUBLIC', v_fn;
    END IF;
  END LOOP;

  -- The functions that only SHARE the prefix keep what they had: the app
  -- matches rules through them as app_user.
  FOREACH v_fn IN ARRAY ARRAY['public.approval_rule_matches(pg_catalog.uuid,pg_catalog.text,pg_catalog.numeric)',
                               'public.approval_rule_strictest_rank(pg_catalog.uuid,pg_catalog.text,pg_catalog.numeric)'] LOOP
    IF NOT pg_catalog.has_function_privilege('app_user', v_fn, 'EXECUTE') THEN
      RAISE EXCEPTION 'migration 881: app_user lost EXECUTE on %', v_fn;
    END IF;
  END LOOP;
END $$;

-- ── 7. By outcome, as each role the runner may become ─────────────────────
-- One savepoint per probe; every statement matches no row. TRUNCATE is
-- asserted above by privilege only. On production the deploy role is a
-- member of app_user, not of platform_admin: the latter is probed only where
-- the runner can become it.
DO $$
DECLARE
  v_role pg_catalog.text;
  v_sql pg_catalog.text;
BEGIN
  FOREACH v_role IN ARRAY ARRAY['app_user', 'platform_admin'] LOOP
    CONTINUE WHEN NOT pg_catalog.pg_has_role(session_user, v_role, 'MEMBER');
    EXECUTE pg_catalog.format('SET LOCAL ROLE %I', v_role);
    FOREACH v_sql IN ARRAY ARRAY[
        'INSERT INTO public.approval_rules (name, document_type) SELECT ''x'', ''supplier_invoice'' WHERE false',
        'UPDATE public.approval_rules SET is_active = false WHERE false',
        'DELETE FROM public.approval_rules WHERE false',
        'SELECT 1 FROM public.approval_rules WHERE false FOR UPDATE',
        'INSERT INTO public.approval_enforcement (company_id, document_type, enabled_by) SELECT NULL, ''supplier_invoice'', ''x'' WHERE false',
        'UPDATE public.approval_enforcement SET enabled_by = ''x'' WHERE false',
        'DELETE FROM public.approval_enforcement WHERE false',
        'SELECT 1 FROM public.approval_enforcement WHERE false FOR UPDATE'] LOOP
      BEGIN
        EXECUTE v_sql;
        RAISE EXCEPTION 'migration 881: % may still run: %', v_role, v_sql USING ERRCODE = 'RA999';
      EXCEPTION WHEN insufficient_privilege THEN
        NULL; -- refused, as intended
      END;
    END LOOP;
    RESET ROLE;
  END LOOP;
END $$;
