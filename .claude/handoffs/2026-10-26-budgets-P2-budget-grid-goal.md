# /goal: Budgets P2, the budget workspace (planning grid + create wizard + Excel round-trip + versions bar). Run autonomously until DONE.

> **How to use:** start a fresh session **on Opus** in `/home/hein/Workspace/IsaFlow` and run:
>
> `/goal Execute .claude/handoffs/2026-10-26-budgets-P2-budget-grid-goal.md to completion. Work autonomously through Precondition → Census → TDD (red first) → Build → Browser proof → Review → Fix loops, one PR at a time (PR-A → PR-B → PR-C → PR-D). Do not stop to ask, except at a Confirmation Gate (§8) or a genuine external blocker. Loop until every Success Criterion (§7) is proven with evidence, then open each PR, queue it with mq-isa only where §8 allows, write a handoff and stop.`

**Spec (the contract for this goal; read it in full first):** `docs/plans/budgets/P2-budget-grid-spec.md`.
**Programme rules:** `docs/plans/budgets/00-shared-contract.md` (obey exactly; canonical names are P1's).
**Parent plan:** `docs/plans/2026-10-26-budgets-next-level.md` §5 P2.

## 0. Precondition: P1 merged (and P0 before PR-D). Check, and STOP if it is not.
Run `cd /home/hein/Workspace/IsaFlow && git fetch origin`, then on `origin/master`:
- `git ls-tree -r --name-only origin/master | grep -F -e src/modules/accounting/services/budgets/budgetVersionStatus.ts -e src/modules/accounting/services/budgets/budgetVersions.ts -e 'pages/api/accounting/budget-versions/[id]/status.ts' -e 'pages/api/accounting/budget-versions/[id]/index.ts' -e src/modules/accounting/services/budgets/.claude.md` lists all five;
- `git grep -q budget_month_amounts_one_grain origin/master -- scripts/migrations/sql` and `git grep -q budget_month_amounts_refuse_locked origin/master -- scripts/migrations/sql` both succeed.
- Before PR-D only: P0 merged — `git ls-tree -r --name-only origin/master | grep -F src/components/accounting/budgets/useBudgetAccounts.ts`.

If any check fails: **STOP**, write a one-paragraph handoff ("P2 blocked: <phase> not merged: <what is missing>"), and end the session. Do not build P0 or P1 pieces (contract ownership table: every `budget-versions/**` route is P1's).

## 1. Mission
Replace the one-form-per-account budgets page with a statement-styled, Excel-grade planning grid, delivered in four PRs. It covers:
- Live GP/OP/NP subtotals, FY total, PY actual, Δ vs PY and a sparkline.
- The full keyboard/selection/clipboard/fill/undo model.
- A batched save with optimistic concurrency (409 flow).
- Row spreads with decision-5 rounding.
- Dimension pivot with decision-4 grain rules.
- A create wizard.
- An Excel template download plus an upload with diff preview.
- A versions bar with role-gated approve/lock/unlock.

"Real" means:
- Every pure rule is a table-driven unit test that is red under a named mutation (spec §14).
- Every write path is a real-PG integration test (CI clusters, `CI_INTEGRATION=1`), including a concurrent-save race.
- The workspace is proven in a browser on dev (dark + light, 1280 + 390) with screenshots.
- The golden path `create from PY +10% → paste column → save → approve → reload` passes.

## 2. What exists — do NOT redo (verified on origin/master 49d139b5e)
- **Current page (replaced in PR-D):** `pages/accounting/budgets/index.tsx`, `src/components/accounting/budgets/BudgetForm.tsx`. `src/components/accounting/budgets/budgetClient.ts` is kept (`monthLabel`, `yearRangeLabel`, `BudgetYear`).
- **Current APIs:** `pages/api/accounting/budgets.ts`, `pages/api/accounting/budgets-action.ts`. **Services:** `src/modules/accounting/services/core/budgetService.ts`, `budgetMonths.ts` (`round2`, `spreadEvenly`, `parseYearLabel`), `budgetYears.ts`. P1 may have moved or re-exported these into `src/modules/accounting/services/budgets/`; read P1's `.claude.md`.
- **Statement look to reuse:**
  - `src/components/accounting/statement/stickyTable.ts` (`STICKY_HEAD`, `STICKY_FIRST_HEAD`, `STICKY_FIRST_CELL`; the page is the only scroll container)
  - `Sparkline.tsx`
  - `StatementRowView.tsx` (its `KIND_CLASS` styling and `FIG_STYLE`, copied, not imported)
  - `src/components/accounting/reportControls/useDensity.ts` + `DensityToggle.tsx` (one `useDensity` per page)
  - `src/components/accounting/charts/ibcs.ts` `varianceColor` + `useChartPalette` (`charts/ChartFrame.tsx`)
  - `src/lib/format/money.ts` `formatStatementFigure` / `formatPct`
- **Bands:** `revenueBand` / `expenseBand` / `aggregateFigures` in `src/modules/accounting/services/gl/accountClassification.ts`. Order as in `src/modules/accounting/services/reports/statementRows/incomeStatementRows.ts`.
- **PY actuals reference:** `src/modules/accounting/services/reports/trendRowsService.ts` `getMonthlyMovements` (parity target).
- **Excel:**
  - `exceljs ^4.4.0` is already a dependency.
  - Server-side safe parse: `src/lib/xlsxNormalise.ts` + the streaming reader pattern in `src/lib/xlsxToCsv.ts` (`XLSX_LIMITS`, `looksLikeXlsx`).
  - Multipart pattern: `pages/api/accounting/migration-parse.ts` (formidable).
  - Workbook-builder pattern: `pages/api/accounting/gl-import-template.ts`, `src/modules/accounting/services/reports/incomeStatementDimensionSheet.ts`.
- **Auth:**
  - `withRole('admin')` admits owner+admin only (`src/lib/auth/withRole.ts`, `src/lib/auth/.claude.md` 2026-10-21).
  - `withWriteAccess`, `withCsrf`.
  - Client role: `useCompany().companyRole` (`src/contexts/CompanyContext.tsx`).
- **Audit:** `logAuditOrThrow` in `src/modules/accounting/services/core/auditTrailService.ts`; entity `'budget'` filter already in `pages/accounting/audit-log.tsx`.
- **Fetch:** `apiFetch` resolves on 4xx, so always `assertOk` / `apiJson` (`src/lib/apiFetch.ts`).
- **Theme tokens:** `styles/globals.css` (`:root` and `.dark`; `--ff-fav`, `--ff-unfav`, `--ff-focus-ring`).
- **Nav:** `src/components/accounting/navSections/accounting.ts:73` and `accountants.ts:76` already link `/accounting/budgets`, so no nav change is needed (`accountingNavConfig.ts` composes them).
- **Golden paths:** `tests/e2e/golden-paths/` (letters a–u used on 2026-10-26; P2 takes the next free letter at commit time, `v` today), config `playwright-golden.config.ts`. **They also run in `scripts/verify-deploy.sh` against prod Demo, and a red result auto-rolls back the deploy.** Obey the contract's golden-spec write rule. Load the `isaflow-golden-paths` skill before writing the spec.
- **P1 (precondition):** `src/modules/accounting/services/budgets/` — `budgetVersions.ts`, `budgetVersionStatus.ts` (`transitionVersion`), `budgetVersionScope.ts` (`lockVersionForWrite`), `budgetVersionTypes.ts` (`BudgetVersionError`, `mapBudgetDbError`); routes `pages/api/accounting/budget-versions/**`; constraints `budget_month_amounts_one_per_cell` / `budget_month_amounts_one_grain`; SQLSTATE `BV001` (locked). The versions bar calls these routes; P2 builds no version route.
- **Callers of the old UI that PR-D must update:**
  - `tests/e2e/fiscal-year-end-change.spec.ts:97-114`
  - `tests/e2e/navigation.spec.ts`
  - `tests/e2e/full-audit.spec.ts`
  - `tests/unit/components/budgetFormValidation.test.tsx`, `budgetsPageMonths.test.tsx`, `budgetsPageRace.test.tsx`
  - `tests/unit/components/d2ErrorEnvelopeG1a.test.tsx`, `d2ErrorEnvelopeG1aSuccess.test.tsx`

## 2a. Product decisions already made (do NOT re-ask)
1. Approve + Lock: owner + admin. Unlock: owner only, mandatory reason, audited.
2. Approved-but-unlocked is editable by the finance user, and every write is audited. Locked is immutable (DB trigger, P1).
3. Converted budgets are one approved primary "Original" per company+FY (P1).
4. One grain per account per version (company OR one dimension set), DB-enforced (P1). The UI edits only at the account's grain (spec §11).
5. Rounding R1 (default) / R100 / R1000; residue on the **last** month.
6. Prod validation writes budgets only into ISAFlow Demo, via the UI, after an approved deploy.
- Plus the spec's own decisions: mobile = read + single-cell edit (§12); no virtualisation library and no windowing (§13); exceljs (§9); text `updated_at` token (§7.1); new page at `/accounting/budgets/workspace` until the PR-D cutover.

## 3. PR-A: pure grid model `[agent builds; greenfield]`
Spec §4.1, §5, §14 unit table. Directory `src/modules/accounting/services/budgets/grid/` NEW. Tests in `tests/unit/services/budgets/grid/` NEW.
- Begin with T0: the census table (spec §3) goes into the PR-A body. Any need P1 lacks is a precondition failure (§0), not PR-B scope.
- TDD: write each test file first and watch it go red. Then implement. Then apply each §14 mutation and watch it go red. Revert it with a cp-backup, **not** `git checkout` (that can wipe the fix).
- `[agent decides]` internal function signatures beyond the spec, and the exact reducer state shape.

## 4. PR-B: services + API `[agent builds; Hein reads the diff]`
Spec §4.2, §4.3, §7, §8, §9.
- Every query is scoped by `company_id`. Use the `sql` tagged template from `@/lib/neon` (arrays via `unnest(${arr}::UUID[])`, never string concatenation). Wrap with `withAuth(withErrorHandler(withCsrf(withWriteAccess(handler))))` for writes. Use `apiResponse.*` and `log`. No empty catch. ≤300 lines per file.
- **Save:** take the `UPDATE … WHERE updated_at = $expected::timestamptz AND status <> 'locked'` row lock first, under `withRowLockBudget` (P1's pre-lock rule). Delete before upsert, `ON CONFLICT ON CONSTRAINT budget_month_amounts_one_per_cell`. Map errors only through P1's `mapBudgetDbError` (409 `BUDGET_VERSION_LOCKED`, 400 `BUDGET_GRAIN_CONFLICT`). Write one `logAuditOrThrow` per batch.
- **No version routes in P2.** Approve/lock/unlock/primary/delete/copy call P1's `budget-versions/**`. Do not widen `withRole`.
- `priorActuals.ts`: if P3 PR-A (`budgets/tracking/trackingActualRead.ts`) is already on master, build it on that reader; otherwise build it with the `getMonthlyMovements` parity test and P3 consolidates (contract ownership table).
- Integration tests (spec §14 table) under `tests/integration/`. Each new suite routes to the right CI database by the guard it calls (see `CLAUDE.md` Testing). Run `CI_INTEGRATION=1 bun run ci` locally before the PR.
- Adversarial breaker (fresh agent, own PG cluster) on save/409/import/role gates before the PR.

## 5. PR-C: workspace UI at `/accounting/budgets/workspace` (unlinked) `[agent builds; Hein reads]`
Spec §4.4, §5, §6, §10–§13.
- Files ≤300 lines (spec §4.4 budgets). Hooks are `useBudgetGrid`, `useGridKeyboard`, `useGridClipboard`, `useUnsavedGuard`; the store is `gridStore.ts`.
- New tokens `--ff-dirty-bg`, `--ff-conflict-bg`, `--ff-cell-selected-bg`, `--ff-cell-focus-ring` go in `styles/globals.css`, in both `:root` and `.dark`. The editor input needs a visible border in dark mode.
- Component tests (spec §14), including the `BudgetGridRenderCount` gate.
- Golden spec `tests/e2e/golden-paths/<next free letter>-budget-workspace.spec.ts` (runs in prod verify; contract golden-spec write rule):
  - Precheck PY actuals and an owner/admin session **before** any write; otherwise skip with a reason. Sweep stale unlocked non-primary `GP-%` versions.
  - Create a `scenario` version `GP-<runId>`, never primary, never locked.
  - Paste via a dispatched `ClipboardEvent` carrying TSV.
  - Save, approve, reload, and assert.
  - Delete the version by its id in `afterAll` and in a `finally`, after asserting non-primary + `GP-` name.
  - The a11y check is report-only in verify-deploy.
- Perf spec `tests/e2e/budget-workspace-perf.spec.ts` NEW, report-only. Record the numbers against spec §13 in the PR body.
- **Browser proof** on dev (`bun run dev`, :3200; QA user per memory "Dev session, no password"):
  - dark+light × 1280+390.
  - Grid with live NP.
  - Paste + undo.
  - Spread dialog.
  - By-CC1 view + Company roll-up read-only.
  - Wizard.
  - Import diff preview.
  - 409 dialog (two tabs).
  - Locked read-only.

  Save the screenshots under `/home/hein/.cache/redchk/budgets-p2/shots/` and say what each shows.
- `.claude.md` for `src/components/accounting/budgets/workspace/` + `grid/`, then `bun run agent-docs:generate`.

## 6. PR-D: cutover `[agent builds; Hein reads]`
- `pages/accounting/budgets/index.tsx` renders `BudgetWorkspace`, and `/accounting/budgets/workspace` redirects to it.
- Delete `BudgetForm.tsx` and any orphaned helpers.
- Replace each retired old-page test with a named equivalent (list them in the PR body).
- Update the 3 e2e specs from §2.
- Old routes `budgets.ts` / `budgets-action.ts`: run a census of callers. If none remain, remove them; if any remain, keep them and mention it in the PR body. `[agent decides by census]`

## 7. Success criteria
- [ ] Precondition (§0) passed. The census table is in the PR-A body.
- [ ] Every spec §14 test exists, is green, and is red under its named mutation (logs in `/home/hein/.cache/redchk/budgets-p2/`).
- [ ] Concurrent-save race: exactly one 200 + one 409, 5/5 runs. A locked-version write is refused (409) and nothing is written. Viewer gets 403. Admin gets 403 on unlock.
- [ ] Invariants hold: 2 (roll-up = Σ dims) and 3 (export→import = 0 changes), both in unit and integration tests.
- [ ] Golden `<letter>-budget-workspace` green on dev twice. The `isaflow_dev` count of `GP-%` versions afterwards = 0, including after a run killed mid-way and followed by a clean run.
- [ ] Browser screenshots for every §5 item (dark+light, 1280+390), each described.
- [ ] Every file ≤300 lines (`wc -l` listed in each PR body).
- [ ] `bun run ci` green; the GitHub `quality` + integration checks are green on each PR head.
- [ ] Blind `/review` + security review SHIP on each final head; every H/M/L fixed.
- [ ] PR-A queued via `mq-isa add <N>`. PR-B, PR-C and PR-D opened and **not queued** (Hein reads them). Handoff written listing PR numbers, evidence paths, the open questions from spec §19, and the after-hours prod deploy request with the Demo validation script (spec §17).

## 8. Confirmation gates: STOP and ask Hein (the contract's human gates, nothing else)
- **Any schema need** (P2 writes no migration).
- `mq-isa add` for PR-B, PR-C or PR-D: these modify production paths, write tenant data or are client-visible, so Hein reads the diff first. PR-A alone may be queued.
- Any production deploy (`bash scripts/deploy.sh` is never run by this session); hand Hein the after-hours request.
- Any outbound email or notification, and any read or write of production or non-Demo company data (on dev, only `isaflow_dev` QA/Demo-style test companies).

A failed §0 precondition is a blocker (stop and report), not a gate. **Never do (not gates):** change `src/lib/auth/*` (e.g. widening `withRole`); build P0/P1 pieces. If review rounds keep surfacing new HIGH findings in one area, scope back to the spec and say so in the PR body.

## Rules (repo law restated)
- **Worktree:** one per PR, from `origin/master` (PR-C/PR-D stacked on their predecessors, or on master once those are merged):
  - `git worktree add -b feat/budgets-p2a-grid-model-20261026 /home/hein/Workspace/IsaFlow-wt-budgets-p2a origin/master`, then `cp -al` node_modules into it. Never `ln -s` it.
  - Prefix every Bash call with `cd <worktree>`.
- **Git:**
  - Never edit or commit on master.
  - Stage explicit paths only; never `git add -A`.
  - No `git stash`, no `--no-verify`, no amend, no force-push.
  - Merges go only through `mq-isa add`; never `gh pr merge`.
  - Push in the background at load < 25 (`uptime`). Delete a remote branch with `gh api -X DELETE`, not `push --delete`.
- **Code:**
  - `company_id` on every query.
  - The `sql` tagged template from `@/lib/neon`.
  - `withAuth(withErrorHandler(...))`.
  - `apiResponse`, and `log` (never console).
  - No empty catch.
  - Strict TS; new code is TypeScript only.
  - ≤300 lines per file.
  - Money: `formatStatementFigure`/`formatPct` in the grid; fav/unfav colour only via `varianceColor`; every tooltip through `src/components/accounting/charts/escapeHtml.ts`.
- **Process:**
  - TDD: tests first.
  - Do not edit a tree while a gate run is in flight.
  - No pattern kills (find the PID; kill the dev server by its `ss` pid).
  - Don't run a CI build beside a running dev server.
  - Subagents never edit memory.
  - Artefacts go in `/home/hein/.cache/redchk/budgets-p2/`, never `/tmp`.
  - Cap parallel agents at about 12.
