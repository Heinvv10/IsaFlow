# Plan: page-complete forensic check runs — 2026-09-10

Status: DRAFT, pending adversarial plan review. Authored by a read-only planning agent against
integration commit `6ec30a9cd`. Closes programme requirement 3 (complete large-data detective and
history jobs) of `2026-09-09-mcp-forensic-controls.md`.

## Verified baseline at 6ec30a9cd

- The whole audit job runs in one REPEATABLE READ transaction with a hard 60 s wall deadline and a
  90 s lease that is never renewed (`auditJobRunner.ts:49-56`, `auditJobContract.ts:5`,
  `auditWorkerTransaction.ts:23-27`). Publication is lease-fenced (`auditComparisonPublication.ts:68-72`,
  `auditSnapshotPublication.ts:37-41`); RLS insert policies require a live lease of the exact
  generation (`668_forensic_snapshot_comparison.sql:56-63`, `673_snapshot_index_build_lineage.sql:16-25`).
- All six detectors truncate: `RISK_SOURCE_LIMIT=10000` (`invoiceRiskQueriesResult.ts:8`); child caps
  `LIMIT 101` (`invoiceRiskQueriesPayments.ts:18,25`; `threeWayMatchSources.ts:29,35,38`;
  `journalRiskQueries.ts:23,35,47`); `LIMIT 10001` fingerprints (`bankStatementCompletenessQueries.ts:54,61,68`);
  payroll `LIMIT 10000` on nine CTEs plus a single jsonb blob (`payrollControlQueries.ts:13-46,57-64`);
  document verification capped at 100 docs / 100 MiB (`capturedEvidenceScan.ts:13,21`). Finding pages
  are offset slices over an in-memory array (`invoiceRiskQueriesResult.ts:20-31`). History over 2 MiB
  returns `RESOURCE_LIMIT`/`requiredDelivery:'async'` with no async path (`controlChangeHistoryService.ts:41-45`).
- Snapshot check capture walks those pages and inherits the caps (`auditSnapshotCheckCapture.ts:40`).

## 0. Freezing the population

| Option | Survives worker kill | 100k feasibility | Verdict |
|---|---|---|---|
| A. One RR txn for capture+analysis+publish | No (restart from zero) | Must fit one lease/statement window; long xmin hold; JS heap analysis | Rejected as sole mechanism |
| B. `pg_export_snapshot()` across worker txns | No (dies with exporting backend) | Parallel readers only | Rejected |
| **C. Run-owned population pages captured in one short RR txn, analysed from immutable copies in later txns** | Yes | Set-based keyset `INSERT … SELECT`; SQL aggregates over the copy | **Chosen** |

Trade-offs accepted: storage per run (~50–150 MB at 100k parents with children; retention needed) and a
second implementation of each detector's grouping (SQL over pages vs existing JS over ≤10k arrays),
controlled by a mandatory equivalence suite and shared SQL predicate fragments. RR affects reads only;
phase-1 INSERTs commit atomically with the census. Phase 1 holds xmin: bound with lease renewal every
≤30 s, a phase budget (~10 min at 100k), `lock_timeout` 5 s, no row locks on source tables.

## 1. Module shape (`src/modules/accounting/services/controls/`, each ≤300 lines)

Reused: queue/lease/generation (`auditJobLease.ts:30-64,76-87`), delegated worker principal and
permission recheck (`context.ts:103-120`, `auditJobDelegation.ts:8-22`), `withAuditWorkerTransaction`,
`createIsolatedAuditJobRunner`, poller, protected request/idempotency (`auditComparisonJobService.ts:15-44`
pattern), batched writer (512 rows / 2 MiB, RETURNING verification, `auditSnapshotIndexRows.ts:11-37`),
`indexBudget`, HMAC sealing, bounded page readers with current-permission checks, tool/REST adapters.

Does not fit: `executeAuditJob` single-RR body (add a dispatch branch to a three-phase orchestrator);
`AUDIT_JOB_LIMITS` 60 s / 90 s with no renewal (add per-kind `AUDIT_CHECK_RUN_LIMITS` and kind-aware
process timeout); `collectSnapshotCheckPages` (left untouched; snapshots may later reference a check run);
offset cursor in `riskResult` (replaced by ordinal keyset over stored findings).

New modules:
- `auditCheckRunContract.ts` — kind `audit_check_run`, limits (capturePageRows 1000, maxPopulationRows
  2,000,000, maxFindings 1,000,000, capture 600 s / analysis 900 s / publish 120 s wall, lease renew 30 s,
  finding page 100, evidence 100 MiB/doc, 20,000 docs/run, 600 s), `CHECK_POPULATIONS`, request parser,
  `auditCheckRunPermissions`, `PopulationCensus {population,rowCount,excludedCount,pageCount,chainHash}`,
  `CheckRunHeader` (company, run, generation, lease, cutoff, capturedAt, snapshotXid, checks, census,
  checkResults, permissions, canonicalHash).
- `auditCheckRunJobService.ts` — `enqueueAuditCheckRun(ctx,input)`; `getAuditJob` gains
  `resultCheckRunId`.
- `auditJobLease.ts` — `renewAuditJobLease(query,lease)`: lease-fenced UPDATE, throws on 0 rows.
- `auditCheckRunRunner.ts` — `runAuditCheckRun(pool,identity,lease,signal)`: phase 1 RR capture, phase 2
  RC analysis (one txn per check allowed), phase 3 RC publish. Retry adopts a committed phase-1 header
  only after `verifyCensus` recomputes the hash chain; phase-2 rows are keyed by `analysis_generation`.
- `auditCheckPopulationCapture.ts` — generic `PopulationSource {count, insertPage}`; keyset pages with
  strict key advance, cumulative ≤ count, final == count, SQL page hash, lease renewal per page.
- Six population sources (`auditCheckPopulation{Invoices,Payments,ThreeWay,Journals,Bank,Payroll}.ts`)
  using existing predicates with `LIMIT`s removed, children as own populations; shared `…Sql.ts`
  predicate fragments used by both sync detector and run.
- Six `auditCheckAnalysis<Check>.ts` — read only the run's population, SQL aggregates/windows for
  cross-row logic, existing pure functions for row-local logic, keyset streaming, never the whole
  population in JS.
- `auditCheckFindingsWriter.ts` — batched, unique `(check, finding_key)`, per-currency Decimal totals
  verified against SQL `SUM(amount::numeric)` before the result row is written.
- `auditCheckRunPublication.ts` — savepoint; reload delegation and assert permissions; `verifyCensus`;
  one result per requested check for the current analysis generation; counts/totals match; seal header;
  insert result pointer; lease-fenced job success. Anything short of that publishes nothing.
- `auditCheckRunReadService.ts` — header, findings (keyset on ordinal, published generation only, HMAC
  verified, current per-check permissions; shared-bank findings withheld without `write:bank-tx`), census.
- Transport: `src/lib/mcp/tools/forensicCheckRuns.ts` (`run_control_checks`, `control_check_run_status`,
  `control_check_run_findings`, `control_check_run_census`); `pages/api/accounting/audit-check-runs.ts`.
- Sync detectors keep their contract; `async_scan_required:*` gains `:use_run_control_checks`.
- History >2 MiB: separate kind `audit_history_delivery` reusing run tables and 256 KiB chunks (T13).

## 2. Data model — migration `676_forensic_check_runs.sql` (PROVISIONAL; rescan all refs/worktrees)

- Extend `control_audit_job_intents` kind check with `audit_check_run`; add
  `control_audit_jobs.result_check_run_id uuid` (= job_id), extend result check to four columns.
- `control_audit_check_runs` (PK company, run; capture_generation, capture_lease_id, cutoff, captured_at,
  snapshot_xid, checks, population_row_count, protected_capture ≤64 KiB; FK to jobs).
- `control_audit_check_population` (PK company, run, capture_generation, check, population, ordinal;
  entity_id text, parent_entity_id, group_key, material jsonb ≤64 KiB; indexes on group_key and parent).
- `control_audit_check_population_pages` (census: page ordinal, first ordinal, row_count 1..1000,
  sha256 page_hash).
- `control_audit_check_derived` (phase-2 derived keys, e.g. beneficiary HMACs, per analysis generation).
- `control_audit_check_findings` (PK … check, ordinal; UNIQUE finding_key; amount/currency text;
  protected_item ≤64 KiB).
- `control_audit_check_results` (per check per analysis generation: status, population/excluded/finding
  counts, amount_totals, coverage, missing_sources, protected_summary).
- `control_audit_check_run_results` (publication pointer; jobs FK `(company,result_check_run_id,generation)`).
- RLS on all: tenant read; INSERT only for a running job of kind `audit_check_run`, exact generation
  and lease, unexpired, requester = `auth.uid()` (copy of `668:56-63`). No UPDATE/DELETE for app_user.
  Retention purge later via root-owned SECURITY DEFINER function.
- Separate capture and analysis generations so a phase-2 retry adopts a verified population and
  readers only ever see the FK-pointed published generation.

## 3. Per-detector conversion

Common: cutoff and ownership joins lifted verbatim; `LIMIT`s removed; children as populations with
`parent_entity_id`; JS grouping becomes SQL `group_key` with the same hash inputs as `riskHash`
(unit-proven equal; SQL `canonical_money` proven equal to `canonicalMoney`).

1. duplicate_invoice_checks — populations `supplier_invoice`, `sage_import`; evidence verification as a
   phase-2 sub-step writing verified hashes to `derived`; windows `first_value … PARTITION BY group_key`
   (and by verified hash) reproduce lines 19-26; evidence budget overflow recorded in missingSources and
   downgrades `reused_invoice_source` to candidate (the one intentional bound).
2. payment_risk_checks — `supplier_payment`, `payment_allocation`, `release_attempt`,
   `supplier_beneficiary` (only with current `write:bank-tx`; envelopes stay encrypted). SQL per-payment
   aggregates reproduce `paymentRiskCurrency`; allocation-set group key via ordered `string_agg`;
   repeated prepared release via `GROUP BY … HAVING count(DISTINCT intent)>1`; repeated candidate via
   `lag()` 7-day test; beneficiary HMAC to `derived` then `GROUP BY … HAVING count>1`; `write:bank-tx`
   asserted at capture and analysis.
3. three_way_match_exceptions — `invoice_line`, `po_bill_line`, `grn_line`, `supplier_coding_rule`;
   per-parent keyset children into `evaluateThreeWayMatchRow`. Gate: read `threeWayMatchMath.ts` first;
   if only sums are consumed, pass SQL sums.
4. journal_risk_checks — `journal_entry`, `journal_change` (no 101 cap), `approval_threshold` (real
   count); threshold split via SQL `GROUP BY (sast_day, person, currency)` into `derived`; row-local
   signals via `analyseJournalRisks(page,[])`.
5. bank_statement_completeness — `statement_root` (existing UNION), `uncovered_transaction`,
   `imported_transaction`; counts/net/fingerprints by SQL over frozen rows (exact).
6. payroll_control_checks — replace jsonb blob with `payroll_run`, `payroll_line`, `employee`,
   `gl_account`, `cost_allocation`, `cost_centre_mapping`, `uif_declaration`, `payroll_journal_line`,
   `shared_bank_group` (employee ids only, never account numbers), `component_change`; per-run keyset
   into unchanged `buildExactPayrollPlan`; UIF expected via SQL sum.

Rule: every array-derived quantity is either a SQL aggregate/window over the immutable population or a
per-parent keyset walk; at most one page of parents or one parent's children in memory.

## 4. Failure semantics

| Event | Behaviour |
|---|---|
| Kill in phase 1 | RR rollback; nothing exists; reclaim at generation+1 restarts phase 1 |
| Kill in phase 2 | Committed population verified by `verifyCensus` and adopted; new analysis generation; old partial rows unreachable |
| Kill in phase 3 | Publication rolls back; retry re-verifies and republishes |
| Lease replaced | Renew fails → throw; failure recorded only if own lease current; RLS refuses stale-lease writes |
| Partial page | Assertions on page size, key advance, cumulative count; any violation rolls back phase 1 |
| Stale population | Header reports capturedAt/cutoff/snapshot_xid; optional reader `maxAgeSeconds`; no silent rerun |
| Permission revoked | Every phase rechecks delegated permissions → `AUTHORITY_REVOKED`; readers recheck per check |
| Tenant isolation | company_id-leading keys, RLS, company-scoped copies; foreign references as `*_unavailable` booleans |
| Resource bound | Population/findings/wall bounds → `RESOURCE_LIMIT`, nothing published; evidence budget → explicit missingSources |

## 5. Task DAG and gates (serialize PG; RED → GREEN → named commit → independent review)

- T1 Contract + migration + `renewAuditJobLease` + job kind/result. Gate: PG schema test (fresh replay,
  RLS refuses without live lease / stale lease, result FK); typecheck; migration naming; prefix rescan.
- T2 Enqueue/status/dispatch + kind-aware process limits (T1). Gate: idempotency conflict refused;
  status never triggers work; poller picks kind.
- T3 Phase-1 engine with one synthetic source (T1). Gate: RR isolation under concurrent insert (two
  connections); reproducible hash chain; non-advancing key throws; renewal observed; abort leaves zero rows.
- T4 Findings writer, results, publication, reader (T3). Gate: duplicate key fails run; SQL vs Decimal
  mismatch fails; expired-lease publish refused and invisible; unpublished generation unreadable;
  current-permission recheck; HMAC tamper detected.
- T5–T10 Detector conversions (T3+T4; ≤3 parallel by ownership). Gate each: (a) equivalence with sync
  detector on ≤10k fixtures (keys, counts, totals, coverage, missingSources); (b) over-cap 10,001 parents
  / 102 children / 101 docs complete in run while sync returns `async_scan_required`; (c) group straddling
  a page boundary equals contiguous; (d) no foreign-company material.
- T11 Transport (T4). Gate: MCP HTTP acceptance extended; enqueue → poll → findings with synthetic
  bearer; cross-tenant not found; revoked scope forbidden.
- T12 Scale + hard-kill (T5–T10). 100,000-parent invoice+payment and journal populations under the
  isolated runner; record elapsed/RSS/DB samples to `forensic-evidence/check-run-scale-100k.json`;
  SIGKILL in phase 2 → population retained, no pointer, reclaim, census adoption, exactly one result.
- T13 History async delivery (T4). Gate: >2 MiB entity delivered completely by hashed chunks; sync path
  still `RESOURCE_LIMIT` with job hint.
- T14 Integration: `bun run ci` on the named integrated commit; independent reviewers on migration, RLS,
  sensitive material, bypass routes; adversarial pass (forged lease copies, other-generation reads,
  snapshot-kind inserts, permission downgrade between enqueue and read).

## 6. Counter-argument, highest risk, what would change this

Against: a second implementation of grouping logic risks divergent findings (spec forbids parallel
sources of truth). Cheaper alternative: option A with lease renewal and keyset streaming, accepting
kill = restart. Rebuttal: A cannot survive kill beyond restart, holds long xmin on shared tables, and
still needs streaming rewrites. The equivalence gate is mandatory; a detector that cannot pass it stays
on per-parent JS streaming over frozen children.

Highest risk: phase-1 wall time and DB pressure at 100k parents with unbounded children under
`lock_timeout` 5 s and one worker connection; unmeasured. Second: captured-document byte verification
at scale (IO outside the snapshot), hence the explicit evidence budget.

Would change the recommendation: phase 1 at 100k well under 20 s plus unacceptable storage → switch to
id+row-hash freeze with `EVIDENCE_CHANGED` on drift; phase 1 over budget → `pg_export_snapshot()`
fan-out inside phase 1 or per-check RR captures with explicit per-check snapshot ids; irreducible SQL/JS
divergence → keep that detector on per-parent JS streaming.
