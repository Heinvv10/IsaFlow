# Actual retained evidence boundary acceptance

Base: 9e71889c5. Owner: invoice_evidence. Branch: feat/mcp-audit-evidence-scale-20260910.

## Source-backed bounds and owned files

- capturedEvidenceStorage.ts MAX_BYTES admits each original up to 10 MiB, with actual configured storage GET, owned namespace, recorded size/hash and 10-second per-object deadline.
- auditSnapshotEvidence.ts admits aggregate retained originals up to 100 MiB, requires repeatable read, and retains no partially published snapshot on failure. Canonical snapshot has its own 100 MiB limit.
- auditEvidenceExportMaterial.ts caps the entire generated bundle at 1 GiB, PDF at 600 MiB/25,000 pages, with a 60-second renderer deadline. The outer 1 GiB cap does not admit 1 GiB of original evidence.
- Actual cold process retains the existing 60-second worker deadline and 65-second parent wall limit, 8 GiB cgroup memory and zero swap. No settings are raised for acceptance.
- Own only auditEvidenceScale.int.test.ts, auditEvidenceScaleFixture.ts, and this file.

## Fixture and failing scenarios (not yet executed)

Use a new explicitly validated synthetic tenant, ten owned bank transactions and captured documents, each with a deterministic 10 MiB original. A local authenticated storage HTTP server streams bounded 64 KiB blocks with backpressure and computes independent original hashes; no giant in-memory fixture map. Snapshot is normally enqueued with bank source and actual current saved authority, then executed by the existing trusted isolated process. No manually sealed snapshot, artifact or publication rows.

1. Exactly 104,857,600 original bytes: queued status reads perform no fetch/work; cold snapshot succeeds with ten hash-verified evidence relations. Cold export succeeds; authenticated descriptors and every chunk independently reconstruct all originals, verify signed manifest and complete file counts/ordinals. Record elapsed time, sampled RSS, cgroup peak, original/bundle bytes and actual generated PDF page count. Completed job replay does not duplicate publication.
2. Add an eleventh one-byte original under its own owned bank parent. Normal new snapshot must fail the aggregate resource limit with no snapshot, index or retained-artifact publication. Same idempotency key returns the same failed job; execution retry cannot publish partial state. Preserve failure observation before assertions.
3. Failure evidence never changes limits, removes admitted originals, fabricates missing bytes or claims the 1 GiB outer ceiling was approached. If exact-bound success fails, retain the failure and coordinate any confirmed source fix with root.

## Status and resource coordination

Planning and source inspection complete. Tests/fixture being authored before any production changes. No PG, process, build or large workload run has been authorized for this stage yet. Independent named review and dedicated TS/lint remain pending. Original fresh-seed 100k timeout remains unresolved and is outside this bounded evidence acceptance.

## Authored acceptance checkpoint

Both test and streaming fixture are authored; no production changes. Dedicated test typecheck (`bunx tsc --noEmit -p .audit-evidence-scale-tsconfig.json`) session11816 terminal0. Typed ESLint on the exact two files session19010 terminal0. Logs: sibling forensic artifacts `audit-evidence-scale-typecheck.log`, `audit-evidence-scale-lint.log`. These checks validate test types/style only; no runtime RED/GREEN or near-bound success is claimed. Root named plan/test review and explicit PG/process lease remain required before running the 100 MiB case.
