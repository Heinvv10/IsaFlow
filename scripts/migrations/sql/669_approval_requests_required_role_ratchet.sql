-- 669 — a pending approval request remembers the authority it was raised under.
--
-- assertMayDecide computed the demanded role at DECIDE time from the bound rule,
-- read live. Both inputs to that computation are editable by an actor ranked at
-- or below the authority they encode:
--
--   * `approval_requests.rule_id` — rebindPendingRequest moved a pending row onto
--     whatever rule the current facts chose, in either direction, so raising the
--     bound rule's condition_value out of range handed the request to the laxer
--     rule beside it;
--   * `approval_rules.approver_role` / `is_active` — rule authority deliberately
--     lets an actor change any rule at or below their own rank, so the bound rule
--     could simply be handed down.
--
-- Either way an admin facing an admin-only request of their own could have a
-- manager clear it. The snapshot below is what makes the demand ratchet: it is
-- written when the request is raised, only ever raised afterwards, and the decide
-- path demands the HIGHER of it and the bound rule's live role.
--
-- Nullable on purpose. Rows raised before this migration keep NULL and are
-- governed by the live rule exactly as they were; the backfill only fills PENDING
-- rows, where the answer is knowable and still matters.

ALTER TABLE approval_requests ADD COLUMN IF NOT EXISTS required_role TEXT;

-- Company-scoped through the join: a rule of another tenant can never supply the
-- snapshot for this tenant's request, which is the same predicate assertMayDecide
-- uses to refuse a foreign rule outright.
UPDATE approval_requests ar
SET required_role = rl.approver_role
FROM approval_rules rl
WHERE rl.id = ar.rule_id
  AND rl.company_id = ar.company_id
  AND ar.company_id IS NOT NULL
  AND ar.status = 'pending'
  AND ar.required_role IS NULL
  AND rl.approver_role IS NOT NULL;
