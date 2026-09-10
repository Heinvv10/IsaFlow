# Check runs: scale, hard-kill and deadline evidence (T2e), with the corrections from the T2c+T2d review

Plan: `docs/superpowers/plans/2026-09-10-forensic-check-runs.md` v8–v11 (A26–A51). The first section is the merged code
(`26be1aeed`); every later figure is the pre-merge worker. Raw measurements beside this file:
`check-run-journals-100k.json` (scale, hard-kill, slab bound, worst-case findings — final head `9ddd49eb7`),
`check-run-storage.json` (bytes per finding, per run and per day) and `check-run-deadline.json` (A34, measured on the
`2b851aa7b` worker; the harness is now `scripts/forensic/measure-check-run-deadline.ts`).

## Restored by the canonical column (`a807acb23`): the index path is back and the stream publishes again

The fix for the section below: migration 684 adds `entity_id_canonical text GENERATED ALWAYS AS (lower(entity_id))
STORED` to the five control tables that were matched by `lower(entity_id)`, indexes it in the 678/679 column order,
drops the 678/679 expression indexes, and every row lookup compares the column with plain `=` (fix `1981532b6`, plus
`a807acb23`, which leaves the exposure predicate on `control_policy_exposure` alone). Text equality is leakproof, so
under `app_user` it stays the Index Cond. Measured on an owned disposable database (`isaflow-canonical-scale-pg-20260911`,
same image and settings as below, schema cloned from the shared fixture after 684, removed with its volume afterwards),
the after worker (`a807acb23`, SHA-256 `47392c26…`; the `1981532b6` build is byte-identical) alternated with the
pre-merge worker (`6b80a8a06`, `9e13f4f4…`, the same build as the round below) on the same rows. Raw numbers:
`check-run-canonical-a807acb23.json`; plans: `check-run-canonical-explain-*.txt`.

| measurement | pre-merge — `6b80a8a06` | broken — `26be1aeed` (below) | fixed — `a807acb23` |
|---|---|---|---|
| 100k mixed, elapsed | 29.6 s, 28.5 s, 33.3 s | failed RESOURCE_LIMIT at 300.1 s | **30.7 s, 29.4 s, 31.8 s** |
| 100k mixed, peak (VmHWM) | 282 / 256 / 274 MiB | 94 MiB | **272 / 274 / 269 MiB** |
| A17 statements at 100k | 547 total, 101 FETCH | 57 total, 1 FETCH | **547 total, 101 FETCH**, `control_change_events` 1, `gl_journal_lines` 2 |
| settled 2 093 361 journals (cutoff 2026-08-11) | published 282.7 s, 268.0 s | failed RESOURCE_LIMIT at 300.1 s | **published 288.5 s, 269.0 s** |
| EXPLAIN, 200 mixed journals | 44.7 ms, 24 767 buffers | 165 037 ms, 17 200 810 buffers | **20.1 ms, 22 979 buffers** |
| EXPLAIN, 10 026 mixed journals, unrestricted | 1.59 s | cancelled at 645 s | **1.72 s** |
| EXPLAIN, 5 quiet journals (33M change events) | 979 ms | 122.5 s | **2.4 ms** |

- Every change-event and entity-version lookup in the 200-journal plan is an `Index Cond` on `entity_id_canonical`
  (`control_entity_versions_entity_canonical_idx`, `control_change_events_entity_canonical_idx`), ~0.002–0.009 ms a
  loop. The period's latest event walks the company's fiscal-period events by `occurred_at` and joins the period, the
  same plan shape as the pre-merge worker.
- The machine was not quiet: load averages 7–11 before every run (a serial integration suite ran beside the first
  100k pairs). The 2.09M point therefore sits 11–32 s under the deadline for BOTH workers here, where the round below
  measured 246.1 s for the pre-merge worker; what these numbers show is parity with the pre-merge worker on the same
  rows at the same moment, not a new ceiling. The settled boundary (~2.1M) is unchanged, not re-bracketed.
- Deploy cost of 684, measured on this database (32 999 778 change events, 2 969 659 entity versions) in one
  transaction as the runner applies it: `control_change_events` rewrite 165.9 s and index build 38.8 s,
  `control_entity_versions` rewrite 6.6 s and index 3.9 s, everything else under a second — about 3 min 36 s under
  ACCESS EXCLUSIVE locks held until COMMIT. On the shared fixture (221 681 events, 302 967 versions, 213 310
  protected-evidence rows / 1.6 GB) the whole migration took 30.6 s.

## Re-measured on the merged code (`26be1aeed`): the lineage query makes the stream unusable at scale

**Every scale figure below this section describes the pre-merge worker and no longer runs.** The check-run branch
merged into the integration branch at `ef5c7809c`; integration's lineage work (the per-journal entity-versions
LATERAL with window counts, and `lower(entity_id)` in the change-event joins) now sits inside the cursor body. Both
worker builds were measured here side by side, alternating, on one disposable database
(`isaflow-t2e-merged-scale-pg-20260910`, same image and settings as below), each artifact beside the same
`node_modules` (`bun.lock` identical at both commits). Raw numbers: `check-run-merged-26be1aeed.json`; plans:
`check-run-merged-explain-*.txt`. Nothing was optimised in this round.

| measurement | before — `6b80a8a06` (pre-merge head) | after — `26be1aeed` (merged) |
|---|---|---|
| 100k mixed, elapsed | **28.7 s** and **25.6 s** (earlier: 26.0 s at `9ddd49eb7`) | **did not publish**: `failed RESOURCE_LIMIT` at 300.1 s, twice |
| 100k mixed, peak (VmHWM) | 284 / 287 MiB | 94 MiB (waiting on the database) |
| A17 statements at 100k | 547 total, 101 FETCH, `control_change_events` 1, `gl_journal_lines` 2 | 57 total, **1 FETCH** (never returned), `control_change_events` 1, `gl_journal_lines` 1 |
| 100k worst-case findings | **76.8 s** / 279 MiB and **74.0 s** / 282 MiB (earlier: 77.6 s at `9ddd49eb7`) | **did not publish**: `failed RESOURCE_LIMIT` at the deadline, twice |
| settled deadline, 2 093 361 journals | **published, 246.1 s** (earlier: 256.6 s at `2b851aa7b`) | **did not publish**: `failed RESOURCE_LIMIT` at 300.1 s |
| settled deadline, bracket | 2 173 359 published in 263.1 s; 2 946 673 overran | — |
| smallest population tried | — | 13 333 journals (unsettled, right after the seed): overran at 300.1 s |

**A17 still holds — there is no per-row statement.** The child tables appear only in the one `DECLARE`; the census
of the merged run is 57 statements with a single FETCH. The cost moved inside the cursor body: the first FETCH has to
sort the whole population, so every row's LATERALs run before any page returns, and they never finished.

**Which node pays** — `EXPLAIN (ANALYZE, BUFFERS)` of the cursor body as `app_user` with the worker's claims (RLS in
force), `work_mem` 64MB, on the 100k mixed company (1 000 678 change events, 89 930 entity versions):

- 10 026 journals, unrestricted body: before **2.45 s**; after **cancelled at 645 s** without finishing.
- 200 journals (body plus one `j.id = ANY(200 ids)` predicate, identical in both): before **59 ms** (27 014 buffers);
  after **165.0 s** (17 200 810 buffers) — **~2 800× slower, 825 ms per journal**, of which:
  - change-facts subquery (`x`): **393 ms** — Bitmap Index Scan on `control_change_events_pkey` with `company_id`
    alone, 1 000 678 rows, *Rows Removed by Filter: 1 000 669*;
  - change-count subquery (`n`): **398 ms** — the same full-company scan;
  - entity-versions LATERAL (`cv`): **30 ms** — `control_entity_versions_canonical_idx` on `(company_id, entity_type)`
    only, 89 930 rows, *Rows Removed by Filter: 89 929*.
  Before, both change-event subqueries used `control_change_events_entity_idx` at ~0.01 ms a journal, and entity
  versions were read once by a single sequential scan into a join (34 ms for the whole query), not once per journal.
- The cost is per journal × **every change event the company has**: on the 3.2M-journal quiet company (32 019 985
  change events) five journals took **122.5 s — 24.5 s each**, 29.7× the 1M-event company for 32× the events. At that
  size about a dozen journals fit in 300 s.

**Why.** `lower()` is not leakproof, and both tables have `FORCE ROW LEVEL SECURITY`. Under `app_user` the planner
may not evaluate `lower(entity_id) = j.id::text` ahead of the RLS policy's qual, so the predicate that matches the
canonical expression index becomes a Filter after a scan of the whole company. As `postgres` (RLS bypassed) the same
body puts `lower(entity_id)` in the Index Cond of `control_entity_versions_canonical_idx`. The same predicate shape
serves integration's synchronous detector (`loadJournalRiskPopulation`, same SQL), and `lower(<t>.entity_id) = …`
appears in 15 controls files; only the check-run body was measured here.

**Not decided here:** how to restore an index path (a leakproof comparison, a stored canonical column, a policy change
or a different join) is the coordinator's decision with these numbers.

## How these were run, and what that leaves out

- **Database.** A disposable container `isaflow-t2e-scale-pg-20260910` (pgvector/pgvector:pg16, PostgreSQL 16.11,
  `shared_buffers=1GB`, `max_wal_size=8GB`, `log_statement=all`, `log_line_prefix='%m|%a|%p|'`, bind parameters not
  logged), schema cloned read-only from the shared forensic fixture with `pg_dump -s`. Never the shared fixture, never
  production. Seeding used `session_replication_role=replica` on its own connection only.
- **Worker.** The real worker executable (`scripts/forensic/build-audit-job.ts` output; the final-head build is
  SHA-256 `342376ed…`, from `9ddd49eb7`), run as a **direct child process** with the class heap (`--max-old-space-size=1536`), the
  literal class and spawn-time variables and the production environment allow-list.
- **Not done, because systemd units were ruled out for this session:** the plan's "under
  `createIsolatedAuditJobRunner`" and "under the real check-run unit with `RuntimeMaxUSec` read back". No
  `RuntimeMaxSec` or `MemoryMax` wall was in force, and no unit readback was performed. Memory figures below are the
  child's own VmHWM, not a cgroup peak. This caveat from the T1 spike therefore remains open.
- **Opt-in.** The scale suite follows the repo's `describe.skipIf(!enabled)` convention
  (`forensic-invocations.int.test.ts`): without `ISAFLOW_AUDIT_SCALE_OPT_IN=1` it is skipped, never red; once opted in,
  a misconfiguration throws. Measurements that answer "how much" rather than "does it hold" are not tests at all:
  `scripts/forensic/measure-check-run-deadline.ts` and `measure-check-run-storage.ts` record observations and refuse
  only on a broken product contract.
- **Machine.** velo-server, 32 vCPU, shared with other sessions; the 1-minute load average is recorded beside every
  timing in the JSON (6–34 across these runs). Timings are this machine at that moment, not a benchmark.

## What each gate proves — and what it does not

- **A20 differential** (run vs. the sync detector, every A20 field): the run and the oracle share
  `journalRiskPopulationSql`, so this proves the stream, slab assembly, writer, seal and reader — **not** the
  population SQL. Demonstrated, not argued: a mutant that re-renders `amount` inside the shared SQL left the A20
  differential green.
- **A15 gate c0** covers the shared layer: the detector exactly as it stood at `bcf5aab53` (vendored, only its three
  unvendored imports re-pointed to the same files) is compared page by page, same transaction, frozen clock, byte for
  byte, cursors included. The same amount-rendering mutant turned it red ("Risk population changed or cursor invalid",
  because `sourceHash` moved). Today's detector — including the blind review's extracted predicate and the quadratic
  fix — is byte-identical to the reference.
- **Over-cap** (10 001 journals, one carrying 150 amendments): the sync path at default limits emits
  `async_scan_required:journal_population_exceeds_10000`, reports 10 001 but analyses exactly 10 000 rows (10 000
  source versions); the oracle with only `sourceFetch` raised to 200 001 reads all 10 001; the published run equals
  it on every A20 field, over more than one page, `journal_change_history_exceeds_100` included. Dropping the seam
  turns it red ("the oracle still truncated at 10 000").

## G3 — the fence gate, corrected (plan A26)

The T2c report and plan A25 called the crossing-expiry gate genuine. **It was not:** it slept 10 s before calling the
phase, so the phase's opening lease check refused, and its regex matched either check. Rebuilt: a lock the phase first
needs at `DECLARE` holds it after the opening check; the gate proves that position (blocked at `DECLARE`, lease still
live), waits for expiry on the database clock, releases, and demands `CheckRunPublicationFenceError` at
`stage:'recheck'`. The reviewer's exact mutant (lease predicate removed from the re-check and the success UPDATE) now
fails with the gate's own message. The success UPDATE's predicate alone is depth behind the result-row RLS: no gate
can isolate it, and removing only that predicate survives.

## G2 — "a run finishing inside grace succeeds" is an EMULATION, and cannot be anything else

The gate shortens the lease to exactly `graceMs` before a run and shows it publishes; that proves "work landing in the
last 30 s of a lease publishes". A real run that *exceeds* `maxRuntimeMs` and still publishes is **unreachable by
construction**: `withAuditWorkerTransaction` refuses to COMMIT once the work deadline (spawn + 300 s) has passed, and
the lease (claim + 330 s) always outlives that deadline. The grace window exists for what happens *after* the deadline
— the failure record, or the `unknown` publication after a resource limit — under the same lease. The deadline run
below is the real evidence of that.

## A17 — statements counted, per worker backend, at 100 000 journals

From the server's own statement log, filtered to the worker's `application_name`:

| | count |
|---|---|
| `FETCH 1000` | **101** (100 pages + the empty one that ends the cursor) |
| statements mentioning `control_change_events` | **1** — the `DECLARE` |
| statements mentioning `gl_journal_lines` | **2** — the `DECLARE` and the SQL-SUM totals cross-check |
| `INSERT` | 197 — 196 sealed-finding batches of 512, plus the result header |
| `SELECT` | 231 — 196 in-transaction re-read pages of 512, plus setup |
| **total** | **546** |

The plan's "≈101 statements for 100k rows" is the FETCH count only. The total scales with **findings** (two
statements per 512), not with rows; there is no per-row statement. A mutant that issues one child query per row
compiled into the real worker produced 100 546 statements, 100 001 of them on `control_change_events`, and the gate
failed with "change events were queried outside the cursor: expected 100001 to be 1".

## Scale — 100 000 journals through the real worker (final head)

Mixed fixture (plan §3 fixture (a)): 100 000 posted journals, ~650 000 lines, ~1 000 000 amendment events, 10 active
rules.

- Published once, `status: fail`, population 100 000, **26.0 s** end to end, child VmHWM **287 MiB** against a
  1 536 MiB heap (the 2 GiB class cap was not in force in this harness). The T2e figure of 673 MiB was measured
  before the findings-memory fix and is superseded.
- **Every journal was a finding: 100 000, exactly `maxFindings`.** This is a property of the fixture, not the
  detector: the seeder assigns day `g % 240` and person `g % 50`, which cycle together every 1 200 journals, so ~83
  journals share each (day, person) and split every threshold. So this run is the worst case for findings — it sat
  exactly on the bound and published — not a realistic mix.
- The T1 spike measured ~102–116 s for 100 000 journals at load 12–52. These runs took 26–33 s at load 7–14; the
  difference is not explained here beyond the load, and is not claimed as an improvement.

## Worst-case findings — 100 000 of the longest message, at the real heap (plan A39)

Every journal carries all six per-row signals and a split under each of 100 usable rules at bigint-wide versions:
100 000 findings of **8 663 characters** each (verified on the published page).

- **Before the fix** (worker built from `2b851aa7b`): the worker died by **SIGABRT** — V8 out of memory — after 79 s,
  with no reply and its lease held, so it would have been reclaimed and aborted again until RETRY_EXHAUSTED, never
  `unknown`. The phase retained every full finding, and a second decrypted copy during the re-read.
- **After** (final head): published in **77.6 s**, child VmHWM **280 MiB**. The phase keeps only
  `{key, itemHash, amount, currency}` per finding and verifies the re-read page by page.
- The slab figure of 15.2 KiB per held row (101 change facts) is a slab-only measure and still stands; the peak
  figures that bound a run are the two above.

## Hard kill — a real SIGKILL mid-stream, proven by outcome

At 100 000 journals the worker was killed with `SIGKILL` 8.5 s after spawn (final head; 8.8 s in T2e), at a moment the test observed its backend
FETCHing **and** holding the row lock of at least one sealed-finding INSERT. Then, by outcome:

- the dead backend ended; **zero** result rows and **zero** finding rows for the job;
- the job stayed `running`, attempts 1, generation 1, lease live — and a fresh worker **before expiry** returned
  `not_claimed`;
- the test then waited for the **real** lease expiry (349.7 s; no synthetic update), after which a fresh worker claimed
  generation 2 and published once: attempts 2, one result row, 100 000 findings all at generation 2;
- a further worker returned `not_claimed`.

A mutant that lets a claim take a live `running` lease failed the gate with "a live lease was reclaimed before
expiry". What no gate here can mutate is the single-COMMIT atomicity itself; it is proven by outcome (rows written in
the killed transaction, observed through its lock, and none surviving).

## Slab bound at production limits (plan A27)

One user, one day, 25 001 journals that can all join a threshold group: at cutoff 2026-06-30 (exactly 25 000) the
real worker published a normal result (0.85 s, 139 MiB); at 2026-07-31 (25 001) it published `unknown`,
`resource_limit:slab_rows_exceed_limit`, population recounted to 25 001, zero findings (0.75 s). The exact edges of
both bounds are also gated in the regular suite through the tighten-only limits parameter; `>` → `>=` on the slab bound
and `>=` → `>` on the findings bound both fail there.

**How the eligibility extraction was proven (P3-6).** Until the second review round, that the adapter holds exactly
the rows `analyseJournalRisks` could group rested on reading the diff: one function, shared by the detector and the
adapter over the same snapshot's thresholds. It is now gated. A slab under two usable rules, where 500 can join the
1 000 group but not the 200 one, and a slab under no usable rule at all, past a tightened bound: the mutant that asks
for eligibility under EVERY rule instead of ANY fails both ("a row eligible under one rule of two was not held").

## Storage — measured bytes per finding, per run and per day (plan A40)

`scripts/forensic/measure-check-run-storage.ts`: `pg_relation_size`, `pg_indexes_size` and `pg_total_relation_size`
deltas on `control_audit_check_findings` (heap, both indexes, TOAST) after `CHECKPOINT`, around one real worker run per
shape, nothing else writing. Per run and per day are derived at `maxFindings` (100 000) and at the enqueue caps.

| shape | message | bytes / finding | per 100 000-finding run | per day, company cap (100) | per day, member share (40) |
|---|---|---|---|---|---|
| typical (one signal) | 122 chars | **2 359** (heap 2 048, indexes 310) | 0.24 GB | **23.6 GB** | 9.4 GB |
| mixed (short splits) | 132 chars mean | 2 356 | 0.24 GB | 23.6 GB | 9.4 GB |
| worst (106 reasons) | 8 663 chars | **21 018** (TOAST 20 707, indexes 310) | 2.1 GB | **210 GB** | 84 GB |

At 26–78 s per 100 000-finding run, a company's whole daily budget is spendable in well under two hours of worker
time. **The cap is unchanged** (100 per company, 40 per member, per 24 h): whether to tighten it is Hein's decision with
these numbers in front of him, and until retention exists nothing else bounds growth.

## A34 — the largest population that publishes inside 300 s

Measured on the `2b851aa7b` worker, before the findings-memory fix. The quiet population produces few findings, so
the fix does not bear on these streaming times; the measurement now lives in
`scripts/forensic/measure-check-run-deadline.ts` and was not repeated.

A quiet population keeps the mixed fixture's per-row streaming cost (the same lines and amendments) but produces few
findings, so the findings bound cannot end a run first. Each attempt is a fresh job on the real worker; cutoffs select
the population. Full figures: `check-run-deadline.json`.

| run | database | population | elapsed | outcome |
|---|---|---|---|---|
| A | 1.4M-journal company, DB ≈19 GB | 303 367 | 40.2 s | published |
| A | same | 1 400 000 | 170.4 s | published |
| A | same | 1 400 000 | 195.1 s | published |
| B | 3.2M-journal company, DB ≈60 GB, **first run after a 23-minute bulk load** | 1 400 045 | 300.4 s | **failed, RESOURCE_LIMIT** |
| C | same 3.2M company, re-measured afterwards | 706 701 | 116.9 s | published |
| C | same | 1 546 708 | 195.8 s | published |
| C | same | 2 093 361 | 256.6 s | published |

**The largest population that publishes is not one number on this machine.** With settled tables, 2 093 361 journals
published in 256.6 s, and none larger was measured (throughput there extrapolates to about 2.4M, which is an
extrapolation, not a measurement). The same 1.4M that published in 170–195 s in run A **overran** in run B. Run B was
the first run after a bulk load, and PostgreSQL's own statistics put autovacuum's last passes over all four streamed
tables (16:45:54–16:52:29 container time) inside or just after it (16:45:21–16:50:21). Every later run in that
database published. That is consistent with post-load maintenance slowing the first scan; it is not proven to be the
mechanism. The operational reading: a population near 1.4M can fail on a freshly loaded or restored database, and
about 2.1M is the most measured to fit on a settled one. Load averages are recorded per attempt (6–34 across runs).

**Run B is also the real evidence for the grace window (plan §4 G2).** The overrun ended exactly as the contract says:
`{state:'failed', code:'RESOURCE_LIMIT', failureRecorded:true}`, no result row, the job `failed` with attempts 1 — and
on the database clock the work lasted 300.2 s (the deadline) and the failure record landed **29.8 s before the
lease's own expiry**, inside the 30 s grace. That is what the grace window carries. It does not change the G2
wording: a success after the deadline remains unreachable, so the success-inside-grace gate stays an emulation.

## Residuals, stated

- **Merged code (`26be1aeed`): no 100k run publishes.** Integration's `lower(entity_id)` predicates cannot use their
  expression indexes under FORCE RLS, so each journal scans every change event of its company (first section).

- A company whose `default_currency` costs more than 1 024 bytes as the seal encodes it gets `unknown`
  (`resource_limit:currency_exceeds_limit`) from every run, published before streaming, where sync would accept it.
  The bound is in bytes because the table's 64 KiB CHECK is (plan A43, A48).
- No systemd unit: the runtime and memory walls, and the unit readback, remain unproven for check runs.
- A single (day, person, currency) with more than 25 000 journals that can join a threshold group still makes that
  run `unknown`, and so does every later run whose cutoff includes that day.
- Check-run storage now grows without bound until retention exists (plan A28).
- The success UPDATE's lease predicate cannot be isolated by any gate (plan A26).
