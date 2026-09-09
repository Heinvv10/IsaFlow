# Cold audit worker failure publication

Base: fd4b7d14b. Owner: snapshot_capture. Root owns runner and integration.

## Gap and files
- auditJobLease.ts: existing failAuditJob requires authenticated ControlTx. A revoked originating grant prevents constructing that context after work rolls back. Add cold failure entry with exact issued lease and cold store identity, sharing only the existing fenced failure SQL.
- tests/integration/controls/auditJobColdFailure.int.test.ts: real app_user transactions and persisted queue/PAT state. Reproduce missing entry before implementation; verify revoked PAT and expired delegation still allow sanitized failure, copied/mismatched/expired/replaced leases fail, active contexts fail, rollback leaves running metadata unchanged, retry uses existing queued behavior.

No financial writes, migrations, permission fabrication or root runner edits. SQL fence remains current company/job/live lease/generation; cold context cannot grant business authority.

## Verification
Pending genuine RED, focused PostgreSQL suites, source typecheck/lint and independent root review.

## Evidence checkpoint
- Genuine preimplementation PG RED: six cases failed at missing failAuditJobForWorker; real revoked-PAT and expired-delegation context refusals succeeded first (command result 0caf67, terminal 1).
- Added cold entry and shared fenced failure UPDATE, preserving existing authenticated API. Root authorized CANCELLED additive error code; schema 630 accepts bounded strings, no migration needed.
- Focused PG: auditJobColdFailure (7), auditJobService (7), auditJobContext (12), 26 passed; handle 47608 terminal 0, pools closed. Rollback, current SQL lease fencing, in-process issuance, revoked grant and delegation expiry verified against synthetic PostgreSQL.
- Source tsc --noEmit --incremental false handle 47731 terminal 0; scoped source ESLint and git diff --check handle 37134 terminal 0.
- Root independent named review pending. Actual runner transaction/cancellation orchestration remains root-owned; no production verification.
