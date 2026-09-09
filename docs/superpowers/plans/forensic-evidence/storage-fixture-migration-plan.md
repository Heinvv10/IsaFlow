# Captured storage fixture migration

Base exactff11e6946; isolated feat/mcp-forensic-storage-fixtures-20260909. Test-only owner ar_recovery. Root owns source corrections/integration and DB/TS leases. Independent source review of ff11 completed before this author task: deadline-aborted catch can mask non-storage authorization/SQL errors; root correction pending, not changed here.

## Owned slices and acceptance

1. Run existing bankStatementAttestationService, beneficiaryVerification, paymentRiskChecks, journalBankChecks, operationApproval and invoiceMatchOverride actualPG suites unchanged. Record missing storage/obsolete fixture failures separately from genuine domain findings.
2. Replace raw-only document INSERT seeds with metadata INSERT plus capturedEvidenceHttpFixture.seed. Retain matched parent, tenant and recorded hash relationships. Replace raw-column tampering with storage.put; use remove for genuinely missing source bytes. Never re-add raw_bytes or change source behavior to satisfy a fixture.
3. Migrate bankAllocationSupplierFixture and paymentReleaseFixture to shared local HTTP fixture lifetime. Direct dependent tests are bankAllocationControls, paymentRelease and paymentRiskChecks. Prefer one fixture server per suite and explicit teardown; any new shared helper remains test-only. Report additional dependent paths before editing.
4. Keep all approval, source mutation, duplicate evidence, current permission, tenant, rollback and actual financial workflow assertions. Run source suites and dependent bank/payment workflows against actual local object requests, complete pools/server shutdown, then sourceTS/scoped supported lint under leases.
5. Name test checkpoint for independent review. This task does not certify large asynchronous evidence scans, full migrations, production object storage, HTTP MCP/UI transport, finalCI or programme completion.

Initial state: exact plan/source audit only. Existing raw column uses identified in eight assigned files. No database run or fixture edits yet; root DB lease requested for baseline. Existing operationApproval hash-only seed is deliberate metadata-only graph test: assess assertion before adding unnecessary source bytes.

## Actual baseline and first fixture adaptation

- Baseline66238:75actual tests,28failed47passed. Missing statement/beneficiary objects and unverified source comparisons in four suites; operationApproval and invoiceMatchOverride passed inline/metadata fixtures. No missing-column claim for this run.
- Adapted14783:63pass12fail. Actual storage-only invoice override evidence now refuses before preparation because invoiceMatchOverrideMaterial still queries d.raw_bytes; root assigned separate source worker. Two failures were PostgreSQL deadlocks from unrelated suites contending with override global table locks; serialized followup avoids fixture interference without removing intentional in-test races.
- Serialized51338:79pass14fail over93tests. Six suites GREEN including actual bank allocation. Remaining14paymentRelease failures traced to a later test replacing the whole fetch router with fake Netcash, causing subsequent captured object reads to receive fake provider output. Corrected test router routes only exact fixture origin/object path to native HTTP and exact Netcash submit URL to fake provider; all other external requests still throw. Rerun pending.
- Test-only helper owns one actual local server per importing suite, explicitly closes/restores env; all raw-only seeds use seed, tamper uses put.121root count test now shares one actual object, preserving complete accounting/count/cursor assertions within separate100object verification bound. Existing actual101document deferral test remains unchanged.
- PAT beneficiary valid-source setup now includes read:invoices; later persisted permission revocation remains tested. OperationApproval metadata-only linkage test left unchanged deliberately.

## Verified release/storage followup

- Root deadline correction be38beb38 independently reviewed by snapshot and cherry-picked asffde4adb6. This is root-authored source dependency, not a worker-owned production edit.
- PG89107 terminal0:29actual tests GREEN, full17paymentRelease plus capturedEvidenceSource and capturedEvidenceConsumers411, serialized suites. Logs storage-fixtures-release-source-green.log. Actual payment release lifecycle includes committed attempting state before fake provider observation, retry/no retransmit, revoked authority, source changes, child-process refusal and actual local captured object reads. Source suites cover actual411 schema, missing/changed object, namespace/current permission checks and101object deferral.
- All fixture pools/local HTTP servers closed and DB lease returned to root. Prior six non-release suites already passed under51338; no final aggregate claim until invoice override source repair is received and existing override suite reruns. Invoice worker has089aaa71f test checkpoint and owns only its source/new tests.
- All touched test files remain under300lines. Final sourceTS/scoped supported lint slot not yet requested/granted; tests are outside the repository typed ESLint project, so their execution evidence is actual Vitest PG. No transport/production verification claimed.

SourceTS25487 terminal0; heavy slot returned. Root independently reviewing exact fixture089aaa71f againstb7af33e9d. Final combined actual acceptance remains queued behind invoice source correction and central DB lease; no process left running.

## Final accepted invoice source and capture fixtures

Root independently reviewed invoice sourcef5b76b6c7 and permitted its exact tests/source/ledger stack. Cherried b829288a2,c6345056f,f5b76b6c7,3ace1f44b,3765144d5 as2b1e44562,14097ac74,160a19924,4ae55053e,e0540f1dd; skipped duplicatebd37fixture. All source edits remain root/invoice-worker authored dependencies.

PG41450 terminal0:119tests across11 serialized suites GREEN after actual invoice source repair. Durable storage-fixtures-final-combined.log. Includes original six source/approval suites, bank allocation, payment release, captured source/consumer411 and new invoice evidence411.

Remaining dependent capture audit found two raw-only seeds. Baseline87697:23pass1fail; actual snapshot statement preparation refused absent storage. Converted both auditSnapshotCapture seeds to shared actualHTTP. Schema-only bankStatementAttestationSchema seed remained passing until a new test-first transactional411 column drop reproduced42703; removed raw payload field while preserving deliberate metadata/FK-only assertions. AlwaysROLLBACK restores schema, no persistent migration.

PG11520 terminal0:24capture/schema tests GREEN, storage-fixtures-capture-schema-green.log. This adds to119tests for143actual tests across two final serialized runs on unchanged production source. All pools and local servers closed and DB lease returned. No remaining raw-only seeds found in controls tests; remaining references are valid hash/size metadata or deliberate transactional column-drop regressions. Final two-fixture correction awaits independent named review. No finalCI, external provider integration or production object storage claim.
