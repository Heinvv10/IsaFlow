# /goal: Budgets P0, one row model with correct signs, sections, periods and CSV parity (run autonomously until DONE)

> **How to use:** start a fresh session **on Opus** in `/home/hein/Workspace/IsaFlow` and run:
>
> `/goal Execute .claude/handoffs/2026-10-26-budgets-P0-correctness-goal.md to completion. Work autonomously through Spec → Build (TDD) → Integrate → Acceptance → Review → Fix loops. Do not stop to ask, except at a Confirmation Gate (§8) or a genuine external blocker. Loop until every Success Criterion (§7) is proven with evidence, then open the PR, write a handoff and stop.`

## 1. Mission
Make every budget figure IsaFlow prints correct on today's schema (no migration). Screen, CSV, MCP and the statement Budget column must read **one row model**.

The spec is `docs/plans/budgets/P0-correctness-spec.md`. It holds the verified defect table D1–D14 with file:line, the row model, period rules, CSV shape, task DAG, tests and mutations. Read it first. This file restates only what you must not get wrong.

- **Sections.** BvA gets Revenue / Expenses / **Net profit** sections. The meaningless revenue+expense totals go (D1, D10, D11).
- **Variance %.** It is `null` when there is no budget or the budget is zero. It renders "—", never "−100%" (D2, D6). A negative budget divides by its absolute value.
- **Zero budgets.** A deliberate zero budget is *budgeted*. Lines carry `budgeted: boolean` (D5).
- **CSV.** The export is built from the same result as the screen. It has no SQL of its own, no `ga.level = 3`, and no `budget − actual` for revenue (D3, D14).
- **Sign and colour.** Screen and CSV print `movement` = actual − budget (and `movement_pct`) for every line, section and NP; the existing favourably signed `variance` stays on the row model for MCP, bullets and the NP invariant (contract "Variance sign"). Favourable/unfavourable comes from the `favourable` boolean via `ibcs.varianceColor` only. The progress bar follows account polarity (D4).
- **Periods** (D8, D12):
  - The page defaults to `ytd`.
  - `current` = the whole fiscal period holding today.
  - `ytd` ends at the end of today's month (capped at FY end), so budget months and actual days match.
  - An unknown `period` is a 400.
- **Statement comparator (D7).** Budget variance = the row's printed `actual` − budget.
- **Budgets page** (D9, D13):
  - Delete asks first.
  - The Add picker offers active **leaf** revenue/expense accounts only.
  - Edit works for an account that has since become inactive or a header.
  - The server refuses a budget on a balance-sheet account.
- **BudgetForm inputs: NOT in P0.** PR #871 (`fix/budgetform-moneyfield-20261026`, queued) replaces the annual and month inputs with the kit `MoneyField`, which fixes the borderless inputs. Do not edit `BudgetForm.tsx` amount inputs or `budgetFormValidation.test.tsx`; rebase on #871 once it merges. The account `<select>` still uses the undefined `ff-select`; leave it, because P2 replaces the page.

"Real" means a real-PG parity test proves screen JSON = CSV = MCP to the cent on a fixture that exercises every defect, and each listed mutation turns it red. No mocked SQL in the evidence.

## 2. What exists — do NOT redo (all paths on `origin/master`)
- **Window + budgets:**
  - `src/modules/accounting/services/reports/budgetWindowService.ts` (`resolveBudgetWindow`, `loadWindowBudgets`)
  - `budgetPeriodWindow.ts` (month keys, whole-month rule)
  - `budgetReportYear.ts` (chosen `fiscal_year`, 404/400)
  - Keep all their behaviour except §2.2 of the spec.
- **Pure line builder:** `src/modules/accounting/services/reports/budgetVsActualLines.ts`. Extend it; do not fork it.
- **Service:** `src/modules/accounting/services/reports/budgetVarianceService.ts` (`getBudgetVariance`). It becomes the single loader for the report, export, MCP and comparator.
- **Routes:**
  - `pages/api/accounting/reports-budget-vs-actual.ts`
  - `pages/api/accounting/budget-vs-actual-export.ts`
  - `pages/api/accounting/reports-budget-comparator.ts`
  - `pages/api/accounting/budgets.ts`
  - `pages/api/accounting/budgets-action.ts`
- **MCP:** `src/lib/mcp/tools/budgetVariance.ts`
- **Comparator:**
  - `src/modules/accounting/services/reports/statementRows/comparators.ts`
  - Consumers: `src/components/accounting/reportControls/useStatementComparators.ts`, `src/components/accounting/present/PresentSlide.tsx`, `src/components/accounting/charts/bulletOption.ts`
  - Response type: `src/lib/apiRoutes.ts`
- **Pages:**
  - `pages/accounting/reports/budget-vs-actual.tsx`
  - `pages/accounting/budgets/index.tsx`
  - `src/components/accounting/budgets/BudgetForm.tsx`
  - `src/components/accounting/budgets/budgetClient.ts`
- **Reuse, don't rebuild:**
  - `src/components/accounting/charts/ibcs.ts` `varianceColor` + `useChartPalette` (`src/components/accounting/charts/ChartFrame.tsx`)
  - `src/lib/chartAccountOptions.ts` `leafAccountOptions` (needs `includeInactive=true` data)
  - `src/components/ui/ConfirmDialog.tsx` (`tone="destructive"`)
  - `src/lib/money/formatMoney.ts`, `src/lib/format/money.ts` `formatPct`, `src/lib/csv.ts` `csvVal`
  - `src/modules/accounting/services/gl/fiscalYearRegistry.ts` `periodForDate`
  - The input-class pattern in `src/components/accounting/createEntity/styles.ts`
- **Tests that pin today's behaviour and MUST be changed deliberately (not deleted):**
  - `tests/unit/services/reports/budgetVsActualLines.test.ts` (the `-100` case becomes null)
  - `tests/unit/api/balanceQueryGuards.test.ts:156-164` (export "keeps the level-3 leaf filter" becomes "reads the same actuals as the report")
  - `tests/unit/services/budgetWindowChosenYear.test.ts:27-29` (ytd to today becomes to the end of today's month)
  - `tests/integration/budgets-report-year.int.test.ts:130,142-160` (old CSV shape)
  - `tests/unit/mcp/budgetVarianceTool.test.ts` (the fixture's `variance_pct` formula and totals)
  - The fixtures in `tests/unit/components/budgetVsActualRange.test.tsx`, `budgetVsActualDrillOnce.test.tsx`, `d2CensusG3a.test.tsx`, `d2R3a2ReportLoads.test.tsx` (`total_*` becomes `sections`)
- **Integration harness:** `tests/integration/budgets-report-year.int.test.ts` + `tests/integration/helpers/budgetsRouteFixture.ts` call the real handlers against a disposable schema. Copy that pattern.

## 2a. Product decisions already made (do not re-ask)
- **The one row model and its rules** are fixed in spec §2.1. Highlights:
  - Unbudgeted lines keep a numeric variance and movement, so sections foot. Their budget and % show "—", and they get no colour.
  - Printed sign = `movement` (actual − budget); MCP keeps the favourably signed `variance` and also carries `movement` + `favourable`.
  - NP variance = Σ line variance.
- **Period semantics** are fixed in spec §2.2. Whole-month alignment, page default `ytd`, posted-through shown. Hein may override `ytd` at diff review. That is a one-line change, so build as specified.
- **MCP `totals` is redefined as net profit** and gains `sections`. Say so in the tool description and the PR body.
- **The report response drops `total_budget/total_actual/total_variance`** for `sections`. The census found only the page and tests as consumers.
- **Services stay in `services/reports/`.** P1 owns the move to `services/budgets/`.
- **The global `ff-input` gap (62 files) is NOT fixed here.** Only BudgetForm. List it in the handoff.

## 3. Row model + sections + one loader [agent implements per spec §2.1, §3]
- **Code:**
  - `budgetVsActualLines.ts` gets `account_id`, `budgeted`, `variance_pct: number|null`, `movement`, `movement_pct: number|null`, `favourable: boolean|null`, and the keep-rule `budgeted || actual ≠ 0`.
  - NEW `budgetVsActualSections.ts`.
  - NEW `budgetWindowActuals.ts` holds the one actuals SQL (company_id on lines and entries, posted, `YEAR_END_JOURNAL_SOURCE` excluded, no `is_active`, no `level`).
  - `getBudgetVariance` uses it and returns `lines`, `rows` (budgeted), `unbudgeted`, `sections`, and `totals` (= NP).
- **Prove:** the unit tests in spec §5 are red first, then green. `git grep -n "credit_less_debit" -- pages src` shows the budget readers only in `budgetWindowActuals.ts`.

## 4. Report, CSV, MCP, comparator [agent implements per spec §2.4, §2.5, §2.7]
- **Report and export.** Both call `resolveBudgetWindow` → `getBudgetVariance`. The export renders with NEW pure `budgetVsActualCsv.ts`, in the shape of spec §2.4. Both answer 400 on an unknown period.
- **MCP.** Zero budgets become rows. Add `sections`. `totals` = NP. Correct the description.
- **Comparator (D7).** `variance = round2(row.actual − line.budget_amount)`, and `favourable` follows `line.account_type`.
  - **Before coding**, confirm the sign of an expense row's `actual` in `src/modules/accounting/services/reports/statementRows/incomeStatementRows.ts`, and pin it in a test.
  - If expenses print negative there, normalise. Do not double-negate.
- **Prove:** NEW `tests/integration/budgets-bva-parity.int.test.ts`, with the fixture and cases from spec §5. Parse the CSV and compare it to the JSON and to MCP to the cent. Check the actuals per type against an independent SQL sum in the test.

## 5. Pages [agent implements per spec §2.3, §2.6]
- **BvA page.**
  - Default `ytd`. Labels "This period" / "Year to date" / "Full year". Posted-through line.
  - NEW `src/components/accounting/budgets/BudgetVsActualTable.tsx` renders the sections, lines, bar and drill-down. It keeps `AccountDrillDown` and the in-flight join.
  - Colours via `varianceColor`. Money via `formatMoney`, % via `formatPct`. Null shows "—".
- **Budgets page.**
  - NEW `src/components/accounting/budgets/useBudgetAccounts.ts` feeds `leafAccountOptions` (revenue + expense).
  - `ConfirmDialog` on delete.
  - Split totals: revenue, expenses, net budgeted profit.
  - The edit form takes its account from the `BudgetRow`.
- **BudgetForm.** A local bordered token input class. Keep every existing `data-testid`.
- **Server (D13).** `upsertBudget` refuses a non-revenue/expense account with `BudgetInputError` (400) before any write.
- **Every touched file ≤ 300 lines.**

## 6. Docs
- Add a 2026-10-26 entry to `src/modules/accounting/services/reports/.claude.md` covering the row model, the period rule, the CSV shape, MCP totals = NP, and D7.
- Run `bun run agent-docs:generate`, then check that `bun run agent-docs:check` is clean.
- No nav change: there are no new pages.

## 7. Success criteria
- [ ] Every test in spec §5 exists, was red before its fix, and is green on the final head. For each mutation listed there:
  - apply it to production code
  - the named test goes red
  - restore it (copy a backup or commit first; never `git checkout` over the fix)
  - Log paths go in the PR body.
- [ ] `budgets-bva-parity.int.test.ts` is green on a disposable PG16 cluster (`CI_INTEGRATION=1 bun run ci` or the redchk harness) and in the GitHub integration job.
- [ ] Playwright acceptance on dev `:3200` (reporting-qa user), on a company seeded with the spec §5 fixture shape through the UI or the dev API:
  - `/accounting/reports/budget-vs-actual` shows Net profit, "—" for unbudgeted %, the favourable colour on revenue over budget, and the `ytd` default.
  - `/accounting/budgets` shows a bordered month input, the delete confirmation dialog, and split totals.
  - Screenshots in **dark and light** at **1280 and 390**, each described in words in the PR.
- [ ] The downloaded CSV opened from that page matches the page's figures. Quote one revenue row, one expense row and Net profit in the PR.
- [ ] `bun run ci` is green and the pre-push hook passes.
- [ ] Blind `/review` and a security review both SHIP on the final head. Every H/M/L finding is fixed. Use the adversarial ledger reviewer too: this touches money figures.
- [ ] PR opened on branch `fix/budgets-p0-correctness-20261026`. The body holds the defect table (spec §1), the mutation log, the screenshots, and the MCP `totals` semantic change.
- [ ] **Stop at the gate:** Hein reads the diff. Do NOT `mq-isa add` until he says so.
- [ ] Handoff written: what shipped, the open `ff-input` UI ticket, and the `ytd` override option. Worktree left clean, clusters stopped.

## 8. Confirmation gates: STOP and ask Hein (the contract's human gates, nothing else)
- **Before `mq-isa add`.** This PR modifies existing production code paths, so Hein reads the diff (contract trust boundary).
- Any schema migration. None is expected; if one seems needed, the design is wrong. Stop.
- Production deploy: `bash scripts/deploy.sh` is never run by this session; the handoff carries the after-hours request.
- Outbound email/notifications, and any data change outside dev's QA companies (never the prod DB).

**Never do (not gates):** change period semantics beyond spec §2.2 or what the income statement itself prints (out of scope; note it in the handoff). If review rounds keep surfacing new defect classes, scope back to the spec and say so in the PR body.

## Rules (repo law, restated)
- **Worktree:**
  1. `git fetch origin && git worktree add -b fix/budgets-p0-correctness-20261026 /home/hein/Workspace/IsaFlow-budgets-p0 origin/master`
  2. Hard-link node_modules (`cp -al`, never `ln -s`).
  3. `cd /home/hein/Workspace/IsaFlow-budgets-p0 &&` on **every** Bash call.
- **Code:**
  - company_id on every query.
  - `sql` from `@/lib/neon`, never string concatenation.
  - `withAuth(withErrorHandler(...))`, `apiResponse`.
  - `log` from `@/lib/logger`, never console. No empty catch.
  - Strict TS, ≤ 300 lines per file.
  - TDD: tests first.
- **Git:** stage explicit paths. Never `git add -A`, no `git stash`, no `--no-verify`, no amend or force-push, never commit to master. Merges go only via `mq-isa add <PR>`, after Hein's OK.
- **DB:** dev is `isaflow_dev`. Never touch prod. Integration suites run on disposable clusters only.
- **Artefacts:** `/home/hein/.cache/redchk/budgets-p0/`, never `/tmp`.
- **Process:**
  - Do not edit the tree while a gate run is in flight.
  - No pattern kills. Kill the dev server by PID from `ss`.
  - Subagents never edit memory.
  - Push in the background at load < 25.
