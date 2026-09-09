# Actual audit queue poller

Base4cb294bff; owner invoice_evidence. Owned auditJobPoller.ts, scripts/forensic/run-audit-worker.ts, new unit/PG tests and this plan. Root owns runner and transaction cancellation fixes, migrations and registry.

Queue discovery is a server-only READ ONLY transaction on supplied private worker pool. Tagged SQL selects only job UUID, requester identity and exact updated_at text, joins intent and queue with company predicate, queued or expired-running only. No protected request/source/financial data read. Temporary ALS carries no ControlPrincipal; no synthetic cookie. Commit and release before real sequential runAuditSnapshotJob outside ALS. Runner owns signed delegation/current permission/lease checks.

Configured company UUIDs required (at most10), batch at most10, round-robin one company per poll. Per-company exact timestamp/UUID keyset advances even when bad jobs cannot claim, resets after exhausted queue. This prevents poisoned oldest entries monopolizing the batch. Interval1–60s, shutdown signal passes to active runner and interrupts polling delay. Metadata query bounded5s and connection acquisition bounded5s with late connections released.

CLI requires repeated --company UUID, optional --once/--interval-ms/--batch-size; explicit ISAFLOW_AUDIT_WORKER_DATABASE_URL (no incidental application DB fallback). Never execute against production during development. Tests inject local synthetic pool and close it. TDD: cold boundary and metadata-only SQL, sequential execution/cancel, queue fairness, actual persisted queued jobs through actual runner and terminal snapshot publication. All PG/heavy checks need root lease.
