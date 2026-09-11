-- The legal state machine of control_operation_approvals, enforced for every role.
--
-- Cancellation is recorded ONLY in status: decideOperationApproval writes no
-- decision row for it, and a requester may cancel an approval that is already
-- fully approved. Execution (lockPolicyThenApproval -> validateDecisions ->
-- assertApprovalExecutable) recomputes the decisions but trusts status for
-- everything else, so one UPDATE of status — app_user holds UPDATE(status)
-- (627), platform_admin UPDATE(status,consumed_at,consumed_effect_id) —
-- revived a cancelled approval. A consumed approval and its consumed_effect_id
-- are the evidence the statement-completeness, match-override, snapshot and
-- receipt-replay readers trust, so they must not be re-opened, erased or forged.
--
-- The transitions the code makes (approvalRequestService, approvalExecutionService):
--   pending  -> pending    a decision that leaves a policy open (decided_at)
--   pending  -> approved   every bound policy has an independent approval
--   pending  -> rejected | cancelled
--   approved -> cancelled  the requester withdraws it
--   approved -> consumed   execution, naming the effect it committed, exactly once
-- Expiry writes nothing: it is expires_at against the clock. rejected,
-- cancelled and consumed are terminal. Nothing else changes after the INSERT:
-- expires_at may be brought forward, never extended.
CREATE OR REPLACE FUNCTION public.control_guard_approval_transition() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE
  -- entity_id_canonical is generated from entity_id, and is not yet computed in a BEFORE trigger.
  v_moving CONSTANT text[] := ARRAY['status','decided_at','consumed_at','consumed_effect_id','expires_at','entity_id_canonical'];
BEGIN
  IF (to_jsonb(NEW) - v_moving) IS DISTINCT FROM (to_jsonb(OLD) - v_moving) THEN
    RAISE EXCEPTION 'Approval transition refused: identity, binding and requester are immutable' USING ERRCODE='23514';
  END IF;
  IF OLD.status IN ('rejected','cancelled','consumed') THEN
    IF (to_jsonb(NEW) - 'entity_id_canonical') IS DISTINCT FROM (to_jsonb(OLD) - 'entity_id_canonical') THEN
      RAISE EXCEPTION 'Approval transition refused: % is terminal', OLD.status USING ERRCODE='23514';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.expires_at > OLD.expires_at THEN
    RAISE EXCEPTION 'Approval transition refused: expiry cannot be extended' USING ERRCODE='23514';
  END IF;
  IF OLD.decided_at IS NOT NULL AND NEW.decided_at IS NULL THEN
    RAISE EXCEPTION 'Approval transition refused: a decision time cannot be erased' USING ERRCODE='23514';
  END IF;
  IF NEW.status <> 'consumed' AND (NEW.consumed_at IS NOT NULL OR NEW.consumed_effect_id IS NOT NULL) THEN
    RAISE EXCEPTION 'Approval transition refused: only consumption records an effect' USING ERRCODE='23514';
  END IF;
  IF NEW.status = OLD.status THEN
    IF NEW.status = 'approved' AND NEW.decided_at IS DISTINCT FROM OLD.decided_at THEN
      RAISE EXCEPTION 'Approval transition refused: an approved approval takes no further decision' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
  END IF;
  IF (OLD.status, NEW.status) NOT IN (('pending','approved'),('pending','rejected'),('pending','cancelled'),
    ('approved','cancelled'),('approved','consumed')) THEN
    RAISE EXCEPTION 'Approval transition refused: % to %', OLD.status, NEW.status USING ERRCODE='23514';
  END IF;
  IF NEW.status = 'consumed' THEN
    IF NEW.decided_at IS DISTINCT FROM OLD.decided_at OR NEW.consumed_at IS NULL OR NEW.expires_at <= clock_timestamp()
      OR NOT EXISTS(SELECT 1 FROM public.control_operation_effects e WHERE e.company_id=NEW.company_id
        AND e.id=NEW.consumed_effect_id AND e.operation_id=NEW.operation_id AND e.operation=NEW.operation
        AND e.binding_hash=NEW.binding_hash)
      OR EXISTS(SELECT 1 FROM public.control_operation_approvals a WHERE a.company_id=NEW.company_id
        AND a.consumed_effect_id=NEW.consumed_effect_id AND a.id<>NEW.id) THEN
      RAISE EXCEPTION 'Approval transition refused: consumption must name its own committed effect before expiry' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.decided_at IS NULL THEN
    RAISE EXCEPTION 'Approval transition refused: a decision records its time' USING ERRCODE='23514';
  END IF;
  -- The rule validateDecisions applies at execution: an 'approved' decision by someone other than the requester
  -- for every bound policy. A binding without a policy array cannot be judged, so it is refused.
  IF NEW.status = 'approved' AND (NEW.expires_at <= clock_timestamp()
    OR jsonb_typeof(NEW.binding->'policies') IS DISTINCT FROM 'array'
    OR EXISTS(SELECT 1 FROM jsonb_array_elements(NEW.binding->'policies') p
      WHERE NOT EXISTS(SELECT 1 FROM public.control_operation_decisions d WHERE d.company_id=NEW.company_id
        AND d.approval_id=NEW.id AND d.policy_id=p->>'policyId' AND d.decision='approved'
        AND d.person_id<>NEW.requester_person_id))) THEN
    RAISE EXCEPTION 'Approval transition refused: approval requires an independent decision for every policy' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS control_guard_approval_transition ON control_operation_approvals;
CREATE TRIGGER control_guard_approval_transition BEFORE UPDATE ON control_operation_approvals
  FOR EACH ROW EXECUTE FUNCTION public.control_guard_approval_transition();
