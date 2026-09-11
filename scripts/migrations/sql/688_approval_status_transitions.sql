-- The legal life of a control_operation_approvals row, enforced for every role (no role is exempt; a BYPASSRLS
-- role meets the same triggers). Each edge is bound to the actor who may take it, not only to its from->to pair.
--
-- Why: cancellation is recorded ONLY in status, and execution (lockPolicyThenApproval -> validateDecisions ->
-- assertApprovalExecutable) recomputes the decisions but trusts status for everything else, so one UPDATE of
-- status by app_user (UPDATE(status), 627) or platform_admin revived a cancelled approval and executed it. A
-- pending or approved approval that is cancelled, rejected or expires stops counting its reserved exposure in the
-- aggregate window (aggregateOperationPolicy.ts), so a cancel by anyone but the requester, a rejection without a
-- decision, or a shortened expiry let a sibling operation run with no policy. Consumed approvals and their
-- consumed_effect_id are the evidence the completeness, match-override, snapshot and receipt-replay readers trust.
--
-- The acting person is auth.uid() (request.jwt.claims sub), which withAuth, the bearer pipeline and the platform
-- admin/import transaction all set. No acting person, no request, no decision, no cancel.
--
-- Birth (INSERT): the requester is the acting person; status is pending, or approved only when no policy binds
-- the operation (requestOperationApproval: nothing to decide, and execution needs no approval then); no decision
-- time, no consumption.
-- Edges (UPDATE), the only ones the services take (approvalRequestService, approvalExecutionService):
--   pending  -> pending    the acting person recorded an approved decision in this transaction, a policy is open
--   pending  -> approved   the same, and every bound policy has an approved decision by someone not the requester
--   pending  -> rejected   the acting person recorded a rejected decision in this transaction
--   pending | approved -> cancelled   the acting person is the requester
--   approved -> consumed   naming an effect committed in this transaction for this approval's company, operation,
--                          entity, operation id and binding, that no other approval claims
-- Every edge needs an unexpired approval. rejected, cancelled and consumed are terminal. Identity, binding,
-- requester, requested_at and expires_at never change. decided_at and consumed_at are the database's clock.
CREATE OR REPLACE FUNCTION public.control_guard_approval_birth() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_actor text := auth.uid()::text;
BEGIN
  IF v_actor IS NULL OR NEW.requester_person_id IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'Approval birth refused: the requester must be the acting person' USING ERRCODE='23514';
  END IF;
  IF NEW.decided_at IS NOT NULL OR NEW.consumed_at IS NOT NULL OR NEW.consumed_effect_id IS NOT NULL
    OR NOT (NEW.status = 'pending' OR (NEW.status = 'approved' AND NEW.binding->'policies' = '[]'::jsonb)) THEN
    RAISE EXCEPTION 'Approval birth refused: an approval is born pending, or approved only when no policy binds it'
      USING ERRCODE='23514';
  END IF;
  NEW.requested_at := clock_timestamp();
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.control_guard_approval_transition() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  -- entity_id_canonical is generated from entity_id, and is not yet computed in a BEFORE trigger.
  v_moving CONSTANT text[] := ARRAY['status','decided_at','consumed_at','consumed_effect_id','entity_id_canonical'];
  v_actor text := auth.uid()::text;
BEGIN
  IF (to_jsonb(NEW) - v_moving) IS DISTINCT FROM (to_jsonb(OLD) - v_moving) THEN
    RAISE EXCEPTION 'Approval transition refused: identity, binding, requester and expiry are immutable' USING ERRCODE='23514';
  END IF;
  IF OLD.status IN ('rejected','cancelled','consumed') THEN
    IF (to_jsonb(NEW) - 'entity_id_canonical') IS DISTINCT FROM (to_jsonb(OLD) - 'entity_id_canonical') THEN
      RAISE EXCEPTION 'Approval transition refused: % is terminal', OLD.status USING ERRCODE='23514';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.status <> 'consumed' AND (NEW.consumed_at IS NOT NULL OR NEW.consumed_effect_id IS NOT NULL) THEN
    RAISE EXCEPTION 'Approval transition refused: only consumption records an effect' USING ERRCODE='23514';
  END IF;
  IF NEW.status = OLD.status AND NEW.decided_at IS NOT DISTINCT FROM OLD.decided_at THEN RETURN NEW; END IF;
  IF (OLD.status, NEW.status) NOT IN (('pending','pending'),('pending','approved'),('pending','rejected'),
    ('pending','cancelled'),('approved','cancelled'),('approved','consumed')) THEN
    RAISE EXCEPTION 'Approval transition refused: % to %', OLD.status, NEW.status USING ERRCODE='23514';
  END IF;
  IF OLD.expires_at <= clock_timestamp() THEN
    RAISE EXCEPTION 'Approval transition refused: the approval has expired' USING ERRCODE='23514';
  END IF;

  IF NEW.status = 'consumed' THEN
    IF NEW.decided_at IS DISTINCT FROM OLD.decided_at OR NOT EXISTS(SELECT 1 FROM public.control_operation_effects e
        WHERE e.company_id=NEW.company_id AND e.id=NEW.consumed_effect_id AND e.operation_id=NEW.operation_id
          AND e.operation=NEW.operation AND e.entity_type=NEW.entity_type AND e.entity_id_canonical=OLD.entity_id_canonical
          AND e.binding_hash=NEW.binding_hash AND e.committed_at BETWEEN transaction_timestamp() AND clock_timestamp())
      OR EXISTS(SELECT 1 FROM public.control_operation_approvals a
        WHERE a.company_id=NEW.company_id AND a.consumed_effect_id=NEW.consumed_effect_id AND a.id<>NEW.id) THEN
      RAISE EXCEPTION 'Approval transition refused: consumption must name the effect this execution committed'
        USING ERRCODE='23514';
    END IF;
    NEW.consumed_at := clock_timestamp();
    RETURN NEW;
  END IF;

  -- Every other edge is a decision, and it is the acting person's.
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'Approval transition refused: a decision needs an acting person' USING ERRCODE='23514';
  END IF;
  IF NEW.status = 'cancelled' THEN
    IF v_actor <> OLD.requester_person_id THEN
      RAISE EXCEPTION 'Approval transition refused: only the requester can cancel' USING ERRCODE='23514';
    END IF;
  ELSIF NOT EXISTS(SELECT 1 FROM public.control_operation_decisions d
      WHERE d.company_id=NEW.company_id AND d.approval_id=NEW.id AND d.person_id=v_actor
        AND d.decided_at >= transaction_timestamp()
        AND d.decision = CASE WHEN NEW.status = 'rejected' THEN 'rejected' ELSE 'approved' END) THEN
    RAISE EXCEPTION 'Approval transition refused: the acting person recorded no such decision in this transaction'
      USING ERRCODE='23514';
  -- The rule validateDecisions applies at execution. A binding without a policy array cannot be judged.
  ELSIF NEW.status = 'approved' AND (jsonb_typeof(NEW.binding->'policies') IS DISTINCT FROM 'array'
    OR EXISTS(SELECT 1 FROM jsonb_array_elements(NEW.binding->'policies') p
      WHERE NOT EXISTS(SELECT 1 FROM public.control_operation_decisions d WHERE d.company_id=NEW.company_id
        AND d.approval_id=NEW.id AND d.policy_id=p->>'policyId' AND d.decision='approved'
        AND d.person_id<>NEW.requester_person_id))) THEN
    RAISE EXCEPTION 'Approval transition refused: approval requires an independent decision for every policy'
      USING ERRCODE='23514';
  END IF;
  NEW.decided_at := clock_timestamp();
  RETURN NEW;
END;
$$;

ALTER FUNCTION public.control_guard_approval_birth() OWNER TO migration_admin;
ALTER FUNCTION public.control_guard_approval_transition() OWNER TO migration_admin;
REVOKE ALL ON FUNCTION public.control_guard_approval_birth() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.control_guard_approval_transition() FROM PUBLIC;
DROP TRIGGER IF EXISTS control_guard_approval_birth ON control_operation_approvals;
CREATE TRIGGER control_guard_approval_birth BEFORE INSERT ON control_operation_approvals
  FOR EACH ROW EXECUTE FUNCTION public.control_guard_approval_birth();
DROP TRIGGER IF EXISTS control_guard_approval_transition ON control_operation_approvals;
CREATE TRIGGER control_guard_approval_transition BEFORE UPDATE ON control_operation_approvals
  FOR EACH ROW EXECUTE FUNCTION public.control_guard_approval_transition();
