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

**Files.** Counted at commit 9d8a142e, where K-043 alone landed:
`src/modules/accounting/services/gl/approvalAuthority.ts` (new, 82 lines), `approvalService.ts`
(+2), `pages/api/accounting/approval-requests.ts` (+13/-3). The later commits on this branch
(K-108, K-109, and the two review rounds) move those numbers; against 9d8a142e the branch tip has
`approvalAuthority.ts` at 140 lines, `approvalService.ts` +44/-112 (the `approvalMatching.ts`
split, 127 lines new), `approval-requests.ts` +32/-5, plus `approval-rules.ts` and
`pages/accounting/approvals/index.tsx`. Per-item file lists are in the K-108 and K-109 fix
documents.

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

## Blind-review dispositions (scratchpad/review-k043.md — 0 HIGH / 3 MEDIUM / 7 LOW)

**M1 — a lost decide race or an unknown id answered 500. FIXED.** `decideRequest` throws a typed
`ApprovalRequestNotFoundError`; the route maps it to 404 in the same catch as the 403. Two tests.

**M2 — the only consumer threw the 403 reason away. FIXED.** `pages/accounting/approvals/index.tsx`
reads the body on `!res.ok` and surfaces `error.message`, so a segregation-of-duties refusal no
longer reads as a network failure. Rendered test, not grepped:
`tests/unit/components/approvalDecisionErrorSurface.test.tsx` (3).

**M3 — the role requirement failed OPEN when the rule row was missing. FIXED, both halves.**
`assertMayDecide` refuses `APPROVER_ROLE_REQUIRED` when `rule_id` is set but no company-scoped rule
came back, instead of falling back to `admin`; and `requestApproval` is now an `INSERT ... SELECT`
scoped to the company, so the id cannot be planted in the first place (that half is K-109).

**L1 — two rank ladders with nothing keeping them in step. FIXED.** `APPROVER_RANK` is exported and
`tests/unit/services/gl/approverRankLadder.test.ts` (5) locks its ORDERING against `ROLE_HIERARCHY`
pair by pair, plus coverage of the `accountant`/`user` roles that map lacks. The numbers still
differ by design. `ROLE_HIERARCHY`'s own `?? 0` bug is left alone as the review advised.
**L2 — self-comparison done in JavaScript. FIXED.** Compared in SQL as `ar.requested_by::TEXT = $`.
**L3 — sole-owner deadlock. NOT FIXED, by design.** An exemption is a feature; see Limits above.
**L4 — `approver_role` unvalidated. FIXED.** Rejected against the ladder keys on create and update,
400 from the route. Two tests.
**L5 — test order coupling. FIXED.** The positive approve case has its own request row.
**L6 — module doc silent on the new files. FIXED.** `services/gl/.claude.md` + `AGENTS.md` mirror.
**L7 — impersonation defeats the control. NOT FIXED, out of scope.** A platform admin impersonating
an eligible approver passes the guard and `decided_by` records the impersonated user, so the audit
row does not say who actually approved. Pre-existing platform capability; worth its own item now
that a segregation-of-duties control leans on identity.

## Round-2 review dispositions (scratchpad/review-k043-r2.md — 0 HIGH / 2 MEDIUM / 7 LOW)

All nine fixed.

**M1 — `bookkeeper` assignable but absent from the ladder.** Added at rank 2, between `accountant`
and `storeman` on the evidence of `ALLOWED_COMPANY_ROLES`' descending order; the ladder is
renumbered 8..0 to make room. `ALLOWED_COMPANY_ROLES` is now exported and the coverage test
enumerates it, plus the invitation route's inline allowlist read out of source so adding a role
there fails the test rather than silently excluding it from every approval.

**M2 — both rank fallbacks untested; `?? 99` survived.** A missing `company_users` row is refused
outright (it also fixes LOW-6: `viewer` ranks 0 and `0 < 0` is false, so a non-member could decide
a viewer rule). Nine unit cases over `assertMayDecide` in
`tests/unit/services/gl/approvalDecisionAuthority.test.ts` cover both fallbacks; mutants M
(decider 0→99), N (rule admin→0) and O (membership check off) each kill two.

**L1 — the K-108 file was order-coupled.** The check test creates its own rule and the first test
scopes its assertion by name. Every test in both integration files now passes with `-t` alone.
**L2 — a legacy unreadable rule could not be deactivated, and failed as a 500.** Migration 647's
CHECK is scoped `OR is_active IS NOT TRUE`, so deactivation always succeeds while reactivation
still requires a real operator; 23514 maps to 400 on the route. Three integration cases plant a
legacy row by dropping the constraint and restoring the definition read back from the catalogue,
so the test cannot pass against an unscoped constraint (mutation R2).
**L3 — malformed ids answered 500.** `requestId` and `ruleId` are validated with `isUuidParam`; a
malformed request id gets the 404 this document already claimed, a malformed rule id a 400.
**L4 — stale file counts.** The "Files" line above now says which commit it counted.
**L5 — `APPROVER_RANK` prototype keys.** Both rank helpers go through `isApproverRole`.
**L6 — viewer rule satisfied by a non-member.** Covered by M2's refusal.
**L7 — `mapRequest` turned NULL `rule_id` into `"null"`.** Returns null; `ApprovalRequest.ruleId`
is `string | null`. No consumer outside the module reads it.
