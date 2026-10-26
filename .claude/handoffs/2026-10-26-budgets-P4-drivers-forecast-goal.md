# /goal — Budgets P4: driver lines, headcount from payroll, reforecast from actuals, rolling forecast (run autonomously until DONE)

> **How to use:** start a fresh session **on Opus** in `/home/hein/Workspace/IsaFlow` and run:
>
> `/goal Execute .claude/handoffs/2026-10-26-budgets-P4-drivers-forecast-goal.md to completion. Ask Hein the §0 decision-gate question once, then work autonomously through Precondition → Engine (TDD) → Migration → Services/API → Reforecast → Rolling hook → UI → Golden path, with Review → Fix loops per PR. Do not stop to ask again, except at a Confirmation Gate (§8) or a genuine external blocker. Loop until every Success Criterion (§7) is proven with evidence, queue each PR with mq-isa (only where §8 allows), write a handoff and stop.`

> **Refresh first.** This goal and its spec were written on 2026-10-26, before P1–P3 existed. Before §3,
> re-read the merged P1–P3 code and Demo usage, and update `docs/plans/budgets/P4-drivers-forecast-spec.md`
> where reality differs (names, routes, section model, actuals reader). If MVP usage shows drivers are not
> wanted, ship only `per_head` + reforecast and say so in the handoff.

## 0. Phase-start decision gate (the ONLY question this session asks)

Ask Hein exactly this, once, and wait for one line:

> **Decision 7 (P4) — headcount driver.** Default: headcount = active payroll employees per month + planned
> hires entered in the budget tool; payroll read-only. "Active in month M" = started on/before M's last day,
> not ended before M's first day, status not `inactive`; any day employed counts a full head (no pro-rata);
> cost-centre heads split by `payroll_employee_cost_allocations` %, else the employee's `cost_centre_id`.
> Planned hires = role label (never a name), optional cost centre, start/end month, FTE. R-per-head is typed
> by the user, never derived from payroll pay. **Reply "yes" or the override.**

Record the answer in the spec §2 and the PR body. After this, no more questions outside §8.

## 1. Mission

Give a budget row a driver (`fixed`, `pct_of_line`, `pct_of_section`, `growth`, `per_head`) whose amounts
recompute when their inputs change, with per-cell manual override; add "New reforecast from actuals"
(closed months = actuals, open months = budget/drivers) and an optional rolling forecast that re-rolls after
each period close. Full design: `docs/plans/budgets/P4-drivers-forecast-spec.md` (NEW — lands with the
planning branch `docs/budgets-next-level-plan`; read it end to end). "Real" means real-PG integration tests, mutation-verified, plus a Playwright
golden path on dev Demo with screenshots — no mocked SQL in the evidence.

## 2. What exists — do NOT redo

- **Precondition: P1, P2 and P3 merged on `origin/master`.** Check (contract "Preconditions"):
  `git ls-tree -r --name-only origin/master | grep -F -e src/modules/accounting/services/budgets/budgetVersionScope.ts -e src/modules/accounting/services/budgets/gridSave.ts -e src/modules/accounting/services/budgets/tracking/trackingActualRead.ts`
  lists all three. **If any is missing, STOP and report which phase.**
- P1 (names from its spec; confirm on master): `budget_versions`, `budget_month_amounts.version_id/cc1_id/cc2_id/bu_id`,
  lock trigger `public.budget_month_amounts_refuse_locked()` (`BV001`), `budgets/budgetVersionScope.ts` `lockVersionForWrite`,
  `budgets/budgetVersionTypes.ts` `mapBudgetDbError` / `BudgetVersionError`, `budgets/budgetVersions.ts` `createVersion`,
  routes `pages/api/accounting/budget-versions/**`, the `entity='budget'` audit writer, primary-version readers.
- P2: the grid on `pages/accounting/budgets/index.tsx` (`src/components/accounting/budgets/workspace/`: `BudgetWorkspace.tsx`,
  `VersionsBar.tsx`, `useBudgetGrid.ts`), batched save `budgets/gridSave.ts` `saveCells` with version `updated_at`
  concurrency, band model `budgets/grid/subtotals.ts` (`BAND_ORDER`), rounding `budgets/grid/cents.ts` `roundToUnit`,
  copy-based "New reforecast" button.
- P3: `budgets/tracking/trackingActualRead.ts` — the one source for actual figures (invariant 1).
- Budget code today: `src/modules/accounting/services/core/budgetService.ts`, `core/budgetMonths.ts`
  (`round2`, `spreadEvenly`), `scripts/migrations/sql/944_budget_month_amounts.sql` (RLS + same-company
  trigger pattern to copy), `src/modules/accounting/services/gl/fiscalYearRegistry.ts` (month lists; a
  transition year has 14).
- Payroll (READ ONLY): `payroll_employees` (`scripts/migrations/sql/380_payroll_employees.sql`: `start_date`,
  `end_date`, `status`; `cost_centre_id` from `450_cost_centres.sql`), `payroll_employee_cost_allocations`
  (`451_…`), runs `payroll_run_headers/lines` (`382_payroll_runs.sql`). Labour posting:
  `src/modules/accounting/services/payroll/payrollJournalParts.ts` `buildLabourLines` +
  `costCentreGlMappingService.ts`. Payroll roles: `src/modules/accounting/services/core/entityChanges/entityChangeTypes.ts`.
  PII rules: `src/modules/accounting/services/payroll/payrollEmployeeRedaction.ts`.
- Period close: `src/modules/accounting/services/gl/fiscalPeriodService.ts` (`closePeriod`, `closeYear`,
  `reopenPeriod`), `gl/fiscalPeriodCloseService.ts`, MCP `src/lib/mcp/tools/writeFiscalPeriods.ts`. After-commit
  model to copy: `src/modules/accounting/services/audit/autoSnapshotQueue.ts` + `src/lib/afterCommit.ts`; census
  `tests/unit/lib/afterCommitSites.test.ts`.

## 2a. Product decisions already made (do not re-ask)

Contract decisions 1–6 (`docs/plans/budgets/00-shared-contract.md`), especially: one grain per account per
version (4) — drivers obey it; rounding R1/R100/R1000 (5); approved-unlocked stays editable and audited (2) —
recomputes too; locked = immutable at DB level (2) — no recompute, no roll; prod writes only to ISAFlow Demo
via the UI (6). Decision 7 = §0 answer. No cron job; rolling uses after-commit + a "Roll now" button.

## 3. Engine — pure TS, TDD [agent decides internals]

`src/modules/accounting/services/budgets/drivers/` NEW: `driverTypes.ts`, `driverGraph.ts` (Kahn topo order,
`DriverCycleError` with the path), `driverEngine.ts` (never writes `override`/`actual` cells or outside the
range; deterministic), `headcount.ts` (decision 7), `reforecast.ts` (`planReforecast`, shared by the roll).
Tests first in `tests/unit/services/budgets/` NEW. PR-1 is greenfield → may be queued without Hein once §7's
per-PR gates pass.

## 4. Migration [Confirmation Gate]

Spec §3: `budget_month_amounts.amount_source` (reuse P1/P2's column if one exists), `budget_driver_lines`,
`budget_planned_hires`, `budget_rolling_forecasts`; 944's forced-RLS policy, same-company triggers, P1's lock
trigger attached to all three tables, grain trigger. Next free 3-digit prefix, re-checked at commit time.
Integration test as `app_user`: cross-tenant refused; locked version refuses every write. **Stop for Hein's
explicit OK before queueing.**

## 5. Services, API, reforecast, rolling hook

- Spec §5 services and routes (`pages/api/accounting/budget-drivers/{index,override,headcount,planned-hires}.ts` and
  `pages/api/accounting/budget-versions/[id]/reforecast.ts`, all NEW), each `withAuth(withErrorHandler(...))`
  (+ `withCsrf(withWriteAccess(...))` on writes), `apiResponse`, `log`, P1's `lockVersionForWrite` first, 409
  `BUDGET_VERSION_LOCKED` via `mapBudgetDbError`, 400 `DRIVER_CYCLE`, audit `entity='budget'`.
- `payrollHeadcountReader.ts` NEW is the only payroll join: counts only, `company_id` on both tables.
  **The PR carrying it needs Hein's diff read** (payroll data). P2's `gridSave.ts` `saveCells` →
  `recomputeDependents` in the same tx also modifies an existing path → same PR, same gate.
- Reforecast from actuals: closed/locked fiscal periods' months = P3 actuals at each row's grain; report
  unplaced untagged actuals by account; drivers copied and recomputed.
- Rolling: `scheduleBudgetRoll` next to `scheduleAutoSnapshot` in `closePeriod` and `closeYear`; never
  throws; idempotent upsert-if-distinct; locked → skip + `last_error`; stale badge + Roll now. **This PR
  modifies `fiscalPeriodService.ts` → Hein reads the diff.**
- At T0 verify on dev whether payroll labour journal lines carry `cc1_id` (spec §11 risk). Report; do not
  change payroll posting.

## 6. UI on P2's grid

Spec §7: `DriverChip`, `DriverEditor`, override indicator + Reset, Actual-month cells, `HeadcountPanel`
(counts only), versions-bar reforecast/rolling controls. `formatMoney`; tooltips via
`src/components/accounting/charts/escapeHtml.ts`; colours only via `src/components/accounting/charts/ibcs.ts`
where a variance is shown. Golden path `tests/e2e/golden-paths/<next free letter>-budget-drivers.spec.ts` NEW
(spec §8 T7). It runs in prod verify against Demo, so it follows the contract's golden-spec write rule: writes only
into its own non-primary `GP-<runId>` versions, precheck + skip before any write, stale sweep, delete in
`afterAll`/`finally`.

## 7. Success criteria

- [ ] §0 answer recorded; P1–P3 precondition evidence in the first PR body.
- [ ] Every row of spec §9 exists, is green, and turns red under its named mutation (log paths in PR bodies).
- [ ] Rolling: a real `closePeriod` on a fixture rolls once; a second roll changes 0 rows; locked skipped.
- [ ] Reforecast closed-month cells equal P3's BvA actual for the same month and grain on the fixture.
- [ ] `bun run ci` green per PR (+ `CI_INTEGRATION=1 bun run ci` locally for the integration suites, or the
      GitHub integration job), pre-push passing, both required checks green on the queued head.
- [ ] Blind `/review` + security review SHIP on each final head; every H/M/L finding fixed.
- [ ] Browser proof on dev ISAFlow Demo: dark AND light, 1280px AND 390px, screenshots described in the PR.
- [ ] `.claude.md` beside `budgets/drivers/` (≥4 files) + `bun run agent-docs:generate` + `agent-docs:check`.
- [ ] PRs queued with `mq-isa add <N>` where allowed; handoff written (incl. the cc1 labour finding and the
      after-hours prod deploy request for Hein); worktree removed.

## 8. Confirmation gates — STOP and ask Hein (the contract's human gates, nothing else)

- §0 decision 7 (once, at the start).
- The P4 migration (§4), before it is queued.
- Diff read before `mq-isa add` on any PR that modifies an existing production path: the payroll-join PR,
  the P2 save-path change, the `fiscalPeriodService.ts` hook.
- Any production deploy (`bash scripts/deploy.sh`) — never run it; hand Hein the after-hours request.
- Outbound email/notifications, and any read/write of the production DB or of any non-Demo company's data.

**Never do (not gates):** change payroll code or payroll posting (report the cc1 labour finding instead); add a
cron/systemd timer. If review rounds keep surfacing new defect classes, scope back to the spec and say so in the PR body.

## Rules

- **Worktree:** `git worktree add -b feat/budgets-p4-drivers-<date> /home/hein/Workspace/IsaFlow-wt-budgets-p4 origin/master`;
  `cp -al` node_modules (never `ln -s`). `cd` into it on every Bash call. One branch per PR, stacked if needed.
- **Repo law:** company_id on every query; `sql` from `@/lib/neon`, never concatenation; `log`, never
  `console`; no empty catch; ≤300 lines per file; TDD; migrations `IF NOT EXISTS`, never edit an applied one.
- **Git:** never commit to master, stage explicit paths (never `git add -A`), no `git stash`, no
  `--no-verify`, no amend or force-push. Merges ONLY via `mq-isa add`; never `gh pr merge`.
- **DB:** dev is `isaflow_dev`; never the prod DB. Do not apply branch migrations to dev before merge
  (breaks master's unit-db gate) — use a disposable PG16 cluster.
- **Artefacts:** `/home/hein/.cache/redchk/budgets-p4/`, never `/tmp`.
- **Process:** no edits while a gate run is in flight; no pattern kills; subagents never edit memory; push at
  load < 25 (`uptime`), in the background.
