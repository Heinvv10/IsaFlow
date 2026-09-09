# Audit evidence retention and runner implementation

Root owns this task from integration `346ff7c0fead8015f11168e113bf8f6b2f42fa89`. Capture corrections and the separate export worker are dependencies. No new migration number is allocated here.

The runner must claim a persisted job in a short committed transaction, then open a fresh repeatable-read transaction using its original saved delegation. Capture source records, resolve retained evidence, seal the exact snapshot, and publish all material with the live generation fence. Failed transactions must not publish success or partial artifacts. Failure recording needs a separate transaction and exact issued lease; authority revocation cannot be hidden by substituting a cookie. Expired leases recover through bounded attempts.

Evidence attachment must enumerate documents from every retained parent, including passing checks. Use captured source references, matched invoice/bank relationships, and procurement direct/link relationships. Procurement supplier_invoice means Sage supplier invoices; never conflate it with ordinary supplier invoices. Independently verify original document parents and cross-link targets against company ownership and requested source authority. Bank attachments and legacy import evidence need explicit coverage decisions.

Storage inspection confirms captured raw bytes, captured bucket/path pointers through documentStorage, and procurement file_path/file_url through vfStorage coexist. Do not assume one store covers all evidence or use arbitrary database URLs as network fetch authority. Validate approved storage namespace and size before bounded retrieval; verify available recorded hashes. Missing historical hash/bytes remain unknown. A capture-time hash is not independent source authenticity. Retained bytes must survive source deletion/modification.

## Owned files and interfaces

- auditSnapshotEvidence.ts: issued-context coordinator taking captured AuditSnapshotData and exact saved AuditSnapshotRequest; detached validation before await; returns complete snapshot plus SnapshotArtifactBytes[]. Require repeatable read/current source authority.
- auditSnapshotEvidenceQueries.ts: owned parent/document discovery with keyset pagination, counts and deduplication; no unchecked polymorphic identities.
- auditSnapshotEvidenceStorage.ts: bounded actual storage reads, immutable copies, hash/length checks and sanitized missing-source results. Storage descriptors originate from authorized queries.
- auditJobRunner.ts: cold claim, fresh capture, deadlines/cancellation, atomic publication, sanitized failure and recovery. Actual server polling remains root-owned; status reads never start work.
- Focused unit and PostgreSQL tests under controls, split into files of at most300 lines.

Preserve the15 source families and seal contract unless separately tested central changes are needed. Authenticated metadata belongs in the snapshot body; exact bytes belong in publication storage. The export worker consumes readRetainedAuditSnapshot and does not query mutable financial sources.

## Failing scenarios before implementation

1. A passing invoice's captured document must be retained and remain reproducible after source modification.
2. Procurement direct/cross-linked evidence is retained exactly once; a dual-member foreign original parent cannot become owned through a cross-link.
3. Changed recorded hash/length refuses verified retention; absent bytes/hash remain explicit unknown.
4. Multiple document pages have exact counts; aggregate byte/record/time overflow cannot publish a partial snapshot. Use real payloads, not mocked counts alone.
5. Actual queued job cold claim commits, fresh repeatable-read capture/publication succeeds without an HTTP principal, and concurrent writes cannot mix source versions.
6. Revoked original authority, expired delegation or replaced lease cannot publish success. Failed capture rolls back publication; retries recover one successful result.
7. Actual cancellation terminates in-flight SQL/storage work within the phase-zero deadline. Observation timeout is not process completion.

Use only local synthetic DB/storage under orchestrator resource leases. Named independent review and integrated PostgreSQL verification are required. This is a file-level implementation plan, not a capability-completion claim.

## Actual captured storage foundation

Committed migration411 removes raw_bytes, and no subsequent committed migration restores it. Current local fixture nevertheless has this column. Existing forensic bank/invoice/beneficiary queries using it therefore do not establish fully migrated schema compatibility. Do not repair this by restoring a fictional production byte column. Adopt actual Supabase object bytes and migrate synthetic tests to a local HTTP storage fixture.

New root-owned capturedEvidenceStorage.ts validates/detaches metadata, enforces the configured bucket and exact company/document object path, uses configured service credentials only against that store without redirects, reads a bounded stream, and verifies recorded size/hash. Missing historical hash remains explicitly unverified even when a capture-time hash can be computed. Single-document bound is10MiB, matching existing forensic source checks; aggregate retention and larger-source programme bounds remain separate work. Actual abort propagates to fetch and the reader. capturedEvidenceSource.ts rechecks current domain permission, loads only the owned document row under a transaction lock and delegates storage access. Callers must separately prove their domain parent association; the helper does not turn an arbitrary document into statement/invoice evidence.

BankStatementAttestationSource now uses this real source reader. Eight actual local HTTP tests pass (captured-evidence-storage-green.log), following missing-module collection RED (no executed assertions). They cover exact bytes, metadata detachment, changed hash/size, foreign namespace before fetch, missing objects, redirects, chunked overflow and cancellation. Five real PG tests run with migration411's raw_bytes drop inside a transaction which always rolls back. Initial fixture errors (overlong account code and nonexistent source_channel) were corrected; the broad permission assertion was tightened and its actual banking module key corrected before accepting evidence. captured-evidence-source-confirmed-red.log has four missing-column failures plus a passing current-denial case. captured-evidence-source-green.log has all5 passing against real local object HTTP. SourceTS/scopedlint99051 terminal0.

Independent review is still required. Remaining raw-column consumers: bankStatementAttestationQuery, bankStatementCompletenessQueries, invoiceRiskQueries, beneficiaryQueries and transactionEvidenceDocuments. Existing raw-byte test fixtures must be migrated too. This foundation does not prove the remaining source consumers, all statement workflows, complete retention, runner or fresh historical migration replay.
