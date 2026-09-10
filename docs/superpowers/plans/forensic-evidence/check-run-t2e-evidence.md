# Check runs: scale, hard-kill and deadline evidence (T2e), with the corrections from the T2c+T2d review

Plan: `docs/superpowers/plans/2026-09-10-forensic-check-runs.md` v8 (A26–A34). Raw measurements beside this file:
`check-run-journals-100k.json` (scale, hard-kill, slab bound) and `check-run-deadline.json` (A34).

## How these were run, and what that leaves out

- **Database.** A disposable container `isaflow-t2e-scale-pg-20260910` (pgvector/pgvector:pg16, PostgreSQL 16.11,
  `shared_buffers=1GB`, `max_wal_size=8GB`, `log_statement=all`, `log_line_prefix='%m|%a|%p|'`, bind parameters not
  logged), schema cloned read-only from the shared forensic fixture with `pg_dump -s`. Never the shared fixture, never
  production. Seeding used `session_replication_role=replica` on its own connection only.
- **Worker.** The real worker executable (`scripts/forensic/build-audit-job.ts` output, SHA-256 `82a7ab23…d572`,
  built from `0201f87b1`), run as a **direct child process** with the class heap (`--max-old-space-size=1536`), the
  literal class and spawn-time variables and the production environment allow-list.
- **Not done, because systemd units were ruled out for this session:** the plan's "under
  `createIsolatedAuditJobRunner`" and "under the real check-run unit with `RuntimeMaxUSec` read back". No
  `RuntimeMaxSec` or `MemoryMax` wall was in force, and no unit readback was performed. Memory figures below are the
  child's own VmHWM, not a cgroup peak. This caveat from the T1 spike therefore remains open.
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

## Scale — 100 000 journals through the real worker

Mixed fixture (plan §3 fixture (a)): 100 000 posted journals, 649 440 lines, 999 873 amendment events, 90 238 entity
versions, 10 active rules, seeded in 30 s.

- Published once, `status: fail`, population 100 000, **33.1 s** end to end (≈3 000 journals/s), child VmHWM
  **673 MiB** against a 1 536 MiB heap (the 2 GiB class cap was not in force in this harness).
- **Every journal was a finding: 100 000, exactly `maxFindings`.** This is a property of the fixture, not the
  detector: the seeder assigns day `g % 240` and person `g % 50`, which cycle together every 1 200 journals, so ~83
  journals share each (day, person) and split every threshold. So this run is the worst case for findings — it sat
  exactly on the bound and published — not a realistic mix.
- The T1 spike measured ~102–116 s for 100 000 journals at load 12–52. This run was 3.5× faster at load 7–14; the
  difference is not explained here beyond the load, and is not claimed as an improvement.

## Hard kill — a real SIGKILL mid-stream, proven by outcome

At 100 000 journals the worker was killed with `SIGKILL` 8.8 s after spawn, at a moment the test observed its backend
FETCHing **and** holding the row lock of at least one sealed-finding INSERT. Then, by outcome:

- the dead backend ended; **zero** result rows and **zero** finding rows for the job;
- the job stayed `running`, attempts 1, generation 1, lease live — and a fresh worker **before expiry** returned
  `not_claimed`;
- the test then waited for the **real** lease expiry (357 s; no synthetic update), after which a fresh worker claimed
  generation 2 and published once: attempts 2, one result row, 100 000 findings all at generation 2;
- a further worker returned `not_claimed`.

A mutant that lets a claim take a live `running` lease failed the gate with "a live lease was reclaimed before
expiry". What no gate here can mutate is the single-COMMIT atomicity itself; it is proven by outcome (rows written in
the killed transaction, observed through its lock, and none surviving).

## Slab bound at production limits (plan A27)

One user, one day, 25 001 journals that can all join a threshold group: at cutoff 2026-06-30 (exactly 25 000) the
real worker published a normal result (0.9 s, 139 MiB); at 2026-07-31 (25 001) it published `unknown`,
`resource_limit:slab_rows_exceed_limit`, population recounted to 25 001, zero findings (0.8 s, 122 MiB). The exact
edges of both bounds are also gated in the regular suite through the tighten-only limits parameter; `>` → `>=` on the
slab bound and `>=` → `>` on the findings bound both fail there.

## A34 — the largest population that publishes inside 300 s

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

- No systemd unit: the runtime and memory walls, and the unit readback, remain unproven for check runs.
- A single (day, person, currency) with more than 25 000 journals that can join a threshold group still makes that
  run `unknown`, and so does every later run whose cutoff includes that day.
- Check-run storage now grows without bound until retention exists (plan A28).
- The success UPDATE's lease predicate cannot be isolated by any gate (plan A26).
