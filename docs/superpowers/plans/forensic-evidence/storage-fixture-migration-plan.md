# Captured storage fixture migration

Base exactff11e6946; isolated feat/mcp-forensic-storage-fixtures-20260909. Test-only owner ar_recovery. Root owns source corrections/integration and DB/TS leases. Independent source review of ff11 completed before this author task: deadline-aborted catch can mask non-storage authorization/SQL errors; root correction pending, not changed here.

## Owned slices and acceptance

1. Run existing bankStatementAttestationService, beneficiaryVerification, paymentRiskChecks, journalBankChecks, operationApproval and invoiceMatchOverride actualPG suites unchanged. Record missing storage/obsolete fixture failures separately from genuine domain findings.
2. Replace raw-only document INSERT seeds with metadata INSERT plus capturedEvidenceHttpFixture.seed. Retain matched parent, tenant and recorded hash relationships. Replace raw-column tampering with storage.put; use remove for genuinely missing source bytes. Never re-add raw_bytes or change source behavior to satisfy a fixture.
3. Migrate bankAllocationSupplierFixture and paymentReleaseFixture to shared local HTTP fixture lifetime. Direct dependent tests are bankAllocationControls, paymentRelease and paymentRiskChecks. Prefer one fixture server per suite and explicit teardown; any new shared helper remains test-only. Report additional dependent paths before editing.
4. Keep all approval, source mutation, duplicate evidence, current permission, tenant, rollback and actual financial workflow assertions. Run source suites and dependent bank/payment workflows against actual local object requests, complete pools/server shutdown, then sourceTS/scoped supported lint under leases.
5. Name test checkpoint for independent review. This task does not certify large asynchronous evidence scans, full migrations, production object storage, HTTP MCP/UI transport, finalCI or programme completion.

Initial state: exact plan/source audit only. Existing raw column uses identified in eight assigned files. No database run or fixture edits yet; root DB lease requested for baseline. Existing operationApproval hash-only seed is deliberate metadata-only graph test: assess assertion before adding unnecessary source bytes.
