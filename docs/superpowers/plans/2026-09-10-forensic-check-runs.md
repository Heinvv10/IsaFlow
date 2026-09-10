# Plan v3: page-complete forensic check runs — 2026-09-10

Status: revised after two independent adversarial reviews rejected v1 (c47c7e246) and v2 (3e4c0aaa7).
Pending third review. Verified at `3e4c0aaa7` (no source drift in the cited paths from 6ec30a9cd).
Spec: `c76b9706:docs/superpowers/plans/2026-09-09-mcp-forensic-controls.md`.

Verification notes: `630_forensic_audit_jobs.sql:20` forces `lease_id`/`lease_expires_at` NULL unless
`state='running'`. `auditSnapshotIndexValidation.ts:32,40` caps any deadline at now+60 s. `context.ts:108`
calls `loadStoredAuditJobDelegation` (`FOR SHARE OF j`, `auditJobDelegation.ts:16`) before the handler.
`paymentRiskChecksBeneficiaries.ts:6-18` owns decryption, fingerprint re-check and `missing` accumulation.
`payrollControlAnalysis.ts:56,68-90` needs all runs and lines together and keys UIF findings on
`periodRuns[0]!.id`. `app_user` is `NOLOGIN` (`348_rls_and_auth_helpers.sql:8`) with no explicit TEMP
grant anywhere, and no `CREATE TEMP` exists in `src`. `641_forensic_match_override_intents.sql:3-11` is
consumed only by `services/ap/invoiceMatchOverride*.ts`, never by `evaluateThreeWayMatchRow`.
`attempts BETWEEN 0 AND 3` is a table CHECK (`630:14`). The "extend `data_integrity_checks` rather than add
redundant tools" sentence is spec line 89 (line 84 is blank); `data_integrity_checks` is a synchronous
13-check ledger suite (`integrity.ts:41-53`).

## Review response

| # | v2 finding | Disposition |
|---|---|---|
| 1 | Phase B cannot write (630:20 nulls the lease on success) | Accepted; **phase B removed**. Evidence bytes are verified inside phase A before detection, under the same lease. §0.1, §4.3 |
| 2 | A sealed `pass` with unverified evidence is permanent | Accepted; eliminated by 1. Verification precedes sealing, so a mismatch or overflow sets `file_verified=false` before the detector runs. A sealed status is final. §2.4 |
| 3 | §3.1 re-derived a detector-owned classification; gate blind | Accepted. No reclassification; `detectInvoiceDuplicates` receives `file_verified`/`file_hash` exactly as `invoiceRiskQueries.ts:16-17` computes them. Differential set now includes `kind, severity, classification, message, entities, evidence` per finding key. §5 |
| 4 | Payroll amounts plaintext under `tenant_read` | Accepted. `amount`/`currency` columns removed; everything lives in `protected_item`. Totals verified by an in-txn re-read that opens the sealed envelopes. T14 gate. §2.1, §4.4 |
| 5 | Three unowned 60 s ceilings | Accepted. `auditJobRunner.ts` and `auditWorkerTransaction.ts` owned; new `auditCheckRunBudget.ts`; `indexBudget` unused. §1, §4.5 |
| 6 | Fence cannot be first; NOWAIT mechanism misstated | Accepted. `context.ts`/`auditJobDelegation.ts` owned: the delegation load takes `FOR UPDATE OF j` for check-run kinds. The competitor skips because *its own* claim uses `FOR UPDATE SKIP LOCKED` (`auditJobLease.ts:49-50`); NOWAIT dropped. §4.1 |
| 7 | TEMP-table trick loses beneficiary `missing` markers | Accepted; temp table dropped. Split into `classifyRiskBeneficiary` and `groupSharedRiskBeneficiaries`, the existing export becoming their composition, with an identity test. §3.2, T4 |
| 8 | Temp-table hygiene/privilege unproven | Moot — no session objects anywhere; stated as a design rule |
| 9 | `analysePayrollControls` not decomposable | Accepted. Payroll keeps the existing synchronous population/analysis inside the check-run txn with its 10,000 bound; over-bound publishes `unknown`. Accumulator deferred to T16. §3.6 |
| 10 | Quota defaults refuse the fan-out | Accepted. Quota is per fan-out (`run_group_id`), `max_active_fanouts` default 2; T13 asserts a six-check enqueue succeeds. §2.2 |
| 11 | Spec l.92 overrides dropped | Accepted as out of numeric scope (consistent with the reviewed decision that override annotations stay separate from numeric truth). The run records `three_way_override_intents_not_evaluated:<n>` when overrides exist for the population; T7 gates it. §3.3 |
| 12 | Results incomparable; no source_hash/source_versions | Accepted. Header carries `sourceHash` (byte-identical to the sync `riskHash` of the row array, computed incrementally) and paged `control_audit_check_sources`; vocabulary mapping in §3.8 |
| 13 | Restart vs 3-attempt cap | Stated: cap unchanged; exhaustion is `failed/RETRY_EXHAUSTED` (that path runs without a lease); fan-out status reports it per check; `maxRuntimeMs` is sized from T3b with headroom instead. §4.2 |
| 14 | Canonical sort keys; order-key test for all adapters | Accepted. §3 common rules, T5–T9 |
| 15 | Sort materialisation, temp bytes, index | Accepted. T3b reports first-FETCH latency and temp bytes; T1 holds the index decision |
| 16 | No T4; no alternative task set; purge semantics | Fixed. §5 numbering; §0.2 A1–A4; §2.2 purge transaction and `run_purged` reader error |
| 17 | Justify new tools against spec l.89 | Reduced to three tools with justification; history chunking extends `entity_change_history`. §4.8 |
| 18 | Citation drift | Fixed: three-way files under `services/ap/`; `auditJobContract.ts:13-16` is `checkSources`, `:23-29` is `auditSnapshotPermissions` |

## 0. Design

### 0.1 Default: one REPEATABLE READ transaction per check, evidence verified in-transaction

Job = one check (`kind='audit_check_run'`, request `{cutoff, check, idempotencyKey, runGroupId}`).

1. **Claim** (`claimAuditJobForWorker`, `auditJobLease.ts:30-43`) commits
   `lease_expires_at = clock_timestamp() + limits[check].maxRuntimeMs + graceMs` (kind-aware).
2. **Phase A**, one RR transaction: `withControlJobRequest` (`context.ts:103-120`) loads delegation with
   `FOR UPDATE OF j` and rechecks permissions; record `txid_current_snapshot()`; `DECLARE c NO SCROLL
   CURSOR FOR <existing predicate without LIMIT> ORDER BY <canonical group tuple>, id`; `FETCH 1000` loop;
   assemble slabs; stream per-parent children by keyset; **verify the slab's captured documents** against
   `captured_documents.raw_bytes_sha256` under the evidence budget and set `file_verified`; hand rows to the
   existing pure detector functions; write sealed findings and source-version rows in batches; accumulate
   totals and `sourceHash`; re-read the inserted findings and re-sum to verify totals; insert the sealed
   header; issue the lease-fenced success UPDATE; COMMIT.
3. Any error rolls everything back. `ResourceLimitError` triggers a fresh RC txn under the same lease that
   publishes a sealed `unknown` result (§4.4).

### 0.2 Alternative (spike-gated)

Population copy, only if T3b shows analysis ≥3× capture with restart cost dominating. Task set: A1 minimal
columns with protected envelopes and an HMAC-sealed census at capture commit; A2 adoption/verification on
retry; A3 retention/quota extension; A4 re-review.

## 1. Module shape (each ≤300 lines)

Owned existing files (shared-file changes requested through root, spec l.20):

- `auditJobRunner.ts` — per-kind-class `running` slot; kind-aware `deadlineAt`/AbortController (`:49-50`);
  dispatch branch to `runAuditCheckRun`.
- `auditWorkerTransaction.ts` — `idle_in_transaction_session_timeout` and per-kind `statement_timeout` (`:26-27`).
- `auditJobLease.ts` — `claimPendingJob(ctx,id,kind)` computes the lease from a kind→leaseMs table; legacy
  kinds keep 90 s.
- `auditJobDelegation.ts` / `context.ts` — `loadStoredAuditJobDelegation(…, {lock:'share'|'update'})`;
  check-run kinds pass `'update'`.
- `auditJobProcessContract.ts` / `auditJobProcess.ts` / `scripts/forensic/run-audit-worker.ts` /
  `auditJobPoller.ts` — kind-class unit limits and a `kinds` filter for a second poller loop.
- `paymentRiskChecksBeneficiaries.ts` — split into `classifyRiskBeneficiary` + `groupSharedRiskBeneficiaries`,
  existing export kept as the composition.
- `controlChangeHistoryService.ts` — `entity_change_history` accepts `chunk_cursor`; the existing
  `RESOURCE_LIMIT` return (`:45`) adds `requiredDelivery:'chunked'` and the first cursor.

New under `src/modules/accounting/services/controls/`: `auditCheckRunContract.ts` (kind, per-check limits
with `UNMEASURED` placeholders that fail a unit test until T3b fills them, request parser, permissions from
`checkSources`/`auditSnapshotPermissions`), `auditCheckRunJobService.ts` (fan-out enqueue sharing a
`runGroupId`, per-fan-out quota), `auditCheckRunBudget.ts` (the only budget helper check-run code uses),
`auditCheckRunCursor.ts` (`declareCursor`, `slabs` with carry-over across FETCH boundaries, `children`),
`auditCheckRunEvidence.ts` (slab-scoped verification with the same semantics as `capturedEvidenceScan.ts:9-33`),
`auditCheckRunSeal.ts` (domain `audit-check-run-v1`), `auditCheckRunWriter.ts` (batched sealed inserts,
Decimal(80) totals, incremental `sourceHash` framed to equal `riskHash(rows)`, duplicate-key detection),
`auditCheckRunPublication.ts` (totals re-read, header seal, fenced job UPDATE),
`auditCheckRunUnknown.ts`, `auditCheckRunRunner.ts`, six adapters
`auditCheckStream{Duplicates,Payments,ThreeWay,Journals,Bank,Payroll}.ts`, `auditCheckRunReadService.ts`,
`controlChangeHistoryChunks.ts`. Transport: `src/lib/mcp/tools/forensicCheckRuns.ts` and
`pages/api/accounting/audit-check-runs.ts`.

## 2. Data model

### 2.1 Migration 676 (provisional; 674/675 held elsewhere; root reserves)

- `control_audit_job_intents.kind` CHECK adds `audit_check_run`; `control_audit_jobs` gains
  `result_check_run_id uuid` (= job_id) with the four-column result constraint and a guarded FK.
- `control_audit_check_results(company_id, job_id, generation, lease_id, check_id, run_group_id, snapshot_xid,
  status CHECK IN('pass','fail','unknown'), population_count, excluded_count, finding_count, source_count,
  source_hash hex64, amount_totals jsonb, coverage jsonb, missing_sources jsonb, evidence_verified,
  evidence_unverified, evidence_bytes, protected_header jsonb ≤64 KiB, PK(company_id,job_id,generation))`.
  `amount_totals` are per-currency only, never per employee.
- `control_audit_check_findings(… ordinal 0..999999, finding_key hex64, protected_item jsonb ≤64 KiB,
  PK(company_id,job_id,generation,ordinal), UNIQUE(…,finding_key))` — no plain amount, currency or entity
  columns; everything is inside the envelope.
- `control_audit_check_sources(… ordinal, entity_type, entity_id, version, fingerprint hex64)` — the sync
  `sourceVersions`, paged.
- `control_audit_check_evidence(… ordinal, document_id, entity_type, entity_id, recorded_sha256, byte_length,
  version, verified boolean NOT NULL, reason, UNIQUE(…,document_id))` — written only in phase A, no UPDATE grant.
- RLS on all four: tenant read (`668:53-55`); INSERT only for a running job with matching generation, lease
  and live expiry, joined to an intent of this kind with `requester_person_id=auth.uid()` (`668:56-63`);
  `REVOKE UPDATE, DELETE FROM app_user` (`673:45`). WITH CHECK subqueries read the job row through the RR
  snapshot; the lease values were committed at claim, before the snapshot.
- Covering index decision deferred to T1 after T3b.

### 2.2 Migration 677 — retention and quota

`control_audit_check_run_quota(company_id PK, max_active_fanouts default 2, max_published_fanouts default 200,
retention_days default 400)`. SECURITY DEFINER `control_audit_purge_check_runs(p_company)` deletes findings,
sources and evidence of succeeded check-run jobs past retention in one short RC transaction per job, keeping
results and job history, guarded by `p_company = app.current_company_id()`, `REVOKE EXECUTE FROM PUBLIC`.
Readers bind cursors to `(job_id, generation, header canonicalHash)`, so a purged job returns an explicit
`run_purged` error rather than a silently shorter page; whole-job deletion means no partial-page state is
observable. Enqueue refuses over quota.

### 2.3 Sensitive data

Plain columns hold identifiers, counts, hashes, coverage/missing strings, document hashes and sizes. Findings
(entities, messages, amount, currency, evidence refs) exist only inside `protected_item`, so a member
selecting the raw table sees envelopes it cannot open. The read service additionally asserts `read:payroll`
for payroll checks and `write:bank-tx` for shared-account findings.

### 2.4 Trust claim

The HMAC seal (domain `audit-check-run-v1`, `CONTROL_SNAPSHOT_SIGNING_KEY`) over the canonical header
(company, job, generation, lease, check, run group, snapshot_xid, cutoff, capturedAt, status, counts,
sourceHash, totals, coverage, missingSources, evidence counters, findings and sources digests) and over each
item proves origin from a key holder acting under an unexpired lease, and integrity since sealing. A sealed
status is final; no later phase can change it. It is not independent of an operator holding both DB write
access and the key, and it does not attest source correctness at capture.

## 3. Per-detector conversion (SQL orders, JS evaluates)

Common: cursor SQL is the existing predicate with `LIMIT` removed and `count(*) OVER()` replaced by a
preceding `count(*)`; ORDER BY the raw group tuple **on canonical values** (numerics as `numeric`, dates as
`date`) then `id`, with a per-adapter unit test proving two rows share the JS `riskHash` group key iff they
share the SQL tuple (fixtures include `1.10` vs `1.1`, `-0`, trailing zeros). Children stream by keyset;
`maxChildrenPerParent` overflow records `child_material_exceeds_limit:<population>` and forbids `pass`.
Counts, totals, `sourceHash` and `sourceVersions` accumulate over the whole stream. Status uses the sync rule
(`findings ? 'fail' : missing ? 'unknown' : 'pass'`, `invoiceRiskQueriesResult.ts:29`) extracted into a shared
pure `checkStatus`.

1. **duplicate_invoice_checks** — cursor `invoiceRiskQueries.ts:7-15` ordered by supplier, date, currency,
   subtotal, tax, total, id; imports from `invoiceRiskQueriesImports.ts:7-14`. Slabs of ≥2 rows get evidence
   verification supplying `file_verified` exactly as `:16-17`; single-row slabs skip byte IO because they
   cannot produce findings. `detectInvoiceDuplicates(slab)` unchanged; `missing` strings identical to
   `duplicateInvoiceChecks.ts:36-41`.
2. **payment_risk_checks** — cursor `invoiceRiskQueriesPayments.ts:9-29` without the two `LIMIT 101`
   LATERALs, ordered by supplier, amount, id; allocations and attempts as children; slab →
   `detectPaymentPatterns`. Beneficiaries (only with current `write:bank-tx`): per row
   `classifyRiskBeneficiary` (decryption, `bankFingerprint` re-check, per-row `missing`), retained
   `(key, id)` pairs under `maxBeneficiaryRows`, then `groupSharedRiskBeneficiaries`. Gate: `missingSources`
   equality including `unverified_supplier_beneficiary_versions`, `supplier_beneficiary_pending_hold`,
   `supplier_bank_changed_outside_verified_version`, `supplier_beneficiary_integrity_unavailable`.
3. **three_way_match_exceptions** — cursor `services/ap/threeWayMatchSources.ts:10-41` without the three
   LATERALs, ordered by invoice, item; bills, receipts and rules as children;
   `evaluateThreeWayMatchRow` (`services/ap/threeWayMatchQueryService.ts:8-26`) unchanged. Overrides counted
   for the population; if any, `three_way_override_intents_not_evaluated:<n>`.
4. **journal_risk_checks** — cursor `journalRiskQueries.ts:9-44` without the caps, ordered by
   `(COALESCE(posted_at,created_at) AT TIME ZONE 'Africa/Johannesburg')::date`, actor, currency, id; changes
   and lines as children; slab → `analyseJournalRisks(slab, thresholds)` (threshold split groups only within
   the tuple, `journalRiskAnalysis.ts:34`); thresholds loaded fully with the existing `missingPolicy` rule.
5. **bank_statement_completeness** — cursor over roots (`bankStatementCompletenessQueries.ts:11-41`) ordered
   by id; per-root subqueries without `LIMIT 10001`; uncovered count and fingerprint computed once; evidence
   verified per root; `analyseBankStatementCompleteness(row)` unchanged.
6. **payroll_control_checks** — existing `loadPayrollControlPopulation` + `analysePayrollControls` unchanged
   inside the check-run txn; if `source.over` (`payrollControlAnalysis.ts:27`) publish `unknown` preserving
   `async_scan_required:payroll_population_exceeds_10000` verbatim. **T16 (follow-on)**: accumulator
   `accumulatePayrollControls`/`finalisePayrollControls` with ordering contract `runs ORDER BY period_year,
   period_month, id` and `periodRuns[0]` = lowest id in period, plus a differential test.
7. **History >2 MiB** — synchronous 256 KiB chunks of the canonical redacted `{before, after}` under a signed
   cursor `{eventId, chunkIndex, valueSha256, permissionsHash}`, rejected if either hash changed.
8. **Vocabulary mapping** — `synchronous_population_limit_10000` ↔ `complete_population_streamed`;
   `async_scan_required:*` ↔ absent, or `resource_limit:*` when a run limit fires;
   `captured_evidence_verification_incomplete` in both. Headers carry `sourceHash`/`sourceVersions` in the
   sync layout so a future snapshot may embed a run result (comparison ignores `capturedAt`,
   `auditSnapshotComparisonMaterial.ts:29`); doing so is a separate task.

## 4. Failure semantics and operations

### 4.1 Fence

The claim commits the lease to the kind deadline plus grace, so the poller predicate
(`auditJobPoller.ts:38`) stays false for the run and nothing re-spawns. Inside phase A the delegation load
holds `FOR UPDATE OF j` for the whole transaction, so a competing claimer's `FOR UPDATE SKIP LOCKED` skips
the row and no second generation can start while the transaction lives, even past expiry.
`idle_in_transaction_session_timeout` (proposed 60 s) plus the per-kind `statement_timeout` terminate a hung
backend and release the lock; the systemd hard kill bounds the process at `maxRuntimeMs`. No renewal exists
for this kind. Only this transaction updates the job row after its snapshot; 40001 stays retryable.
Gate (T2): injected limits (`maxRuntimeMs` 6 s, legacy lease 2 s) and a cursor containing `pg_sleep` — one
generation, zero extra units, success.

### 4.2 Kill and retry

Phase A kill rolls back with nothing visible; reclaim after expiry at generation+1 restarts the check. After
three attempts the claim path marks `failed/RETRY_EXHAUSTED` without a lease (`auditJobLease.ts:51-56`,
`630:14`); the fan-out status reports it per check and callers may re-enqueue under a new idempotency key.
`maxRuntimeMs` is sized from T3b with headroom rather than raising the attempt cap.

### 4.3 Evidence

Verified in phase A per slab under `evidenceDocumentsPerRun`, `evidenceBytesPerRun` and `evidenceWallMs`,
with the existing ≤100 MiB per document (`capturedEvidenceScan.ts:21`). Overflow or storage failure sets
`file_verified=false` for those rows and adds `captured_evidence_verification_incomplete:<remaining>` to
`missingSources`, so the status cannot be `pass`. Every reference is recorded with `verified` and `reason`
before sealing.

### 4.4 Resource limits

`ResourceLimitError` aborts phase A; a fresh RC txn under the same lease publishes `unknown` with
`resource_limit:<reason>` and marks the job succeeded. Fan-out status is `unknown` if any check is.

### 4.5 Budgets and queue isolation

Kind-class deadlines in the runner and transaction; `createCheckRunBudget` is the only budget helper used;
`running` is per kind class; the poller takes a `kinds` filter; check runs use their own unit template.
Gate: a snapshot job completes while a check run sleeps.

### 4.6 Deploy interaction

Drain the check-run poller before migrations; migrations `SET lock_timeout='5s'`; alert on
`age(backend_xmin)` for `application_name LIKE 'isaflow-audit:%'`.

### 4.7 `write:bank-tx`

Decrypting supplier bank envelopes uses the writer's authority (`invoiceRiskQueriesBeneficiaries.ts:8-10`,
`paymentRiskChecks.ts:67`); no narrower permission exists in the effective-permission model, and adding one
is a root-owned contract change. Without it the run records `beneficiary_comparison_authority` and readers
withhold shared-account findings. T14 covers both branches and revocation.

### 4.8 MCP surface (spec l.89)

`data_integrity_checks` is a synchronous 13-check ledger suite (`integrity.ts:41-53`); asynchronous job
delivery does not fit its semantics, and the six Phase 3 checks already ship as separate tools. Three tools
are added, mirroring the existing job-delivery family (`auditDelivery.ts:86`): `run_control_checks` (fan-out
enqueue), `control_check_run` (status, sealed header, evidence counters) and `control_check_run_findings`
(page). History chunking is a parameter of `entity_change_history`, not a new tool.

## 5. Task DAG and gates (RED first; real PG; serialised DB lease)

- **T1** Contracts, migrations 676/677, quota, purge: schema RED/GREEN, RLS refusals, purge guard, quota;
  index decision recorded after T3b.
- **T2** Owned runner/transaction/lease/delegation changes, queue isolation, fan-out enqueue and status:
  gates §4.1 and §4.5; idempotent enqueue; status never triggers work.
- **T3** Cursor/slab engine, budget helper, writer, seal, publication, unknown path, reader on a synthetic
  check: slab split across a FETCH boundary; duplicate key fails; totals re-read mismatch fails; seal tamper
  detected; abort leaves zero rows; unknown publication after a limit.
- **T3b Spike (go/no-go)**: 100k invoices with 0–150 allocations/attempts and 100k journals with 3–10 lines
  and change events. Per check: phase A wall, first-FETCH latency, temp bytes, WAL bytes, RLS WITH CHECK
  cost, `age(backend_xmin)`, envelope re-read cost, storage; plus a population-copy prototype for one check
  to settle §0.2. Output `forensic-evidence/check-run-spike-100k.json` and the filled limits.
- **T4** Beneficiary refactor with an identity test on existing fixtures.
- **T5–T9** Adapters (duplicates, payments, three-way, journals, bank): randomised differential test
  asserting per finding key `kind, severity, classification, message, entities, evidence` plus counts,
  totals, coverage (modulo §3.8), `missingSources`, `sourceHash`, `sourceVersions`; over-cap test (10,001
  parents, 150 children, 101 documents); cross-FETCH group test; order-key equality unit test; tenant-leak
  test; envelope-only storage test.
- **T10** Payroll adapter (synchronous wrap) with an over-bound `unknown` test.
- **T11** Transport and history chunking: synthetic bearer, revoked scope, >2 MiB event delivered, cursor
  rejected after change.
- **T12** Scale and hard-kill for all six checks under `createIsolatedAuditJobRunner`; SIGKILL mid-phase-A ⇒
  zero rows, reclaim, success; RSS and elapsed recorded.
- **T13** Retention and quota runtime: six-check fan-out succeeds under the default quota; purge after
  publish; `run_purged` reader error; sealed headers retained.
- **T14** Permissions: raw-table select without `read:payroll` yields only unopenable envelopes; both
  `write:bank-tx` branches; revocation between claim and phase A records `AUTHORITY_REVOKED`.
- **T15** Integration: `bun run ci` on the named commit; independent review of migrations, RLS, seals,
  sensitive data and bypass routes; adversarial pass.
- **T16** (follow-on) payroll accumulator per §3.6.

## 6. Requirement → test matrix (spec lines at c76b9706)

| Line | Requirement | Tests |
|---|---|---|
| 18 | Company scoping; payroll/beneficiary narrowly scoped and redacted | T1 RLS; T5–T10 envelope-only; T14 |
| 83 | No unnecessary bank/payroll secrets; cross-tenant ids disclose nothing | T5–T10; T14; T15 |
| 87 | Reuse verified detectors; no parallel truth | T4 identity; T5–T9 differential over full finding fields; review rule that adapters never compute keys or classifications |
| 89 | Extend rather than duplicate tools | §4.8; T11 registry consistency |
| 92 | Complete populations, tolerances, overrides, partial receipts | T7 over-cap; override missingSources gate |
| 97 | Totals beyond pagination; a failed check cannot make the run pass; payroll restricted | T3 totals re-read; T13 fan-out status; T14 |
| 107 | Define and test the trust boundary | T3 seal tests; §2.4 |
| 109 | Bounded async jobs/status/pagination; reads never trigger processing | T2 status; T11 page bounds and chunk reads |
| 120 | Large datasets with latency, pagination, recovery, resource bounds | T3b; T12 |

## 7. Strongest argument against, highest-risk unknown, decisive evidence

Against: phase A now holds the RR snapshot through evidence byte-IO as well as streaming, so heavy tenants
keep xmin old for longer; the mitigation (only multi-row slabs trigger IO, run-level byte and wall budgets,
`unknown` on overflow) trades completeness of evidence confirmation for bounded transactions. Highest-risk
unknown: T3b numbers for payments and three-way match (per-parent child loops) and envelope re-read cost at
100k findings. Decisive evidence: phase A within the proposed 10-minute ceiling with acceptable temp and WAL
⇒ the default stands; child loops dominating ⇒ a merge-join second cursor over children; analysis ≥3×
capture with retries dominated by restarts ⇒ §0.2.
