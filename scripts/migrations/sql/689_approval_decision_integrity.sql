-- A control_operation_decisions row is the proof of an independent approval, and validateDecisions trusts its
-- person_id. app_user holds INSERT (627) and the RLS policy checked only company_id, so a requester could INSERT a
-- decision naming a real admin, set the approval approved, and execute. Enforced here for every role, BYPASSRLS
-- included, beside the RLS check:
--   a decision is never changed or removed (UPDATE, DELETE, TRUNCATE refused);
--   its person is the acting person (auth.uid(), request.jwt.claims sub), a member of the company, and not the
--     requester;
--   it lands only on a pending, unexpired approval, for a policy that approval binds; the primary key
--     (company_id, approval_id, policy_id) already allows one decision per policy;
--   decided_at is the database's clock, which is what lets 688 tie a status change to a decision made in the
--     same transaction.
CREATE OR REPLACE FUNCTION public.control_guard_decision_append_only() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  RAISE EXCEPTION 'Approval decision refused: decisions are append-only' USING ERRCODE='23514';
END;
$$;

CREATE OR REPLACE FUNCTION public.control_guard_decision_insert() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_actor text := auth.uid()::text; v_approval record;
BEGIN
  IF v_actor IS NULL OR NEW.person_id IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'Approval decision refused: the decider must be the acting person' USING ERRCODE='23514';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM public.company_users cu WHERE cu.company_id=NEW.company_id AND cu.user_id::text=v_actor) THEN
    RAISE EXCEPTION 'Approval decision refused: the decider must be a member of the company' USING ERRCODE='23514';
  END IF;
  SELECT a.status,a.requester_person_id,a.binding,a.expires_at INTO v_approval FROM public.control_operation_approvals a
    WHERE a.company_id=NEW.company_id AND a.id=NEW.approval_id FOR SHARE;
  IF NOT FOUND OR v_approval.status <> 'pending' OR v_approval.expires_at <= clock_timestamp() THEN
    RAISE EXCEPTION 'Approval decision refused: a decision lands only on a pending, unexpired approval' USING ERRCODE='23514';
  END IF;
  IF v_approval.requester_person_id = v_actor THEN
    RAISE EXCEPTION 'Approval decision refused: the requester cannot decide their own approval' USING ERRCODE='23514';
  END IF;
  IF jsonb_typeof(v_approval.binding->'policies') IS DISTINCT FROM 'array' OR NOT EXISTS(
    SELECT 1 FROM jsonb_array_elements(v_approval.binding->'policies') p WHERE p->>'policyId' = NEW.policy_id) THEN
    RAISE EXCEPTION 'Approval decision refused: the policy is not bound to this approval' USING ERRCODE='23514';
  END IF;
  NEW.decided_at := clock_timestamp();
  RETURN NEW;
END;
$$;

ALTER FUNCTION public.control_guard_decision_insert() OWNER TO migration_admin;
REVOKE ALL ON FUNCTION public.control_guard_decision_insert() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.control_guard_decision_append_only() FROM PUBLIC;
DROP TRIGGER IF EXISTS control_guard_decision_insert ON control_operation_decisions;
CREATE TRIGGER control_guard_decision_insert BEFORE INSERT ON control_operation_decisions
  FOR EACH ROW EXECUTE FUNCTION public.control_guard_decision_insert();
DROP TRIGGER IF EXISTS control_guard_decision_append_only ON control_operation_decisions;
CREATE TRIGGER control_guard_decision_append_only BEFORE UPDATE OR DELETE ON control_operation_decisions
  FOR EACH ROW EXECUTE FUNCTION public.control_guard_decision_append_only();
DROP TRIGGER IF EXISTS control_guard_decision_truncate ON control_operation_decisions;
CREATE TRIGGER control_guard_decision_truncate BEFORE TRUNCATE ON control_operation_decisions
  FOR EACH STATEMENT EXECUTE FUNCTION public.control_guard_decision_append_only();

-- Defence in depth for app_user: the same person binding as a policy check.
DROP POLICY IF EXISTS tenant_isolation ON control_operation_decisions;
CREATE POLICY tenant_isolation ON control_operation_decisions TO app_user
  USING(company_id = app.current_company_id() AND company_id IN (SELECT auth.user_companies()))
  WITH CHECK(company_id = app.current_company_id() AND company_id IN (SELECT auth.user_companies())
    AND person_id = auth.uid()::text);
