# /goal — Budgets P6: balance-sheet & cash budgets (three-way) + scenarios, behind a Demo-only flag (run autonomously until DONE)

> **How to use:** start a fresh session **on Opus** in `/home/hein/Workspace/IsaFlow` and run:
>
> `/goal Execute .claude/handoffs/2026-10-26-budgets-P6-three-way-goal.md to completion. Answer §0 with Hein first, then work autonomously through Engine (TDD, hand-computed fixtures, red first) → Migration (stop at gate) → Readers/API → UI → Review → Fix loops. Do not stop to ask, except at §0, a Confirmation Gate (§8) or a genuine external blocker. Loop until every Success Criterion (§7) is proven with evidence, then open the PRs, queue the eligible ones with mq-isa, write a handoff and stop.`

**Precondition:** P1, P2, P3 and P4 are merged on `origin/master` (contract "Preconditions"):
`git ls-tree -r --name-only origin/master | grep -F -e src/modules/accounting/services/budgets/budgetVersionScope.ts -e src/modules/accounting/services/budgets/gridSave.ts -e src/modules/accounting/services/budgets/tracking/trackingActualRead.ts -e src/modules/accounting/services/budgets/drivers/driverEngine.ts`
lists all four, and `git grep -q budget_driver_lines origin/master -- scripts/migrations/sql` succeeds. If not, STOP and report.
**Refresh first:** re-read `docs/plans/budgets/P6-three-way-spec.md` against what the MVP (P0–P3) taught on Demo
(handoffs since 2026-10-26, Hein's feedback). Where feedback contradicts the spec, feedback wins; write the change into spec §13.

## 0. Phase-start decision gate — decision 10 (ask Hein once, pre-filled; he answers yes/override)

> Defaults (build these unless Hein overrides):
> - **10** Cash timing from **actual** debtor/creditor/inventory days, derived at the opening date, editable per version. VAT and PAYE paid on **SARS due dates** (VAT: month after the VAT period ends, per company cadence + alignment; EMP201: 7th of the following month). **Not client-visible** until Hein reviews on ISAFlow Demo — flag `budgets_three_way`, off for everyone but Demo.
> - **10a** Opening BS = actual BS the day before the first budget month; if that is in the future, latest actual ≤ today with a "provisional opening" banner.
> - **10b** Provisional tax for companies: 50 % of FY budgeted tax in month 6, balance in month 12; prior-year balance in the top-up month (6 months after a Feb YE, else 7). Non-companies: off.
> - **10c** P&L budget is the only authority for depreciation, interest and tax; asset register and loan schedules are warning checks only.
> - **10d** Negative cash is shown, never auto-funded.

Record the answer verbatim in the PR body and spec §1. Then verify, before coding: SARS VAT category ↔ alignment and the IRP6 top-up month (spec §1, §11 R2). If a source contradicts a default, tell Hein in one line and take his ruling.

## 1. Mission
Derive a budgeted balance sheet and cash-flow statement, month by month, from a budget version's P&L plus
working-capital, VAT, payroll-tax, income-tax, capex, loan and equity assumptions, starting from the actual
balance sheet. Add scenarios (versions of kind `'scenario'` with sparse assumption overrides) and a compare
view with a cash-runway chart.

"Real" means: a pure TS engine in integer cents that emits balanced double-entry postings; the budgeted BS
balances to the cent every month; closing cash equals opening cash plus the cash flow; direct and indirect
operating cash flow agree; fixtures F1–F7 (spec §10) pass to the cent; each mutation M1–M10 turns a named test red.
Real-PG integration tests for the readers, the assumptions table, the lock and tenant isolation. No mocked SQL in evidence.

## 2. What exists — do NOT redo (verified on origin/master 2026-10-26)
- Actual BS: `src/modules/accounting/services/reports/balanceSheetService.ts` (lines keyed by `accountCode`; retained earnings is a derived plug — read its header).
- Subtypes/bands: `src/modules/accounting/services/gl/accountSubtypes.ts`, `gl/accountSubtypeVocabulary.ts`, `gl/accountClassification.ts`, `gl/balanceByAccountType.ts`.
- Cash groups: `src/modules/accounting/services/afs/cashFlowClassification.ts`; cash balance `src/modules/accounting/services/bank/cashBalanceService.ts`.
- Actual cash-flow report: `pages/api/accounting/reports-cash-flow.ts`, `pages/accounting/reports/cash-flow.tsx`. The AI cash forecast (`src/modules/accounting/services/reports/cashFlowForecastService.ts`, `pages/accounting/reports/cash-flow-forecast.tsx`) is a different product: do not touch or merge.
- Days definitions: `src/modules/accounting/services/reports/ratioCalculations.ts`; aging `src/modules/accounting/services/ar/arAgingService.ts`, `src/modules/accounting/services/ap/apAgingService.ts`.
- VAT: `src/modules/bureau/services/vatPeriodHelper.ts`, `src/modules/accounting/services/core/companyMapper.ts`, `src/modules/accounting/services/reports/vatBoxBasis.ts` (`SA_VAT_RATE`). `src/modules/accounting/services/reports/sarsTaxPeriodsService.ts` is reference only (Feb-YE IRP6; opposite alignment meaning).
- EMP201: `src/modules/accounting/services/reports/emp201Service.ts`.
- Assets: `src/modules/accounting/services/items/depreciationSchedule.ts`, `items/assetRegisterService.ts`.
- Loans: `src/modules/accounting/services/loans/loanScheduleService.ts` — `previewSchedule` only (never `getOrComputeSchedule` on a read path); `src/lib/amortisation/engine.ts`; gotchas in `src/modules/accounting/services/loans/.claude.md`.
- Fiscal years: `src/modules/accounting/services/gl/fiscalYearRegistry.ts`. Money: `src/lib/money/decimalSum.ts`, `src/lib/format/money.ts`.
- Flags: `src/modules/admin/services/featureFlagService.ts`, `src/modules/admin/middleware/withFeature.ts`, `src/components/admin/FeatureGate.tsx`, `pages/api/features/check.ts`; flag insert pattern `scripts/migrations/sql/263_admin_platform_features.sql`.
- UI: `src/components/accounting/statement/StatementGrid.tsx`, `src/components/accounting/charts/CashPositionChart.tsx`, `charts/ibcs.ts`, `charts/escapeHtml.ts`; nav `src/components/accounting/navSections/accounting.ts`, `navSections/accountants.ts`, `src/components/accounting/AccountingNav.tsx`.
- P1–P4 (merged by precondition; names from their specs, confirm on master): P1 `budget_versions`, versioned `budget_month_amounts`, `src/modules/accounting/services/budgets/` + `.claude.md`, lock trigger `public.budget_month_amounts_refuse_locked()`, `budgetVersionScope.ts` `lockVersionForWrite`, `budgetVersionTypes.ts` `mapBudgetDbError`; P2 version copy +x% (`POST /api/accounting/budget-grid/seed`) and `VersionsBar.tsx`; P3 `budgets/tracking/trackingActualRead.ts` and `budgets/tracking/budgetTrackingService.ts` (NP for I5); P4 `budgets/drivers/driverEngine.ts`.

## 2a. Product decisions already made (do not re-ask)
Contract decisions 1–6 (approve/lock roles, locked = DB-immutable, one grain per account, rounding, Demo-only prod validation via the UI) plus §0 above. Scenarios are `budget_versions.kind = 'scenario'`; their P&L amounts come from P2's "copy another version +x%"; P6 adds only assumption overrides. Company level only; no dimensions on BS/CF.

## 3. Engine — pure TS [agent decides internals; spec §5 is the algorithm]
- NEW `src/modules/accounting/services/budgets/threeWay/`: `types.ts`, `assumptionsSchema.ts`, `daysMethod.ts`, `vatSchedule.ts`, `statutorySchedule.ts`, `postings.ts`, `engine.ts`, `cashFlow.ts`, `compare.ts`, `.claude.md` (+ `bun run agent-docs:generate`). Each file < 300 lines.
- Integer cents; every posting asserts Σdr = Σcr; derived flows are residuals (`open + inflow − close`) so rounding can never unbalance.
- `vatPeriodOf` must reproduce `vatPeriodHelper` semantics — pin with a table test over 12 months × {monthly, odd, even}.
- Opening unbalanced > 1 cent → typed `OpeningUnbalancedError`; no plug.
- Tests FIRST (`tests/unit/services/budgets/threeWay/`, NEW): F1–F7 to the cent, invariants I1–I4, I6, I8, seeded property test (500 cases).

## 4. Schema — one migration [Confirmation Gate]
- NEW `scripts/migrations/sql/<next-free>_budget_three_way_assumptions.sql` per spec §6: table, unique `(company_id, version_id)`, forced RLS like `budget_month_amounts`, company-match trigger, lock trigger (reuse P1's), grants per the 945/946 app-pool rules, `feature_flags` row `budgets_three_way` (`is_global = false`). `IF NOT EXISTS`; re-check the prefix at commit time.
- Prove on the GitHub integration step (non-superuser): app_user write on a locked version refused (I9); other tenant invisible (I10).

## 5. Readers, service, API [agent decides internals]
- NEW `budgets/threeWay/openingBalances.ts`, `actualsLookback.ts`, `deriveAssumptions.ts`, `loanInputs.ts`, `assumptionsRepo.ts`, `threeWayService.ts`. `sql` from `@/lib/neon`, `company_id` on every query and join, `log` not console, no empty catch.
- I7 parity (real PG): opening bucket totals = `getBalanceSheet` totals; cash = `getCashBalance`. I5: NP = P3's reader for the same version.
- NEW routes `pages/api/accounting/budget-three-way/{index,assumptions,derive,compare}.ts` (the P1/P2 folder style): `withAuth(withErrorHandler(...))` + `withFeature('budgets_three_way')`, `apiResponse`, zod 400, 409 on stale `updated_at`, typed refusal on locked, audit `entity='budget'`. Route tests: 400/403/404/409/locked.

## 6. UI [agent decides layout within spec §8]
- NEW `pages/accounting/budgets/three-way.tsx` in `FeatureGate`; NEW components under `src/components/accounting/budgets/threeWay/`.
- Runway chart (`CashPositionChart`), BS and CF tabs on `StatementGrid`, assumptions panel with derived/manual chips and derive evidence, compare (≤ 3 versions). `formatStatementFigure`/`formatPct`; colours only via `ibcs.varianceColor`; tooltips via `escapeHtml`.
- Nav entry under Budgets, hidden unless the flag is on (feature filter in `AccountingNav.tsx` — existing code → Hein reads that PR's diff).
- Browser proof on dev: dark and light, 1280 and 390, screenshots under `docs/evidence/budgets/p6/` (NEW).
- Golden spec NEW `tests/e2e/golden-paths/<next free letter>-budgets-three-way.spec.ts` (spec §10), **dev-only**: add its file name to `playwright-golden.config.ts`'s `testIgnore` regex (contract golden-spec rule; it needs the flag and writes assumptions, so it must never run in prod verify against Demo). Prove it with `GOLDEN_SKIP_A11Y=1 bunx playwright test --config playwright-golden.config.ts --list`.

## 7. Success criteria
- [ ] §0 answered by Hein, recorded in the PR body and spec §1; spec §13 updated from MVP feedback.
- [ ] F1–F7 pass to the cent; I1–I10 have tests; I5, I7, I9, I10 run on real PG (GitHub integration step green).
- [ ] M1–M10 each turn a named test red, then green when restored — logs under `/home/hein/.cache/redchk/budgets-p6/`, paths in the PR body.
- [ ] `bun run ci` green on every PR head; GitHub `quality` + integration green.
- [ ] Blind `/review` and a security review SHIP on each final head; adversarial review on the migration PR (RLS, lock trigger, grants). Every H/M/L finding fixed.
- [ ] Playwright acceptance green with screenshots (dark/light × 1280/390); flag off → API 403 and no nav item (tested).
- [ ] PRs opened (A engine · B migration · C readers/API · D UI); A queued via `mq-isa add` if all gates are green (greenfield); B, C, D queued only after Hein's OK / diff read.
- [ ] Handoff written: PR numbers, mutation evidence, the R2 VAT-alignment disagreement, the after-hours deploy request, and Hein's Demo review checklist (enable flag on Demo via admin.isaflow.co.za; check one month's BS, VAT payment month, EMP201 month, runway).

## 8. Confirmation gates — STOP and ask Hein (the contract's human gates, nothing else)
- §0 decision 10 (at start, including the one-line source check it names).
- The migration (before merge).
- PRs that modify existing production code paths (nav filter, anything outside the new module/routes/page) before `mq-isa add`.
- Outbound email/notifications; any read or write of production or non-Demo company data; any deploy (`bash scripts/deploy.sh` is never run by this session; hand Hein the after-hours request).

**Never do (not gates):** enable the flag for any company (Hein's act, via admin.isaflow.co.za; list it in the handoff); change `sarsTaxPeriodsService`, `vatPeriodHelper`, the AI cash forecast, or any P1–P4 behaviour; scope beyond spec §3 (refuse and note for a later phase). If review rounds keep surfacing new engine defects, scope back to the spec and say so in the PR body.

## Rules
- **Worktree:** `git worktree add -b feat/budgets-p6-three-way-<date> /home/hein/Workspace/IsaFlow-budgets-p6 origin/master`, then `cp -al` node_modules (never `ln -s`). `cd` into it on every Bash call. One branch per PR, stacked on the previous if needed.
- **Git:** never commit to master; stage explicit paths, no `git add -A`; no `git stash`; no `--no-verify`; no amend or force-push. Merges only via `mq-isa add <PR>`; never `gh pr merge`.
- **Repo law:** `company_id` on every query; `sql` tagged template; `withAuth(withErrorHandler(...))`; `apiResponse`; `log`; no empty catch; ≤ 300 lines/file; TDD; migrations `IF NOT EXISTS`, next free prefix, never edit an applied one; nav updated; `.claude.md` + `bun run agent-docs:generate`.
- **DB:** dev is `isaflow_dev`; never prod. Integration runs on GitHub; locally `CI_INTEGRATION=1 bun run ci`.
- **Artefacts:** `/home/hein/.cache/redchk/budgets-p6/`, never `/tmp`.
- **Process:** no edits while a test run is in flight; no pattern kills; subagents never edit memory; push at load < 25 (`uptime`), in the background.
