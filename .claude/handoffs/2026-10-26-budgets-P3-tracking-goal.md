# /goal — Budgets P3: tracking (Budget vs Actual rebuilt on the statement grid, wired into comparator, packs and MCP) (run autonomously until DONE)

> **How to use:** start a fresh session **on Opus** in `/home/hein/Workspace/IsaFlow` and run:
>
> `/goal Execute .claude/handoffs/2026-10-26-budgets-P3-tracking-goal.md to completion. Work autonomously through Precondition → TDD (red, then green) → Mutation proof → Review → Fix loops, one PR at a time in the order of §7. Do not stop to ask, except at a Confirmation Gate (§8) or a genuine external blocker. Loop until every Success Criterion (§7) is proven with evidence, then open each PR, queue the greenfield one with mq-isa, hand Hein the diff-read PRs, write a handoff and stop.`

**Spec (read it whole first, it is the contract for this file):** `docs/plans/budgets/P3-tracking-spec.md`.
**Programme contract:** `docs/plans/budgets/00-shared-contract.md`. **Parent plan:** `docs/plans/2026-10-26-budgets-next-level.md` §3, §5 P3, §7.

## 0. Precondition — STOP if it fails

P3 builds on P0 (BvA defects D1–D9 fixed, shared BvA row model) and P1 (versions + dimensions schema, the `services/budgets/` home).

1. `git fetch origin`. Read `docs/plans/budgets/P0-correctness-spec.md` and `docs/plans/budgets/P1-schema-versions-spec.md`.
2. On `origin/master`, all of these must hold (contract "Preconditions"):
   - P0: `git ls-tree -r --name-only origin/master | grep -F src/modules/accounting/services/reports/budgetVsActualSections.ts`, and D7 fixed: `git show origin/master:src/modules/accounting/services/reports/statementRows/comparators.ts | grep -c line.actual_amount` = 0;
   - P1: `git ls-tree -r --name-only origin/master | grep -F -e src/modules/accounting/services/budgets/budgetVersionScope.ts -e src/modules/accounting/services/budgets/.claude.md` lists both, and `git grep -q "CREATE TABLE IF NOT EXISTS budget_versions" origin/master -- scripts/migrations/sql`.
3. Confirm the P0/P1 names listed at the top of the spec against the merged code; write any drift into the PR-A body.

If step 2 fails, **stop** and report what is missing. Do not build P3 on the old single-version schema, and do not build P0/P1 work yourself (D1–D14, D7 and the MCP D5/D6/D11 changes are P0's).

## 1. Mission

Rebuild `/accounting/reports/budget-vs-actual` on `StatementGrid`:

- **Bands:** the income-statement bands and subtotals, through Net profit.
- **Columns:** Actual, Budget, Var R, Var %, Projected FY, FY budget, Proj. var.
- **Periods:** month, quarter (14-month years have a 2-month Q5), YTD, FY, custom (month-granular).
- **Controls:** a version picker (default primary) and CC1/CC2/BU filters, with the roll-up rules in spec §2.4.
- **Drill:** variance → GL lines → source document.
- **Visuals:** a profit bridge from budget NP to actual NP, an account × month variance heatmap, and a bullet per cost centre.
- **Export:** CSV and XLSX from the same row model.

Then wire the same engine into:

- the statement Budget comparator (version and dims honoured, the dims disable removed, D7);
- the board pack (Budget column);
- the management pack (`comparison_mode` honoured, budget sections rendered);
- MCP `budget_variance` (optional `version_id`, `cc1_id`, `cc2_id`, `bu_id`, backward compatible).

"Real" means:

- **Invariant 1** (BvA actual = income statement for every window × filter, to the cent) and **Invariant 2** (company roll-up = Σ grains) proven on real PostgreSQL in `tests/integration/`. Each is red under its named mutation, then green again.
- A Playwright golden path with screenshots.
- Browser proof in dark and light at 1280 and 390.

No mocked SQL counts as evidence for a figure.

## 2. What already exists — do NOT redo (verified on origin/master 2026-10-26)

**Budget readers today.** These are replaced or wrapped, not duplicated:

- `pages/api/accounting/reports-budget-vs-actual.ts`, `pages/api/accounting/budget-vs-actual-export.ts`, `pages/accounting/reports/budget-vs-actual.tsx`
- `src/modules/accounting/services/reports/budgetVarianceService.ts` (`getBudgetVariance`), `budgetVsActualLines.ts`, `budgetWindowService.ts`, `budgetPeriodWindow.ts` (calendar-month keys, 1–15 month years), `budgetReportYear.ts`

**Its consumers:**

- `getBudgetVariance`: `pages/api/accounting/reports-budget-comparator.ts`, `src/lib/mcp/tools/budgetVariance.ts`, `src/modules/accounting/services/packs/figures/packFigureSet.ts`, and the type in `src/lib/apiRoutes.ts`.

**Statement stack.** Read every sibling `.claude.md` before touching it:

- `src/modules/accounting/services/reports/statementRows/`: `statementModel.ts`, `incomeStatementRows.ts`, `comparators.ts`. Its `.claude.md` sets "copy, never derive" and allows exactly three exceptions; derive in the engine, not the adapter.
- `src/components/accounting/statement/`: `StatementGrid.tsx`, `StatementRowView.tsx`.
- `src/components/accounting/reportControls/`: `useStatementComparatorState.ts` holds the dims gate; `useStatementComparators.ts`; `ComparatorNotices.tsx`.

**Charts.** All live in `src/components/accounting/charts/` (rules in its `.claude.md`):

- `ibcs.ts` `varianceColor` / `roleStyle`, `escapeHtml.ts`, `ChartFrame.tsx`
- `ProfitWaterfall.tsx` + `waterfallOption.ts`. The step type is in `services/reports/waterfallDataService.ts`.
- `BudgetBulletRow.tsx` + `bulletOption.ts`
- `SmallMultiples.tsx`

**Dimensions:**

- `incomeStatementService.ts`: `cost_centre_id` matches `cc1_id OR cc2_id`.
- `dimensionPnlService.ts`: `fetchDimensionAccountRows`, the UNTAGGED column. This is the invariant oracle for the cc filters.
- `gl/dimensions/dimensionDerivation.ts`: `deriveFnoId` and `loadCostCentreChains` (CC2 → FNO).
- The dimension tables are `cost_centres` (`cc_type`, `parent_id`) and `business_units`.

**Drill:**

- `src/components/accounting/AccountDrillDown.tsx`
- `pages/api/accounting/reports-account-transactions.ts` (has `cost_centre_id` and `business_unit_id` only)

**Packs:**

- Board pack: `packs/figures/packFigureSet.ts` (budget fetched, never printed), `packs/pages/packStatementRows.ts` (`columnsFor`), `packs/pages/packTableModel.ts` (`'budget'` and `'variance'` keys unused), `packs/pages/boardPackDocument.ts`. The integrity rules are in `packs/figures/.claude.md`.
- Management pack: `afs/managementPackConfigService.ts` (`comparisonMode`, `income_vs_budget`, `budget_variance` stored but unread), `afs/managementPackGeneratorService.ts` (`renderSection` has no budget case), `components/accounting/management-packs/ManagementPackConfigTab.tsx`.
- Presentation: `pages/accounting/reports/present/[pack].tsx`, `components/accounting/present/PresentSlide.tsx`.

**Test patterns:**

- Painted chart labels: `tests/unit/services/packs/packChartAxisLegibility.test.ts`, `packWaterfallLegibility.test.ts`, `tests/unit/print/ratioTrendTicks.test.ts`.
- MCP contract: `tests/unit/mcp/budgetVarianceTool.test.ts`.
- Comparator rules: `tests/unit/services/reports/statementRows/comparators.test.ts`. This is the ONE file for that module; extend it.

## 2a. Product decisions already made — build them, do not re-ask

- **Contract decisions 1–6** (`00-shared-contract.md`), in particular:
  - readers use the **primary** version unless `version_id` is passed;
  - one grain per account per version, so roll-ups never double count;
  - prod validation writes only into ISAFlow Demo, via the UI, after an approved deploy.
- **Contract "Variance sign" / spec §2.1:** every human-facing surface prints `Var R = actual − budget` (P0's `movement`) with polarity colour via `favourable`. MCP keeps its favourably signed `variance` and carries `movement` + `favourable` (P0).
- **Spec §2.2:** windows are whole months for budget and actuals alike (P0's rule; the in-progress month runs to its month end, flagged with "posted through").
- **Contract ownership:** P3 owns the one actuals SQL (`budgets/tracking/trackingActualRead.ts`); PR-C retires P0's `budgetWindowActuals.ts`, PR-B retires P0's `BudgetVsActualTable.tsx`, `budgetVsActualCsv.ts` and the old routes. If P2's `budgets/priorActuals.ts` is on master, PR-B (not the greenfield PR-A) makes it delegate to `trackingActualRead.ts`.
- **Spec §2.1:** "—" for unbudgeted (`Comparison.absent`). A budgeted zero prints 0.
- **Spec §2.2:** custom ranges are month-granular. A day-level custom date is a 400.
- **Spec §2.3:** the projection cutoff is the last complete month, and the in-progress month contributes its budget.
- **Spec §2.4:** a coarser-grain budget is never apportioned under a filter. It is shown as "unallocated", with a link to the unfiltered view.
- **Spec §2.5:** a cross-FY window uses each FY's primary. An explicit `version_id` outside the window's FY is a 400.

Spec §10 Q1–Q2 are open for Hein. Build the bold default and list them in the PR-B body.

## 3. PR-A — tracking engine (greenfield) [agent decides internals within spec §3]

- **Scope:** spec §3 module shape (`services/budgets/tracking/*` NEW, `statementRows/budgetTrackingRows.ts` NEW), the routes `reports-budget-tracking.ts` and `budget-tracking-export.ts` (NEW), the heatmap (NEW), and spec §2/§4 semantics.
- **No existing file is edited.** If one must be, the edit moves to PR-B.
- **TDD:** write each test in spec §6 (unit and integration rows for T1–T7) first, run it red, then implement.
- **Rules:**
  - `company_id` on every query; `sql` tagged template only.
  - Version and dimension ids are looked up under `company_id`. A miss is a 404.
  - Queries run sequentially under `withAuth` (one pg client; see the `packFigureSet.ts` header).
  - `round2` on money; `null` = absent, never 0.
  - Every tooltip goes through `escapeHtml`; colour comes only from `varianceColor`.
  - ≤300 lines per file; `.claude.md` for the new module.
- **Gate:** greenfield. Once `bun run ci` is green, the GitHub integration job is green, and a blind `/review` plus a security review pass on the final head with every finding fixed, run `mq-isa add <N>`.

## 4. PR-B — BvA cut-over [Confirmation Gate: Hein reads the diff]

- **Scope:** spec T8–T10.
  - `statementModel.ts` additive fields (`Comparison.absent`, `StatementRow.projection`, `StatementColumns.projection`) and grid cells. Every other surface's output must stay identical (snapshot test).
  - Rewrite the page using NEW `src/components/accounting/budgets/tracking/*`; page ≤300 lines.
  - Add `cc1Id`/`cc2Id` to `AccountDrillDown` and `cc1_id`/`cc2_id` to `reports-account-transactions.ts`, both additive.
  - Add the transaction → source-document link. Census for an existing helper first; only if none exists, add NEW `src/lib/journalSourceHref.ts`.
- **Old routes:** remove `reports-budget-vs-actual.ts` and `budget-vs-actual-export.ts` only if a census across `src pages tests scripts docs` finds no other consumer. Update the tests spec §6 lists.
- **Nav:** the entry stays (`navSections/reports.ts`, `navSections/accountants.ts`). No new page, so no nav change.
- **Browser proof:** load the real page on dev in dark and light, at 1280 and 390, and say what you saw. Screenshots go to `docs/evidence/budgets/P3/` (NEW).

## 5. PR-C — comparator + facade [Confirmation Gate: Hein reads the diff]

- **Facade:** `getBudgetVariance` gains optional `{versionId, cc1Id, cc2Id, buId, costCentreId}` and delegates to the engine. With no options its output must deep-equal the pre-facade (P0 + P1) result: `budget-variance-facade-parity.int.test.ts` uses the merge-base `loadWindowActuals` / `loadWindowBudgets` SQL as its oracle. Delete `reports/budgetWindowActuals.ts` once nothing imports it.
- **Comparator route:** add the params from spec §4. `cost_centre_id` keeps its either-level meaning; `business_unit_id` is an alias of `bu_id`.
- **Un-gate:** `useStatementComparatorState` stops forcing `budget: false` under a dimension. **The trend stays gated.**
- **Notices:** `ComparatorNotices` gains the unallocated sentence.
- **D7:** already fixed by P0 (precondition); keep P0's test as is.
- **Present deck:** `PresentSlide` and `present/[pack].tsx` pass the version.
- **Nothing else goes in this PR.**

## 6. PR-D / PR-E / PR-F [Confirmation Gate each: Hein reads the diff]

- **D — management pack:** `comparisonMode` honoured, and the `income_vs_budget` / `budget_variance` sections rendered from the engine (spec §4 Packs). Test: `managementPackComparisonMode.test.ts`.
- **E — board pack:** Budget and Variance columns when `set.budget !== null`, with provenance on every figure; `assertPackIntegrity` stays green; an adversarial reviewer is required. After two review rounds with comparable finding counts, write simplify / harden / revert into the PR body for Hein's diff read.
- **F — MCP:** optional `version_id`, `cc1_id`, `cc2_id`, `bu_id`. With no new args the output is byte-identical (baseline test). The description adds the spec §2.4 rules and the version default to P0's wording.

Order: A, then B and C (each after A); D, E and F after C, one at a time.

## 7. Success criteria

- [ ] §0 precondition evidence (the grep output) is in the PR-A body, together with any P0/P1 name drift found.
- [ ] Every test named in spec §6 exists and is green. For each one, its listed mutation was applied, went red, and was reverted. The red and green log paths are in the PR body, under `/home/hein/.cache/redchk/budgets-p3/`.
- [ ] `budget-tracking-is-invariant.int.test.ts` covers {every month, Q1–Q5 of a 14-month FY, YTD, FY, 3 customs incl. cross-FY} × {none, cc1, cc2, bu, cc1+bu, cc2+bu} and runs on GitHub's integration step (not skipped).
- [ ] The export parity test (CSV/XLSX === JSON) is green.
- [ ] `tests/e2e/golden-paths/<next free letter>-budget-tracking.spec.ts` is green on dev, with screenshots in dark and light at 1280 and 390, and is listed in `playwright-golden.config.ts`'s `testIgnore` regex (dev-only: it asserts seeded figures and must never run in prod verify against Demo; contract golden-spec rule).
- [ ] `bun run ci` is green and pre-push passes for every PR. The GitHub integration job is green.
- [ ] A blind `/review` plus a security review has run on each final head, with every H/M/L finding fixed. PR-E also has an adversarial review.
- [ ] PR-A is queued with `mq-isa add`. PRs B–F are opened and listed for Hein's diff-read, each body stating "modifies existing production paths: <list>".
- [ ] `.claude.md` files are updated (spec §8.4) and `bun run agent-docs:generate` has been run.
- [ ] A handoff is written. It contains the after-hours prod deploy request for Hein, and the ISAFlow Demo validation script from spec §8.2 for after that deploy. The worktree is removed and the clusters are stopped.

## 8. Confirmation gates — STOP and ask Hein (the contract's human gates, nothing else)

- Any migration, including an index P1 did not create.
- `mq-isa add` for PRs B, C, D, E and F: Hein reads each diff first.
- Any production deploy (`bash scripts/deploy.sh` is never run by this session); hand Hein the after-hours request. Prod validation on ISAFlow Demo happens only after Hein's approved deploy, via the UI.
- Outbound email/notifications, and any read or write of production or non-Demo company data. On `isaflow_dev`, seed only your own test company, then report it.

**Never do (not gates):** apportion a coarser budget across members; change the either-level meaning of the existing `cost_centre_id` filter; change the MCP tool's default output or its `figureBasis`; re-fix P0's defects. If PR-E review rounds keep returning comparable finding counts, scope back to the spec and lay out simplify / harden / revert in the PR body for Hein's diff read.

## Rules (CLAUDE.md, restated)

- **Worktree per PR:** `git worktree add -b feat/budgets-p3-<slug>-20261026 /home/hein/Workspace/IsaFlow-wt-budgets-p3-<slug> origin/master`. Link `node_modules` with `cp -al`, never `ln -s`. `cd` into the worktree on every Bash call.
- **Git:**
  - Never commit to master.
  - Stage explicit paths; no `git add -A`.
  - No `git stash`, no `--no-verify`, no amend or force-push.
  - Merge only through `mq-isa add <N>`; never `gh pr merge`.
  - Push at load < 25 (`uptime`), in the background.
- **Code:**
  - Wrap handlers in `withAuth(withErrorHandler(...))`; respond with `apiResponse`.
  - `log`, never `console`. No empty catch.
  - No `any` beyond what Next.js patterns require.
  - Money: `formatStatementFigure` / `formatPct` on statements, `formatMoney` elsewhere.
  - Dates: handle both `Date` and `string`; never build a `Date` to read a month (`budgetPeriodWindow.ts` header).
- **Tests:**
  - Integration suites run with `CI_INTEGRATION=1 bun run ci` locally, or on GitHub.
  - A missing test path shrinks a vitest run silently; check the "Test Files" count.
  - Do not edit the tree while a gate run is in flight.
- **Artefacts:** in `/home/hein/.cache/redchk/budgets-p3/`, never `/tmp`.
- **Process:**
  - No pattern kills.
  - Subagents never edit memory.
  - A subagent's self-report is not evidence; re-run the check yourself.
