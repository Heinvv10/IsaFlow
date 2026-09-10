# Indexless cold-process verification

Owner: review_indexless. Exact implementation base: 519cec04e. Worktree: mcp-indexless-cold-proof-20260910. Test-only scope; no production code or migration changes.

The existing cold-process indexless case proved enqueue only. Extend it to run the isolated production worker, verify succeeded result and retained build lineage, preserve original protected snapshot/artifact values, and refuse a duplicate claim.

Add reversed comparisons of two genuine worker-created snapshots after fixture-only removal of their original indexes and comparison companions. A synthetic index INSERT trigger pauses the first worker; observation of both distinct worker application names waiting on PostgreSQL advisory locks proves overlapping real processes. Releasing the trigger permits success or a legitimate serialization retry. Both jobs must eventually succeed, retain exactly two original indexes and companions, publish each result once and leave original protected material unchanged. Existing companion-only concurrency assertions remain intact.

Tests authored before execution. PostgreSQL and static execution pending the root resource lease. This is neither a passing claim nor scale/kill-recovery evidence.
