# Plan v2: page-complete forensic check runs — 2026-09-10

Status: revised after an adversarial review returned REJECT on v1 (c47c7e246). Pending re-review.
Verified against integration commit `c47c7e246` (no source drift from 6ec30a9cd in the reviewed paths).
Spec: `c76b9706:docs/superpowers/plans/2026-09-09-mcp-forensic-controls.md`.

Correction to the review's item 1 that changes the fence design: the claim transaction commits before
work starts (`auditJobRunner.ts:53`, `:56`), so the claim's `FOR UPDATE SKIP LOCKED` lock
(`auditJobLease.ts:49-50`) is released at claim commit. The lock that persists during work is the
`FOR SHARE OF j` taken by `loadStoredAuditJobDelegation` (`auditJobDelegation.ts:16`). It does block a
competing claim (row skipped, `not_claimed`), but the poller still lists the job after 90 s
(`auditJobPoller.ts:38`) and spawns a unit per poll (`auditJobProcess.ts:23`); a hung worker holds the
share lock indefinitely. The review's conclusion — spawn storm, indefinite hold, renewal ineffective —
is confirmed; only the lock type differs. No `idle_in_transaction_session_timeout` exists anywhere in
`src` or `scripts`. `calculateCumulativeThreeWayMatch` reduces invoiced/accepted arrays to sums
(`threeWayMatchMath.ts:12`), but `evaluateThreeWayMatchRow` inspects each receipt's status/quality
(`threeWayMatchQueryService.ts:17-22`), so receipts must stream per line rather than be pre-summed.

## Review response

| # | Finding | Disposition |
|---|---|---|
| 1 | Lease renewal inside the RR txn is invisible; second-connection renewal breaks RLS under the snapshot; hung workers hold locks; poller re-spawns | Accepted. Fence = `FOR UPDATE NOWAIT` on the job row as phase A's first statement (upgrading the existing `FOR SHARE`), `lease_expires_at` set once at claim to `clock_timestamp() + maxRuntimeMs(kind) + grace`, `idle_in_transaction_session_timeout` per session, no in-txn renewal. §4.1 |
| 2 | Option A rejected for reasons C shares | Accepted. Reviewer design 18 is the default; population copy is spike-gated only. §0 |
| 3 | Plaintext payroll/bank `material`, member-readable, failed generations kept | Accepted. No population copy, so no `material` table. Findings stored as protected envelopes; failed generations leave no rows. §2.3 |
| 4 | No retention/purge/quota | Accepted. Migration 677: SECURITY DEFINER purge, per-company quota, enqueue refusal. §2.2 |
| 5 | Census authenticates nothing; trust claim imprecise | Accepted. Sealed at commit; precise claim in §2.4 |
| 6 | Second SQL implementation of detector logic (spec l.87) | Accepted. SQL only orders/groups by raw tuples; existing pure functions evaluate; differential randomised tests. §3 |
| 7 | Evidence budget uncapped; silent downgrade | Accepted. Total byte cap, sha256/size/version recorded at capture, overflow ⇒ coverage incomplete, never a clean pass. §4.3 |
| 8 | Unmeasured limits; all-or-nothing publish | Accepted. One job per check; limits from the T3b spike; resource limit publishes `unknown`. §4.4 |
| 9 | Per-check snapshot fallback weakens consistency silently | Accepted. One job per check, each header carries its own `snapshot_xid`, no cross-check consistency claim. §2.1 |
| 10 | T13 targets the wrong problem and contradicts §2 | Accepted. Replaced by synchronous chunked pagination of one oversized event. §3.7 |
| 11 | Check runs starve existing audit jobs | Accepted. Kind-aware queue slot, poller `kinds` filter, separate unit template. §4.5 |
| 12 | Highest risk measured last | Accepted. T3b spike right after T3 is the go/no-go; T12 covers all six checks. §5 |
| 13 | Deploy interaction with a long RR txn | Accepted. Drain, migration `lock_timeout`, xmin-age alert. §4.6 |
| 14 | RLS WITH CHECK/FK read through the RR snapshot; job-row UPDATE can raise 40001 | Accepted, noted. Lease values were committed at claim, before the snapshot. §4.1 |
| 15 | Split migrations; split runner per phase | Accepted. 676 schema, 677 retention; runner split into fence/cursor/publication/evidence/orchestrator. §1 |
| 16 | Justify `write:bank-tx` for a read job | Accepted with justification. §4.7 |
| 17 | "Requirement 3" does not exist in the spec | Accepted. Requirement→test matrix by spec line. §6 |
| 18 | Simpler default design | Adopted as default. §0.1 |

## 0. Design

### 0.1 Default (adopted)

One `audit_check_run` job = one check.

1. **Claim** (RC txn, existing `claimAuditJobForWorker`, `auditJobLease.ts:30-43`) with the lease set to
   the kind's full deadline plus grace.
2. **Phase A, one REPEATABLE READ txn**: `FOR UPDATE NOWAIT` on the job row; delegation and permissions
   reloaded (`withControlJobRequest`, `context.ts:103-120`); record `txid_current_snapshot()`;
   `DECLARE c NO SCROLL CURSOR FOR <existing detector predicate, LIMIT removed> ORDER BY <group tuple>, id`;
   `FETCH 1000` loop; slabs of equal group tuple go to the existing pure functions; each parent's children
   come from a bounded keyset loop; findings are sealed and inserted in 512-row / 2 MiB batches
   (`auditSnapshotIndexRows.ts:11-37` pattern); evidence document references recorded; sealed result header
   inserted; lease-fenced `UPDATE control_audit_jobs … state='succeeded'` last; COMMIT.
3. **Phase B, RC txn(s)**: verify captured-document bytes against recorded sha256 within the evidence
   budget; insert a sealed evidence summary. Idempotent, keyed by job+generation; tracked by `result_phase`.

A kill in phase A leaves nothing and restarts that check from zero; T3b quantifies the restart cost.

### 0.2 Alternative (spike-gated)

The v1 population-copy design is kept only if T3b shows analysis time dominates capture time by a wide
margin and restart-from-zero is the observed failure mode. If adopted it must satisfy review items 3, 4
and 5 verbatim (minimal columns, protected envelopes for sensitive fields, HMAC-sealed census at capture
commit, retention in T1) and gets its own review.

### 0.3 Why the default meets the requirements

Immutable population = the RR snapshot, recorded by `snapshot_xid`. Cursor streaming has no LIMIT and no
`LIMIT 101` child caps. Counts, totals, coverage and the success pointer share one COMMIT. Readers page
stored findings by ordinal. Failure rolls back rather than partially publishing. Kill survival comes from
lease=deadline plus the `FOR UPDATE` fence plus the idle timeout; retry uses a new generation and nothing
committed by a failed generation exists. Permissions are rechecked per phase and again at read time.

## 1. Module shape

All under `src/modules/accounting/services/controls/` unless noted; each ≤300 lines.

| File | Responsibility |
|---|---|
| `auditCheckRunContract.ts` | kind `audit_check_run`; per-check `AUDIT_CHECK_RUN_LIMITS {maxRuntimeMs, leaseGraceMs, idleMs, fetchRows:1000, maxSlabRows, maxChildrenPerParent, maxReferenceRows, maxFindings, evidenceDocumentsPerRun, evidenceBytesPerRun, evidenceWallMs}` — placeholders marked `UNMEASURED` fail a unit test until T3b fills them; `parseAuditCheckRunRequest({cutoff, check, idempotencyKey})`; `auditCheckRunPermissions(check)` = the sync detector's set (`auditJobContract.ts:13-16,23-29`, plus optional `write:bank-tx`) |
| `auditCheckRunJobService.ts` | `enqueueAuditCheckRuns(ctx,{cutoff,checks[],idempotencyKey})` → one intent per check (`idempotencyKey:check`), quota check, advisory lock (`auditComparisonJobService.ts:15-44` pattern); `getAuditJob` gains `resultCheckRunId` and `evidencePhase` |
| `auditCheckRunFence.ts` | `fenceAuditCheckRun(ctx,lease)`: `FOR UPDATE NOWAIT` on the job row bound to state/lease/generation; throws on 0 rows or expiry; returns `{snapshotXid}` |
| `auditWorkerTransaction.ts` (+3 lines) | `idle_in_transaction_session_timeout` beside `statement_timeout`/`lock_timeout` (`:26-27`) |
| `auditJobLease.ts` | `claimPendingJob` sets `lease_expires_at` from a kind→limits table (legacy kinds keep `AUDIT_JOB_LIMITS.leaseSeconds`); kind is already read at `:35` |
| `auditCheckRunCursor.ts` | `openCheckCursor`; `fetchSlabs` (FETCH loop yielding rows sharing the group tuple, carry-over across fetches, `ResourceLimitError('slab_rows')` above `maxSlabRows`); `fetchChildren` keyset loop with `maxChildrenPerParent`; budget/abort via `indexBudget` (`auditSnapshotIndexValidation.ts:31-44`) |
| `auditCheckRunSeal.ts` | `sealCheckResultHeader`, `sealCheckFindingItem`, `sealCheckEvidenceSummary`, verifiers; domain `audit-check-run-v1` |
| `auditCheckRunPublication.ts` | batched findings writer (RETURNING identity check, Decimal(80) totals cross-checked against SQL `SUM(amount::numeric) GROUP BY currency`), `publishCheckResult` with the fenced job UPDATE (`auditComparisonPublication.ts:68-72`) |
| `auditCheckRunEvidence.ts` | phase B verification and sealed summary |
| `auditCheckRunUnknown.ts` | `publishUnknownCheckResult` for resource-limit outcomes |
| `auditCheckRunRunner.ts` | orchestrator; new dispatch branch in `auditJobRunner.ts` |
| `auditCheckStream{Duplicates,Payments,ThreeWay,Journals,Bank,Payroll}.ts` | per check: cursor SQL, slab→pure-function adapter, child loops, evidence refs, coverage/missing assembly using the sync detector's own string constants |
| `auditCheckRunReadService.ts` | header, findings (keyset, seal-verified, current per-check permissions), evidence summary |
| `controlChangeHistoryChunks.ts` | oversized single-event chunked reads; `controlChangeHistoryService.ts:45` gains `requiredDelivery:'chunked'` and the first cursor |
| `src/lib/mcp/tools/forensicCheckRuns.ts` | `run_control_checks`, `control_check_run_status`, `control_check_run_findings`, `control_check_run_evidence`, `entity_change_history_chunk` |
| `pages/api/accounting/audit-check-runs.ts` | POST enqueue, GET status/findings (`audit-comparisons.ts:17-34` pattern) |
| `scripts/forensic/run-audit-worker.ts`, `auditJobProcessContract.ts` | kind-class limits (`audit` 65 s, `check-run` measured) and a separate unit template |

## 2. Data model

### 2.1 Migration 676 (PROVISIONAL — 674 and 675 are held on other branches; root must rescan all refs and worktree SQL dirs and reserve, spec l.20)

- `control_audit_job_intents.kind` CHECK extended with `audit_check_run` (`668:2-3` pattern).
- `control_audit_jobs`: `result_check_run_id uuid` (= job_id), `result_phase text CHECK IN
  ('analysis','evidence_pending','evidence_complete','evidence_incomplete')`, result-check rewritten over
  four result columns, `GRANT UPDATE(result_check_run_id,result_phase)`. Comment records that this kind's
  lease is set once at claim with no renewal.
- `control_audit_check_results(company_id, job_id, generation, lease_id, check_id, snapshot_xid, status
  CHECK IN('pass','fail','unknown'), population_count, excluded_count, finding_count, amount_totals jsonb,
  coverage jsonb, missing_sources jsonb, protected_header jsonb ≤64 KiB, PK(company_id,job_id,generation),
  FK→control_audit_jobs)`; guarded job FK on `(company_id,result_check_run_id,generation)` (`668:44-49`).
- `control_audit_check_findings(… ordinal 0..999999, finding_key hex64, amount text, currency text,
  protected_item jsonb ≤64 KiB, PK(company_id,job_id,generation,ordinal),
  UNIQUE(company_id,job_id,generation,finding_key))`.
- `control_audit_check_evidence(… ordinal, document_id, entity_type, entity_id, recorded_sha256,
  recorded_byte_length, recorded_version, verified boolean, verified_at, PK(…,ordinal),
  UNIQUE(…,document_id))`; `GRANT UPDATE(verified,verified_at)` under the worker policy only.
- `control_audit_check_evidence_summary(… verified_count, unverified_count, bytes_read, state
  CHECK IN('complete','incomplete'), protected_summary jsonb, PK(company_id,job_id,generation))`.
- RLS on all: tenant read (`668:53-55`); INSERT/UPDATE only for a running job with matching generation,
  lease and unexpired lease, joined to an intent of this kind with `requester_person_id=auth.uid()`
  (`668:56-63`). No other UPDATE/DELETE grants. These WITH CHECK subqueries read the job row through the
  RR snapshot; its lease values were committed at claim, before the snapshot, so they are visible.
- Indexes: PKs serve ordinal paging; add a kind-filtered claim index only if T2's `EXPLAIN` needs it.

### 2.2 Migration 677 — retention and quota

`control_audit_check_run_quota(max_published_runs default 200, max_active_runs default 2, retention_days
default 400)`; SECURITY DEFINER `control_audit_purge_check_runs(p_company)` deleting findings/evidence/
results past retention while keeping sealed headers and job history, `REVOKE EXECUTE FROM PUBLIC`, granted
to app_user with an internal `app.current_company_id()` guard; runner calls it after publication; enqueue
refuses over quota with `quota_exceeded`.

### 2.3 What is stored where

Plain columns: identifiers, counts, totals, hashes, coverage/missing strings, document sha256/size/version.
Protected envelopes: every finding item, result header, evidence summary. Payroll findings reference
`payroll_run`/`employee` ids only (`payrollControlAnalysis.ts:24-26`); reads require current `read:payroll`.
Beneficiary account values never leave the transaction (`paymentRiskChecksBeneficiaries.ts:5`).

### 2.4 Trust claim for seals (spec l.107)

The HMAC (domain `audit-check-run-v1`, key `CONTROL_SNAPSHOT_SIGNING_KEY`) over the canonical header
(company, job, generation, lease, check, snapshot_xid, cutoff, capturedAt, population/excluded/finding
counts, totals, coverage, missingSources, evidence-ref digest, findings digest) and over each item proves
(a) the result was produced by a key holder holding an unexpired lease of that generation, and (b) it has
not been altered since sealing. It does not prove the sources were complete or correct at capture, and it
is not independent of an operator holding both DB write access and the key.

## 3. Per-detector conversion (SQL orders, JS evaluates)

Common: cursor SQL is the existing detector SELECT with `LIMIT` removed; `count(*) OVER()` becomes a
preceding `count(*)` under the same snapshot; `ORDER BY` the raw grouping tuple then `id`; children come
from `fetchChildren`; exceeding `maxChildrenPerParent` records `missingSources:
'child_material_exceeds_limit:<population>'` with coverage incomplete (status cannot be `pass`); totals use
`Decimal.clone({precision:80})` (`invoiceRiskQueriesResult.ts:26-27`) cross-checked by SQL before sealing.

1. **duplicate_invoice_checks** — cursor `invoiceRiskQueries.ts:7-15` ordered by supplier, date, currency,
   subtotal, tax, total, id; slab → `detectInvoiceDuplicates`; imports streamed for population/mapped
   counts; evidence refs recorded; byte-reuse findings stay `candidate` until phase B verifies both docs.
2. **payment_risk_checks** — cursor over `supplier_payments` (`invoiceRiskQueriesPayments.ts:9-29` without
   the two `LIMIT 101` LATERALs) ordered by supplier, amount, id; allocations and attempts per payment via
   `fetchChildren`; slab → `detectPaymentPatterns`. Beneficiaries (only with current `write:bank-tx`):
   phase A computes `beneficiaryFingerprint` per row and writes `(fingerprint, supplier_id)` to a session
   TEMP table dropped at commit, then reads it back ordered as slabs into `detectSharedRiskBeneficiaries`.
3. **three_way_match_exceptions** — cursor over invoice lines (`threeWayMatchSources.ts:10-41` without the
   three LATERALs) ordered by invoice, item; bills, receipts and rules per line via `fetchChildren`;
   `evaluateThreeWayMatchRow` unchanged (receipts must be rows, not sums).
4. **journal_risk_checks** — cursor over `journalRiskQueries.ts:9-44` without the caps, ordered by
   `(actual_at AT TIME ZONE 'Africa/Johannesburg')::date`, person, currency, id (a unit test proves SQL
   equality with `parts()` at `journalRiskAnalysis.ts:9-13`); changes and lines per journal via
   `fetchChildren`; slab → `analyseJournalRisks(slab, thresholds)`; thresholds loaded fully under
   `maxReferenceRows` with the existing `missingPolicy` semantics (`journalRiskQueries.ts:48-50`).
5. **bank_statement_completeness** — cursor over roots (`bankStatementCompletenessQueries.ts:11-41`);
   per-root counts, nets and fingerprints lose `LIMIT 10001` and stay set-based in PG; uncovered counts and
   fingerprints computed without LIMIT; row → `analyseBankStatementCompleteness` unchanged.
6. **payroll_control_checks** — reference sets loaded under `maxReferenceRows`; runs cursor; lines and
   journal lines per run and declarations via `fetchChildren`; shared banks and component changes from the
   existing SQL (`payrollControlQueries.ts:33-46`) without LIMIT; `analysePayrollControls` refactored into
   pure `analysePayrollRun` and `analysePayrollCrossRun`, with a differential test proving the composition
   is identical on existing fixtures.
7. **History >2 MiB** — `controlChangeHistoryChunks.ts` serves one oversized event's redacted
   `{before, after}` canonical JSON in 256 KiB chunks under a signed cursor
   `{eventId, chunkIndex, valueSha256, permissionsHash}`; a cursor whose hash or permissions no longer
   match is rejected. Synchronous, bounded, no job kind.

Differential testing: per check, randomised fixtures (≤10k parents, up to 150 children, deliberate group
collisions across FETCH boundaries) assert equality of finding keys, counts, totals, coverage (minus the
`synchronous_population_limit_10000` marker) and missingSources between sync detector and run.

## 4. Failure semantics and operations

### 4.1 Fence

Claim sets `lease_expires_at = clock_timestamp() + maxRuntimeMs(kind) + leaseGraceMs`, committed, so the
poller predicate (`auditJobPoller.ts:38`) stays false for the run. Phase A's first statement is
`FOR UPDATE NOWAIT` on the job row, so any competing claim skips it. `idle_in_transaction_session_timeout`
(proposed 60 s) plus the existing `statement_timeout` terminate a hung backend, rolling back and releasing
the lock; the lease then admits a new generation. The systemd hard kill uses the kind's `maxRuntimeMs`
(`auditJobProcess.ts:38-39`). No renewal exists for this kind. The only in-RR job-row UPDATE is the final
success pointer; 40001 remains retryable (`auditJobRunner.ts:79`).
Gate (T2): with injected limits (`maxRuntimeMs` 6 s, legacy lease 2 s) a check running 3× the legacy lease
yields exactly one generation, zero extra units spawned, and success.

### 4.2 Kill, retry, idempotency

Phase A kill: rollback, nothing visible, reclaim at generation+1, restart. Phase B kill: analysis already
succeeded with `result_phase='evidence_pending'`; retry re-enters phase B only, idempotent per document.
Three attempts then `failed/RETRY_EXHAUSTED` (`auditJobLease.ts:51-56`).

### 4.3 Evidence

Phase A records each referenced document's `recorded_sha256`, byte length and version. Phase B verifies via
`loadOwnedCapturedEvidence` under `evidenceDocumentsPerRun`, `evidenceBytesPerRun` (proposed 2 GiB, pending
T3b) and `evidenceWallMs`. Overflow ⇒ summary `incomplete`, `coverage: evidence_verification:incomplete`,
`missingSources: captured_evidence_verification_incomplete:<n>`, status `unknown` unless findings make it
`fail`; unverified documents never yield `confirmed` byte-reuse.

### 4.4 Resource limits

`ResourceLimitError` in phase A aborts the txn; the runner then writes, in a fresh RC txn under the same
lease, a sealed `status:'unknown'` result with `missingSources:['resource_limit:<reason>']` and marks the
job succeeded. The fan-out tool reports each check separately and the aggregate is `unknown` if any check
is `unknown` (spec l.97).

### 4.5 Queue isolation

`running` becomes per-kind-class; the poller takes a `kinds` filter; check-run units use their own template
and limits. Gate (T2): a snapshot job completes while a 20 s check run is in progress.

### 4.6 Deploy interaction

Drain the check-run poller before migrations (SIGTERM, wait for no running check-run jobs, else kill after
the kind deadline); migrations run with `SET lock_timeout='5s'` and retry; alert on
`age(backend_xmin)` for `application_name LIKE 'isaflow-audit:%'`. Legacy kinds keep the 65 s limit.

### 4.7 `write:bank-tx` for beneficiary comparison

Decrypting supplier bank envelopes is gated by the same authority the writer path uses
(`invoiceRiskQueriesBeneficiaries.ts:8-10`, `paymentRiskChecks.ts:67`); no narrower `read:beneficiary`
permission exists in the effective-permission model at this commit, and adding one is a shared-contract
change owned by root. Without current `write:bank-tx` the check publishes
`missingSources:['beneficiary_comparison_authority']` and no shared-account findings; page reads re-assert
the permission and withhold otherwise. T14 covers both branches and revocation between enqueue and read.

### 4.8 Tenant isolation

Every table keyed by `company_id` with RLS; cursor SQL is the existing company-scoped predicate; foreign
parents stay masked booleans; cross-tenant job ids read as not found.

## 5. Task DAG and gates (RED first; real PG; serialised DB lease)

- **T1** Contracts + migrations 676/677 (root). Gate: fresh replay; RLS refuses insert without a live lease
  of the right kind/generation; purge refuses a foreign company; quota refusal; typecheck; naming gate;
  recorded prefix rescan.
- **T2** Fence, kind-aware lease, idle timeout, queue isolation, dispatch, enqueue/status. Gates: §4.1
  (3× lease, no spawn storm), §4.5 (snapshot completes during a check run), idempotent enqueue, status
  never triggers work.
- **T3** Cursor/slab engine, publication/seal, reader on a synthetic check. Gates: slab split across a
  FETCH boundary preserved; duplicate finding key fails; totals mismatch fails; seal tamper detected;
  unpublished generation unreadable; abort mid-stream leaves zero rows.
- **T3b Spike (go/no-go)** 100k supplier invoices with 0–150 allocations/attempts and 100k journals with
  3–10 lines plus change events. Measure per check: phase A wall time, WAL bytes, RLS WITH CHECK cost,
  `age(backend_xmin)`, storage; plus a population-copy prototype for one check to settle §0.2. Output
  `forensic-evidence/check-run-spike-100k.json` and the filled limits; decision recorded in the ledger
  before T5–T10 start.
- **T5–T10** Six stream adapters (≤3 parallel). Gates each: differential randomised test vs sync detector;
  over-cap test (10,001 parents, 150 children, 101 documents) complete; cross-FETCH group test; tenant leak
  test; sensitive-field absence in stored envelopes.
- **T11** Transport and history chunking: MCP/REST with synthetic bearer; revoked scope forbidden; >2 MiB
  event delivered by chunks with a stable cursor rejected after change.
- **T12** Scale and hard-kill, all six checks: 100k fixtures under `createIsolatedAuditJobRunner`; SIGKILL
  in phase A ⇒ zero rows, reclaim, success; SIGKILL in phase B ⇒ `evidence_pending` then completion.
- **T13** Retention/quota runtime: purge after publish; quota refusal; sealed headers survive retention.
- **T14** Permissions: both `write:bank-tx` branches; payroll page read refused without `read:payroll`;
  revocation between phases records `AUTHORITY_REVOKED`.
- **T15** Integration: `bun run ci` on the named commit; independent review of migrations, RLS, seals,
  sensitive-data absence and bypass routes; adversarial pass (forged lease, other generation, snapshot-kind
  job inserting check rows, downgrade between enqueue and read).

## 6. Requirement → test matrix (spec lines at c76b9706)

| Spec line | Requirement | Tests |
|---|---|---|
| 18 | Company-scoped access; payroll/beneficiary narrowly scoped and redacted | T1 RLS; T5–T10 tenant-leak and sensitive-field absence; T14 |
| 83 | No unnecessary bank/payroll secrets; cross-tenant ids disclose nothing | T5–T10 envelope inspection; T14; T15 adversarial |
| 87 | Reuse verified detectors; no parallel sources of truth | T5–T10 differential tests; review rule: adapters may not compute finding keys or classifications |
| 92 | Three-way match across complete populations | T7 over-cap test |
| 97 | Totals cover all findings beyond pagination; a failed check cannot make the run pass; payroll restricted | T3 totals cross-check; T8 unknown aggregate; T14 |
| 107 | Define and test the trust boundary of hashes | T3 seal tamper tests; §2.4 reproduced in tool descriptions |
| 109 | Bounded async jobs/status/pagination; reads never trigger unbounded processing | T2 status test; T11 page bounds; O(chunk) history reads |
| 120 | Large datasets with explicit latency, pagination, recovery and resource bounds | T3b spike; T12 scale and hard-kill; measured limits |

## 7. Strongest argument against, highest-risk unknown, decisive evidence

Against: one RR transaction per check at 100k parents with per-parent child loops issues 10^5–10^6
statements over one connection under one xmin; if T3b shows phase A for payments or three-way match exceeds
a tolerable window (proposed ceiling 10 min) or vacuum pressure is unacceptable, the design fails
operationally even though it is correct. Highest-risk unknown: exactly that measurement, plus evidence-byte
verification throughput. Decisive evidence: analysis ≥3× capture with restart cost dominating ⇒ adopt §0.2
under the item 3/4/5 constraints; per-parent child loops dominating ⇒ replace them with a second ordered
cursor over children merged by parent id, still without copying. If T3b passes, no population tables are
ever created.
