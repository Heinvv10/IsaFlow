# Tenant access review: server boundary and implementation

Exact base: 68fe45ffa. Root-owned task, no migration reservation. Extends the
source inventory at 43bd03477:access-review-fileplan.md. Not runtime proof.

## Authority decision

Use a private metadata-only server reader, not a SQL function callable by
app_user. The exported reader takes an issued ControlTx and rechecks current
read:access through the existing permission engine before acquiring a separate
auth-pool client. Those current principal/grant/override locks remain held by
the original transaction. No reviewed subject receives an executable context.

The private client runs a read-only transaction with row_security=off: a role
whose reads would be filtered must fail instead of reporting an incomplete
tenant census. This requires the application's existing privileged server DB
login; it grants no new table privileges. Query text is built with the existing
sql tagged template; fixed query branches select only safe metadata. Never
select hashes, token prefixes/values, secrets, IP addresses, names or emails.
The company is exclusively ctx.principal.companyId. No caller SQL fragment,
table name, role or principal is accepted. Always rollback/release on failure.

## Files and contracts

- accessControlReviewInput.ts: strict canonical detached kind, limit, cursor,
  dormantDays; cursor company/kind/filter/position binding. Pagination is live,
  not an immutable assurance snapshot.
- accessControlReviewMetadata.ts: readAccessReviewMetadata(ctx,input), current
  issued authority, fixed membership/PAT/OAuth page query and independent COUNT
  in the same statement snapshot; bounded per-subject override aggregation.
  Missing profile and orphaned grant membership remain visible.
- accessControlReviewPolicy.ts: map safe metadata through permissionReason and
  isActiveUserAccount, never a copied permission evaluator. Separate cookie
  potential, current access, and refresh eligibility. Conditional constraints
  are not executable permissions; unknown scopes and malformed/duplicate
  overrides remain explicit findings. Dormancy is observation-based.
- accessControlReviewService.ts: bounded result with populationTotal,
  returnedCount, nextCursor, evaluatedAt, coverage and findingCountsForPage.
  Refuse oversized metadata rather than silently omit rows or constraints.
- Dedicated unit and real PostgreSQL tests, then root-owned strict MCP adapter,
  registry/discovery/current contract and actual HTTP acceptance.

## Failing scenarios and acceptance

1. Missing module RED; pure subject policy table proves owner deny, viewer,
   scopes, dependencies, conditional rights, duplicate overrides and expiry.
2. Authorized reviewer sees another person's OAuth grant despite owner-only
   table RLS; independent company census matches and foreign rows never appear.
3. Forged/escaped ControlTx, absent/revoked read:access, removed membership and
   suspended reviewer refuse before private metadata acquisition.
4. Read-only pool under app_user fails on RLS instead of claiming zero rows;
   setup/query failures release the acquired client.
5. Limit-one traversal, empty/final page, malformed and cross-tenant cursors;
   count/page consistency and explicitly live pagination under concurrent edits.
6. Revoked/expired/refresh-valid/dormant/orphaned grants; no secrets in output.
7. Actual MCP HTTP success, current authority changes, tenant/injection refusal;
   reads create no account, grant, exception or financial effects.

Each source change needs focused tests, actual relevant PG, static checks and
independent named review before integration. This plan resolves an architectural
decision; tenant-wide access review is not implemented or verified yet.
