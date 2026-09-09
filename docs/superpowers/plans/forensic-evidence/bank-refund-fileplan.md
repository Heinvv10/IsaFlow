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
