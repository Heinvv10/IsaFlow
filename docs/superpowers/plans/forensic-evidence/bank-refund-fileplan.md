# Restore controlled bank refund allocation

Base243c0d88f; owner snapshot_capture. Root approved existing immutable bank_allocation.post operation and six bank source files; no migrations/registry changes. Preserve reviewed settlement metadata helper calls.

## Confirmed gap
Baseline5661d6f0 and current MCP description promise supplier money-in/customer money-out refunds. Current pure journal builder rejects both. Removing only that check would fabricate child payment/receipt rows; inverse also assumes every party allocation owns such a row.

## Owned file plan
- bankAllocationPlan.ts: shared signed-source refund classifier; require empty applications, exact gross reverse-direction control/bank lines, no VAT.
- bankAllocationSources.ts: reject targeted refunds before invoice reads; inbound supplier refund needs no outbound beneficiary; retain canonical normal-source shape.
- bankAllocationService.ts: bypass strategy lookup only for refunds, preserve target refusal and normal settlement behavior.
- bankAllocationChildEffect.ts: return null for proven refund before child insertion, preserve normal recompute metadata.
- bankAllocationReversalSources.ts: require no generated payment/allocation children for refund, original effect paymentId null, original exact journal and bank provenance unchanged; ordinary payments keep full checks.
- bankAllocationReversalEffect.ts: do not cancel fictional children; reverse journal/reset bank under existing permit and atomic audit.
- tests/integration/controls/bankRefundControls.int.test.ts: tests FIRST actual app_user PG, real approval/person separation, both signs with exact gross/noVAT/nochildren, enabled strategy, targeted invoice refusal, stale bank source, current authority, tenant, closed/backdated period, concurrent execution/retry, inverse and rollback.

No new public refund flag: immutable signed bank source and existing party kind determine meaning. No source fingerprint additions that would invalidate ordinary existing intents. Default strategy restoration for normal settlements and VAT1140/2120 account fallback remain separate tasks.

## Acceptance evidence
Pending genuine RED, full refund and existing settlement PG, sourceTS/lint, named independent review. No HTTP/UI/production verification claimed.

## Verification checkpoint
- Tests/file plan committed BEFORE source changes as da71c7984. Actual PG52055 terminal1/poolclosed: eight economic/lifecycle scenarios failed on existing `Allocation party direction is invalid`. Two targeted-refund checks failed message specificity (generic missing invoice instead); these are NOT bypass reproductions.
- Implemented shared signed-source classifier, refund application refusal, gross two-line posting, no refund cash child, no inbound supplier beneficiary requirement, adapter strategy skip, and inverse no-child provenance. Existing recomputeInvoiceStatus calls and ordinary canonical facts unchanged.
- Combined74686 terminal1: all23 existing settlement/allocation PG passed. Nine new refund scenarios stopped at a fixture mismatch: PAT approval decisions correctly require an authenticated human. Corrected fixture to real cookie decisions, asserted alternate-PAT rejection separately and same-maker cookie refusal explicitly. Also corrected override module to actual `banking` via policy inspection before authority checks. No source changes followed this combined run.
- Final dedicated58264 terminal0: all12 actual refund PG passed,2.70s, poolclosed. Includes both directions, enabled oldest strategy, exact gross/noVAT, no generated cash documents, concurrent one-effect execution/replay, targeted refusal, independent human approval, inverse/retry/outer rollback, closed period, backdated/amount-changed source, foreign tenant/party and current write permission denial.
- Root authorized directly related obsolete direction-refusal unit replacement. Exact-line/refund-target unit suite b764e4 terminal0:7 passed. HTTP/UI transport and production execution remain unverified in this slice.
- Source tsc --noEmit --incremental false97941 terminal0; scoped six-source ESLint95623 terminal0, no warnings; diff whitespace check passed. DB/TS leases released. Independent named review pending root assignment; no integration/completion claim yet.

## Independent review correction: historical cash children
- Review of 46c87d50a found the refund inverse incorrectly rejected cancelled children from earlier reversed allocations of the same bank source. Genuine two-direction actual PG RED48134 terminal1: original approved customer receipt/supplier payment, approved inverse, new opposite-party refund post, then refund inverse failed `Refund must not have payment or application children`. Supplier history used actual local HTTP evidence and independent beneficiary verification.
- Scope absence to exact current refund journal; keep all historical children and allocations in the source fingerprint. Any application belongs to a payment, so absence of both customer/supplier payment children for this journal also proves no child applications. Original effect must still declare paymentId null.
- Full15 actual PG75281 terminal0: both repeated lifecycle cases now pass, preserve the prior cancelled payment row exactly, and replay final inverse without new effect. Added actual unexpected child attached to current refund journal: inverse refuses before reversing. Pools and local HTTP evidence server closed, DB lease released.
- Scoped source ESLint32943 and diff check terminal0. Source tsc --noEmit --incremental false11052 terminal0. Independent named re-review pending root.
