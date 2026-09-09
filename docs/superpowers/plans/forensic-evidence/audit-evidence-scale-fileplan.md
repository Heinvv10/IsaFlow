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

## Actual local boundary proof

Root independently reviewed 0b574a25f and granted exclusive PG/process/heavy lease. Cleanup was strengthened to initiate server.close before closing connections and restore environment in finally. Actual `bunx vitest run --config vitest.integration.config.ts --no-file-parallelism tests/integration/controls/auditEvidenceScale.int.test.ts` with explicit validated fixture.env, `ISAFLOW_AUDIT_EVIDENCE_SCALE_LEASE=100MiB`, explicit trusted artifact and report path: session98994 terminal0, one complete workflow passed in32.87seconds.

- Company ad139f48-57e7-4b6d-b3be-e93adbde5012. Snapshot d283514a-7017-4bcb-beef-52cf2bacafc8: succeeded14,269ms; kernel cgroup peak974,606,336B; sampled RSS peak1,006,878,720B; no OOM.
- Export76fdbb00-2b82-494e-ab15-510067ff89fa: succeeded7,613ms; cgroup peak634,388,480B; sampled RSS614,858,752B; no OOM. Sixteen files total104,887,461B fully reconstructed through authenticated paging/chunks, hashes and manifest HMAC independently checked. Ten original files total104,857,600B, exact recorded identities/hash/size verified. Generated evidence.pdf has2pages. Completed export retry not_claimed.
- Overflow job27248762-28da-47ed-975e-88752b4a31e9: eleven originals total104,857,601B, all11 HTTP reads observed; RESOURCE_LIMIT/failureRecordedtrue in641ms. No snapshot, retained artifact or index rows; repeated enqueue same idempotency key returns same job; execution retry not_claimed. Cgroup peak215,756,800B, sampled RSS262,021,120B, no OOM.
- Fixture pool and storage server closed; actual systemctl user-unit listing showed zero audit units after terminal. PG/process lease explicitly released.
- Evidence logs: sibling artifacts audit-evidence-scale-100mib.log, audit-evidence-scale-100mib-report.json and .overflow.json. Trusted actual cold artifact: ../mcp-isolated-poller-20260909/.audit-build/audit-job.cjs, root-approved existing build; unchanged worker bounds.

This proves arbitrary deterministic original-byte retention; synthetic.bin originals are octet-stream with a legacy PDF classification marker and are not valid-PDF parsing evidence. Generated PDF page proof is separate. The1GiB outer export ceiling was not approached: admitted original bytes are100MiB, actual bundle104,887,461B. This does not fix or waive the prior fresh-seed100k timeout, prove a combined100k+100MiB workload, or verify production behavior.

Final cleanup dedicated TypeScript and typed lint session7236 terminal0; logs audit-evidence-scale-final-typecheck.log and audit-evidence-scale-final-lint.log. Artifact SHA2566e19d3c4b6fc6af8161f3d14659666d8a1b039614659f911878a858eb79c595f; artifact tree HEAD02d549ca90ca363b0474c838ad0016876a08b97c (test-only commit atop16eef4d34 production sources). No source or limit changes were necessary for this boundary acceptance. Root named re-review of cleanup/results remains pending.
