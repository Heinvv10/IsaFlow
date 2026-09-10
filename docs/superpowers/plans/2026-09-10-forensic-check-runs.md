# Plan v6: minimal vertical slice — measurement spike, then journal_risk_checks

Status: v5. Narrowed after three independent adversarial reviews rejected the whole-system designs
(v1 c47c7e246, v2 3e4c0aaa7, v3 fcd86380a). Verified at `fcd86380a`. Spec `c76b9706`.
v4 measures first and ships ONE detector; everything else is deferred to a later plan reviewed
after this slice has run on real data.

Verification: `effectivePermissionQueries.ts:24-28` reloads and decrypts the delegation on every
`assertEffectivePermission` under `authMethod='job'`; `capturedEvidenceSource.ts:21` takes `FOR SHARE`
on `captured_documents` before the storage read; `630:53` grants column updates without
`result_check_run_id` (668:11 added `result_comparison_id` the same way); `auditJobProcessProtocol.ts:4`
is a strict identity schema with no kind; `journal_risk_checks` has only a unit test, no PG test;
spec lines 91-95 are the five Phase 3 check requirements, 93 being journals.

## Review response (v3 findings)

1 sourceHash byte-identity impossible — **accepted**: v4 defines a run-scoped `populationDigest` over a
documented framing, states it is not comparable with the sync hash, and removes it from every equality
gate. 2 beneficiary branch cannot execute in a job — **deferred with payments**; recorded decision: derive
`write:bank-tx` into the stored delegation at enqueue when the requester holds it, else declare the
detector out of scope. 3 amount_totals disclosure — **accepted**: no monetary column on any new table;
totals live in `protected_header`; T14 rewritten to select every column of every new table as a member
lacking the permission. 4 evidence `FOR SHARE` locks — **deferred** (journals have no document IO); the
spike measures lock counts and cross-writer blocking so the later plan can choose. 5 per-call delegation
reload — **accepted**: permissions asserted once before the cursor; `src/lib/auth/effectivePermissionQueries.ts`
added to the owned set; the spike reports query counts. 6 fan-out unique-constraint collision — **accepted**:
derived key `${userKey}:${checkId}` (user key ≤100 so the derived key stays ≤128, `630:5`), with a
repeat-enqueue gate. 7 FOR UPDATE lock mode — **accepted, dropped**: the mechanism is the existing
`FOR SHARE OF j`, which already makes a competitor's `FOR UPDATE SKIP LOCKED` skip the row; T2 asserts it.
8 bank population-global reviewState, 9 dropped Sage import population, 12 beneficiary grouping — **deferred**
with their detectors. 10 vacuous/red differential and missing over-cap oracle — **accepted**: the oracle is
the unmodified detector with its literal limits raised through a test-only seam; divergent-by-construction
fields are enumerated and excluded. 11 order-key invariant — **accepted**, one-directional. 13 purge —
**deferred; no purge in v4**, growth bounded by an enqueue quota. 14 kind-aware systemd timeout — **accepted**
with no protocol change: a dedicated check-run poller/runner instance is configured server-side and refuses
kinds outside its class before claiming. 15 lease overrun — **accepted and gated** at the boundary.
16 idle timeout vs storage stalls — **deferred** with evidence bytes; journals do no storage IO.
17 "same semantics as capturedEvidenceScan" — **withdrawn**. 18 totals re-read — **accepted**: stated as a
persistence check; correctness comes from the differential. 19 column-level UPDATE grant — **accepted**.
20 `txid_current_snapshot()` — **accepted**: `pg_current_snapshot()::text` as `snapshot_text` plus
`pg_current_xact_id()::text` as `capture_xid`. 21 preceding count — **accepted**: journals need none
(`excludedCount=0`); the spike measures it for later detectors. 22 deliberately red placeholder test —
**accepted**: no placeholders; the limits file is created in T2 from spike output. 23 payroll gains nothing
— **stated plainly**: complete-population payroll is deferred and spec l.95 is unaddressed by v4.
24 missing matrix rows — **fixed** (§6 lists 91-95).

## 1. Scope

- **T1 measurement spike**: throwaway code on a scratch branch, never merged, run against its own
  disposable PostgreSQL instance. Output: `forensic-evidence/check-run-spike-100k.json` and a proposed
  limits table. Go/no-go for T2.
- **T2 `journal_risk_checks` as an `audit_check_run` job**, end to end: migration, contract, runner
  integration, adapter, reader, MCP + REST, PG tests, hard-kill, scale.
- **Deferred to a later plan**: duplicates and Sage imports, payments and beneficiaries, three-way match
  overrides, bank completeness, payroll, history chunking, purge/retention, the population-copy alternative.

## 2. T2 design (journals only)

### 2.1 Migration 676 (provisional; 674/675 held elsewhere; root reserves, spec l.20)
`control_audit_job_intents.kind` adds `audit_check_run`. `control_audit_jobs` gains `result_check_run_id`
with the four-column result constraint, the identity CHECK, `GRANT UPDATE(result_check_run_id)` (as 668:11)
and the guarded FK. `control_audit_check_results(company_id, job_id, generation, lease_id, check_id CHECK
='journal_risk_checks', status CHECK IN('pass','fail','unknown'), population_count, excluded_count,
finding_count, snapshot_text, capture_xid, captured_at, protected_header jsonb ≤64 KiB, PK(company,job,
generation))` — no monetary columns; totals, coverage, missingSources and digests live in the header
envelope. `control_audit_check_findings(… ordinal 0..999999, finding_key hex64, protected_item jsonb ≤64 KiB,
UNIQUE(company,job,generation,finding_key))`. RLS on both: tenant read (668:53-55); INSERT only for a running
job with matching generation and lease, live expiry, intent kind and `requester_person_id=auth.uid()`
(668:56-63); `REVOKE UPDATE, DELETE FROM app_user` (673:45). The cursor sort index is decided from spike M2
(the predicate is already covered; the sort key is computed, so an expression index is added only on measured
spill).

### 2.2 Contract and job service
`AUDIT_CHECK_RUN_LIMITS.journal_risk_checks = {maxRuntimeMs, graceMs, idleMs, fetchRows,
maxChildrenPerParent, maxSlabRows, maxFindings, maxThresholds}` filled from the spike — the file is created
in T2, so no red placeholder test is ever committed. Permissions are `['read:reports']`
(`journalRiskQueries.ts:8`). `enqueueAuditCheckRuns` writes one intent per check with
`idempotency_key = ${userKey}:${checkId}`; a repeat enqueue returns the same jobs, the same key with a
different request is refused (`auditJobService.ts:54` rule); quota refuses at 6 active or 100 published
check-run jobs per company until retention lands.

### 2.3 Adapter `auditCheckStreamJournals.ts`
Assert `read:reports` once before the cursor. Load all active `approval_rules` for `journal_entry` without
`LIMIT 101`, applying the `usable`/`missingPolicy` rule exactly as `journalRiskQueries.ts:45-50`; over
`maxThresholds` raises `ResourceLimitError`. `DECLARE c NO SCROLL CURSOR FOR` the `journalRiskQueries.ts:9-44`
SELECT with the lines and changes subqueries and `LIMIT 10001` removed, `lineCount`/`changeCount` kept, and
`ORDER BY ((COALESCE(j.posted_at,j.created_at)) AT TIME ZONE 'Africa/Johannesburg')::date,
COALESCE(j.posted_by,j.created_by)::text, c.default_currency, j.id`. `FETCH 1000`; slabs share
`(day, person, currency)` with carry-over across fetches. Per row, changes stream by keyset over
`control_change_events` with the same period-history LATERAL, bounded by `maxChildrenPerParent`; overflow
records `journal_change_history_exceeds_limit:<n>` (documented replacement for the sync
`journal_change_history_exceeds_100`) and forbids `pass`. Line facts are not fetched — the analysis uses only
`amount` and `lineCount` — so `journal_line_material_exceeds_100` has no run equivalent and is listed as
divergent by construction. Slab → `analyseJournalRisks(slab, thresholds)` unchanged; findings built from the
identical literal at `journalRiskChecks.ts:18-21`. `populationCount` is the streamed row count,
`excludedCount` 0, totals via Decimal(80), `populationDigest` = sha256 over
`${id}\n${version??''}\n${accountingDate}\n${actualAt}\n${amount}\n${currency}\n` in cursor order, explicitly
run-scoped and not comparable with the sync `sourceHash`. Per-row `sourceVersions` are deferred; the header
carries `sourceVersionCount`. Status uses the shared pure `checkStatus` extracted from
`invoiceRiskQueriesResult.ts:29`.

### 2.4 Equality contract (oracle = unmodified detector with limits raised via a test-only seam)
Asserted equal per finding key: `kind, severity, classification, message, entities, evidence`; plus
`findingCount`, `populationCount`, `excludedCount`, `amountTotals`, `status`, and `missingSources`/`coverage`
after mapping. Excluded by construction: `async_scan_required:journal_population_exceeds_10000` (sync only),
`journal_change_history_exceeds_100` ↔ `journal_change_history_exceeds_limit:*`,
`journal_line_material_exceeds_100` (sync only), `sourceHash`, `sourceVersions`, `capturedAt`, `nextCursor`.
Order-key invariant, one-directional: two rows `analyseJournalRisks` would place in the same threshold group
(`JSON.stringify([day, personId, currency])`, `journalRiskAnalysis.ts:34`) always share the SQL tuple; unit
test over generated rows including SAST edge times (23:59 UTC, 21:59 UTC).

### 2.5 Runner integration
Owned: `auditJobRunner.ts`, `auditWorkerTransaction.ts`, `auditJobLease.ts`, `auditJobPoller.ts`,
`auditJobProcessContract.ts`, `scripts/forensic/run-audit-worker.ts`, and
`src/lib/auth/effectivePermissionQueries.ts` (measurement hooks only).
`claimAuditJobForWorker(store, id, expectedKinds)` returns null before claiming when the intent kind (already
read at `auditJobLease.ts:35`) is outside the instance class; `claimPendingJob` takes `leaseMs` (legacy 90 s;
check-run `maxRuntimeMs+graceMs`). `executeAuditJob` takes `{kinds, deadlineMs}` and the timer at
`auditJobRunner.ts:49-50` uses it. `withAuditWorkerTransaction` sets `idle_in_transaction_session_timeout`
beside the existing timeouts. The poller selects `i.kind` and filters by class; the check-run poller is a
second CLI invocation with its own unit template, so `auditJobProcessProtocol.ts:4` is untouched.
`auditCheckRunRunner.ts` runs phase A in one RR transaction (delegation → adapter → batched sealed inserts →
persistence re-read of totals → sealed header → lease-fenced success UPDATE) and, on `ResourceLimitError`,
publishes `unknown` with `resource_limit:<reason>` in a fresh RC transaction under the same lease. Budget
helper `auditCheckRunBudget.ts` (not `indexBudget`, which caps at 60 s). Seal domain `audit-check-run-v1`;
trust claim as v3 §2.4. Reader pages findings by ordinal bound to `(job, generation, header hash)` and
verifies every seal. Transport: `run_control_checks`, `control_check_run`, `control_check_run_findings` plus
`pages/api/accounting/audit-check-runs.ts`.

## 3. T1 spike measurements (scratch branch, disposable database)

Fixtures: (a) 100k posted journals with 3-10 lines, `posted_at` spread across SAST hours and weekends, 0-20
change events each including period close/lock, 10 active rules; (b) 100k supplier invoices with 0-150
allocations/attempts and 20k captured documents with real storage objects (M7/M8 only). Server version recorded.

| ID | Measurement |
|---|---|
| M1 | Journal cursor: total wall, first-FETCH latency, per-FETCH p50/p95 |
| M2 | Temp bytes and sort method at 100k, with and without an expression index |
| M3 | Per-parent child keyset cost (changes per journal; allocations per payment) |
| M4 | Preceding `count(*)` versus streamed count |
| M5 | Query counts per phase, and the cost of `assertEffectivePermission` under `authMethod='job'` (delegation reload + decrypt) per call |
| M6 | Batched sealed inserts of 100k findings: wall, WAL bytes, RLS WITH CHECK cost |
| M7 | `loadOwnedCapturedEvidence` for 20k docs inside one RR txn: wall, bytes, `FOR SHARE` lock count, blocking of a concurrent writer, `lock_timeout` trip rate |
| M8 | The same in short per-slab RC transactions with a hash re-check |
| M9 | `age(backend_xmin)` over the run; autovacuum interaction |
| M10 | Envelope re-read of 100k sealed findings: wall, RSS |
| M11 | Restart cost: kill at 25/50/75 % of the stream; reclaim and completion time |
| M12 | Lease boundary: duration versus expiry, and behaviour when the final UPDATE lands after it |
| M13 | Cross-writer blocking on `gl_journal_entries` during the RR transaction |

Go/no-go: T2 proceeds if M1 + M3 + M6 fit inside a transaction budget root accepts operationally (proposed
10-minute ceiling) with M9 tolerated and M11 acceptable under the three-attempt cap. Otherwise the later plan
adopts the population-copy alternative using M1-M6 as evidence. M7/M8 decide the evidence design for the
deferred detectors.

## 4. Failure semantics (journals slice)

Fence: the claim commits `lease_expires_at = now + maxRuntimeMs + graceMs`, so the poller predicate stays
false; the work transaction holds `FOR SHARE OF j` for its lifetime, so a competitor's
`FOR UPDATE SKIP LOCKED` skips the row; every RLS insert and permission check re-evaluates
`lease_expires_at > clock_timestamp()`, so a transaction crossing expiry fails at its next write and rolls
back completely. Gates: a run 3× the legacy lease yields one generation and zero extra units; a run finishing
inside grace succeeds; a run crossing expiry rolls back with nothing readable.
Kill and retry: rollback, reclaim at generation+1, three-attempt cap then `failed/RETRY_EXHAUSTED`; a new
idempotency key re-enqueues. Permissions and tenancy: delegation and `read:reports` rechecked at transaction
entry and again at read; all tables company-keyed with RLS; findings hold only journal ids and messages.
Deploy: drain the check-run poller before migrations, `SET lock_timeout='5s'`, alert on xmin age.

## 5. Tasks and gates

- **T1** spike (scratch branch, disposable DB): measurement JSON, proposed limits, go/no-go memo. No product
  code, no migration.
- **T2a** migration, contract, job service: RED PG schema test (RLS refuses without a live lease or the right
  kind; the column grant exists; repeat enqueue returns the same jobs; a different request under the same key
  is refused; quota refusal) → GREEN; naming gate; prefix rescan.
- **T2b** runner/lease/poller: the three fence gates; a snapshot job completes while a check run sleeps; a
  kind outside the class is not claimed; status never triggers work.
- **T2c** adapter, writer, seal, reader: a new PG fixture for journals (only a unit test exists today); slab
  split across a FETCH boundary preserves threshold-split findings; duplicate key fails the run; differential
  against the oracle on randomised ≤10k fixtures and on 10,001-row / 150-change over-cap fixtures asserting
  the §2.4 field set including `amountTotals`; one-directional order-key unit test; seal tamper detected;
  unpublished generation unreadable; resource limit publishes `unknown`; raw-table read as a same-tenant
  member exposes no monetary or entity-derived value outside envelopes.
- **T2d** transport: MCP structural acceptance extension; REST tests; revoked `read:reports` forbidden on page read.
- **T2e** scale and hard-kill: 100k journals under `createIsolatedAuditJobRunner`; SIGKILL mid-stream leaves
  zero rows, reclaims and succeeds; elapsed and RSS recorded to `forensic-evidence/check-run-journals-100k.json`.
- **T2f** integration: `bun run ci` on the named commit; independent review of migration, RLS, seal and runner
  changes; adversarial pass (forged lease, other generation, snapshot-kind job inserting check rows).

## 6. Requirement → test matrix (spec lines at c76b9706)

| Line | Requirement | v4 |
|---|---|---|
| 18, 83 | Company scoping; no unnecessary secrets; cross-tenant ids disclose nothing | T2a RLS; T2c raw-table read; T2f adversarial |
| 87 | Reuse verified detectors; no parallel truth | T2c oracle differential; adapters never compute keys or classifications |
| 89 | Extend rather than duplicate tools | §2.5; T2d |
| 91 | Duplicates, payments, beneficiaries | Deferred |
| 92 | Three-way match, overrides | Deferred |
| 93 | Actual time vs accounting date, reversals, thresholds, closed-period changes | T2c differential and over-cap gates; existing unit fixtures ported to PG |
| 94 | Bank completeness | Deferred |
| 95 | Payroll | Deferred; unaddressed by v4 |
| 97 | Totals beyond pagination; a failed check cannot make the run pass | T2c totals and unknown-status gates |
| 107 | Trust boundary defined and tested | T2c seal tests; §2.5 |
| 109 | Bounded async jobs; reads never trigger processing | T2b; T2d |
| 120 | Large datasets: latency, pagination, recovery, resource bounds | T1; T2e |

## 7. Strongest argument against, highest-risk unknown, decisive evidence

Against: a journals-only slice proves the machinery on the easiest detector and may pass while the hazards
that rejected v1-v3 — evidence locks, delegation-bound permissions, beneficiary grouping, payroll
accumulation — remain unmeasured in product code; M5, M7 and M8 exist precisely so those stay measured
rather than argued. Highest-risk unknown: M1 + M3 + M6 wall time and M9 xmin age for 100k journals with
change-event children in one transaction. Decisive evidence: the T1 JSON; if the ceiling is exceeded, the
later plan adopts the population-copy alternative under the constraints already recorded in v2 and v3.


---

# v5 amendments (after the v4 review of T2)

The v4 review returned REJECT for T2 with the explicit note that nothing required redesign. These
amendments supersede the corresponding v4 text. Drift check: the three files changed between
`6ec30a9cd` and `e9b067fba` are outside every file this plan cites, so all citations remain valid.

## A1. The worker protocol change is real, and is now explicit (v4 finding 1)

Confirmed: the reply union at `auditJobProcessProtocol.ts:5-11` has no check-run variant;
`RuntimeMaxSec=65s` is a literal at `:28`; and the readiness loop at `auditJobProcess.ts:57-60` reads back
only `MemoryMax`/`MemorySwapMax` (`auditJobSystemd.ts:25-26` never requests `RuntimeMaxUSec`), so a unit's
runtime cap is unverified today. T2 therefore changes the protocol: the reply union gains
`{state:'succeeded', checkRunId, canonicalHash}`; `AuditWorkerResult` gains the variant;
`AUDIT_PROCESS_LIMITS` becomes per kind class (`audit` keeps 65 s / 8 GiB, `check_run` from the spike);
`auditProcessArguments(config, unitName, limits)` derives `RuntimeMaxSec` and `MemoryMax` from the class
limits; `auditUnitProperties` also requests `RuntimeMaxUSec`; and the readiness loop compares both against
the class limits before releasing the identity. The request schema is unchanged.
**Spike note:** the running T1 spike is bounded by the same 65 s literal, so its M11/M12 runs must use a
spike-local copy of the unit arguments with a raised `RuntimeMaxSec`, and the JSON must record which value
was in force.

## A2. Change facts are capped at 101 exactly as the sync detector does (v4 finding 2)

The adapter scans changes in `(occurred_at, id)` order, feeds `analyseJournalRisks` only the first 101,
counts everything beyond, and emits `journal_change_history_exceeds_100` when `changeCount > 100`. Signal
equality is therefore exact rather than aspirational. That both paths are blind to a closed-period change
beyond position 101 is recorded as a known shared limitation and carried into the later plan.
`maxChildrenPerParent` remains only as a defensive bound on the 101-row fetch.

## A3. `journal_line_material_exceeds_100` is reproduced, not excluded (v4 finding 3)

The `lines` LATERAL is kept whole (`SUM(debit)`, `COUNT(*)`); only the two `facts` sub-selects are removed
from the cursor. `lineCount` streams and the marker is emitted exactly as `journalRiskChecks.ts:15`, so the
status cannot differ from the sync detector on a population whose only missing reason is this marker.

## A4. Owned-file set (v4 finding 4)

Adds `auditJobContract.ts`, `auditJobProtection.ts` (kind allow-list and parse dispatch),
`auditJobDelegation.ts` (per-kind permissions), `auditJobService.ts` (status union and the result-kind
identity guard, which would otherwise throw "Audit job result kind changed"), `auditJobProcessProtocol.ts`,
`auditJobProcess.ts`, `auditJobSystemd.ts`, `journalRiskQueries.ts`, `journalRiskChecks.ts`,
`invoiceRiskQueriesResult.ts` (extractions), the MCP registry files and the agent-doc mirrors. Shared files
are requested through root per spec l.20.

## A5. The oracle seam is a defaulted parameter over six named literals (v4 finding 5)

`loadJournalRiskPopulation(ctx, cutoff, limits = JOURNAL_RISK_DEFAULT_LIMITS)` with
`sourceFetch:10001`, `sourceKeep:10000`, `thresholdFetch:101`, `thresholdKeep:100`, `changeFacts:101`,
`lineFacts:101` — today's values as defaults. Gate (c0): at defaults the seam's canonical JSON output equals
the pre-seam detector's on a committed fixture. Differential runs raise only `sourceFetch`/`sourceKeep`
(200,001 / 200,000) and leave threshold and facts limits at defaults, so `missingPolicy` and both
`*_exceeds_100` markers are compared rather than excluded. The oracle is paged with
`collectSnapshotCheckPages` at `limit:100`, and the over-cap fixture must exceed 100 findings so paging is
genuinely exercised.

## A6. `control_audit_jobs_result_check` is a root-coordinated shared object (v4 finding 6)

676 drops and re-adds it naming all four result columns, then a `DO` block reads `pg_get_constraintdef` and
raises unless all four appear. Root records which of 674/675 touch the constraint and the required apply
order; T2a re-asserts after replaying 674, 675 and 676 in every order root permits.

## A7. The claim transaction keeps its own short bound (v4 finding 7)

`executeAuditJob(input, options, instance:{kinds, workDeadlineMs, claimDeadlineMs:5000})`. Only the work
transaction receives the class deadline, so the claim's `SELECT … FOR UPDATE SKIP LOCKED` no longer inherits
a ten-minute `statement_timeout`. A contended job row fails the claim fast and the poller moves on, as today.

## A8. Remaining v4 findings

8 the concurrency gate runs across two isolated units, not in-process. 9 threshold over-limit behaviour now
mirrors the sync detector (LIMIT 101, slice 100, set `missingPolicy`); no `ResourceLimitError` for
thresholds and `maxThresholds` is removed. 10 `riskAmountTotals(findings)` is extracted from
`invoiceRiskQueriesResult.ts:26-27` beside `checkStatus` and used by both paths, so the ISO-currency filter
and `canonicalMoney` normalisation are shared rather than reimplemented. 11 oracle paging as in A5.
12 the run's public shape is `CheckRunResult`, not `ControlCheckResult`, carrying
`sourceVersions:{available:false, reason:'deferred_paged_source_versions', count:n}`, covered by the T2d
contract test. 13 the agent-doc mirrors are regenerated in T2f and the runner is split into
`auditCheckRunRunner.ts` (orchestration) and `auditCheckRunPhase.ts` (phase A body).

## A9. Gates added to T2b

(4) a check-run unit's `RuntimeMaxUSec` and `MemoryMax` read back equal to the class limits before identity
release, while a legacy unit still gets 65 s / 8 GiB; (5) the claim transaction's `statement_timeout` is
observed at ≤5 s while the work transaction gets the class deadline; (6) cross-process concurrency — a
snapshot job completes in a second unit while a check-run unit sleeps; (7) an out-of-class kind is not
claimed; (8) the reply union round-trips the new variant and rejects malformed replies.


---

# v6 amendments (after the v5 review — ACCEPT WITH CHANGES; spike folded in)

v5 was accepted with changes: nothing needed redesign, but T2 could not execute until the worker-class
blocker was written in. These amendments supersede any conflicting earlier text. The T1 spike is complete
with a GO (`62096e9d2:docs/superpowers/plans/forensic-evidence/check-run-spike-100k.json`): 100k journals
in ~102–116 s of a 600 s budget. Verified at `62096e9d2`. Next free migration prefix: **680, provisional** —
674 is K-091, 675–677 belong to the platform-import branch, 678–679 to the control-intent branch.

## Review response

| # | v5 finding | Disposition |
|---|---|---|
| 1 | The worker child cannot learn its kind class, so it would run the legacy path and claim any kind | A10 |
| 2 | 65 s and 4 GiB hardcoded in the parent; no written timing order | A11 |
| 3 | `systemctl show` prints human time spans on this host | A12 |
| 4 | Gates not run by `bun run ci`; timeouts; informational naming gate; parallel deadlocks | A13 |
| 5 | The seam cannot reach the oracle; limits would leak into `sourceHash` | A14 |
| 6 | Gate c0 cannot pass as written | A15 |
| 7 | The adapter copies detector logic | A16 |
| 8 | Keep the changes LATERAL whole in the cursor (the spike agrees: 94% of wall) | A17 |
| 9 | Two shared constraints; stale prefix premise | A18 |
| 10 | Return the SQL slab tuple as columns | A19 |
| 11 | §2.4 omissions and stale exclusions | A20 |
| 12 | Resource-limit `unknown` row semantics | A21 |
| 13 | Owned-file additions | A22 |
| 14 | Per-class idle timeout | A23 |

Spike conditions folded in: lease = `maxRuntimeMs + graceMs` at claim (A11); a class-specific `RuntimeMaxSec`
(A10/A11); permission asserted once before the cursor (A16); `SET LOCAL work_mem='64MB'` (A17); change facts
fetched with the cursor row (A17).

## A10 Worker class propagation and fail-closed claiming

- `AuditProcessConfig` (`auditJobProcessContract.ts:10`) gains `workerClass: 'audit' | 'check_run'`, frozen
  with the rest (`auditJobProcess.ts:14`).
- `auditProcessArguments(config, unitName)` appends the literal
  `--setenv=ISAFLOW_AUDIT_WORKER_CLASS=${config.workerClass}`. The name is NOT added to `AUDIT_PROCESS_ENV`,
  so it can never be inherited from the parent environment.
- `scripts/forensic/run-audit-job.ts` validates the variable against the enum, exits non-zero with a bounded
  diagnostic when it is missing or invalid, and calls `runAuditJob(identity, {pool, signal, workerClass})`.
- `runAuditJob` requires `workerClass`. `claimAuditJobForWorker(store, id, allowedKinds)` compares the intent
  kind read at `auditJobLease.ts:35` against the class's kind set (`audit` → snapshot/export/compare;
  `check_run` → `audit_check_run`) and returns null BEFORE `claimPendingJob`, so the row is untouched.
- The parent rejects any decoded success variant not permitted for `config.workerClass` (`WORKER_ERROR`,
  `invalid=true`).
- **Gate A10-G1:** a legacy-class unit handed a queued `audit_check_run` job returns `not_claimed` and the
  job row (state, attempts, generation, lease columns, updated_at) is byte-identical before and after; the
  converse holds for a check-run unit handed a snapshot job. **Gate A10-G2:** a child started without the
  variable fails closed with no claim.

## A11 Class-derived timers, heap and the written ordering

| | `audit` (unchanged) | `check_run` (spike-derived) |
|---|---|---|
| work deadline | 60 000 runner / 65 000 parent | **300 000** (≈116 s measured; 2.6× the worst clean run) |
| lease grace | n/a (90 s lease) | **30 000** (reclaim ≤119 ms; post-stream work 1–3 s) |
| claim deadline | 5 000 | **5 000** |
| unknown-publication budget | n/a | **10 000** |
| failure-record bound (`auditJobRunner.ts:81`) | 5 000 | 5 000 |
| parent SIGTERM (`auditJobProcess.ts:38`) | 65 000 | **325 000** |
| killGraceMs (`:39`) | 2 000 | 2 000 |
| systemd `RuntimeMaxSec` | 65 s | **340 s** |
| `MemoryMax` / `--max-old-space-size` | 8 GiB / 4096 | **2 GiB / 1536** (+57–61 MB RSS at 100k findings) |
| `idle_in_transaction_session_timeout` | unset | **15 000** (A23) |

The ordering is enforced by a unit test over this table:
`claim 5 + work 300 + unknown 10 + failure record 5 = 320 s < parent SIGTERM 325 s ≤ RuntimeMaxSec 340 − killGrace 2`,
and `lease = 300 + 30 = 330 s ≥ 320 s`. `createIsolatedAuditJobRunner` derives its timer, hard kill, heap,
`MemoryMax` and `RuntimeMaxSec` from `AUDIT_PROCESS_LIMITS[config.workerClass]`.
**Gate A11-G1:** a check-run child that deliberately runs 130 s completes and publishes; a legacy child still
dies at 65 s (existing `auditJobProcess.int.test.ts` behaviour preserved).

## A12 Reading the unit's real caps before identity release

Read `RuntimeMaxUSec` through `busctl --user get-property org.freedesktop.systemd1
/org/freedesktop/systemd1/unit/<escaped unit> org.freedesktop.systemd1.Service RuntimeMaxUSec`, parsing the
raw `t <integer>` reply; `MemoryMax` keeps coming from `systemctl show`, which prints bytes as an integer. A
fallback `parseSystemdTimeSpan(text)` is unit-tested against real strings captured on this host (`"1min 30s"`,
`"5min 40s"`, `"45s"`, `"infinity"`, `"2h 3min 4.500s"`). The readiness loop releases the identity only when
`RuntimeMaxUSec`, `MemoryMax` and `MemorySwapMax='0'` all equal the class limits; otherwise it terminates.
**Gate A12-G1:** a real transient unit for each class reports the expected values, and a unit started with a
wrong `RuntimeMaxSec` is refused before the identity is written.

## A13 Running the gates

T2f runs `DATABASE_URL=<isaflow_test> bun run ci` (the integration step at `scripts/ci/run-ci.sh:42-46`) and
then the controls suite with `--no-file-parallelism`, because parallel files deadlock on the shared fixture
database. Long gates carry explicit per-test timeouts and opt-in variables: the 3× lease gate (400 s,
`ISAFLOW_CHECK_RUN_LONG_GATES=1`), the 100k scale run (900 s, reusing the `ISAFLOW_AUDIT_SCALE_OPT_IN`
conventions of `auditJobScale.int.test.ts:38-39`), and the lease-boundary and 130 s gates (300 s). The prefix
rescan is recorded manually in the ledger, because `audit-migration-naming.ts:4` only warns and exits 0.

## A14 The seam reaches the oracle

`JOURNAL_RISK_DEFAULT_LIMITS = Object.freeze({sourceFetch: 10001, sourceKeep: 10000})`;
`loadJournalRiskPopulation(ctx, cutoff, limits = DEFAULT)` and `checkJournalRisks(ctx, options = {}, limits =
DEFAULT)`, which still calls `riskOptions(options)` so the unknown-key check is untouched. The limits never
enter the returned `source` object, since `sourceHash = riskHash(source)`. The threshold, change-facts and
line-facts limits stay literals and are never raised.

## A15 Gate c0 made passable

A verbatim copy of the pre-seam `journalRiskQueries.ts` is vendored under
`tests/integration/controls/journalRiskSeamReference/`, with its source SHA in the header. The test pins the
clock with fake timers so `capturedAt` is fixed, runs both versions on the same live fixture in the same
transaction, and compares full canonical JSON for every page cursor. Stated delta: production SQL changes from
the literal `LIMIT 10001` to a bound parameter; the rows are identical, so `sourceHash` and fingerprints are
identical, and the test asserts it.

## A16 Shared pure functions, not copied logic

Extract from `journalRiskChecks.ts` the missing-reasons loop (`:11-16`) as `journalRiskMissingReasons(row)`,
the finding builder (`:18-21`) as `buildJournalRiskFinding(...)`, and the coverage constant (`:23`) as
`JOURNAL_RISK_COVERAGE`; `checkJournalRisks` calls them (behaviour-neutral, covered by the existing unit test
and A15). The adapter calls exactly these plus `analyseJournalRisks`, `riskAmountTotals` and `checkStatus`. A
mutation test stubs each extracted function with a marker and asserts BOTH paths reflect it, so a private copy
in either fails the test. Permission is asserted exactly once, before `DECLARE` (M5: per-row assertion would
add ~17 minutes at 100k).

## A17 The cursor keeps the changes LATERAL; per-transaction work_mem

One shared builder `journalRiskPopulationSql({limits, slabTuple, orderBy})` produces both the sync query
(`slabTuple: false`, `orderBy: 'id'`, `LIMIT ${sourceFetch}`) and the cursor body (`slabTuple: true`,
`orderBy: 'slab'`, no LIMIT). Both the `lines` and `changes` LATERALs are kept whole, including their capped
`facts` sub-selects (LIMIT 101), so a 1000-row fetch carries at most ~101k facts of each kind and there are no
per-parent child queries; `maxChildrenPerParent` is removed. Before `DECLARE`, `SET LOCAL work_mem='64MB'` (M2:
removes the ~17 MB external sort; no expression index, which the planner would not choose). Both
`*_exceeds_100` markers are emitted by the shared `journalRiskMissingReasons`.

## A18 Shared constraints and prefix

Both `control_audit_jobs_result_check` and `control_audit_job_intents_kind_check` are root-coordinated shared
objects. Migration 680 drops and re-adds both (the `662:2-3` / `668:2-8` pattern) and ends with a `DO` block
asserting that the result-check definition names every `result_%_id` column found in
`information_schema.columns` for `control_audit_jobs`, and that the kind-check names every kind in the contract
(`audit_snapshot, audit_export, audit_compare, audit_check_run`); T2a repeats both assertions from the contract's
exported list. Merge-time gate: a `git grep` across every local branch for `ADD CONSTRAINT
control_audit_job(s|_intents)_(result|kind)_check` under `scripts/migrations/sql` must list only 662, 668 and
680; any other hit blocks integration until root sequences it.

## A19 SQL slab tuple columns

With `slabTuple: true` the builder adds `slab_day`, `slab_person` and `slab_currency` (the same expressions as
the ORDER BY). The adapter splits slabs on those three columns and strips them before calling the shared
functions; `parts()` is not used for slab boundaries. With `slabTuple: false` they are absent, so the sync row
shape and `sourceHash` are unchanged, which A15 depends on.

## A20 §2.4, rewritten in place

Asserted equal between the run and the seam oracle (paged via `collectSnapshotCheckPages` at limit 100):
`checkId`, `checkVersion`, `cutoff`, `status`, `populationCount`, `excludedCount`, `findingCount`,
`amountTotals`, `coverage`, `missingSources` (including both `*_exceeds_100` markers, the two policy markers,
and every per-row reason), and per finding key `kind, severity, classification, message, entities, evidence`.
Excluded, with reason: `sourceHash` and `sourceVersions` (framing differs; the run reports
`sourceVersions: {available: false, reason: 'deferred_paged_source_versions', count}`), `capturedAt` and
`nextCursor`. The oracle with raised source limits does not emit
`async_scan_required:journal_population_exceeds_10000` either, so no vocabulary mapping remains. The order-key
invariant stays one-directional and unit-tested. This supersedes v4 §2.4.

## A21 Resource-limit `unknown` row

Published in a fresh read-committed transaction under the same lease: `status='unknown'`, `finding_count=0`,
`population_count` from a `count(*)` over the same predicate in that transaction (recorded as
`populationCountBasis: 'recount_after_limit'` in the header), `excluded_count=0`, `snapshot_text` and
`capture_xid` from that transaction, `missingSources=['resource_limit:<reason>']`, `amountTotals={}`. Table
CHECK: `(status <> 'unknown') OR finding_count = 0`. The reader surfaces `populationCountBasis`.

## A22 Owned-file additions

`scripts/forensic/run-audit-job.ts`; `scripts/forensic/run-audit-worker.ts` (`--class`, strict `parseArgs` at
`:9`); `src/lib/mcp/toolIndex.ts`; `src/lib/mcp/clientMetadata.ts` and its drift test; `src/lib/mcp/flowMetering.ts`
(`TOOL_FLOW_OPERATIONS` at `:58` must name the three new tools) and its drift test; the `auditJobPoller.ts` strict
schema (`kinds`); a new unit template `scripts/isaflow-audit-check-run-worker.service` (modelled on
`scripts/isaflow-fraud-scan.service`, invoking `run-audit-worker.ts --class check_run`); `auditJobSystemd.ts`,
`auditJobProcess.ts`, `auditJobProcessProtocol.ts`, `auditJobProcessContract.ts`; plus the v5 set. New or shared
files are requested through root.

## A23 Per-class idle timeout

`withAuditWorkerTransaction` receives the class limits and sets `idle_in_transaction_session_timeout='15000ms'`
only for `check_run`; legacy classes keep today's settings (`auditWorkerTransaction.ts:26-27`) unchanged. Gate:
a legacy job's transaction reads the default (0) via `current_setting`; a check-run transaction reads 15 s.

## Consolidated limits (`AUDIT_CHECK_RUN_LIMITS.journal_risk_checks`)

`maxRuntimeMs 300000`, `graceMs 30000`, `idleMs 15000`, `fetchRows 1000`, `maxSlabRows 1000` (real slabs ≤6
rows; `analyseJournalRisks` is quadratic per group), `maxFindings 100000` (measured at exactly 100k),
`workMem '64MB'`. Thresholds follow the sync truncate-and-flag rule (LIMIT 101, keep 100, `missingPolicy`), so
there is no threshold resource limit. `maxChildrenPerParent` is removed.

## Gate additions to T2

A10-G1/G2, A11-G1, A12-G1, the A13 timeouts and opt-ins, A15 c0 as rewritten, the A16 mutation test, an A17
check that no per-row child query appears in the statement log (≈101 statements for 100k rows, M3-style), the
A18 constraint assertions and merge grep, the A21 CHECK and the A23 setting check. T2e records the 100k run
under the real check-run unit with `RuntimeMaxUSec` read back, closing the spike's caveat that no runtime cap
was in force.


---

# v7 amendments (implementation findings from T2c; nothing above is rewritten)

T2c shipped at `60794ad8f`. These entries record what the database actually does, where the v6 text assumed
otherwise, and which v6 gates moved to a later task rather than being dropped.

## A24 `approval_rules` accepts exactly one aggregate shape, so §2.3's premise is wrong

v6 §2.3 and A8 finding 9 assume the detector's `usable` filter (`aggregate_window_days === null &&
aggregate_by === null`, now `journalRiskThresholds` in `journalRiskPopulationSql.ts`) is guarding against
arbitrary windowed or grouped approval policies. It is not, because such policies cannot exist. The row
trigger `control_version_approval_policy` on `approval_rules` raises `Unsupported aggregate approval policy`
unless

```
(aggregate_window_days IS NULL OR aggregate_window_days = 1)
AND (aggregate_by IS NULL OR aggregate_by = 'supplier')
AND (aggregate_window_days IS NULL) = (aggregate_by IS NULL)
```

so the only non-null aggregate a company can hold is **one day, by supplier**. The assumption that is wrong is
the plan's, not the trigger's: `usable` is not a broad filter over a large space of unsupported policies, it is
a two-valued gate.

`unsupported_or_bounded_current_journal_policy` is therefore reachable in production through exactly three
doors, and the check must be read as covering those and nothing else:

1. an active `journal_entry` policy with `aggregate_window_days = 1 AND aggregate_by = 'supplier'`;
2. an active `journal_entry` policy whose `condition_field` is outside `('amount','total')`;
3. an active `journal_entry` policy whose `condition_operator` is outside `('greater_than','greater_equal')` —
   in practice `'any'`, which is the column default's neighbour and the commonest value in the wild.

Consequences carried forward: T2c's fixture uses door 1, since it is the only aggregate the database will
accept (`tests/integration/controls/journalRiskCheckRunFixture.ts`, the "Windowed" rule). A later plan that
widens `usable` must widen the trigger first, and that is a root-coordinated shared object. No new detector
work is implied — the flag already fires correctly on all three doors.

**Deployed-company incidence: NOT MEASURED, and deliberately so.** Production (`isaflow`) is never queried
from an implementation session, not even with `SELECT`. The shapes enumerated while writing this amendment
came from the disposable synthetic fixture database `isaflow_schema_fixture` on 127.0.0.1:33149, whose rows
are the accumulated residue of test runs and say nothing about any real tenant: there, `1/supplier` was the
only non-null aggregate present on `journal_entry` (19 rows) alongside 45 `journal_entry` rows at operator
`'any'` (door 3). Whether any deployed company holds a door-1, door-2 or door-3 policy is an open question for
whoever runs the production read, and this plan does not answer it.

## A25 v6 gates deferred out of T2c, with their destination

- **A15 gate c0** (the vendored pre-seam `journalRiskQueries.ts` reference) and the **over-cap differential**
  (10 001-row / 150-change fixtures, oracle at `sourceFetch` 200 001) move to **T2e**, beside the scale
  fixture that has to build a population that large anyway. T2c implemented the A14 seam itself
  (`loadJournalRiskPopulation(ctx, cutoff, limits = JOURNAL_RISK_DEFAULT_LIMITS)`), so the oracle can reach
  past 10 000 as soon as a population exists to read; the differential T2c did run is at default limits over
  1 086 rows, where neither path emits `async_scan_required:journal_population_exceeds_10000`, which is the
  end state A20 describes.
- **A17's statement-count gate** ("no per-row child query in the statement log, ≈101 statements for 100k
  rows") moves to **T2e**: it is an M3-style measurement and needs the 100k population. The property it
  measures is structural in T2c — both LATERALs travel inside the cursor body and the only per-page statement
  is `FETCH` — but it is asserted by nothing, and a later edit could reintroduce a per-parent query silently.
- **§4's "a run finishing inside grace succeeds" is an emulation and stays one.** The gate shortens the lease
  to exactly `graceMs` before the run rather than letting a real 300 s run overrun into the grace window, so
  what it proves is "work landing in the last 30 s of a lease publishes", not "work that exceeded
  `maxRuntimeMs` publishes". The genuine half is the opposite gate, which lets the lease expire while the
  transaction is streaming — the only way a run can cross expiry, since it holds `FOR SHARE` on the job row
  and no competitor can shorten the lease under it. Any evidence document for this slice must say so in these
  terms; a summary that reports the gate as "finishes inside grace: PASS" without the emulation is wrong.


---

# v8 amendments (blind review of T2c+T2d, `bcf5aab53..f5f09286d`: no P1, three P2, six P3)

Nothing above is rewritten; where an earlier entry is wrong, the entry here says so and supersedes it.

## A26 G3 did not reach the fence — A25's "genuine half" was false

A25 said the crossing-expiry gate "lets the lease expire while the transaction is streaming". It did not. The gate
set the lease to now+3 s and then ran a 10 s `pg_sleep` *before* calling the phase, so the phase's opening lease check
(`auditCheckRunPhase.ts`, the first `loadStoredAuditJobDelegation`) already saw an expired lease and refused — and the
gate's `/lease expired or was replaced/` matched that message as readily as the publication fence's. Deleting the
lease predicate from both the post-stream re-check and the success UPDATE left it green.

Rebuilt (`e1c911a87`, `68d6fffe0`): the gate holds a lock the phase first needs at `DECLARE`, proves the phase is
blocked there with the lease still live (so the opening check passed and expiry lands after it), waits for expiry on
the database clock, releases, and demands `CheckRunPublicationFenceError` with `stage:'recheck'`. The tenant has no
journals, so no finding INSERT — whose RLS also checks the lease — runs first. The reviewer's exact mutant now fails
with "the publication fence did not refuse; got Error: Audit job lease expired or was replaced".

What no gate can isolate, stated rather than hidden: the success UPDATE's own `lease_expires_at` predicate. For it to
be the refusing check, expiry must land between the result-row INSERT (whose RLS already demands a live lease) and
the UPDATE, a window of microseconds with no lock to widen it. Removing that predicate alone survives. It is depth
behind the RLS, like T2d's layered permission checks, and it stays.

## A27 `maxSlabRows` counted the wrong rows and rested on a false premise

v6 set `maxSlabRows 1000` because "real slabs ≤6 rows". That premise is false: the reviewer measured one user's
927 posted journals in a single (SAST day, person, currency) slab on isaflow_dev (2026-07-05), with others at 670 and
387 — dev data, not production, which nobody queries from here. Worse, the bound counted every row, including rows
that can never join a threshold group, and the population is cumulative to the cutoff: one historical day of more than
1 000 postings by one user made every later run `unknown`, permanently.

Now: only rows that can join a threshold group are held and counted. A row that can join none has a result that
depends on no other row, so it is analysed at once, alone, by the same detector. The eligibility predicate
(`journalRiskThresholdGroup`) is extracted from `analyseJournalRisks`, not copied. The per-row array copy that made
one group quadratic is gone — same node harness, one group, typical history: 10 000 rows 472 ms → 133 ms, 20 000
5.6 s → 0.24 s, 40 000 33.8 s → 0.48 s. The bound was then set by
measurement on the fixed detector, under node with the worker's 1 536 MiB heap:

| rows held | analyse (3 facts) | analyse (101 facts) | heap held (101 facts) |
|---|---|---|---|
| 10 000 | 133 ms | 136 ms | 149 MiB |
| 20 000 | 244 ms | 295 ms | 298 MiB |
| 40 000 | 481 ms | 550 ms | 595 MiB |

A held row costs 0.7 KiB with typical history and 15.2 KiB at the 101-change-fact worst case; the unfixed detector
exhausted the heap at 80 000 worst-case rows. **`maxSlabRows = 25 000` groupable rows**: at most ≈371 MiB held and
≈0.36 s of analysis, 27× the largest dev slab. A 2 500-journal dev-shaped slab publishes at production limits.

Residual, stated: a single (day, person, currency) with more than 25 000 journals that can join a threshold group
still makes that run `unknown`, and so does every later run whose cutoff includes that day, until retention or a
different algorithm exists. The exact edge of both bounds is now gated through a tighten-only limits parameter.

## A28 The absolute run cap was a permanent lockout; it is now a rate — and storage has no bound

`maxPublishedJobs = 100` counted every succeeded run, `unknown` included, with no retention: the 101st run was
refused forever, and a read-only token or a looping agent could reach it. It is replaced by **at most 100 enqueued per
company in any trailing 24 hours** (plus the unchanged 6 active), on the database clock, so old runs stop counting.

**Dependency Hein must see:** with a rate instead of a count, check-run results and findings now grow without bound
until retention exists. The cap no longer hides that; nothing else bounds it either.

## A29 Enqueueing takes `write:audit`

`run_control_checks` was `write:true` but gated on `read:reports`. It now requires the existing opt-in `write:audit`
scope: the MCP tool declares it (so the tool boundary refuses legibly), and `enqueueAuditCheckRuns` asserts it inside
the transaction that writes — the only layer REST has. Reads stay on `read:reports`. The worker's stored delegation is
unchanged (`read:reports`): enqueue authority and execution authority are separate. Out of this slice, noted:
`audit_snapshot`, `export_audit_evidence` and `compare_audit_snapshots` share the old write-under-`read:reports` shape.

## A30 Reader statuses

An absent run and another tenant's are indistinguishable `not_found` (REST 404); the requester's own unpublished run
is `not_ready` (REST 409) — told only to the person who enqueued it, matching `getAuditJob`'s audience. A succeeded job
without its result row stays a server fault. None of these is a 500.

## A31 The seal never refuses what the synchronous detector accepts

The 4 096-character message cap refused a journal carrying about 60 threshold reasons, which sync publishes. The
detector's maximum is now proven at the database's type bounds (100 thresholds of uuid id and bigint version, six
signals): **8 663 characters**, built through the real detector in a unit test. The cap is 9 216; currency and amount,
unbounded text on the sync path, get 1 024 each, and the envelope still fits the table's 64 KiB CHECK.

## A32 Permission asserted once before `DECLARE` — accepted, with the reason

The worker asserts `read:reports` once, before the cursor. A re-check inside the repeatable-read snapshot could not
see a revocation anyway, and per-row assertion would reload and decrypt the delegation 100 000 times (spike M5).
Readers re-authorise against their own current permissions on every read. This is accepted, not an oversight.

## A33 What the A20 differential does and does not prove

The run and the sync oracle share `journalRiskPopulationSql` on both sides, so the A20 differential proves the
stream, slab assembly, writer, seal and reader — not the population SQL itself. The shared layer is covered by A15:
the vendored pre-seam reference compared byte for byte against today's sync detector. Evidence must say this.

## A34 A run past the 300 s deadline is `failed`, never `unknown` — T2e measures where that begins

The contract stays: a timeout records `RESOURCE_LIMIT` failure, so a population too large to stream in 300 s can
never publish anything. T2e must measure the largest population that fits and put the number in the evidence doc.


---

# v9 amendments (T2e results; evidence in `forensic-evidence/check-run-t2e-evidence.md`)

## A35 T2e ran without a systemd unit, so part of its definition of done is still open

The worker ran as the real artifact but as a direct child process, because this session was barred from starting
systemd units. "Under `createIsolatedAuditJobRunner`" and "under the real check-run unit with `RuntimeMaxUSec` read
back" were therefore **not done**: no `RuntimeMaxSec`/`MemoryMax` wall was in force and no unit readback happened. The
T1 spike's caveat that no runtime cap was in force is still open, and T2f or a later session must close it.

## A36 A17's "≈101 statements" was the FETCH count, not the statement count

Measured at 100 000 journals: 101 FETCH, one statement touching `control_change_events` (the DECLARE), two touching
`gl_journal_lines` (the DECLARE and the SUM cross-check), 546 in total. The total grows with findings — one sealed
INSERT and one re-read page per 512 — never with rows. The gate asserts the FETCH count, the two child-table counts and
a total below one per hundred rows.

## A37 A34's answer: there is no single largest population

Settled tables: 2 093 361 journals published in 256.6 s, the most measured. The first run after a bulk load, while
autovacuum was processing the streamed tables, overran the deadline at 1 400 045. So "largest population that fits"
depends on the database's state, not only its size; a restored or freshly migrated tenant near 1.4M journals can time
out and publish nothing. That overrun is also the only real evidence of the grace window: the failure record landed
29.8 s before lease expiry. G2's success-inside-grace remains an emulation — a COMMIT after the work deadline is
refused by construction.

## A38 The mixed scale fixture makes every journal a finding

Its day (`g % 240`) and person (`g % 50`) assignments cycle together every 1 200 journals, giving ~83 journals per
(day, person) that split every threshold: the 100k run carried exactly `maxFindings`. It is the worst case for the
findings path, not a realistic mix, and the evidence says so. Decorrelating it would change what the recorded run
measured, so it stays as committed.
