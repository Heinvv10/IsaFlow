# P4 — Drivers & forecasting: phase spec

**Date:** 2026-10-26 · **Status:** Draft, refresh before execution · **Parent:** `docs/plans/2026-10-26-budgets-next-level.md` §5 P4 · **Contract:** `docs/plans/budgets/00-shared-contract.md` (obeyed exactly; canonical names below are P1's)

> **Refresh before execution.** Written before P1–P3 exist. Before the P4 session starts, re-read the
> merged P1–P3 code and MVP usage on ISAFlow Demo (which rows people actually budget, at which grain,
> whether "New reforecast" is used at all) and cut or reshape this spec to match. Peer names below are the
> ones the P1–P3 specs define (contract ownership table); confirm them against the merged code.
>
> **Peer names used here.** P1: `budget_versions`, `budget_month_amounts.version_id/cc1_id/cc2_id/bu_id`,
> lock trigger function `public.budget_month_amounts_refuse_locked()` (SQLSTATE `BV001`), `budgets/budgetVersionScope.ts`
> `lockVersionForWrite`, `budgets/budgetVersionTypes.ts` `BudgetVersionError` / `mapBudgetDbError`, `budgets/budgetVersions.ts`
> `createVersion`, routes `pages/api/accounting/budget-versions/**`. P2: `budgets/gridSave.ts` `saveCells`, the band model
> `budgets/grid/subtotals.ts` (`BAND_ORDER`, `foldBands`), `budgets/grid/spread.ts` / `cents.ts` (`roundToUnit`), UI
> `src/components/accounting/budgets/workspace/` (`BudgetWorkspace.tsx`, `VersionsBar.tsx`, `useBudgetGrid.ts`). P3: the one
> actuals SQL `budgets/tracking/trackingActualRead.ts`. Precondition checks: contract "Preconditions".

**Strongest argument against P4:** driver modelling is exactly where Fathom/Spotlight are strong, and the
plan's own thesis is "don't compete on modelling depth before the in-ledger advantages ship". P4 is
justified only by the two things a ledger can do that they cannot: headcount read straight from payroll,
and a reforecast that rolls itself the moment a period closes. If MVP usage shows nobody edits more than a
handful of rows, ship only R-per-head + reforecast and drop the other driver kinds.

## 1. Scope

1. **Driver lines** — a budget row (one account at one grain within one version, decision 4) may carry
   ONE driver that computes its monthly amounts:
   - `fixed` — R x per month.
   - `pct_of_line` — p% of another row (account + grain) in the same version. COGS = 38% of Sales.
   - `pct_of_section` — p% of a statement-section subtotal (Turnover, Cost of sales, Other income,
     Operating expenses — P2's `grid/subtotals.ts` `BAND_ORDER`), same grain or company roll-up.
   - `growth` — base month value × (1 + g)^(months since base), compounding m/m.
   - `per_head` — R x per head × headcount(month, scope); headcount = payroll actives + planned hires.
   Each driver applies over a month range `[from_month, to_month]` inside the version's fiscal year;
   months outside the range stay manual.
2. **Manual override per cell** — typing over a driver cell keeps the typed value and marks it
   `override`; recompute never touches it; "Reset to driver" removes the override.
3. **Reforecast from actuals** — new version (`kind='reforecast'`, `based_on_version_id` = source):
   closed months = actuals at each row's grain, open months = source amounts, driver rows copied and
   recomputed (so a growth or %-of driver in an open month feeds off closed-month actuals).
4. **Rolling forecast (optional, per reforecast version)** — after a period close, the version re-rolls:
   newly closed months become actuals, drivers recompute. Idempotent; never blocks the close.
5. **UI** on P2's grid: driver editor per row, formula chip, override indicator, actual-month marker,
   headcount / planned-hires panel, reforecast + rolling controls in the versions bar.

**Not building:** salary escalation dates, pro-rata heads, payroll-pushed recompute (payroll stays
read-only — headcount refreshes on demand), MCP driver tools, a cron job (see §6), balance-sheet drivers (P6).

## 2. Phase-start decision 7 (pre-filled default — confirm in the goal's §0)

Headcount driver = active payroll employees per month + planned hires entered in the budget tool;
read-only on payroll. Concretely (default):
- An employee is **1 head in month M** when `start_date <= last day of M` AND (`end_date IS NULL` OR
  `end_date >= first day of M`) AND `status <> 'inactive'` (an `inactive` row has no date to place it).
  Any day employed in M counts a full head; no pro-rata.
- **Cost-centre scope**: when `payroll_employee_cost_allocations` rows exist for the employee, the head
  splits by `percentage/100` across those centres; else it counts 1 in `payroll_employees.cost_centre_id`;
  NULL centre counts only in the company scope.
- **Planned hires**: label (role, never a person), optional cost centre, `start_month`, optional
  `end_month`, FTE (default 1.00). Stored per version.
- Payroll is **never written**. The reader selects only `id, start_date, end_date, status,
  cost_centre_id` and the allocation split — no names, ID/tax numbers or pay.

## 3. Schema sketch (ONE migration — Confirmation Gate: Hein's explicit OK before merge)

Prefix: next free 3-digit prefix at commit time (contract "Migration prefixes"; re-check
`git ls-tree --name-only origin/master scripts/migrations/sql/` and open PRs' files immediately before committing). All
`CREATE ... IF NOT EXISTS`; every table gets the 944 tenant policy verbatim (`FORCE ROW LEVEL SECURITY`,
`company_id = app.current_company_id() AND company_id IN (SELECT auth.user_companies())`, grants to
`app_user`), an `updated_at` trigger, and a same-company trigger for every FK it carries (944's pattern).

- **`budget_month_amounts`** *(P1 table)* += `amount_source text NOT NULL DEFAULT 'manual' CHECK
  (amount_source IN ('manual','driver','override','actual'))`. If P1/P2 already added a source column,
  reuse it and extend its CHECK instead. Existing rows = `manual` (no data rewrite).
- **`budget_driver_lines`** NEW: `id uuid pk`, `company_id`, `version_id` (FK `budget_versions` ON DELETE
  CASCADE), `gl_account_id`, `cc1_id`, `cc2_id`, `bu_id` (the row's grain), `kind text CHECK IN
  ('fixed','pct_of_line','pct_of_section','growth','per_head')`, `from_month date`, `to_month date`
  (day 1, `from <= to`), `amount numeric(15,2)` (fixed; R per head), `pct numeric(9,4)` (pct/growth),
  `ref_gl_account_id`, `ref_cc1_id`, `ref_cc2_id`, `ref_bu_id` (pct_of_line target), `ref_section text`
  (pct_of_section), `ref_scope text CHECK IN ('same_grain','company')`, `base_month date` (growth),
  `headcount_cost_centre_id uuid null` (per_head; NULL = company), `created_by/at`, `updated_by/at`.
  A per-kind CHECK requires exactly the columns that kind uses. Unique `(company_id, version_id,
  gl_account_id, cc1_id, cc2_id, bu_id) NULLS NOT DISTINCT` (prod is PG 15.8, P1 spec §2). Company
  consistency by composite FKs to `budget_versions (company_id, id)`, `cost_centres (company_id, id)` and
  `business_units (company_id, id)`, as P1 does. A trigger refuses a driver whose grain differs from the grain the version already uses for
  that account (decision 4 holds for drivers too).
- **`budget_planned_hires`** NEW: `id`, `company_id`, `version_id` (FK, CASCADE), `label text NOT NULL`,
  `cost_centre_id uuid null` (→ `cost_centres`), `start_month date`, `end_month date null`,
  `fte numeric(6,2) NOT NULL DEFAULT 1 CHECK (fte > 0)`, `created_by/at`, `updated_at`.
- **`budget_rolling_forecasts`** NEW: `company_id`, `fiscal_year integer`, `version_id` (FK, unique),
  `rolled_through_month date null`, `last_rolled_at timestamptz`, `last_error text null`; unique
  `(company_id, fiscal_year)` — one rolling version per company-year. Row present = auto-roll on.
- **Lock**: P1's `public.budget_month_amounts_refuse_locked()` reads only `NEW/OLD.version_id` and `company_id`,
  so attach it (`ENABLE ALWAYS`) to the three new tables; if its body turns out to be table-specific, add a sibling
  with the same behaviour. Tested as `app_user`.
- Changed or new `SECURITY DEFINER` functions need an `app_definer_reviews` row (mig 930 registry).

## 4. Driver engine — pure TypeScript

Home: `src/modules/accounting/services/budgets/drivers/` NEW (inside P1's `budgets/` module).
No `sql`, no I/O — everything is passed in; unit-tested with Vitest in `tests/unit/services/budgets/` NEW.

| File (all NEW) | Responsibility |
|---|---|
| `driverTypes.ts` | `RowKey` (account + cc1/cc2/bu), `DriverDef` union per kind, `Cell {month, amount, source}`, typed errors `DriverCycleError(path)`, `DriverRefError`. |
| `driverGraph.ts` | `buildDriverGraph(rows, drivers, sectionOf)` → edges row←ref (a section ref = an edge from every row in that section at the scope); `topoOrder()` (Kahn); cycle → `DriverCycleError` naming the path, e.g. `Sales → COGS → Sales`. Growth's self-reference to its base month is intra-row, not an edge. |
| `driverEngine.ts` | `computeVersion({months, rows, cells, drivers, headcount, closedMonths, rounding})` → `{writes: Cell[] per row, warnings}`. Rules: never writes a cell whose source is `override` or `actual`; never writes outside `[from,to]`; a ref row with no cells = 0 + warning; rounding per cell at the rounding unit the caller passes (P2's toolbar unit; nothing is stored on the version — R1 default, R100/R1000, decision 5; no residue, drivers have no total to hit). Deterministic output order. |
| `headcount.ts` | `headcountByMonth(employees, allocations, hires, months, scope)` — decision 7 rule, returns `Map<month, number>` (2-dp FTE). |
| `reforecast.ts` | `planReforecast({sourceCells, actuals, closedMonths, drivers})` → full cell set for the new version: closed → `actual`, open → source cell (source kept), then `computeVersion`. Same function serves the roll. |

Each < 300 lines. `computeVersion` recomputes the whole version (accounts × grains × ≤14 months — a 14-month
transition year comes from `gl/fiscalYearRegistry`, never a hard-coded 12); the service writes only changed cells.

## 5. Services, API

Services (NEW, `src/modules/accounting/services/budgets/drivers/`): `driverRepository.ts` (CRUD, company_id
on every query), `payrollHeadcountReader.ts` (the ONLY file joining payroll tables — read-only),
`driverRecomputeService.ts`, `reforecastService.ts`, `rollingForecastService.ts`. Every write: inside
`withAuth`'s tx, P1's `lockVersionForWrite` first (the `UPDATE budget_versions SET updated_at …` pre-lock of P1's
upgrade-deadlock rule — never `SELECT … FOR UPDATE` followed by trigger `FOR SHARE`; serialises with P2's `saveCells`
and with a roll), refuse `locked` with P1's typed 409 `BUDGET_VERSION_LOCKED` before computing (DB trigger is the
backstop; errors mapped via `mapBudgetDbError`), which also bumps `updated_at` (P2's optimistic-concurrency token), audit `entity='budget'`
(driver save/delete, recompute summary with cell count, reforecast create, roll).

**Recompute triggers:** driver saved/deleted; P2's batched save touches a cell that some driver references
(P2's `gridSave.ts` `saveCells` calls `recomputeDependents` in the same tx — P4 owns this hook; modifies P2 code); planned hire changed; "Refresh
headcount" pressed (records `headcount_as_of` in the audit row). Payroll edits never push a recompute.
Cycle check runs at driver save (400 `DRIVER_CYCLE` + path) and again in compute (defence).

Routes (NEW, in the folder style P1 (`budget-versions/`) and P2 (`budget-grid/`) use). All
`withAuth(withErrorHandler(...))` (+ `withCsrf(withWriteAccess(...))` on writes), `apiResponse`, zod-validated
bodies (seeded ids: not `z.uuid()` — Zod 4 gotcha):
- `pages/api/accounting/budget-drivers/index.ts` — GET (version), PUT (upsert one row's driver), DELETE.
- `pages/api/accounting/budget-drivers/override.ts` — POST reset a cell/row to driver.
- `pages/api/accounting/budget-drivers/headcount.ts` — GET payroll actives + hires per month (counts only).
- `pages/api/accounting/budget-drivers/planned-hires.ts` — GET/POST/PUT/DELETE.
- `pages/api/accounting/budget-versions/[id]/reforecast.ts` — POST `{name, rolling?: boolean}` → new draft
  reforecast from version `[id]` (via P1 `createVersion`, `based_on_version_id = [id]`); POST `{action:'roll'}` =
  "Roll now" on a rolling version; PUT toggles rolling. (P1 owns the other `budget-versions/**` routes; this one
  is P4's addition to that folder.)

**Actuals** come from P3's `budgets/tracking/trackingActualRead.ts` at each row's grain, in budget sign convention — the same
figure BvA shows (invariant 1). Untagged actuals on an account budgeted at a dimension grain cannot be
placed (decision 4 forbids a company row beside dimension rows): the reforecast result and the grid banner
name the account and the unplaced amount; nothing is silently dropped.

## 6. Rolling forecast (auto-roll after close)

- **Hook:** `closePeriod` and `closeYear` in `src/modules/accounting/services/gl/fiscalPeriodService.ts` call a
  new `scheduleBudgetRoll(companyId, endDate)` next to `scheduleAutoSnapshot` — same pattern as
  `src/modules/accounting/services/audit/autoSnapshotQueue.ts`: `runAfterCommit` (`src/lib/afterCommit.ts`),
  one queued job per request, lazy `import()`, logs and never throws, so the close never blocks or rolls back.
  The MCP `close_fiscal_period` and `closePeriodWithReadiness` go through `closePeriod`, so they are covered.
  Register the new site wherever `tests/unit/lib/afterCommitSites.test.ts`'s census requires.
- **Roll:** for the company's rolling version of that fiscal year: lock version row; if `locked`, skip, write
  `last_error='version locked'`, log.warn; else `planReforecast` over ALL closed/locked months of the year
  (not just the new one) → upsert with `IS DISTINCT FROM` → set `rolled_through_month`. Re-running changes
  zero rows (idempotent by construction: output is a function of committed state).
- **Missed roll** (after-commit job failed, server restart): no cron. The versions bar shows "Rolled through
  <month> · <month> closed since" when `rolled_through_month` < latest closed month, with **Roll now**.
  A cron + systemd timer would be ops work under `/home/velo` (Confirmation Gate) — not proposed.
- **Reopen:** a reopened month keeps its `actual` cells until the next roll; banner "<month> reopened after
  the roll — Roll now refreshes it". No auto un-roll.

## 7. UI on P2's grid

New components under `src/components/accounting/budgets/drivers/` NEW, each < 300 lines, dark/light tokens:
- `DriverChip.tsx` — in the row header: `38% × Sales`, `+2% m/m from Mar`, `R32,000 × heads`, `R15,000 fixed`;
  click opens the editor. Tooltip text through `src/components/accounting/charts/escapeHtml.ts`.
- `DriverEditor.tsx` (drawer) — kind picker, params, month range, target-row picker (same version, active
  non-header accounts only), live preview of the 12/14 computed months, cycle error inline with the path.
- Override indicator — corner mark + "Override of driver value R x · Reset" on hover/focus; keyboard reachable.
- Actual-month cells in a reforecast — read-only, muted, "A" marker, column header "Actual".
- `HeadcountPanel.tsx` — months × (payroll actives, planned hires, total) per scope; hires editable inline;
  "Refresh headcount" + "as of" stamp. Shows counts only — never names or pay.
- Versions bar (P2's `VersionsBar.tsx`) — "New reforecast from actuals" (source picker, rolling toggle), rolled-through badge, Roll now. P2's copy-based "New reforecast" stays as is; P4 adds the from-actuals action beside it.
- Money via `formatMoney`; no new page (the grid page already has a nav entry — if a page is added, update
  `src/components/accounting/accountingNavConfig.ts`).

## 8. Task DAG (each with `verify:`)

```
T0 precondition + decision-7 gate
T1 engine (pure) ──┬─► T3 services+API ──► T4 reforecast ──► T6 UI ──► T7 golden path + browser proof
T2 migration ──────┘          └──► T5 rolling hook (gl) ──────┘
```
- **T0** P1–P3 merged; decision 7 confirmed. verify: `git ls-tree -r --name-only origin/master | grep -F -e src/modules/accounting/services/budgets/budgetVersionScope.ts -e src/modules/accounting/services/budgets/gridSave.ts -e src/modules/accounting/services/budgets/tracking/trackingActualRead.ts` lists all three (contract "Preconditions").
- **T1** (PR-1, greenfield) engine + headcount + reforecast planner + unit tests. verify: `bunx vitest run tests/unit/services/budgets/` green; each §9 mutation turns its test red.
- **T2** (PR-2, migration — **Hein OK**) §3. verify: integration suite applies it on a PG16 cluster as non-superuser; lock + RLS tests red→green.
- **T3** (PR-3, modifies P2's save path + payroll join — **Hein reads diff**) repository, headcount reader, recompute, routes. verify: real-PG integration tests §9 green; `bun run ci` green.
- **T4** (PR-3 or PR-4) reforecast create. verify: reforecast actual cell = P3 BvA actual for same month/grain on the fixture.
- **T5** (PR-4, modifies `fiscalPeriodService.ts` — **Hein reads diff**) rolling hook + Roll now. verify: integration test closes a real period → roll applied; second roll = 0 rows changed; locked version skipped.
- **T6** (PR-5) UI. verify: component tests + browser proof on dev Demo, dark and light, 1280px and 390px.
- **T7** golden path `tests/e2e/golden-paths/<next free letter>-budget-drivers.spec.ts` NEW. It runs in prod verify, so it obeys the contract's golden-spec write rule: every write goes into its own non-primary `GP-<runId>` scenario version (and the reforecast it creates is also named `GP-…`, non-primary), prechecks before writing, stale sweep, delete in `afterAll`/`finally` (drivers and planned hires cascade). Steps: set COGS = 38% of Sales → edit a Sales cell → COGS follows → override one COGS cell → indicator → add a planned hire → salary row moves → New reforecast from actuals → closed months marked Actual. verify: spec green on dev with screenshot.

## 9. Tests and mutations

| Test (NEW) | Proves | Mutation that must turn it red |
|---|---|---|
| unit `driverGraph` | self, 2-node, 3-node-via-section cycles refused with path; topo order valid | skip the cycle check |
| unit `driverEngine` | each kind's arithmetic; growth compounding; range bounds; ref-missing warning | write `override` cells; drop range check; `(1+g)*n` instead of `^n` |
| unit `headcount` | start/end boundary days, inactive excluded, allocation split, hires FTE | `<` for `<=` on start/end; ignore allocations |
| unit `reforecast` | closed → actual, open → source, drivers recompute from actual base | read source for closed months |
| int `budget-drivers-rls` | cross-tenant read/write refused on all new tables as app_user | drop policy in the test cluster migration copy |
| int `budget-drivers-locked` | locked version refuses driver/hire/amount writes at DB level as app_user, and API 409 | remove the trigger attach |
| int `budget-drivers-recompute` | edit ref cell → dependents updated in same tx; override untouched; unchanged cells not rewritten | recompute rewrites all cells |
| int `budget-headcount-reader` | counts per month on fixture; response keys contain no PII fields; company A never sees B | remove `company_id` predicate |
| int `budget-reforecast-actuals` | closed-month cells = P3 actual reader, per grain; unplaced untagged actual reported | ignore grain |
| int `budget-rolling-forecast` | real `closePeriod` → roll; rerun = 0 changed rows and `updated_at` unchanged; locked skipped | INSERT instead of upsert-if-distinct |

Integration suites route to `isaflow_schema_fixture`/`isaflow_test` per `tests/helpers/integrationGate.ts`; they run on GitHub (local: `CI_INTEGRATION=1 bun run ci`).

## 10. Acceptance

On ISAFlow Demo (dev, then prod after a Hein-approved after-hours deploy, writes via UI only — decision 6), a
finance user: sets COGS as 38% of Sales and sees it follow a Sales edit; budgets salaries as R x per head and
sees payroll actives + two planned hires drive it; overrides one month and resets it; creates "Reforecast Q2"
from actuals with closed months showing Actual; closes a dev period and sees the rolling version roll once.
P3's BvA for the reforecast shows the same actuals for closed months.

## 11. Risks

- **Payroll labour actuals may carry no `cc1_id`.** `buildLabourLines` (`payroll/payrollJournalParts.ts`) splits
  labour by GL account via `costCentreGlMappingService.ts`, and no payroll file references `cc1` (grep,
  2026-10-26). Labour budgeted by cost centre would then reforecast with zero CC actuals. MEDIUM confidence —
  verify on dev at T0; if true, report it, don't change payroll posting (separate decision for Hein).
- **Salary disclosure:** R-per-head × a one-person cost centre reveals pay. P4 never derives a rate from payroll;
  the user types it. Any later "suggest rate from payroll" must be payroll-role-only (`entityChangeTypes.ts`
  PAYROLL_ROLES) with a ≥3-employee floor.
- **Peer names drift** (P1 lock function, P2 band model and save path, P3 actuals reader are named above from their specs) — refresh step confirms them.
- **After-commit job lost** → stale rolling version; mitigated by the stale badge + Roll now, not by cron.
- **Recompute storm** from a large paste: one recompute per batched save, never per cell.
- **Approved-unlocked version** recomputes are allowed and audited (decision 2); a driver change can silently
  move an approved number — the audit row lists changed cells.
