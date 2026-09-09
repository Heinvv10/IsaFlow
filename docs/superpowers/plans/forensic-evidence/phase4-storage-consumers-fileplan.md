# Migration411 forensic source consumers

Base2799a9779; isolated worktree/branchmcp-forensic-storage-consumers-20260909. Root capturedEvidenceSource/Storage remain unchanged. Migration411 removes inline raw_bytes and retains owned storage pointer, recorded SHA256 and size.

## Interfaces and owned changes

- bankStatementAttestationQuery.ts: retain complete SQL population counts and owned intent/account/document/provenance joins. Resolve each distinct document through root loadOwnedCapturedEvidence(read:bank-tx), set bytes_verified only when recordedHashVerified and actual hash equals immutable expected_source_hash. Only then evaluate currentStatementReview. Return explicit evidenceMissing reasons alongside existing rows/count/over.
- bankStatementCompletenessQueries.ts: same actual source checks for owned source import/review roots. Record-level sourceBytesVerified requires actual recorded-hash-verified object. Preserve incomplete/unknown/candidate distinctions and review expectedhash equality. Complete database population count independent of fetched object count.
- invoiceRiskQueries.ts: preserve supplier and source_document association, full invoice population count and existing10000row SQL guard. Actual recorded-hash-verified source bytes alone permit file_verified. Missing/changed/foreign/unavailable objects never confirm source reuse. Add evidenceMissing for caller result.
- beneficiaryQueries.ts: prove matched invoice and supplier ownership under locks, then actual loadOwnedCapturedEvidence(read:invoices); expected evidence hash must equal actual verified recordedhash. Missing/changed/unretrievable bytes refuse proposal/verification. Existing10document maximum plus aggregate20second/100MiB budget. Preserve employee-specific evidence path.
- transactionEvidenceDocuments.ts: recorded valid SHA256 availability only; remove nonexistent raw_bytes fallback, no network fetch during graph reads and no verified claim.
- capturedEvidenceScan.ts (new): sequential, deduplicated source-reader orchestration. Proposed max100distinctdocuments/100MiB aggregate/20seconds, deadline propagated as AbortSignal. Skip all HTTP if known distinctdocumentcount exceeds bound; return explicit async_scan_required. Preserve complete metadata population and candidate findings. Authentication failures propagate; storage absence/hash/namespace errors become explicit unavailable evidence, never verified. SQL/schema failures propagate, so schema compatibility tests cannot pass by swallowing errors.
- Minimal duplicateInvoiceChecks/bankStatementCompletenessChecks missing-source propagation requested from root; no sharedcontracts/registry changes.

## Tests first

1. Real fixture transaction drops raw_bytes then alwaysROLLBACK, uses actual local HTTP objectstore; all five consumers must work against411schema. Existing queries fail42703 before implementation; graph availability currentlyfalse despite validhash should fail assertion.
2. Approved statement remains active only while actual storagebytes+expectedhash+provenance match; changed/missingbytes make stale/unknown. Wrongtenant/path and currentdenial fetch no foreignbytes.
3. Same actual invoice objecthash yields confirmedreuse; changedobject with oldmetadata yields candidate/unavailable; missinghash cannotverify.
4. Beneficiary ownerassociation, exacthash, independentdecision and currentauthority preserved; altered/missingobjectrefuses.
5. Known overbudget skipsHTTP while countsremaincomplete and reportsasync requirement; deadline abort and byteaggregate limits do not return verifiedpartialscan.
6. Existing affected bank/beneficiary/invoice fixtures migrate to storagepointer+recordedhash+realHTTPbytes. No raw_bytes re-add, no productionactions.

Root centrally leases PostgreSQL/sourceTS. Source/light unit work proceeds independently. Exact tests/handles, namedcommit and independentreview follow.

## Root takeover and source checkpoint

Worker turn errored twice at platform level. Root inspected the isolated branch2799a9779, found only this plan and two untracked test files, and confirmed no live Vitest/tsc process. Root took over edits in this worktree; no completed implementation/review was inferred from the error.

Initial actual PG run found only a fixture status error (completed is not a bank import status); corrected to committed. captured-consumers-411-confirmed-red.log then proves four missing d.raw_bytes column failures plus one incorrect hash-availability assertion under transactional411schema. No persistent column change: every test rolls back and closes its pool.

All five consumers now use valid metadata queries. Actual object verification is performed by scanCapturedEvidence; unique document limit100, cumulative100MiB and foreground900ms/background20s bounds. Deferral clears verified results, preserves complete SQL population counts and adds explicit async_scan_required. These are bounded scan semantics, not completion of large asynchronous scanning or full request latency proof. Reviewed statements use deferred state for resource deferral instead of claiming provenance changed. Graph hash availability is valid recorded SHA256 metadata only and never fetches bytes.

Supplier beneficiary evidence still locks its matched supplier invoice association, then checks actual owned object bytes/current invoice permission. Metadata is detached before await, source errors retain the existing EVIDENCE_UNAVAILABLE_OR_CHANGED code; authorization and SQL failures propagate. Actual changed-object PG first exposed a generic-error regression, corrected before acceptance. Old inline-byte unit mocks were adapted to assert source-result/error propagation; actual HTTP integrity is proved by PG, not those mocks. An accessor case verifies zero getter/source-row reads.

captured-consumers-411-expanded-green.log:7 actual PG GREEN including changed object, beneficiary error code and actual101invoice metadata population deferring all HTTP. captured-consumers-regression-unit-green.log:18 units GREEN. Initial sourceTS found nullable row guard, corrected; sourceTS69368 terminal0. Source lint before final guard/import changes passed; final scoped lint required before checkpoint.

Legacy bank/beneficiary/invoice/payment release fixtures still need actual HTTP storage pointers instead of raw-byte-only seeds. No final consumer integration acceptance, full schema replay, full statement workflow or transport claim until those tests are migrated and rerun. Root remains responsible for actual full-population background scans, retention and runner.
