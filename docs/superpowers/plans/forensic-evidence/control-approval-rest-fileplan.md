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

## Verification and review handoff
- Catalogue missing-function RED in control-approval-catalogue-red.log; root accessor340660cf3 cherry-picked as1a45fdce7 and independently reviewed clean. Reader/route missing-module RED in control-approval-reader-route-red.log preceded source.
- Actual PostgreSQL initial7 cases passed43031. Added explicit current-permission HTTP403 test then actual RED79604 (7pass/1failed) before narrow EffectivePermissionError mapping. Unexpected errors still propagate.
- Final8 actual PG passed91640, pool closed and lease released: domain filtering before pagination, authority revocation, tenant isolation, authenticated cursor replay/tamper/filter refusal, exact microseconds/UUID ties, actual request/independent decision/self and bearer refusal, no financial execution.
- Final18 focused units passed; source tsc --noEmit64043 terminal0 and scoped ESLint passed. Logs control-approval-reader-final-{pg,units}.log, control-approval-reader-{ts,lint}.log under forensic artifacts directory.
- No migrations or financial SQL in route. Existing signing key reused; no new configuration. Cookie-human decisions delegated to existing trusted service.
- Independent named review pending. Actual PG invokes exported REST handler inside real issued context; CSRF wrapper is unit exercised. Full HTTP authentication/middleware workflow, UI integration and programme-wide CI remain root acceptance work. Existing generic error middleware still maps non-permission domain refusals (including invalid cursors and self-approval) to generic errors; their shared-service refusals are tested. No production verification claimed.
