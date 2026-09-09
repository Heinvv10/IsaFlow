# Phase 4 execution contract

Root owner; base8c561e15 plus64253f89a18. Existing phase2-4-subplans remains the programme's file-level inventory. This checkpoint makes the durable execution boundary concrete; it does not waive any snapshot/export/exception capability.

## Owned files and interfaces

- Migration630: control_audit_job_intents (immutable protected request/delegation), control_audit_jobs (bounded leases/status/attempts). Migration645 owns control_audit_snapshots (encrypted complete sealed material, including all records) and control_audit_snapshot_artifacts (encrypted exact retained bytes authenticated by the sealed manifest). Indexed record paging remains to be implemented separately; full retained loads are background-only. Migration643 owns control_exceptions and immutable occurrences/decisions separately. Root allocates all prefixes; no reuse of reserved640/642.
- controls/auditJobContract.ts validates bounded snapshot requests; auditJobService.ts enqueues immutable request plus initial status atomically and returns status without processing. auditJobLease.ts claims owned jobs with SKIP LOCKED, generation+expiry fencing and bounded retries; stale workers cannot publish. auditJobRunner.ts obtains an actual fresh transaction and trusted persisted delegation, rechecks current membership, grant expiry/revocation and all required domain permissions. No role/scopes supplied in job request. Status and paging reads never execute work.
- controls/context.ts and lib/auth/effectivePermissionQueries.ts acquire job authority only from an authenticated, tenant-bound stored delegation and active lease. Forged object/authMethod job remains rejected. Preserve original grant ceiling, actual provenance job and original person; no synthetic cookie to bypass revoked bearer grants. Jobs cannot decide independent approvals.
- auditSnapshotQueries.ts captures explicit owned source columns/relationships under one REPEATABLE READ transaction; pages1000 with total hard bound100000 records and bounded60s runtime. Exceeding bounds fails explicitly without publishing a partial ready snapshot. Initial source families journal/header/line, supplier/customer invoice/payment/allocation, bank sources and requested payroll with separate payroll permission. Capture accounting cutoff and actual capture time separately.
- auditSnapshotCanonical.ts seals canonical materialized records, source versions/fingerprints, complete counts/exclusions, check IDs/versions/results and retained evidence hashes. Source raw bytes are retained, not only mutable references. Separate domain-separated HMAC using a server key outside database; privileged DB replacement of data+plain hash is detected, while attacker controlling both key and storage is outside boundary. PDF byte hash is separate from stable canonical snapshot hash.
- auditSnapshotService.ts publishes only a complete sealed snapshot; auditSnapshotCompareService.ts compares materialized identities and exact hashes, including backdated addition/edit/reversal/classification/check-version changes. Original records never change.
- auditEvidenceExportService.ts emits complete manifest and artifacts from the snapshot, verifies retained bytes and signatures, never reloads mutable business rows. Existing capture/auditTrailExportService.ts and portal polling flow delegate after real behavior is verified.
- controlExceptionService.ts persists stable finding identity, occurrences, version, owner/due date/evidence. resolveException cannot mark remediated from failed/unknown/error/incomplete recheck; requires exact current check version and independent current permitted human for high risk. Accepted risk keeps reason/expiry/reviewer visible; recurrence reopens. Immutable decisions retain old checks/evidence, concurrent transitions use row lock+expected version. Root owns registry/HTTP/UI adapters after services.

## Tests first and acceptance evidence

1. Actual enqueue leaves source rows/results untouched; rollback removes both intent/status; same requester/key/same request returns one job, changed request refuses, foreign requester/company cannot inspect it.
2. Two workers claim one job once; expired lease takeover increments generation; stale completion refuses; restart after sealed result reuses receipt. Revoked person/role/PAT/OAuth and narrower original scopes refuse before source reads. Forged job context fails.
3. Two-session header/line update during capture never produces mixed state. Capture501journals/1002lines and exact full populations through pages. Bounds fail visibly; no source count fabricated from one page.
4. Backdated posting/edit/reversal after snapshot leaves old canonical bytes/hash unchanged and comparison identifies actual differences. Alter record/artifact and plain stored hash still fails independent authentication; source/document foreign-parent references do not expose metadata.
5. Actual archive population/counts/totals/evidence manifest match snapshot; missing evidence explicit unknown. PDF renderer variance does not change canonical hash. Local synthetic external receipt demonstrates trust boundary without any real upload.
6. High-risk owner cannot self-verify via second token; revoked reviewer fails. Failed/unknown/error stale-version recheck cannot close; accepted risk remains visible, subsequent occurrence reopens; foreign tenant cannot assign/read/evidence-link. Concurrent assignment/resolution yields one expected version transition.
7. Existing local MCP HTTP and REST/UI supplier/payroll/close workflows consume these real services. No final completion until full finalCI, named independent integrated review and draftPRs.

Resource leases remain centralized. Initial job contract/630 schema REDs precede code; declaration-only schema never counts as runnable jobs/snapshots/exceptions.

## Snapshot sealing implementation contract

`auditSnapshotSeal.ts` seals complete explicit materialized populations: unique source/record identities, source versions, declared counts/exclusions, complete nonpaginated check results, retained artifact SHA256/byte lengths and explicit coverage/missing sources. It canonicalizes record ordering and authenticates the canonical hash with domain-separated HMAC-SHA256. `CONTROL_SNAPSHOT_SIGNING_KEY` is mandatory (at least32characters) and must stay outside database storage; `CONTROL_SNAPSHOT_KEY_ID` defaults to current. There is no insecure ordinary-hash fallback. Loss/rotation of this key currently makes old seals unverifiable; retained key-ring management remains an operational requirement before production rollout. Compromise of both server key and database is outside this trust boundary.

Verification requires expected tenant and snapshot IDs, validates complete canonical structure, and returns privately branded deeply frozen material. Artifact checks refuse copied/unverified metadata and require the exact retained bytes. Rendered PDF bytes are not accepted in canonical snapshot data; the eventual export manifest must authenticate its own rendered artifact hash separately. This module is cryptographic retention support, not completed source capture, snapshot storage, export or transport. Current hard bounds100000records/100MiBcanonicaldata complement forthcoming paginated database capture bounds.
# Cold worker claim implementation

Root owns auditJobLease.ts, context.ts, auditJobDelegation.ts and auditJobContext.int.test.ts.
The missing boundary is claiming a durable request after restart without a live HTTP principal.
Add claimAuditJobForWorker(store, jobId) for a server-owned transaction with tenant/person GUCs.
Validate protected saved request identity before touching the queue; use the existing private
lease issuer and generation fencing, then validate original current authority through the real
job context before returning. Refusal rolls back the claim savepoint even if its caller catches it.
No synthetic cookie, caller-supplied grants or injected worker callback are accepted.
Tests: cold claim and later job context, foreign tenant refusal with untouched queue,
revoked authority with no committed attempt, concurrent claim, expired takeover and retries.
This does not yet supply polling, consistent capture, retained storage or publication.

## Atomic retained publication

Root auditSnapshotPublication.ts and auditSnapshotPublicationMaterial.ts own exact request/population/check validation,
artifact detachment and completeness, protected retained writes, and terminal success under the active lease.
Snapshot identity equals job identity. A fresh cookie cannot replace original job delegation during publication.
readRetainedAuditSnapshot rechecks current reader source permissions, authenticates the retained snapshot and every
artifact, and never reloads financial source rows. It is for bounded background comparison/export, not status or paging.
The complete sealed snapshot is encrypted with the evidence key; its independent HMAC remains outside database control.
Tests begin with missing publication capability and actual absent storage, then verify successful retention, wrong/missing
artifact refusal, foreign reader refusal, rollback/retry, complete population and original job-context requirements.
Further real capture-to-publication, tamper/concurrency/recovery, paging and complete export workflow verification remains required.
