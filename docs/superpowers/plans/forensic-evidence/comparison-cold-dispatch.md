# Comparison cold dispatch and legacy concurrency proof

Base21c8252f3; owner snapshot_capture; branch feat/mcp-comparison-dispatch-proof-20260910.
Owned comparisonDispatchFixture.ts/comparisonDispatch.int.test.ts and this evidence file only. No production/schema changes.

Test-first cases:
1. Real snapshot jobs produce retained original/index/companion; actual isolated systemd worker artifact executes comparison, protocol returns comparisonId, DB result/status/items agree, retry is not_claimed, originals remain byte-identical.
2. Remove only synthetic companion from a real sealed snapshot. Two separate cold workers hit an owned snapshot-specific INSERT barrier. Release after both actual sessions wait. Exactly one creates companion; unique conflict must become retryable whole-transaction failure, second attempt succeeds, two results reference one companion and original remains unchanged. This bypasses no in-process runner semaphore and mocks no dispatch.
3. Remove synthetic original index too: expect legitimate legacy comparison enqueue. Current readAuditSnapshotIndexHeader requires an index, so this is a predicted distinct unsupported capability. Actual PG failure remains required before reporting confirmed runtime gap. Never rewrite original seal/hash to manufacture compatibility.

Fixture uses explicit synthetic33149 target validation, process opt-in and absolute built artifact; parent controls PG/build/static leases. Source-only inspection completed; no test executed yet. Artifact must be freshly built from named owned checkpoint using scripts/forensic/build-audit-job.ts, record artifact hash and exact commit. Original-index-missing fixture represents missing retained metadata, not a claim of historical15-population schema coverage.

DDL barrier is limited to random synthetic company/snapshot and always removed; owned children aborted/awaited, advisory lock released. No production reads, financial transactions, shared schema migration, or external messages.
