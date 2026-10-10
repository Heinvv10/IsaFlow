-- 885: the `bank_rule` switch (forensic-controls step 2, migration 877)
-- through 881's SECURITY DEFINER approval_enforcement_set.
--
-- 881 (R-035 N1b B, PR #690) took every write on approval_enforcement from
-- app_user and routes each switch through approval_enforcement_set, whose
-- enforceable list predates `bank_rule`: switching bank-rule approval on or
-- off was refused (RB010). This redefines the function with a `bank_rule`
-- branch mirroring what approvalEnforcement.ts checks for it; every other
-- branch is 881's, unchanged:
--   - a person in their own session, on and off (RB012; DETAIL
--     impersonation|unknown) — 881's session classification;
--   - on: the switcher's own role, in good standing, at or above
--     bank_rule_approver_role (877: the strictest active manual_journal
--     rule's role, never below admin) — RB014 (DETAIL: that role);
--   - on: bankRuleAutoPostLock's per-company advisory lock, EXCLUSIVE, before
--     the row is written — enabled_at is a cutoff for switching auto-post on
--     (877, breaker R3-1), so no rule change records across it. Same key as
--     the TypeScript: 'bank_rule_auto_post:' || the company id as text;
--   - off: the authority to weaken that role (approval_rule_may_weaken) — RB011;
--   - the audit rows exactly as 881 writes them for every type.
-- Then re-asserts what 881 asserts of this function: SECURITY DEFINER with an
-- owner that bypasses RLS, search_path pinned with pg_temp last, EXECUTE for
-- app_user and its owner only (the deploy role exempt only as session_user,
-- as 872/881 do), and no write on approval_enforcement for any other role.
-- Runs after 881; idempotent (CREATE OR REPLACE keeps the owner and ACL).

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
  v_bank_rule pg_catalog.bool := p_document_type = 'bank_rule';
  v_types pg_catalog.text[] := CASE WHEN p_document_type IN ('supplier_payment', 'payment_batch')
                                    THEN ARRAY['supplier_payment', 'payment_batch'] ELSE ARRAY[p_document_type] END;
  v_type pg_catalog.text;
  v_session pg_catalog.text;
  v_verifier pg_catalog.text;
  v_approver pg_catalog.text;
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
       'supplier_bank_details', 'bank_rule']::pg_catalog.text[])) THEN
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
  IF v_bank_rule THEN
    -- A person in their own session, on and off alike (bankControlRefusal assertHumanSession).
    v_session := public.approval_request_session_actor();
    IF v_session <> 'self' THEN
      RAISE EXCEPTION '%', CASE v_session WHEN 'impersonation'
          THEN 'You cannot switch bank-rule approval ' || CASE WHEN p_enabled THEN 'on' ELSE 'off' END
               || ' while impersonating another user. End the impersonation and act as yourself.'
          ELSE 'Only a person signed in as themselves can switch bank-rule approval ' || CASE WHEN p_enabled THEN 'on' ELSE 'off' END
               || '; an agent or a job cannot.' END
        USING ERRCODE = 'RB012', DETAIL = v_session;
    END IF;
    -- bankRuleApproverRole: the strictest active manual_journal rule's role, never below admin (877).
    v_approver := public.bank_rule_approver_role(p_company_id);
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
    IF v_bank_rule THEN
      -- ownCompanyRole, as for supplier bank details: the switcher's own role while in good standing.
      SELECT cu.role::pg_catalog.text INTO v_own
      FROM public.company_users cu JOIN public.users u ON u.id = cu.user_id
      WHERE cu.company_id = p_company_id AND cu.user_id = p_actor
        AND u.is_active IS TRUE AND u.suspended_at IS NULL
        AND (u.status IS NULL OR pg_catalog.lower(u.status) = 'active');
      IF v_own IS NULL OR public.approval_actor_rank(v_own) < public.approval_required_rank(v_approver) THEN
        RAISE EXCEPTION 'Switching bank-rule approval on needs the % role or above — the role that approves bank-rule changes.', v_approver
          USING ERRCODE = 'RB014', DETAIL = v_approver;
      END IF;
      -- bankRuleAutoPostLock, EXCLUSIVE, before the row: enabled_at is a cutoff
      -- for switching auto-post on, so no rule change records across it (877, R3-1).
      PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('bank_rule_auto_post:' || p_company_id::pg_catalog.text, 0));
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
  ELSIF v_bank_rule THEN
    v_strictest := v_approver;
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
        WHEN v_bank_rule
        THEN 'Switching bank-rule approval off lets a rule that posts money change with nobody approving it. Bank-rule changes '
             || 'are approved at the ' || v_strictest || ' level, so only a role above ' || v_strictest
             || ' (or the owner, at owner level) may switch it off'
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

-- ── Privileges: as 881 — EXECUTE for the owner and app_user only ──────────
DO $$
DECLARE
  v_fn pg_catalog.regprocedure := 'public.approval_enforcement_set(pg_catalog.uuid,pg_catalog.text,pg_catalog.bool,pg_catalog.text)';
  v_grantee pg_catalog.text;
BEGIN
  EXECUTE pg_catalog.format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', v_fn);
  FOR v_grantee IN
    SELECT DISTINCT pg_catalog.quote_ident(r.rolname)
    FROM pg_catalog.pg_proc p, pg_catalog.aclexplode(COALESCE(p.proacl, pg_catalog.acldefault('f', p.proowner))) a
    JOIN pg_catalog.pg_roles r ON r.oid = a.grantee
    WHERE p.oid = v_fn AND a.grantee <> p.proowner AND r.rolname <> 'app_user'
  LOOP
    EXECUTE pg_catalog.format('REVOKE ALL ON FUNCTION %s FROM %s', v_fn, v_grantee);
  END LOOP;
END $$;
GRANT EXECUTE ON FUNCTION public.approval_enforcement_set(pg_catalog.uuid, pg_catalog.text, pg_catalog.bool, pg_catalog.text) TO app_user;

-- ── Assertions: 881's, for this function and its table ────────────────────
-- The exemption is 872's (#680): only the role RUNNING this migration, when
-- it inherits the owner (the deploy role `postgres` on production, a member
-- of `migration_admin`). Any other member of the owner still refuses it.
DO $$
DECLARE
  v_fn pg_catalog.text := 'public.approval_enforcement_set(pg_catalog.uuid,pg_catalog.text,pg_catalog.bool,pg_catalog.text)';
  v_owner pg_catalog.oid;
  v_role pg_catalog.text;
  v_priv pg_catalog.text;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_roles r ON r.oid = p.proowner
    WHERE p.oid = v_fn::pg_catalog.regprocedure AND p.prosecdef AND (r.rolbypassrls OR r.rolsuper)
  ) THEN
    RAISE EXCEPTION 'migration 885: % must be SECURITY DEFINER with an owner that bypasses RLS', v_fn;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_proc p
    WHERE p.oid = v_fn::pg_catalog.regprocedure
      AND p.proconfig[pg_catalog.array_upper(p.proconfig, 1)] ~ '^search_path=.*pg_temp$'
  ) THEN
    RAISE EXCEPTION 'migration 885: % must pin search_path with pg_temp last', v_fn;
  END IF;
  IF pg_catalog.has_function_privilege('public', v_fn, 'EXECUTE')
     OR NOT pg_catalog.has_function_privilege('app_user', v_fn, 'EXECUTE') THEN
    RAISE EXCEPTION 'migration 885: % must be executable by app_user and not by PUBLIC', v_fn;
  END IF;
  FOR v_role IN
    SELECT r.rolname FROM pg_catalog.pg_proc p
    CROSS JOIN (SELECT rolname, oid FROM pg_catalog.pg_roles WHERE NOT rolsuper AND rolname !~ '^pg_') r
    WHERE p.oid = v_fn::pg_catalog.regprocedure AND r.oid <> p.proowner AND r.rolname <> 'app_user'
      AND NOT (r.rolname = session_user AND (pg_catalog.pg_has_role(r.oid, p.proowner, 'USAGE')
                                             OR pg_catalog.pg_has_role(r.oid, 'app_user', 'USAGE')))
  LOOP
    IF pg_catalog.has_function_privilege(v_role, v_fn, 'EXECUTE') THEN
      RAISE EXCEPTION 'migration 885: % may still execute %', v_role, v_fn;
    END IF;
  END LOOP;

  v_owner := (SELECT c.relowner FROM pg_catalog.pg_class c WHERE c.oid = 'public.approval_enforcement'::pg_catalog.regclass);
  FOR v_role IN
    SELECT r.rolname FROM pg_catalog.pg_roles r
    WHERE NOT r.rolsuper AND r.oid <> v_owner AND r.rolname !~ '^pg_'
      AND NOT (r.rolname = session_user AND pg_catalog.pg_has_role(r.oid, v_owner, 'USAGE'))
    UNION ALL SELECT 'public'
  LOOP
    FOREACH v_priv IN ARRAY ARRAY['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'TRIGGER'] LOOP
      IF pg_catalog.has_table_privilege(v_role, 'public.approval_enforcement', v_priv) THEN
        RAISE EXCEPTION 'migration 885: % holds % on approval_enforcement', v_role, v_priv;
      END IF;
    END LOOP;
  END LOOP;
END $$;
