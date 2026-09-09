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
