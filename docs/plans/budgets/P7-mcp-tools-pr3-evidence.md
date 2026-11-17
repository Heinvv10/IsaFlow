# MCP budget tools, PR 3 of 3: evidence

Branch `feat/mcp-budget-tools-drivers-20261117`, stacked on PR 1 (`feat/mcp-budget-tools-core-20261116`, #1513). No
migration. The tools and the service changes are described in `src/lib/mcp/.claude.md` ("Budget tools, PR 3") and
`src/modules/accounting/services/budgets/.claude.md` ("MCP budget tools, PR 3").

## Tools

| Tool | Kind | Service (the app route that calls it) | Who |
|---|---|---|---|
| `get_budget_drivers` | read | `listDrivers`, `listHires`, `readHeadcount`, the grid's override cells (`budget-drivers/**` GETs) | any member with read:reports; per-head rate and headcount counts for owner/admin/manager only (#979) |
| `get_three_way` | read | `getThreeWay` (GET `budget-three-way`) | read:reports; the company's `budgets_three_way` flag |
| `derive_three_way` | read | `deriveView` (POST `budget-three-way/derive`, which never saves) | owner/admin/manager (handler, as the route's withWriteAccess); the flag |
| `budget_remaining` | read | `remainingFor` (POST `budgets/remaining`) | owner/admin/manager (handler, as the route) |
| `budget_tracking` | read | `listBudgetAlerts` (GET `budgets/alerts`) | owner/admin (`requiresRole: 'admin'`, as the route) |
| `set_budget_drivers` | write | `saveDriver`, `deleteDriver`, `resetOverride`, `refreshHeadcount`, `createHire`, `updateHire`, `deleteHire` (`budget-drivers/**`) | write fence |
| `set_three_way_assumptions` | write | `saveAssumptions` (PUT `budget-three-way/assumptions`) | write fence; the flag |
| `submit_budget_for_review` | write | `transitionSlice(…, 'submit')` (POST `budgets/slices/[id]/submit`) | write fence; the slice's holder (service) |

## Red first

Each unit file was written and run before its implementation existed:

- `tests/unit/services/budgets/budgetSnapshotRestoreDrivers.test.ts`: `Tests  3 failed | 1 passed (4)` (no
  `DRIVER_WRITE_TOOL` export; both refusals answered `ok: true`).
- `tests/unit/mcp/budgetDriverTools.test.ts`: `Cannot find package '@/lib/mcp/tools/budgetDriverWrite'` (Test Files 1 failed).
- `tests/unit/mcp/budgetThreeWayTools.test.ts`: `Cannot find package '@/lib/mcp/tools/budgetThreeWayTools'`.
- `tests/unit/mcp/budgetControlTools.test.ts`: `Cannot find package '@/lib/mcp/tools/budgetControlTools'`.

A missing module is a weak red; the mutation table below is the evidence that each test fails on its guard.

## Mutation table

Each guard was mutated in the production code after the code and tests were committed (ecf03d6c0f, 980ef7bd0d), the tests named
ran, and the file was restored with `git checkout --` of its committed state (tree verified clean after each: `git status
--porcelain --untracked-files=no` empty). unit = `vitest run <file>`; int = the integration files on a throwaway PostgreSQL 16
cluster built as `scripts/ci/integration/run.sh` builds its template, suites as `app_user` through the real registry. Counts are
the runs' own `Tests` lines (2026-11-17, box load 40-65).

| # | Guard | Mutant | Tests run | Result |
|---|---|---|---|---|
| P1 | restore refuses a set_budget_drivers snapshot | the `DRIVER_WRITE_TOOL` check disabled | unit budgetSnapshotRestoreDrivers; int mcp-budget-controls | unit 1 failed | 3 passed (4); int 1 failed | 4 passed (5) |
| P2 | restore refuses an amount write once drivers changed after it | `driverChangesSince(...) > 0` → `> 999` | unit budgetSnapshotRestoreDrivers; int mcp-budget-drivers + controls | unit 1 failed | 3 passed (4); int 2 failed | 17 passed (19) |
| P3 | a driver write in the amount write's own transaction counts | `created_at >= since` → `>` | int mcp-budget-drivers + controls | int 1 failed | 18 passed (19) |
| P4 | set_budget_drivers live needs plan_hash | the "plan_hash is required" check disabled | unit budgetDriverTools; int mcp-budget-drivers | unit 1 failed | 25 passed (26); int 1 failed | 13 passed (14) |
| P5 | plan_hash binds the stored lines, hires and cells | the hash over the changes only | unit budgetDriverTools; int mcp-budget-drivers | unit 1 failed | 25 passed (26); int 14 passed (14) |
| P5b | (the same, re-run after the same-transaction test, fd03849704) | as P5 | unit budgetDriverTools; int mcp-budget-drivers | unit 1 failed | 25 passed (26); int 1 failed | 14 passed (15) |
| P6 | a stale version_token is refused | the version_token comparison removed | unit budgetDriverTools; int mcp-budget-drivers | unit 1 failed | 25 passed (26); int 1 failed | 13 passed (14) |
| P7 | the dry run runs the real services (rolled back) | dry run skips `applyDriverChanges` | unit budgetDriverTools; int mcp-budget-drivers | unit 4 failed | 22 passed (26); int 4 failed | 10 passed (14) |
| P8 | more than MAX_SAVE_CELLS changed cells refused, never chunked | the dry run's cap removed | unit budgetDriverTools | unit 1 failed | 25 passed (26) |
| P9 | a live driver write records its snapshot | no snapshot recorded | unit budgetDriverTools; int mcp-budget-drivers + controls | unit 1 failed | 25 passed (26); int 2 failed | 17 passed (19) |
| P10 | all or nothing: a refused change refuses the live call | the live refusal check disabled | unit budgetDriverTools; int mcp-budget-drivers | unit 1 failed | 25 passed (26); int 5 failed | 9 passed (14) |
| P11 | role fence / write flag | `set_budget_drivers` declared `write: false` | unit writeToolRoleFence; int mcp-budget-drivers | unit 3 failed | 236 passed (239); int 2 failed | 12 passed (14) |
| P12 | derive_three_way for write roles only | the handler role check removed | unit budgetThreeWayTools; int mcp-budget-three-way | unit 1 failed | 13 passed (14); int 1 failed | 4 passed (5) |
| P13 | budget_remaining for write roles only | the handler role check removed | unit budgetControlTools | unit 1 failed | 13 passed (14) |
| P14 | budget_tracking owner/admin only | `requiresRole: 'admin'` removed | unit budgetControlTools + writeToolRoleFence; int mcp-budget-controls | unit 3 failed | 252 passed (255); int 1 failed | 4 passed (5) |
| P15 | the budgets_three_way flag gates the three-way tools | `gate` always passes | unit budgetThreeWayTools; int mcp-budget-three-way | unit 3 failed | 11 passed (14); int 1 failed | 4 passed (5) |
| P16 | three-way money is decimal text (a number refused) | numbers in money fields passed through | unit budgetThreeWayTools; int mcp-budget-three-way | unit 1 failed | 13 passed (14); int 1 failed | 4 passed (5) |
| P17 | per-head detail for budget writers only (#979) | `perHeadAccessOf(role)` → `'full'` | unit budgetDriverTools; int mcp-budget-drivers | unit 1 failed | 25 passed (26); int 1 failed | 13 passed (14) |
| P18 | submit by version picks only the caller's own slices | the holder filter removed | unit budgetControlTools | unit 1 failed | 13 passed (14) |
| P19 | get_budget_drivers page fits 90 KB | `DRIVERS_LIMIT_MAX` 75 → 300 | unit readLimitsSizeBudgetsPr3 | unit 2 failed | 7 passed (9) |
| P20 | get_three_way lists cut so the reply fits 90 KB | `THREE_WAY_LIST_CAP` 50 → 2000 | unit readLimitsSizeBudgetsPr3 | unit 1 failed | 8 passed (9) |
| P21 | assumptions_token is required | the presence check disabled | unit budgetThreeWayTools | unit 1 failed | 13 passed (14) |

P5 first stayed **green in integration** (14 passed / 14): across requests the version token moves and is in the hash, so the
token alone refused the stale plan. Added "inside one transaction the plan_hash still binds the cells" (a batch: a save, the dry run, a
second save, the apply; the token stays still), commit fd03849704; re-run P5b is red. Same lesson as PR 1's N3.

## Mutation table, review round 1 (head 37637d7e9a, after the master merge ffdde0d831)

Every guard of the first table re-run at the new head, plus one per round-1 fix. Same procedure (committed first, restored with
`git checkout --`, tree clean after each); a fresh cluster built at the new head. Counts from the runs' own `Tests` lines.

| # | Mutant | unit | int |
|---|---|---|---|
| P1 | restore refuses a set_budget_drivers snapshot | 1 failed | 4 passed (5) | 1 failed | 4 passed (5) |
| P2 | restore refuses once drivers changed (>0 → >999) | 2 failed | 3 passed (5) | 2 failed | 21 passed (23) |
| P3 | created_at >= → > | – | 1 failed | 22 passed (23) |
| P4 | plan_hash required (required: false) | 1 failed | 31 passed (32) | 1 failed | 17 passed (18) |
| P5 | hash binds status, slices, lines, hires, cells (→ changes only) | 2 failed | 30 passed (32) | 1 failed | 17 passed (18) |
| P6 | stale version_token check removed | 1 failed | 31 passed (32) | 1 failed | 17 passed (18) |
| P7 | dry run skips the services | 4 failed | 28 passed (32) | 5 failed | 13 passed (18) |
| P8 | dry-run MAX_SAVE_CELLS cap removed | 1 failed | 31 passed (32) | – |
| P9 | no snapshot recorded | 1 failed | 31 passed (32) | 2 failed | 21 passed (23) |
| P10 | live all-or-nothing check disabled | 1 failed | 31 passed (32) | 5 failed | 13 passed (18) |
| P11 | set_budget_drivers write: false | 3 failed | 236 passed (239) | 2 failed | 16 passed (18) |
| P12 | derive role check removed | 1 failed | 17 passed (18) | 1 failed | 4 passed (5) |
| P13 | remaining role check removed | 1 failed | 19 passed (20) | – |
| P14 | budget_tracking requiresRole removed | 4 failed | 257 passed (261) | 1 failed | 4 passed (5) |
| P15 | three-way flag gate always passes | 3 failed | 15 passed (18) | 1 failed | 4 passed (5) |
| P16 | a number accepted in a money field | 1 failed | 17 passed (18) | 1 failed | 4 passed (5) |
| P17 | per-head access always 'full' | 1 failed | 31 passed (32) | 1 failed | 17 passed (18) |
| P18 | submit holder filter removed | 1 failed | 19 passed (20) | – |
| P19 | DRIVERS_LIMIT_MAX 75 → 300 | 2 failed | 7 passed (9) | – |
| P20 | THREE_WAY_LIST_CAP 50 → 2000 | 1 failed | 8 passed (9) | – |
| P21 | assumptions_token presence check disabled | 1 failed | 17 passed (18) | – |
| N1 | F1: a line's bu dropped (buId: null) | 1 failed | 19 passed (20) | 5 passed (5) |
| N1b | F1: the same, after the bu-level equivalence line (37637d7e9a) | 1 failed | 19 passed (20) | 1 failed | 4 passed (5) |
| N2 | F3: version status out of the hash | 1 failed | 31 passed (32) | 1 failed | 17 passed (18) |
| N3 | F3: slice reviews out of the hash | 1 failed | 31 passed (32) | – |
| N4 | F4: <list>_total dropped | 1 failed | 17 passed (18) | – |
| N5a | M1: every refusal answered (position check → true) | – | 1 failed | 17 passed (18) |
| N5b | M1: the first-change answer branch never taken (→ false) | 1 failed | 31 passed (32) | – |
| N6 | M2: live MAX_SAVE_CELLS throw removed | 1 failed | 31 passed (32) | – |
| N7a | M3: an unclassified number passed through | 1 failed | 2 passed (3) | – |
| N7b | M3: closingCash out of MONEY_KEYS | 2 failed | 19 passed (21) | 1 failed | 4 passed (5) |
| N8a | L3: driver bucket charged 1 per call, not per change | 1 failed | 31 passed (32) | – |
| N8b | L3: remaining bucket removed | 1 failed | 19 passed (20) | – |
| N9 | L1: TrackingError catch removed | 1 failed | 19 passed (20) | – |

N1 first stayed green in integration (5 passed / 5): at a cc1-level account `remainingFor` drops a line's bu anyway. Added a
bu-level account line (cc1 + bu, keeps the bu), commit 37637d7e9a; N1b is red. pct past 4 decimals and FTE past 2 are refused by the
services (engine `scaledPct`, `checkedHire`), never rounded: pinned in `mcp-budget-drivers` ("a percent past 4 decimals…").

Red first for round 1: the new and changed unit tests before the fixes: `Tests  19 failed | 61 passed (80)`.

Runs at the final head: unit `tests/unit` `Test Files  2575 passed | 47 skipped (2622)`, `Tests  37560 passed | 289 skipped (37849)`;
integration (every mcp-budget-*, budget-grid-*, budget-drivers-*, budgets-three-way-*, budget-tracking-* file, 67 files)
`Test Files  67 passed (67)`, `Tests  559 passed | 1 skipped (560)`; tsc exit 0; eslint on src/lib/mcp and services/budgets 0 errors
(2 warnings, both in tools/reports.ts, not this branch); `agent-docs:check` OK (114 mirrors).

## Mutation table, review round 2 (head 702b9cf494)

Red first: `Tests  14 failed | 59 passed (73)` (the paging cases against both tools, the argument order, a numeric code).

| # | Mutant | unit | int |
|---|---|---|---|
| Q1 | M-1: listPage without the floor of 1 | 6 failed / 51 | – |
| Q2 | M-1: a non-integer list_limit floored instead of defaulted | 7 failed / 51 | – |
| Q3 | L-2: bucket and grid read before the version_token / plan_hash checks | 2 failed / 32 | – |
| Q4 | L-3: a numeric code read as '' | 1 failed / 21 | – |
| Q5 | L-1: loadChartRefs without its gl_accounts company predicate | – | **6 passed / 6** |
| Q5b | the same, after the RLS-bypassed case (702b9cf494) | – | 1 failed / 6 |
| Q6 | L-1: loadChartRefs without its cost_centres company predicate | – | **6 passed / 6** |
| Q6b | the same, after 702b9cf494 | – | 1 failed / 6 |

Q5 and Q6 first stayed green: as app_user the tenant policy refused the other company's rows on its own (PR 1's M4b
lesson). The case added in 702b9cf494 runs `loadChartRefs` on the superuser connection, so only the service's own
predicate keeps them out.

Runs at 702b9cf494: unit `tests/unit` `Test Files  2576 passed | 47 skipped (2623)`, `Tests  37581 passed | 289 skipped (37870)`;
`tests/unit/security/rateLimitKeyCensus.test.ts` `Tests  10 passed (10)`; integration (67 files, same set)
`Test Files  67 passed (67)`, `Tests  560 passed | 1 skipped (561)`; tsc exit 0; eslint 0 errors (the 2 warnings in
tools/reports.ts); `agent-docs:check` OK (114).

## Mutation table, review round 3 (head ec9a993d0f, after the master merge c52d603064)

Red first: `Tests  19 failed | 33 passed (52)` (`budgetNumericCodes.test.ts` before `refText`). The call-order test (the bucket
before the grid read) passed at once: it pins round 2's L-2 fix; S8 shows it catches its regression.

| # | Mutant | unit |
|---|---|---|
| S1 | `refText` truncates a fraction instead of refusing it | 9 failed / 19 |
| S2 | `refText` ignores numbers (the old string-only rule) | 14 failed / 19 |
| S3 | resolveRows (set_budget_amounts / annual / note) reads accounts string-only | 4 failed / 19 |
| S4 | seed_budget drops the refusal of a fractional code | 1 failed / 19 |
| S5 | get_budget drops the refusal of a fractional account | 1 failed / 19 |
| S6 | set_budget_drivers' cost centre drops the refusal | 1 failed / 19 |
| S7 | budget_remaining treats a fractional account as missing | 1 failed / 19 |
| S8 | set_budget_drivers reads the grid before charging its bucket | 1 failed / 33 |

Runs at ec9a993d0f: unit `tests/unit` `Test Files  2580 passed | 47 skipped (2627)`, `Tests  37622 passed | 289 skipped (37911)`;
integration (every mcp-budget-*, budget-grid-*, budget-drivers-*, budgets-three-way-*, budget-tracking-* and budgets-p5-remaining
file, 68 files) `Test Files  68 passed (68)`, `Tests  568 passed | 1 skipped (569)`; tsc exit 0; eslint 0 errors (2 warnings,
tools/reports.ts); `agent-docs:check` OK (114).

## Equivalence

- `mcp-budget-drivers-equivalence` (1): one twin version through the app's routes as the owner (PUT a pct_of_line driver,
  POST a planned hire, a grid save over a driver cell, POST override reset, PUT a fixed driver, DELETE it) and one
  through `set_budget_drivers` (dry run + apply each time) with `set_budget_amounts` for the typed cell. Equal: every
  `budget_month_amounts` row with its source and `created_by`, every driver line (all columns, `created_by` /
  `updated_by`), every planned hire, the version's state, and the six audit rows. (2) A holder's slice submit through
  POST `slices/[id]/submit` and `submit_budget_for_review` by version: equal slice review row, audit row and the
  owner's notification.
- `mcp-budget-three-way` (equivalence half): PUT assumptions vs `set_three_way_assumptions` (dry run, insert; then an
  update with the token): equal stored document, author and audit rows; the version token untouched on both. POST
  derive and GET `budget-three-way` vs `derive_three_way` and `get_three_way`: the same figures (the tools' only
  difference: decimal text for cents; round 1 compares with an independent conversion in the test, not the tool's converter,
  plus one figure pinned by hand: R1 000.00 = 100 000 cents).
- `mcp-budget-controls` (read half): `budget_remaining` vs POST `budgets/remaining` (budget, actual, committed,
  remaining, off-slice, unassigned, grain per line; round 1: a cc1 + bu line at a cc1 and at a bu account, and a
  balance-sheet account, answered as the route answers them) and `budget_tracking` vs GET `budgets/alerts` (a manager refused by both).

Ignored, and why: ids and timestamps (new rows); the version name (two versions of one year cannot share one); a
planned hire's and a slice's id in audit metadata (new rows) and `headcountAsOf` (a clock); the order of audit rows (one
`set_budget_drivers` call with two changes writes both in one transaction, same `created_at`), so they compare as a
sorted set. MCP-only rows by design: `mcp_tool_calls`, `budget_write_snapshots`.

## Decisions taken inside the brief (for confirmation)

1. **`rehome_budget_year` is not built (decision point).** `budgetYearRehome` has no UI of its own: its only callers are the
   change of financial year end and its undo (`gl/financialYearEndChange{Service,Apply,Undo}.ts`), where it runs inside the
   registry change (with CIPC/SARS confirmations); its refusals take the change's boundary and year. Standalone it would only move
   "stray" primary months, a behaviour the app never offers, so there is no route to be equivalent to. Recommendation: drop it, or
   decide whether an agent may change the financial year end at all (a GL-wide, human-gated action, not a budget tool).
2. **The slice actions are `submit` only.** `sliceReviewState` has three moves: submit (a holder), approve and return (owner/admin,
   the reviewer). "Mark reviewed" does not exist. `submit_budget_for_review` is the one non-approver move.
3. **`derive_three_way` is a read.** The app's derive computes and never saves; the tool proposes, and its description (and
   `set_three_way_assumptions`'s) says the assumptions must be saved before the forecast uses them. Its write-role check (the
   route's withWriteAccess) is in the handler, as is `budget_remaining`'s: the registry's `requiresWriteRole` words its refusal as
   "per-employee payroll data".
4. **`budget_tracking` is the overspend alerts list** (the controls page; owner/admin as its route). Budget vs Actual tracking is
   already `budget_variance` (PR 0), on the same tracking engine.
5. **`set_budget_drivers` always needs its plan_hash**, even for one change: one change can recompute many cells.
6. **`set_three_way_assumptions` has no plan_hash**: it saves one document behind the row's own token (`assumptions_token`,
   required, null with none stored), which binds the live call to what the dry run read.
7. **Restore and drivers, without a migration.** Restore cannot undo driver-line edits exactly (line ids, a deleted driver's
   overrides already re-sourced, per_head headcount read from payroll at the time), so it refuses: a `set_budget_drivers` snapshot
   is a record only, and an amount write is refused once `driverChangesSince` finds a driver audit row (`driverAction`) at or after
   its transaction time. Over-refusal: a driver change made BEFORE the amount write in the same batch also refuses it (one
   transaction's rows share `created_at`). Exact ordering would need a stored drivers fingerprint on `budget_write_snapshots` (a
   migration); not taken.
8. **Driver amounts are decimal strings; `pct` and `fte` are numbers** (not money; the services bound them). Three-way money is
   decimal text both ways: the document's five money fields (a number refused), and every integer of a run answer except day and
   month counts.
9. **No service logic moved.** The driver, three-way, remaining, alerts and slice routes hold only shape checks (zod) and their gates;
   the tools call the same services with the same inputs, which the equivalence suites prove.

Confirmed by the coordinator in review round 1: 1 (rehome dropped), 2-9.

## Integration runs

On one throwaway cluster (baseline + this branch's migrations as non-superuser `postgres`), 2026-11-17, through
`int-run-drivers.sh isaflow_schema_fixture <87 files>`: every `mcp-budget-*` (PR 1's six and PR 3's four), every
`budget-grid-*`, `budget-drivers-*`, `budget-headcount-reader`, `budget-reforecast-actuals`, `budget-rolling-forecast*`,
`budget-tracking-*`, `budgets-three-way-*`, and `budgets-p5-{remaining,holders-*,holder-scope,slice-race,driver-slices,r3-*,r4-frozen,unassign,alerts*}`:

    Test Files  87 passed (87)
         Tests  679 passed | 1 skipped (680)

PR 3's own suites: `mcp-budget-drivers` 15, `mcp-budget-drivers-equivalence` 2, `mcp-budget-three-way` 5, `mcp-budget-controls` 5.
Unit: `tests/unit/mcp/ tests/unit/services/budgets/ tests/unit/guards/ tests/unit/auth/` 384 files, 4942 passed, 88 skipped;
the whole `tests/unit` 2552 files, 37218 passed, 289 skipped (run on ecf03d6c0f).
