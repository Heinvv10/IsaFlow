# K-043 — self-approval allowed and approver role ignored

**Claim.** `decideRequest` filters on id, company and pending status only, never reading
`approver_role` or comparing the decider to the requester.

**Corrected trigger.** Two separate holes in one statement
(`src/modules/accounting/services/gl/approvalService.ts:236-244`). The UPDATE predicate is
`id = $1 AND company_id = $2 AND status = 'pending'`. `approval_rules.approver_role` — a
NOT NULL column populated on every rule — is loaded into `ApprovalRule.approverRole`
(:269) and read by nothing on the decide path. `requested_by` is never compared with
`decidedBy`. The route passes the caller's own id straight through
(`pages/api/accounting/approval-requests.ts:71`), and `withWriteAccess` admits any
owner/admin/manager, so a manager can approve an owner-only rule.

**Disposition: confirmed.**

**Evidence.** Baseline `origin/master` = `0f16391e`; file unchanged since `5661d6f0`.
RED test drives the real route against the disposable fixture:
`tests/integration/k-043-self-approval-and-approver-role.int.test.ts` — 1 test, 1 failed.
A `manager` raised a R250,000 supplier-invoice request under a rule whose `approver_role` is
`owner`, then approved it himself: HTTP 200, and the committed row reads
`status = 'approved'`, `decided_by = <the requester>`. Log:
`docs/audits/remediation/K-043/red.log`.

**Reachability.** Live API route, POST `action: 'approve'`, no extra gate. The 200 means
`withAuth` COMMITs (`withAuth.ts:224-226`), so the decision is durable.

**Proposed minimal fix.** In `decideRequest`, join the rule and refuse in SQL rather than in
the caller: add `FROM approval_rules rl` with `rl.id = approval_requests.rule_id`,
`approval_requests.requested_by <> ${decidedBy}::UUID`, and a membership test that the decider
holds `rl.approver_role` in `company_users` for this company. Take the decider's role as a
parameter from the route (`req.companyRole`) rather than re-querying. Keep the existing
"not found or already decided" throw so a refused decision is indistinguishable from a stale
one to an attacker.

**Historical impact.** Any already-decided request may have been self-approved or approved by
someone lacking the rule's role. Read-only impact query (not run here):
```sql
SELECT ar.id, ar.company_id, ar.document_type, ar.document_id, ar.amount,
       ar.requested_by, ar.decided_by, rl.approver_role, cu.role AS decider_role
FROM approval_requests ar
JOIN approval_rules rl ON rl.id = ar.rule_id
LEFT JOIN company_users cu ON cu.company_id = ar.company_id AND cu.user_id = ar.decided_by::text
WHERE ar.status = 'approved'
  AND (ar.decided_by = ar.requested_by OR cu.role IS DISTINCT FROM rl.approver_role);
```

**Risks.** Tightening this can strand requests in companies with a single owner who is also
the only person who raises them. Decide deliberately whether a sole owner may self-approve,
and if so encode it as an explicit exemption rather than leaving the check off.
