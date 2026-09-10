# Comparison cold dispatch and legacy concurrency proof

Base21c8252f3; owner snapshot_capture; branch feat/mcp-comparison-dispatch-proof-20260910.
Owned comparisonDispatchFixture.ts/comparisonDispatch.int.test.ts and this evidence file only. No production/schema changes.

Test-first cases:
1. Real snapshot jobs produce retained original/index/companion; actual isolated systemd worker artifact executes comparison, protocol returns comparisonId, DB result/status/items agree, retry is not_claimed, originals remain byte-identical.
2. Remove only synthetic companion from a real sealed snapshot. Two separate cold workers hit an owned snapshot-specific INSERT barrier. Release after both actual sessions wait. Exactly one creates companion; unique conflict must become retryable whole-transaction failure, second attempt succeeds, two results reference one companion and original remains unchanged. This bypasses no in-process runner semaphore and mocks no dispatch.
3. Remove synthetic original index too: expect legitimate legacy comparison enqueue. Current readAuditSnapshotIndexHeader requires an index, so this is a predicted distinct unsupported capability. Actual PG failure remains required before reporting confirmed runtime gap. Never rewrite original seal/hash to manufacture compatibility.

Fixture uses explicit synthetic33149 target validation, process opt-in and absolute built artifact; parent controls PG/build/static leases. Initial source inspection preceded the committed tests; runtime results follow below. Artifact must be freshly built from named owned checkpoint using scripts/forensic/build-audit-job.ts, record artifact hash and exact commit. Original-index-missing fixture represents missing retained metadata, not a claim of historical15-population schema coverage.

DDL barrier is limited to random synthetic company/snapshot and always removed; owned children aborted/awaited, advisory lock released. No production reads, financial transactions, shared schema migration, or external messages.

## Actual local verification

Tests-first checkpoint: f8ed190de, product base 21c8252f3. Built real cold worker with `bun scripts/forensic/build-audit-job.ts --outfile <owned-worktree>/.next/forensic/audit-job.cjs`; build exited 0. Artifact SHA256: `3324854f3f5e1bdd441607ab83dc0f68d00d4078bb4c76c15e4f9e0e1a0c989e`.

With validated private database environment, `ISAFLOW_FORENSIC_PROCESS_TEST=1`, and the absolute artifact path, ran `bunx vitest run --config vitest.integration.config.ts tests/integration/controls/comparisonDispatch.int.test.ts`. Handle 49156 exited 1: **two PASS, one genuine RED** in 10.57 seconds. Raw log: `/tmp/isaflow-comparison-dispatch-first.log`.

- Actual cold process dispatch passed: one published comparison, authenticated protocol result, observed process memory, terminal unit cleanup, idempotent second claim refusal, immutable original bytes/hash.
- Actual concurrent companion conversion passed: both independent child sessions reached the scoped barrier; one comparison completed, the conflicting transaction queued for retry, retry completed, exactly one companion and two comparison results remained, original bytes/hash unchanged.
- Missing original index remains a required failing scenario. Enqueue rejected with `Retained snapshot index unavailable` from `auditSnapshotIndexRead.ts:14`, reached via `auditComparisonJobService.ts:15`. This is a confirmed separate capability gap before job creation, not evidence that existing companion conversion fails. The RED is retained for a centrally authorized production correction.

All fixture pools, child workers and barrier resources closed after the run. No production behavior was verified. Dedicated test TypeScript initially exposed inferred UUID parameter typing (corrected with explicit string) and ambient child-process type resolution; the final node-types-only dedicated check produced an empty log and no surviving process, but its tool exit handle was lost during compaction. That observation is **not** recorded as a passing static gate; definitive static verification remains pending.

Definitive static follow-up: handle **98501 exited 0**, running `bunx tsc --noEmit -p /tmp/isaflow-comparison-dispatch-tsconfig.json` followed by scoped ESLint with that dedicated project against both owned test files. The dedicated project extends the repository configuration, includes both files and `next-env.d.ts`, and selects Node ambient types explicitly. Logs: `/tmp/isaflow-comparison-dispatch-ts-definitive.log` and `/tmp/isaflow-comparison-dispatch-lint.log`. No runtime rerun was needed for the explicit fixture parameter type annotation. Resources released immediately. The required indexless-runtime RED remains unresolved; passing static checks do not close it.
