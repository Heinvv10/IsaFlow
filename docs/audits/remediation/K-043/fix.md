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

## Round-3 review dispositions (scratchpad/review-k043-r3.md — 2 HIGH / 2 MEDIUM / 4 LOW)

All eight fixed. R-032 (admin impersonation) and R-033 (sole-owner deadlock) stay registered as
open and were not touched.

**H1 — 647 is idempotent on the constraint NAME, so a database that ran its earlier form keeps
the unscoped CHECK forever. FIXED by a new migration, not by editing 647 again.**
`scripts/migrations/sql/658_approval_rules_operator_check_rescope.sql` reads
`pg_get_constraintdef` and drops whatever constraint of that name does not mention `is_active`,
then adds the scoped one — idempotent by DEFINITION. 647 is left exactly as committed, because
editing an applied migration a second time is the defect. Applied out of transaction to the
disposable fixture in a scratch schema, both directions: a pre-edit (unscoped) constraint is
rescoped and a second run is a no-op; an already-scoped constraint keeps its `pg_constraint.oid`,
which proves it was not dropped and re-added. **Operators:** a database that applied the PRE-EDIT
647 fails `scripts/apply-migrations.ts` on a checksum mismatch for 647 before reaching 658 — clear
it with `scripts/migrations/resolve-checksum-conflicts.ts` first. A database that ran the older
`632_` filename has no conflict and diverges silently; 658 repairs it either way. 647 is unique
across all refs and production has run neither, so the exposure is `isaflow_dev`, the fixture, and
peer databases.

**H2 — the authority the decide guard reads is editable by the people it constrains. FIXED.**
`src/modules/accounting/services/gl/approvalRuleGuards.ts` (new): `assertMayEditRule` ranks the
actor's `company_users.role` against the rule's CURRENT `approver_role` on every PUT and DELETE,
using the ladder exported from `approvalAuthority` rather than a second copy, so an admin can no
longer lower an owner-only rule to their own role or deactivate it. An unrecognised
`approver_role` falls back to `admin`, mirroring the decide path. `auditRuleChange` writes an
`audit_log` row for create/update/delete through `logAuditOrThrow` — deliberately the throwing
variant: an unrecorded weakening of a separation-of-duties control is what this exists to prevent.
Rank, not `allowedRoles: ['owner']`, because ordinary administration of admin- and manager-level
rules must keep working; a test asserts that it does.

**M1 — three ids reach a `::UUID` cast unvalidated. FIXED.** `isUuidParam` on the PUT and DELETE
`id` of `approval-rules.ts` and on `documentId` of `approval-requests.ts` `?action=check`. 400,
not a 500 with a logged stack.

**M2 — nothing enforces the workflow; `checkApproval` has no posting-path caller. NOT FIXED —
out of K-043's scope, and the overclaim it caused IS fixed.** `services/gl/.claude.md` and its
`AGENTS.md` mirror now say the DECIDE path is enforced, not the workflow, and state plainly that a
document requiring approval can still be posted without one. Belongs to its own item.

**L1 — the role census read 2 of the 4 allowlists. FIXED.** `VALID_ROLES` is exported from
`userAccessService` and `userInvitationService`, and `approverRankLadder.test.ts` enumerates all
four. `tenantProvisioningService.ts:155`, `pages/api/invitations/[token]/accept.ts:70` and
`pages/api/invite/[token].ts:117` write `company_users.role` with no allowlist at all — recorded
here because there is no list a test can read.

**L2 — the operator allowlist lived only at the route. FIXED.** `assertConditionOperator` sits
beside `assertApproverRole` in `approvalService`, throwing `ApprovalOperatorInvalidError`, which
the route maps to 400. Any caller of the module is now covered, not just the HTTP route.

**L3 — the 23514 catch answered 400 on an aborted transaction. FIXED.** Every mutation runs inside
`withSavepoint('approval_rule_write', ...)`, so a caught check violation cannot discard a write
added above it in the same handler.

**L4 — DELETE reported success for a row it never touched. FIXED.** `deleteRule` returns whether a
row came back from `RETURNING id`; the route answers 404 otherwise. Another tenant's rule id is a
404 and that rule is left in place.

**Round-3 tests.** `tests/integration/k-043-r3-rule-authority.int.test.ts` (15: six on the H2
guard including two legitimate-administration cases and the audit trail, five on M1/L4 ids, four
on the 658 convergence including the end-to-end legacy-deactivation consequence),
`tests/unit/services/gl/approvalRuleAuthority.test.ts` (11),
`tests/unit/services/gl/approvalRuleOperatorGuard.test.ts` (6),
`tests/unit/api/approvalRulesSavepoint.test.ts` (6). Seven mutations, one per finding, each
turned the corresponding tests red — see `green.log`.

**Round-3 migration / rollback.** `658_approval_rules_operator_check_rescope.sql`. Rolling back
means restoring the unscoped CHECK, which reinstates the defect; there is no data to undo.

**Round-3 historical impact.** No rows are rewritten. Rules weakened before this branch left no
trace, since `approval_rules` had no history — the audit trail starts now. Read-only query for
rules whose `approver_role` sits below what their pending requests imply, not run here:
```sql
SELECT rl.id, rl.company_id, rl.name, rl.approver_role, rl.is_active, rl.updated_at,
       count(ar.id) FILTER (WHERE ar.status = 'pending') AS pending_requests
FROM approval_rules rl
LEFT JOIN approval_requests ar ON ar.rule_id = rl.id AND ar.company_id = rl.company_id
WHERE rl.updated_at > rl.created_at
GROUP BY rl.id
ORDER BY rl.updated_at DESC;
```

## Round-4 review dispositions (scratchpad/review-k043-r4.md — 1 HIGH / 2 MEDIUM / 4 LOW)

All seven addressed. R-032 (admin impersonation) and R-033 (sole-owner deadlock) stay registered
as open and were not touched. Migration 658 was re-verified by the reviewer on real PostgreSQL in
all three directions; not redone here.

**H1 — `createRule` had no rank guard and `requestApproval` took `ruleId` from the request body,
so the admin refused a weakening of the owner-only rule just minted a manager-level rule and named
it. FIXED, both halves.**
*Rank.* `assertMayDemand(actor, role)` in `approvalRuleGuards.ts` ranks the actor against the role
a rule is about to DEMAND: on create, against `input.approverRole || 'admin'` — the INSERT's own
default, because ranking only what the caller typed let a manager create an admin-level rule by
omitting the field — and on update, against the role it is being moved TO, which
`assertMayEditRule` never saw (it ranks the stored role, and still does; both run). Synchronous, so
no statement executes on a refusal. An actor may still set a rule anywhere at or BELOW their own
rank; what they cannot do is mint or touch one above it, which is the property the decide path
leans on.
*Rule selection.* `requestApproval` no longer accepts `ruleId`; the route does not read it. The
governing rule is resolved by `checkApproval` from the document type and amount, and the request is
returned unchanged if the document already has a pending one — a second request under a different
rule was the other way to choose. `ApprovalNotRequiredError` → 400 when no active rule governs.

**M1 — the branch's security claim is much narrower than the commit subject implies. ACCEPTED, and
the doc now says so plainly.** `services/gl/.claude.md` and its `AGENTS.md` mirror state that
`checkApproval` and `requestApproval` have exactly one caller each — this one route — that no UI
calls `?action=check`, and therefore that an operator can post a customer invoice, supplier
invoice, payment, journal entry or credit note of any amount under an active owner-only rule with
no approval request ever existing. Nothing creates a request as part of a document's lifecycle and
nothing reads a request's status before a write. The DECIDE path is enforced; the WORKFLOW is not.
Registered as R-035 (five posting services, needs a document-level `approval_status`).

**M2 — equal-priority rule selection was heap order and `priority` is unreachable. FIXED, and by
rank rather than by ordering alone.** The STRICTEST matching rule governs; `ORDER BY priority ASC,
created_at ASC, id ASC` is now only the tiebreak among rules of EQUAL rank. Ordering alone would
have left a laxer rule shadowing an owner-only one in whichever direction the tiebreak ran.
`priority` is deliberately still not writable through the API — exposing it would hand back a way
to reorder which rule governs — and the doc says so instead of pretending it is a control.

**L1 — `k108-k109` was order-coupled on a shared rule name. FIXED.** The second rule is
`'Payments over 1000 (valid operator)'`. Six `--sequence.shuffle` runs of the three files, green.
**L2 — `plantLegacyRule` dropped the constraint at auto-commit. FIXED.** It now runs
`BEGIN; LOCK TABLE approval_rules IN ACCESS EXCLUSIVE MODE; DROP; INSERT; ADD; COMMIT` on one
client, so no concurrent file observes the fixture without the constraint. Ten parallel runs of the
pair, 27/27 each.
**L3 — the round-3 doc entry was appended to the bottom of a newest-first list. FIXED.** Moved
above the round-2 line, with the round-4 entry above it.
**L4 — 658 skips 656 and 657. NOT A DEFECT, and no longer true.** Both are now claimed on other
branches (656 released as unused, 657 used by K-140/K-144); this branch changes nothing there.

**Round-4 tests.** `tests/integration/k-043-r4-rule-rank.int.test.ts` (9: the reviewer's bypass
sequence end to end including the manager 403 and the owner 200, a manager-only document still
decided by a manager, strictest-wins with the lax rule created FIRST, idempotent re-request, and
five rank cases on create/update),
`tests/unit/services/gl/approvalRuleRankGuard.test.ts` (11),
`tests/unit/services/gl/approvalStrictestRule.test.ts` (6). Five mutations, each red — see
`green.log`. Existing files adapted to the new contract: `k108-k109`'s K-109 block now asserts the
property that replaced `ruleId` (whatever the body names, the stored `rule_id` is resolved or
nothing is written), and `k-043-approval-authority`'s malformed-id case moved from `ruleId` to
`documentId`.

**Round-4 migration / rollback.** None. Revert the commit.

**Round-4 historical impact.** No rows are rewritten. Requests raised before this could name any
rule of the company, so a pending or decided request may be governed by a laxer rule than the one
that should have applied. Read-only, not run here — pending requests whose stored rule is not the
strictest active rule matching their document type and amount:
```sql
SELECT ar.id, ar.company_id, ar.document_type, ar.document_id, ar.amount,
       ar.status, ar.requested_by, ar.decided_by,
       named.approver_role AS named_role,
       array_agg(DISTINCT other.approver_role) AS other_matching_roles
FROM approval_requests ar
JOIN approval_rules named ON named.id = ar.rule_id AND named.company_id = ar.company_id
JOIN approval_rules other ON other.company_id = ar.company_id
                         AND other.document_type = ar.document_type
                         AND other.is_active = true
                         AND other.id <> named.id
                         AND (other.condition_operator = 'any'
                              OR (other.condition_operator = 'greater_than'
                                  AND COALESCE(ar.amount,0) > other.condition_value)
                              OR (other.condition_operator = 'greater_equal'
                                  AND COALESCE(ar.amount,0) >= other.condition_value))
GROUP BY ar.id, named.approver_role
ORDER BY ar.requested_at DESC;
```
Rank `named_role` against `other_matching_roles` by hand (the ladder is in `approvalAuthority.ts`);
a row where another matching rule demands MORE is one that was decided under the wrong authority.

## Round-5 review dispositions (scratchpad/review-k043-r5.md — 2 HIGH / 2 MEDIUM / 4 LOW)

All eight addressed. R-032 (admin impersonation), R-033 (sole-owner deadlock) and R-035 (no
posting-path enforcement) stay registered as open and were not touched. `priority`'s unwritability
and the totality of the rank order were re-verified by the reviewer; not redone here.

**H1 + H2 — the requester still chose their own governing rule, via `amount` and via
`documentType`/`documentId`. FIXED as one change: the rule is derived from a REAL document.**
The reviewer's ruling is accepted — this is the branch's own defect, not R-035. `checkApproval`
filters candidates by the operator/threshold comparison BEFORE strictest-wins ranks them, so a
rule that does not match is not a rule the ranking can pick: `amount: 1` for a R500 000 supplier
invoice dropped the `owner over 100k` rule out of the candidate set and bound the `manager any`
one. `documentType` did the same one level up, and nothing checked the document existed at all.
`src/modules/accounting/services/gl/approvalDocuments.ts` (new) resolves the document by
`(company_id, documentType, documentId)` — five types, one statement each; `payment` looks in
`customer_payments` then `supplier_payments`; a journal entry has no amount column so its size is
`SUM(gl_journal_lines.debit)` — and throws `ApprovalDocumentNotFoundError` (400) when the id names
nothing of that type in this company. `requestApproval` now takes only
`{ documentType, documentId, requestedBy }`: the amount AND the document reference come from the
stored row, so no caller-supplied field reaches the rule match at all. **Every other body field was
re-examined**: `ruleId` was already unread (round 4), `documentReference` is now server-derived,
`requestedBy` was already `req.user.id`, and on the decide branch `requestId` is UUID-validated and
`notes` is free text that reaches no decision. `?action=check` resolves the same way and ignores
the query `amount`, so the advisory answer is the rule the request path would actually bind.
*The pin.* `checkApproval` no longer short-circuits on an existing pending request — it returns
the governing rule ALONGSIDE it — and `rebindPendingRequest` moves a pending row onto the rule
today's facts choose (status-predicated UPDATE; a row decided in between is left alone). Both
inputs are server-derived, so re-binding cannot be steered by a caller. A pending request survives
unchanged only when it is already on the governing rule at the stored amount, or when no active
rule governs the document any more.

**M1 — "one pending request per document" was a comment. FIXED by migration 665.**
`uq_approval_requests_pending`, a partial unique index on
`(company_id, document_type, document_id) WHERE status = 'pending'`. Existing duplicates are
collapsed first, keeping the row whose rule demands the highest rank (ties: earliest request) and
cancelling the rest with a note; the ladder is inlined as a CASE because SQL cannot call
`approvalAuthority.ts`. `requestApproval` runs its INSERT inside
`withSavepoint('approval_request_insert', ...)` and treats `23505` as "re-read and return the
existing row", re-bound the same way. Rows with a NULL `company_id` (migration 234's unscoped
seeds) are outside the index, since NULLs are distinct; every path in this module writes it.

**M2 — deleting a used rule was a 500 leaking the raw FK message. FIXED.**
`respondToRuleWriteError` gained a `23503` arm returning 400 — "this rule has approval requests
recorded against it and cannot be deleted. Deactivate it instead." A test asserts the message does
NOT contain `approval_requests_rule_id_fkey`.

**L1 — the `INSERT ... SELECT` did not re-check `is_active`. FIXED.** `AND rl.is_active = true`
added, so a rule deactivated between the resolve and the insert aborts the request rather than
binding it — the conservative direction, and consistent with `checkApproval` having considered
only active rules. `assertMayDecide` still reads the rule WITHOUT an `is_active` filter, which is
deliberate and unchanged: deactivating a rule must not free its pending requests. *Limit:* the
intra-statement window is not reachable through the route in one process, so the added predicate is
defence in depth; the test that covers it deactivates the only governing rule and asserts the
request is refused with nothing written, which is red if the resolve stops filtering on
`is_active` but green if only the insert predicate is removed.

**L2 — stale file line counts. FIXED.** At this commit:
`approvalAuthority.ts` 157, `approvalMatching.ts` 134, `approvalService.ts` 244,
`approvalDocuments.ts` 213 (new), `approvalRuleGuards.ts` 131, `approval-requests.ts` 142,
`approval-rules.ts` 137. All under the 300-line ceiling. These numbers belong to THIS commit and
will drift again if the branch moves.

**L3 — the module doc contradicted itself about `?action=check`. FIXED.** The original entry's
"the advisory `GET ?action=check` the approvals page polls" now says plainly that no UI calls it,
and the round-4 entry's closing claim that `amount` still arrives from the caller is marked
superseded. `bun run agent-docs:check`: 74 mirrors match.

**L4 — no enumeration query for rules whose `approver_role` is off the ladder. FIXED** (query
added under Round-5 historical impact below). The fail-open-to-`admin` behaviour itself is
unchanged: it is the column's own DEFAULT, applied consistently on all three paths, and
`assertApproverRole` stops new bad values.

**Round-5 tests.** `tests/integration/k-043-r5-server-derived-rule.int.test.ts` (13, real
Postgres): the reviewer's understated-amount sequence end to end with the manager 403 and the owner
200; the mirror case where an honestly small invoice IS manager-governed and an OVERSTATED body
amount does not raise the bar; the pin, re-requested by the owner; a ghost id, a mistyped id and
another company's document all refused with nothing written; a journal entry resolved by the sum of
its debits; `?action=check` answered from the document; the unique index refusing a second pending
row; a document re-requested after its first request was decided; the 23503 delete; and the
inactive rule. `tests/integration/approval-document.helpers.ts` (new) plants the documents.
`tests/unit/services/gl/approvalRuleRankGuard.test.ts` grew to 13 (five on `requestApproval`,
including the re-bind and the document refusal). Existing files adapted: `k-043-r4-rule-rank` and
`k108-k109` plant real documents, since a random UUID no longer names one.
Suite: 60 integration cases across the six approval files, 60 unit cases across the eight approval
unit files, three `--sequence.shuffle` runs of the three request-path files (34/34 each), and the
full unit suite with `DATABASE_URL` unset — 9504 passed / 234 skipped. Mutations, each red:
caller `amount` honoured again (5 red), `resolveApprovalDocument` not refusing an unknown document
(4 red), `rebindPendingRequest` returning the existing row unconditionally (1 red), the unique
index dropped (1 red), the `23503` arm removed (1 red). See `green.log`.

**Round-5 migration / rollback.** `665_approval_requests_one_pending_per_document.sql`. Applied
twice to the fixture: the second run is a no-op (`IF NOT EXISTS` on the index, and the dedupe
UPDATE matches nothing). Rolling back means `DROP INDEX uq_approval_requests_pending`; the
cancelled duplicate rows are not restored by that and would have to be un-cancelled by hand — the
dedupe UPDATE names itself in `decision_notes`, so they are findable.

**Round-5 historical impact.** Two populations. (a) Requests raised under a caller-supplied amount
may be bound to a rule the document's real amount would not have chosen — the round-4 query above
finds requests whose stored rule is not the strictest matching one, and with the amount itself
suspect it should be re-run reading the amount from the document. (b) Requests naming a document
that does not exist could be minted freely; read-only, not run here:
```sql
SELECT ar.id, ar.company_id, ar.document_type, ar.document_id, ar.amount, ar.status,
       ar.requested_by, ar.decided_by, ar.decided_at
FROM approval_requests ar
WHERE NOT EXISTS (SELECT 1 FROM customer_invoices d WHERE d.id = ar.document_id AND d.company_id = ar.company_id)
  AND NOT EXISTS (SELECT 1 FROM supplier_invoices d WHERE d.id = ar.document_id AND d.company_id = ar.company_id)
  AND NOT EXISTS (SELECT 1 FROM credit_notes      d WHERE d.id = ar.document_id AND d.company_id = ar.company_id)
  AND NOT EXISTS (SELECT 1 FROM customer_payments d WHERE d.id = ar.document_id AND d.company_id = ar.company_id)
  AND NOT EXISTS (SELECT 1 FROM supplier_payments d WHERE d.id = ar.document_id AND d.company_id = ar.company_id)
  AND NOT EXISTS (SELECT 1 FROM gl_journal_entries d WHERE d.id = ar.document_id AND d.company_id = ar.company_id)
ORDER BY ar.requested_at DESC;
```
And (c), for LOW-4 — rules whose stored `approver_role` is off the ladder and therefore rank as
`admin`:
```sql
SELECT id, company_id, name, approver_role, is_active
FROM approval_rules
WHERE approver_role NOT IN ('super_admin','owner','system','admin','manager',
                            'accountant','bookkeeper','storeman','technician','user','viewer');
```
No rows are rewritten by the code change; migration 665 cancels duplicate PENDING requests only.
