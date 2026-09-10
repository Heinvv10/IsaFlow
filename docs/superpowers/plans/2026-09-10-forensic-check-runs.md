# Plan v4: minimal vertical slice — measurement spike, then journal_risk_checks

Status: narrowed after three independent adversarial reviews rejected the whole-system designs
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
