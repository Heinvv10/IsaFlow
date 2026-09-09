# Shared control approval reader and REST exposure

Base678ebffc6. Owner invoice_evidence; branch feat/mcp-control-approval-rest-20260909. Root owns approval operation catalogue accessor and all MCP/registry integration.

## Owned files and interfaces
- New services/controls/approvalReadService.ts: listOperationApprovals(ctx,{status?,limit?,cursor?}) -> {items:ApprovalSummary[],nextCursor:string|null}. Limit defaults50 and never exceeds100.
- New pages/api/accounting/control-approvals.ts: GET action list/pending; strict POST requirements/request with strict OperationRef, decide with approvalId/decision/evidence. Default withAuth(withErrorHandler(withCsrf(handler))). Shared services derive identities and enforce current rights; no actor/body company fields or route financial SQL.
- New unit and actual PostgreSQL tests plus this fileplan. Existing legacy approval route and UI untouched.

## Server filtering and cursor contract
Resolve effective current rights, require read:approvals, derive allowed operation names from root's actual permission catalogue. SQL filters company, allowed operations and optional status BEFORE keyset ORDER requested_at DESC,id DESC and LIMIT page+1. Select summary columns only, no binding details. No counts or hidden-domain pagination holes. Cursor contains company/status/allowed-operation digest and exact PostgreSQL timestamp+UUID; authenticate using existing CONTROL_FINGERPRINT_KEY with a distinct cursor domain, strict bounded parsing, no new secret/migration. Revoked domain rights invalidate old cursors.

## Failing scenarios before source
- Root catalogue accessor missing: actual unit invocation must fail before root adds it.
- Reader module absent: focused tests must fail import before implementation.
- Actual PG creates real operation approval requests; bounded pages, same timestamp ordering, current read:approvals revoked, domain read revoked/hidden rows filtered before pagination, foreign tenant/cursor rejection, malformed/tampered cursor and invalid limits.
- Actual raw REST handler inside real issued PostgreSQL control context: request -> independent decision, same-person refusal, bearer human-decision refusal, requirements/read list, strict actor/unknown field/malformed reference rejection. Separate wrapper wiring/CSRF validation tests do not claim authentication integration.

## Pending
RED, root accessor, source implementation, focused PG/units, scoped source TS/lint, independent named review. No production or full HTTP claim.
