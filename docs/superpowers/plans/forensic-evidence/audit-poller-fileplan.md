# Actual audit queue poller

Base4cb294bff; owner invoice_evidence. Owned auditJobPoller.ts, scripts/forensic/run-audit-worker.ts, new unit/PG tests and this plan. Root owns runner and transaction cancellation fixes, migrations and registry.

Queue discovery is a server-only READ ONLY transaction on supplied private worker pool. Tagged SQL selects only job UUID, requester identity and exact updated_at text, joins intent and queue with company predicate, queued or expired-running only. No protected request/source/financial data read. Temporary ALS carries no ControlPrincipal; no synthetic cookie. Commit and release before real sequential runAuditSnapshotJob outside ALS. Runner owns signed delegation/current permission/lease checks.

Configured company UUIDs required (at most10), batch at most10, round-robin one company per poll. Per-company exact timestamp/UUID keyset advances even when bad jobs cannot claim, resets after exhausted queue. This prevents poisoned oldest entries monopolizing the batch. Interval1–60s, shutdown signal passes to active runner and interrupts polling delay. Metadata query bounded5s and connection acquisition bounded5s with late connections released.

CLI requires repeated --company UUID, optional --once/--interval-ms/--batch-size; explicit ISAFLOW_AUDIT_WORKER_DATABASE_URL (no incidental application DB fallback). Never execute against production during development. Tests inject local synthetic pool and close it. TDD: cold boundary and metadata-only SQL, sequential execution/cancel, queue fairness, actual persisted queued jobs through actual runner and terminal snapshot publication. All PG/heavy checks need root lease.

## Verification checkpoint

- Tests-first bdd26cf4c absent-module RED. Initial implementation's lazy tagged SQL escaped its ALS context; executing the thenable inside the ALS async callback corrected it. Explicit regression checks the private metadata context and absence of ControlPrincipal.
- Malformed requester identity rejected before runner claim initially aborted polling (1failed/7passed, audit-poller-malformed-red.log). Corrected to sanitized WORKER_ERROR/failureRecorded:false result and cursor advancement, preserving later jobs. No database failure record or authorization is fabricated.
- Final8 units GREEN. Actual PostgreSQL57065 terminal0,2 tests: oldest revoked authority does not claim; next valid same-tenant job publishes; other tenant stays queued; keyset wrap retries restored authority; executable Bun --company UUID --once CLI publishes using only explicitly validated fixture URL. Pools and subprocess closed; database lease returned.
- Source type-check and scoped source lint79576 terminal0. All worker resource leases released. Named root cancellation-capacity correction still to be imported; this poller suite did not retest its in-flight SQL cancellation cases.
- One poll/--once scans one configured company, at most10 candidates; repeated polling round-robins configured companies. No source queries or protected requests read by queue discovery. Actual business work remains delegated to runAuditSnapshotJob.
- Independent named review and integrated runner/poller verification remain required. No deployed scheduler or production execution claimed.
