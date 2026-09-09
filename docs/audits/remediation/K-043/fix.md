# K-043 fix — self-approval and approver role on the decide path

**Trigger.** `decideRequest` updated on `id + company_id + status='pending'` alone: `decided_by`
was never compared with `requested_by`, and `approval_rules.approver_role` was read by nobody on
the decide path. A manager raised a R250,000 request under an owner-only rule and approved it
himself — HTTP 200, row durably `approved`.

**After.** `decideRequest` calls `assertMayDecide` before the UPDATE. One company-scoped SELECT
reads the pending request, its rule and the decider's `company_users` row, then refuses two ways:
`SELF_APPROVAL_FORBIDDEN` (decider raised it) and `APPROVER_ROLE_REQUIRED` (decider's per-company
role ranks below the rule's `approver_role`). Both apply to reject as well as approve. The route
maps them to 403 with the code in `error.details.reason`; unknown/already-decided still reports
"not found or already decided". Rank is a local ladder, not `ROLE_HIERARCHY` from
`@/lib/auth/types` — that map has no `accountant` or `user` entry and its `?? 0` fallback would
let anybody satisfy an `accountant` rule (a migration-234 default). Unrecognised rule role falls
back to `admin`, the column default; a higher role satisfies a lower requirement.

**Files.** `src/modules/accounting/services/gl/approvalAuthority.ts` (new, 82 lines),
`approvalService.ts` (+2), `pages/api/accounting/approval-requests.ts` (+13/-3).

**Tests.** `tests/integration/k-043-self-approval-and-approver-role.int.test.ts` (1, validator's
RED case) and `tests/integration/k-043-approval-authority.int.test.ts` (5 new: wrong role refused,
requester refused even when their role satisfies the rule, decider authenticated to another
company, correct role approves, rejection path). 6 passed on the fixture Postgres; mutation-proofed
three ways — see `green.log`.

**Migration / rollback.** None. Revert the commit.

**Historical impact.** Already-decided requests may have been self-approved or approved below the
rule's role. Read-only query, not run here:
```sql
SELECT ar.id, ar.company_id, ar.document_type, ar.document_id, ar.amount,
       ar.requested_by, ar.decided_by, ar.decided_at, rl.approver_role, cu.role AS decider_role,
       (ar.decided_by = ar.requested_by) AS self_approved
FROM approval_requests ar
LEFT JOIN approval_rules rl ON rl.id = ar.rule_id AND rl.company_id = ar.company_id
LEFT JOIN company_users cu ON cu.company_id = ar.company_id AND cu.user_id = ar.decided_by::TEXT
WHERE ar.status IN ('approved','rejected')
  AND (ar.decided_by = ar.requested_by OR cu.role IS NULL OR cu.role <> rl.approver_role)
ORDER BY ar.decided_at DESC;
```
`cu.role <> rl.approver_role` over-reports (an owner clearing a manager rule matches); rank the
returned rows by hand.

**Limits.** No exemption for a sole owner who is also the only requester — such a company can no
longer clear its own approvals. If that is wanted it should be an explicit exemption, not the
check being off.
