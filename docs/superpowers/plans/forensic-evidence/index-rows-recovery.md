# Original index row retention

Owner index_rows, exact base 600de7e4b, isolated feat/mcp-index-rows-recovery-20260910. Root owns migration 673 and existing publisher integration.

Confirmed gap: existing auditSnapshotIndexPublication ignores INSERT returned rows entirely. A silent BEFORE INSERT trigger suppression can therefore publish incomplete original indexes; actual PostgreSQL reproduction pending resource lease. Its implicit lease.jobId target also prevents an actual comparison worker retaining another original index.

Owned new auditSnapshotIndexRows.ts exposes retainSnapshotIndexMaterial(ctx,lease,snapshotId,material,options). It checks issued worker identity, current saved delegation/permissions and allowed kind/target; writes explicit builder lineage; validates every returned header/item/chunk identity and cardinality. Encoded SQL batches include punctuation in their 2MiB ceiling and cap at 512 rows. Caller owns enclosing transaction/savepoint rollback. No schema, publisher, transport or registry changes in this branch.

Tests: new focused unit suite initially seven failures because module absent; after implementation eleven pass including suppression, equal-count foreign identity, target authority, revocation, row and byte bounds. This is not PostgreSQL behavioral RED evidence. New real PostgreSQL suite exercises existing actual snapshot worker: three independently suppressed write tables must roll back all snapshot/index state; positive 520-record case checks exact ordinal population and actual builder lineage. Run baseline before root applies migration/integration, then rerun final candidate with both root dependencies. Comparison-worker lineage and migration RLS acceptance belongs to integrated conversion proof, not mocked unit authority.

2026-09-10: source/runtime focused command `bun run test:unit -- tests/unit/services/controls/auditSnapshotIndexRows.test.ts` terminal0, 11 tests, 208ms. PostgreSQL/static lease pending; no completion or integrated claim.
