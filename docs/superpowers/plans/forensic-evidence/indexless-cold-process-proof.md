# Indexless cold-process verification

Owner: review_indexless. Exact implementation base: 519cec04e. Worktree: mcp-indexless-cold-proof-20260910. Test-only scope; no production code or migration changes.

The existing cold-process indexless case proved enqueue only. Extend it to run the isolated production worker, verify succeeded result and retained build lineage, preserve original protected snapshot/artifact values, and refuse a duplicate claim.

Add reversed comparisons of two genuine worker-created snapshots after fixture-only removal of their original indexes and comparison companions. A synthetic index INSERT trigger pauses the first worker; observation of both distinct worker application names waiting on PostgreSQL advisory locks proves overlapping real processes. Releasing the trigger permits success or a legitimate serialization retry. Both jobs must eventually succeed, retain exactly two original indexes and companions, publish each result once and leave original protected material unchanged. Existing companion-only concurrency assertions remain intact.

Tests authored before execution. PostgreSQL and static execution pending the root resource lease. This is neither a passing claim nor scale/kill-recovery evidence.

## Verified local execution

Test commit c989a96a0, unchanged production source from 519cec04e. Fresh artifact built with `bun scripts/forensic/build-audit-job.ts --outfile <owned-tree>/.next/forensic/audit-job.cjs`; SHA-256 `491f1eccbc4d7e15ec57b4dd4ca4624fdc2d69028fc1c7ff6fd9c8f2d54bb7f8`.

With validated local fixture environment and explicit process-test opt-in, `bunx vitest run --config vitest.integration.config.ts tests/integration/controls/comparisonDispatch.int.test.ts` handle21818 exited0: **4/4 PASS**,19.89 seconds total,19.19 seconds tests. Both indexless cases actually executed isolated worker processes. The reversed-pair test observed both database connections waiting before releasing the synthetic pause, then verified complete eventual results and a single builder for both original indexes. It does not require a serialization failure when both processes legitimately succeed.

Dedicated two-file TypeScript handle44970 and typed ESLint handle51155 both exited0. Durable logs are in sibling `mcp-forensic-artifacts-20260909/indexless-cold-proof.log` and `indexless-cold-proof-static.log`. All processes terminal; resource lease released. No production execution, hard-kill proof or scale claim.
