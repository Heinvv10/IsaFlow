# Budgets P0: correctness on the current model (spec)

**Date:** 2026-10-26 · **Parent:** `docs/plans/2026-10-26-budgets-next-level.md` §3, §5 P0 · **Contract:** `docs/plans/budgets/00-shared-contract.md`
**Base:** `origin/master` (migration head 946) · **Schema change:** none · **PR count:** 1
**Gate:** this PR changes existing production code paths, so Hein reads the diff before `mq-isa add`.

**Strongest argument against:** P3 rebuilds the BvA page on StatementGrid, so the page-level parts of
this work get thrown away within weeks. They are kept small for that reason. The parts that survive
are the row model, the sections, the period rules, the CSV and the comparator fix, and P3 builds on
all of them. A wrong number in prod today costs more than the throwaway page work.

---

## 1. Defects re-verified against `origin/master`

Line numbers are from `49d139b5e`.

| ID | Verdict | Where (file:line) | What is actually wrong |
|----|---------|-------------------|------------------------|
| D1 | **Confirmed, corrected** | `pages/api/accounting/reports-budget-vs-actual.ts:97-99`; page `pages/accounting/reports/budget-vs-actual.tsx:238-247` | `total_budget` and `total_actual` add revenue and expense together, which means nothing. `total_variance` is the sum of favourably-signed line variances, and that sum happens to equal the net-profit variance, so the prod "+R710k" was arithmetically right but had no label. The fix is to replace all three with Revenue / Expenses / Net profit sections. |
| D2 | Confirmed | `src/modules/accounting/services/reports/budgetVsActualLines.ts:70-77`; rendered at `budget-vs-actual.tsx:213-214` | Sentinel `-100` when budget ≤ 0 and actual > 0, and `0` when actual ≤ 0. A **negative** budget (contra account) also gets the sentinel, because the guard is `budgetAmount > 0`, not `!== 0`. |
| D3 | Confirmed | `pages/api/accounting/budget-vs-actual-export.ts:75` (`ga.level = 3`), `:92` (`\|\|`), `:94` (`budget − actual` for every type), `:95` (pct 0), no zero-row filter. The SQL is a third copy of the actuals query. | The CSV disagrees with the screen on accounts (level filter), signs (revenue), zero budgets and row set. `tests/unit/api/balanceQueryGuards.test.ts:156-164` **pins** the level-3 filter on the export, so that assertion has to be changed deliberately. |
| D4 | Confirmed | `budget-vs-actual.tsx:192` (pct only when budget > 0), `:219` (red when > 100%) | Revenue over budget is good news, but the bar paints it red. |
| D5 | **Confirmed, cite corrected** | `budgetVarianceService.ts:106-107` (split on `budget_amount !== 0`), root cause `budgetVsActualLines.ts:37-43` (`lookupBudget` returns 0 for "absent") | The line has no "budgeted" bit, so a deliberate zero budget is filed under `unbudgeted`. This matters for MCP `rows` / `excludedRows`, comparator `budgetedCount`, and `hasBudgetData`. (The parent cited `:124-125`, which is `unbudgetedMovement` and only a consequence.) |
| D6 | **Confirmed, narrowed** | `src/lib/mcp/tools/budgetVariance.ts:165` (description: "reported as 0 where there is no budget") | MCP `rows` only hold budget ≠ 0, so the sentinel only reaches a client for a **negative** budget today. Once D5 is fixed, zero-budget rows reach `rows` and would carry `-100`/`0`. The fix is `null` plus a corrected description. |
| D7 | Confirmed | `src/modules/accounting/services/reports/statementRows/comparators.ts:98-101` | `variance = line.actual_amount − line.budget_amount` and `favourable = line.variance ≥ 0`. Both use the GL aggregate, never `row.actual`, which is the figure printed on that row. |
| D8 | **Confirmed, extended** | Page default `budget-vs-actual.tsx:47` (`'current'`) vs API default `reports-budget-vs-actual.ts:41` (`'ytd'`). `current` = `currentMonthWindow` `budgetPeriodWindow.ts:172-179` via `budgetWindowService.ts:49-51`. | Three problems. (a) The page and the API disagree on the default. (b) "Current Period" is the calendar month to date, not the fiscal period (`fiscalYearRegistry.periodForDate` exists and is unused here). (c) **New:** budgets count whole months (`budgetPeriodWindow.ts:100-102`) but actuals stop at *today* for both `current` and `ytd` (`budgetWindowService.ts:46,56`). The current month's full budget is set against part-month actuals, so expenses look under budget and revenue looks short on every day except month end. |
| D9 | **Half wrong, corrected** | Delete: `pages/accounting/budgets/index.tsx:234` → `handleDelete` `:99-111`, no confirmation. Picker: `:62-81`. | The confirmation defect is real. The **inactive** half is wrong: `GET /api/accounting/chart-of-accounts` without `includeInactive` already filters `is_active = true` (`chartOfAccountsService.ts` `getChartOfAccounts`). The **header** half is real: revenue/expense parents are offered. **New:** `formAccounts` (`:136`) filters the editing account out of `accounts`, so editing a budget whose account has since gone inactive or become a header shows an empty picker. |

### Adjacent defects found in the same code paths (added to P0)

| ID | Where | Defect |
|----|-------|--------|
| D10 | `pages/accounting/budgets/index.tsx:130` (`totalBudget`), rendered `:193` and `:244` | The budget page's "Total Budget" adds revenue and expense budgets together. It is D1 on the planning page. |
| D11 | `budgetVarianceService.ts:119-123` → MCP `totals` (`budgetVariance.ts:221`) | MCP `totals.budget` / `totals.actual` have the same revenue + expense problem as D1. |
| D12 | `reports-budget-vs-actual.ts:41`, `budget-vs-actual-export.ts:141` | An unknown `period` (`?period=quarter`) is silently treated as `ytd` and answers 200. It should be a 400. |
| D13 | `src/modules/accounting/services/core/budgetService.ts:136-138` | `upsertBudget` checks only ownership. A budget on an asset/liability/equity account is stored, yet appears on no report (every reader filters `account_type IN ('expense','revenue')`). The UI never offers one, so this is a server-side hole. Refuse with `BudgetInputError` (400). |
| D14 | Actuals SQL duplicated in `reports-budget-vs-actual.ts:62-88`, `budget-vs-actual-export.ts:52-79`, `budgetVarianceService.ts:66-89` | Three copies. D3 exists because they drifted. Collapse them to one. |

**Seen, NOT fixed here (mention only):** `ff-input` / `ff-select` are used in 62 files and defined in
no stylesheet (`styles/globals.css` and `styles/themeContrast.css` have no rule). That is the root
cause of the borderless BudgetForm inputs. P0 fixes only BudgetForm (below). The global class is a
separate UI ticket. The comment `budgetWindowService.ts:64-65` ("an account with stored months but
none inside the window is present at 0") is false: the query filters months to the window. Correct
the comment when touching the function.

**Also fixed (small, prod-visible):** BudgetForm month and annual inputs use the undefined `ff-input`
class (`src/components/accounting/budgets/BudgetForm.tsx:84,85,93`) and are borderless in dark mode.

---

## 2. Design: one row model

Every surface (screen, CSV, MCP, statement comparator, presentation bullets) consumes the output of
**one** loader and **one** pure builder. Nothing re-derives a variance, a sign or a total.

```
budgetWindowService.resolveBudgetWindow ─┐ (page/CSV only: period → window)
                                          ▼
budgetVarianceService.getBudgetVariance(companyId, start, end)
   ├─ loadWindowBudgets            (existing; keys present ⇒ budgeted)
   ├─ loadWindowActuals            NEW, the ONE actuals SQL (moved from varianceService)
   └─ buildBudgetVsActualLines     (pure, extended)
        └─ buildBudgetVsActualSections (pure, NEW)
   ⇒ BudgetVarianceResult { lines, rows, unbudgeted, sections, totals, postedThrough, monthKeys, fiscalYear, universeTotal, unbudgetedMovement }
        │
        ├─ GET reports-budget-vs-actual  → { report: { period, lines, sections, posted_through, … } }
        ├─ GET budget-vs-actual-export   → budgetVsActualCsv(result)   (pure, NEW)
        ├─ MCP budget_variance           → rows/excluded + sections + totals(=net profit)
        └─ GET reports-budget-comparator → applyBudgetComparator(rows, lines)  (D7 fixed)
```

### 2.1 Row model (in `budgetVsActualLines.ts`)

```ts
export type BudgetLineType = 'revenue' | 'expense';
export interface BudgetVsActualLine {
  account_id: string;          // moved in from BudgetVarianceRow
  account_code: string;
  account_name: string;
  account_type: BudgetLineType;
  budgeted: boolean;           // NEW: a budget_month_amounts row exists in the window (zero counts)
  budget_amount: number;       // 0 when !budgeted
  actual_amount: number;       // revenue cr−dr, expense dr−cr (unchanged)
  variance: number;            // favourably signed (unchanged): rev A−B, exp B−A. MCP, bullets and the NP invariant use it
  movement: number;            // NEW: round2(actual − budget). The sign every screen and export prints (contract: variance sign)
  variance_pct: number | null; // variance / |budget| × 100; null when budget === 0 or !budgeted
  movement_pct: number | null; // NEW: movement / |budget| × 100; same null rule. The % every screen and export prints
  favourable: boolean | null;  // variance ≥ 0; null when !budgeted
}
export interface BudgetVsActualSection {
  key: 'revenue' | 'expense' | 'net_profit';
  budget: number; actual: number; variance: number; movement: number;
  variance_pct: number | null; movement_pct: number | null; favourable: boolean | null; // null when nothing in it is budgeted
}
```

Rules:
- Keep a row when `budgeted || actual_amount !== 0`.
- Revenue section = Σ revenue lines. Expense section = Σ expense lines. Variance follows the section's own polarity.
- Net profit: budget = Brev − Bexp, actual = Arev − Aexp, variance = actual − budget.
- **Invariant:** NP variance = Σ line.variance, to the cent (`round2`).
- An unbudgeted line keeps its numeric variance, so the sections foot. Budget and % render "—", and the colour comes from `favourable` (null, so neutral).
- The display layer prints `null` pct as "—", never "0.0%" and never "−100%".
- **Printed sign (contract "Variance sign"):** the page and the CSV print `movement` (actual − budget) for every line,
  section and NP; `favourable` alone carries good/bad. `variance_pct` is computed from `variance` (favourably signed), so
  the printed % is `movement / |budget| × 100` = `variance_pct` with the movement's sign: the builder exposes it as
  `movement_pct` (same null rule) and the display prints that. Nothing outside the builder flips a sign.
- `BudgetVarianceRow` becomes an alias of `BudgetVsActualLine`, so `account_id` sits on the shared type.

Consumers that must type-check against `variance_pct: number | null`:
- `pages/accounting/reports/budget-vs-actual.tsx`
- `src/components/accounting/charts/bulletOption.ts` (reads `variance` only, so no change)
- `src/components/accounting/present/PresentSlide.tsx`
- `pages/accounting/reports/present/[pack].tsx`
- `src/components/accounting/reportControls/useStatementComparators.ts`
- `src/lib/apiRoutes.ts:136-145`

### 2.2 Period semantics (D8). Decided here; Hein may override at review

**The rule:** budgets are whole months, so a window's actuals must cover the same whole months.
Otherwise the variance compares a full month of plan with part of a month of fact.

| `period` | Window | Label on page |
|----------|--------|---------------|
| `current` | The fiscal period holding today (`periodForDate`), start to **end**. No period row, so the whole calendar month. | "This period: 1 to 31 October 2026" |
| `ytd` | FY start to the **end of the period/month holding today**, capped at FY end. A chosen finished year runs to its end. A chosen not-started year is `notStarted` (unchanged). | "Year to date" |
| `full_year` | Unchanged | "Full year" |
| anything else | **400** `period must be current, ytd or full_year` (D12) | — |

- The page default becomes `ytd`, matching the API.
- The page shows "Actuals posted through {posted_through}" under the range, so a part-month is visible rather than hidden.
- MCP and the comparator take explicit dates, and their windows are unchanged.

### 2.3 Colour and format
- **Screen:** prints `movement` / `movement_pct`; colour is `varianceColor(line.favourable ?? undefined, useChartPalette())` from `src/components/accounting/charts/ibcs.ts`. No `text-teal-400` / `text-red-400` on figures.
- **Money on the page:** `formatMoney` (`src/lib/money/formatMoney.ts`). The page is not a statement surface.
- **Percent:** `formatPct` (`src/lib/format/money.ts`). A null pct prints "—".
- **Progress bar (D4):** fill = |actual| / |budget|, capped at 100%. Bar colour = `varianceColor(favourable)`. A row with no budget or a zero budget gets no bar.

### 2.4 CSV (D3)
- **Header:** `Section,Account Code,Account Name,Budget,Actual,Variance,Variance %,Favourable`.
- **Rows, in order:**
  1. Revenue lines, then a `Total revenue` row.
  2. Expense lines, then a `Total expenses` row.
  3. A `Net profit` row.
- **Cells:**
  - Variance = `movement` (actual − budget) and Variance % = `movement_pct`, for every row type; Favourable carries the polarity.
  - An unbudgeted line's Budget is empty.
  - A null pct is empty.
  - Favourable is `yes` / `no` / empty.
  - Every value goes through `csvVal`. Money is `toFixed(2)` from the same numbers the JSON carries.
- **Not-started year:** the header plus the three total rows, all zero.

### 2.5 Statement comparator (D7)
In `applyBudgetComparator`:
- `variance = round2(row.actual − line.budget_amount)`.
- `favourable = line.account_type === 'revenue' ? variance ≥ 0 : variance ≤ 0`.

**Verify first:** an expense row's `row.actual` is positive in `statementRows/incomeStatementRows.ts`. If it is not, normalise by sign there and pin it in a test. This is the only change to the statement path; versions and dimension filters on the comparator are P3.

### 2.6 Budgets page (D9, D10, BudgetForm)
- **Add-budget picker:** `leafAccountOptions(accounts, type)` from `src/lib/chartAccountOptions.ts`, fed by `GET /api/accounting/chart-of-accounts?includeInactive=true`. It needs the inactive rows: an inactive child still makes its parent a header. Revenue and expense only.
- **Edit:** the form's single account comes from the `BudgetRow` itself (code/name), so an inactive or header account can still be edited.
- **Delete:** `src/components/ui/ConfirmDialog.tsx` (`tone="destructive"`). The message names the code, name, year and total ("Delete the 2027 budget for 6100 Rent (R 120 000.00)? Every month is removed."). There is no request until the user accepts.
- **Totals (D10):** Revenue budget / Expense budget / Net budgeted profit in the summary card and the tfoot.
- **BudgetForm inputs:** an explicit token class. Copy the `INPUT` pattern of `src/components/accounting/createEntity/styles.ts:1`: border `var(--ff-border-light)`, bg `var(--ff-bg-primary)`, text `var(--ff-text-primary)`, focus ring. Put it in a local constant in `BudgetForm.tsx`. Do not touch the global `ff-input`.

### 2.7 MCP (D5, D6, D11)
- `rows` = budgeted lines, including deliberate zero budgets. Each row carries `variance` (favourably signed, unchanged), `movement` and `favourable`. `excludedRows` = unbudgeted lines with movement (reason `no_budget_set`, unchanged).
- New field `sections: { revenue, expense, net_profit }`.
- **`totals` is redefined as net profit** (budget, actual, variance). The old revenue + expense sums were meaningless, and no consumer can rely on them correctly.
- The description is rewritten to match: variance_pct is null when the budget is zero, `variance` is favourably signed while `movement` is actual − budget, and totals are net profit. `tests/unit/mcp/budgetVarianceTool.test.ts` pins the new wording.

---

## 3. Module shape

| File | Status | Change |
|------|--------|--------|
| `src/modules/accounting/services/reports/budgetVsActualLines.ts` | edit | Row model 2.1: `budgeted`, `account_id`, null pct, `favourable`, keep-rule |
| `src/modules/accounting/services/reports/budgetVsActualSections.ts` | **NEW** | `buildBudgetVsActualSections(lines)` (pure) |
| `src/modules/accounting/services/reports/budgetVsActualCsv.ts` | **NEW** | `budgetVsActualCsv(result): string` (pure) |
| `src/modules/accounting/services/reports/budgetWindowActuals.ts` | **NEW** | `loadWindowActuals(companyId, start, end)`: the one actuals SQL (company_id on both tables, posted, not year_end, no level and no is_active filter) |
| `src/modules/accounting/services/reports/budgetVarianceService.ts` | edit | Uses `loadWindowActuals`; adds `lines`, `sections`; `rows`/`unbudgeted` split on `budgeted`; `totals` = net profit |
| `src/modules/accounting/services/reports/budgetWindowService.ts` | edit | `current` = fiscal period (whole); `ytd` ends at period/month end; `assertBudgetPeriod` (D12); fix the stale comment |
| `src/modules/accounting/services/reports/budgetPeriodWindow.ts` | edit | `monthEnd(isoDate)` helper (string-only, no Date) |
| `src/modules/accounting/services/reports/statementRows/comparators.ts` | edit | D7 |
| `src/modules/accounting/services/core/budgetService.ts` | edit | D13 type refusal |
| `pages/api/accounting/reports-budget-vs-actual.ts` | edit | Calls `getBudgetVariance`; answers `lines`, `sections`, `posted_through`; drops `total_*`; 400 on bad period |
| `pages/api/accounting/budget-vs-actual-export.ts` | edit | Calls `getBudgetVariance` + `budgetVsActualCsv`; no SQL of its own |
| `src/lib/mcp/tools/budgetVariance.ts` | edit | 2.7 |
| `src/lib/apiRoutes.ts` | edit | Comparator response type follows the new line type |
| `pages/accounting/reports/budget-vs-actual.tsx` | edit | Default `ytd`; period labels; posted-through; renders the table component |
| `src/components/accounting/budgets/BudgetVsActualTable.tsx` | **NEW** | Sections + lines + bar + drill-down rows (keeps the page < 300 lines) |
| `src/components/accounting/budgets/budgetClient.ts` | edit | `variancePctLabel(pct: number \| null)` → "—" or `formatPct` |
| `pages/accounting/budgets/index.tsx` | edit | D9, D10 |
| `src/components/accounting/budgets/useBudgetAccounts.ts` | **NEW** | Account fetch + leaf/type filter, moved out of the page (keeps it < 300 lines) |
| `src/components/accounting/budgets/BudgetForm.tsx` | edit | Input classes; editing account from the row |
| `src/modules/accounting/services/reports/.claude.md` | edit | 2026-10-26 entry: row model, period rule, CSV shape, MCP totals; then `bun run agent-docs:generate` |

P1 owns the move to `src/modules/accounting/services/budgets/`. P0 leaves files in `reports/` so the
two PRs do not fight over paths. Both touch `budgetWindowService.ts`; whichever merges second rebases.

P3 later retires `budgetWindowActuals.ts` (into `budgets/tracking/trackingActualRead.ts`, via the
`getBudgetVariance` facade), `budgetVsActualCsv.ts`, `BudgetVsActualTable.tsx` and the two old BvA routes
(contract ownership table). P0 builds them anyway: it ships weeks earlier, and its row-model fields, sections,
D7 fix and MCP changes are what P3 builds on.

---

## 4. Task DAG

```
T1 row model ──► T2 sections ──► T3 one actuals loader + service ──┬─► T5 report API ──► T8 BvA page/table
                                                                   ├─► T6 CSV export
                                                                   ├─► T7 MCP
T4 period rules (independent) ─────────────────────────────────────┘   T9 comparator D7 (after T1)
T10 budgets page D9/D10 + BudgetForm (independent) · T11 D13 server refusal (independent)
T12 parity + integration suite (after T5,T6,T7) ──► T13 browser proof ──► T14 docs ──► T15 gates/review
```

| Task | Work | `verify:` |
|------|------|-----------|
| T1 | Row model 2.1 in `budgetVsActualLines.ts` | `bunx vitest run tests/unit/services/reports/budgetVsActualLines.test.ts`: new cases green, then the T1 mutations below turn them red |
| T2 | `budgetVsActualSections.ts` | `bunx vitest run tests/unit/services/reports/budgetVsActualSections.test.ts`; NP-invariant property case green; mutation red |
| T3 | `budgetWindowActuals.ts`; service uses it; `rows`/`unbudgeted` by `budgeted`; `sections`; `totals` = NP | `bunx vitest run tests/unit/services/budgetVarianceDb.test.ts tests/unit/api/balanceQueryGuards.test.ts`; `git grep -n "credit_less_debit" -- pages src` returns ONLY `budgetWindowActuals.ts` (plus unrelated readers listed in the PR) |
| T4 | Period rules 2.2 + 400 | `bunx vitest run tests/unit/services/budgetWindowChosenYear.test.ts tests/unit/services/budgetWindowCurrentPeriod.test.ts tests/unit/services/budgetPeriodWindow.test.ts` |
| T5 | Report API on the service | `bunx vitest run tests/unit/components/budgetVsActualRange.test.tsx`; integration T12 |
| T6 | CSV via `budgetVsActualCsv` | `bunx vitest run tests/unit/services/reports/budgetVsActualCsv.test.ts`; `git grep -n "ga.level" pages/api/accounting/budget-vs-actual-export.ts` returns nothing |
| T7 | MCP 2.7 | `bunx vitest run tests/unit/mcp/budgetVarianceTool.test.ts tests/unit/mcp/writeToolRoleFence.test.ts` |
| T8 | Page + `BudgetVsActualTable` | `bunx vitest run tests/unit/components/budgetVsActualSections.test.tsx tests/unit/components/budgetVsActualDrillOnce.test.tsx tests/unit/components/d2CensusG3a.test.tsx tests/unit/components/d2R3a2ReportLoads.test.tsx` |
| T9 | Comparator D7 | `bunx vitest run tests/unit/services/reports/statementRows/comparators.test.ts tests/unit/components/charts/useStatementComparators.test.tsx tests/unit/components/charts/PresentSlideBudgetGuard.test.tsx` |
| T10 | Budgets page + form | `bunx vitest run tests/unit/components/budgetsPageDelete.test.tsx tests/unit/components/budgetsPageMonths.test.tsx tests/unit/components/budgetsPageRace.test.tsx tests/unit/components/budgetFormValidation.test.tsx` |
| T11 | D13 | `bunx vitest run tests/unit/services/budgetServiceDb.test.ts`; integration `budgets-route.int` case |
| T12 | Real-PG parity suite | `CI_INTEGRATION=1 bun run ci` (or the redchk harness on a disposable cluster) runs `tests/integration/budgets-bva-parity.int.test.ts` green; each listed mutation red |
| T13 | Browser proof | Screenshots dark + light × 1280 + 390 of `/accounting/reports/budget-vs-actual` and `/accounting/budgets` (form open, confirm dialog open) on dev :3200, each described in the PR |
| T14 | Docs | `bun run agent-docs:check` clean |
| T15 | Gates | `bun run ci` green; blind `/review` + security review SHIP on the final head; every H/M/L fixed |

---

## 5. Tests (TDD: written red first, named, each with the mutation it catches)

Unit, pure:

| Test (file › name) | Mutation it must catch |
|---|---|
| `tests/unit/services/reports/budgetVsActualLines.test.ts` › "a deliberate zero budget is budgeted, pct null" | `budgeted` from `budget_amount !== 0` instead of key presence |
| › "no budget: pct null, favourable null, variance still signed" | restore the `-100` sentinel; set `favourable` when unbudgeted |
| › "negative budget: pct over the absolute budget" | `budget > 0` guard; dropping `Math.abs` |
| › "revenue over budget is favourable" / "expense over budget is unfavourable" | swap the polarity branch |
| › "movement = actual − budget for both types; movement_pct null on a zero budget" | `movement` computed as the favourable variance |
| › "keeps a budgeted zero/zero row, drops an unbudgeted zero/zero row" | the old `budget !== 0 \|\| actual !== 0` filter |
| (replace) "returns -100 when budget is 0" → "returns null" | — (the old pin is deleted, not kept) |
| `tests/unit/services/reports/budgetVsActualSections.test.ts` (**NEW**) › "net profit = revenue − expenses, budget and actual" | NP = rev + exp |
| › "NP variance equals Σ line variance (property, 200 random line sets)" | flip the sign of the expense contribution |
| › "section with nothing budgeted: pct and favourable null" | pct computed off a zero budget |
| `tests/unit/services/reports/budgetVsActualCsv.test.ts` (**NEW**) › "Variance is actual − budget for revenue and expense; Favourable carries the polarity" | `budget − actual` for every type (D3); printing the favourably signed `variance` |
| › "rows, section totals and net profit in order; null pct is an empty cell" | dropping the section rows; printing `0.00` for null |
| › "every figure equals the JSON figure it came from" (round-trip parse) | any re-derivation in the CSV |
| `tests/unit/services/budgetWindowCurrentPeriod.test.ts` (**NEW**) › "current is the whole fiscal period holding today" | calendar MTD (`currentMonthWindow`) |
| › "no period row: the whole calendar month" | returning MTD as the fallback |
| › "ytd ends at the end of the month holding today, capped at FY end" | `endDate = today` |
| › "unknown period is a BudgetPeriodError" | silent `ytd` fallback (D12) |
| `tests/unit/services/budgetWindowChosenYear.test.ts` › update "year to date runs … to today" → "… to the end of today's month" | — |
| `tests/unit/services/reports/statementRows/comparators.test.ts` › "budget variance uses the row's printed actual, not the GL aggregate" (row.actual ≠ line.actual_amount) | `line.actual_amount` back in (D7) |
| › "favourable follows account type from the row's own variance" | `line.variance >= 0` |
| `tests/unit/mcp/budgetVarianceTool.test.ts` › "a zero budget is a row, not an exclusion" | D5 |
| › "totals are net profit; sections carried" | rev + exp totals (D11) |
| › "description says variance_pct is null where there is no budget" | stale description (D6) |
| `tests/unit/api/balanceQueryGuards.test.ts` › replace "export … keep the level-3 leaf filter" with "export reads the same actuals as the report (no level filter)" | re-adding `ga.level = 3` |

Component (happy-dom):

| Test | Mutation |
|---|---|
| `tests/unit/components/budgetVsActualSections.test.tsx` (**NEW**) › "renders Total revenue, Total expenses, Net profit" | dropping a section row |
| › "unbudgeted revenue shows — not −100%" | rendering `variance_pct.toFixed` |
| › "revenue over budget: bar and figure use the favourable colour from varianceColor" | expense logic on revenue (D4); hard-coded red/teal |
| › "defaults to Year to date and sends period=ytd" | default `'current'` (D8) |
| `tests/unit/components/budgetsPageDelete.test.tsx` (**NEW**) › "delete asks first; Cancel sends nothing; Accept sends one delete" | calling `handleDelete` on click |
| › "the add picker offers no header and no inactive account" | dropping `leafAccountOptions` |
| › "editing an account that became a header still shows it" | `formAccounts` from `accounts` |
| › "summary shows revenue, expense and net budgeted profit" | `Σ annualAmount` (D10) |
| `tests/unit/components/budgetFormValidation.test.tsx` › "month inputs carry the bordered token class" | restoring `ff-input` alone |

Integration, real PG (`tests/integration/budgets-bva-parity.int.test.ts`, **NEW**, pattern of `tests/integration/budgets-report-year.int.test.ts` + `helpers/budgetsRouteFixture.ts`, disposable cluster only):

**Fixture:** one company with these accounts:
- revenue budgeted under
- revenue unbudgeted with movement
- expense over budget
- expense budgeted at exactly 0 with movement
- expense with a negative budget
- an expense account at level 2 with postings (the export's old filter dropped it)
- a balance-sheet account with postings (must not appear)
- a year_end journal (excluded)

| Case | Mutation |
|---|---|
| "screen JSON and CSV carry identical lines, sections and net profit" (parse CSV, compare to JSON to the cent) | any of D3's four drifts re-introduced in the export path |
| "MCP rows + excludedRows = the report's lines; MCP totals = report net profit" | MCP filtering on `budget_amount !== 0` |
| "comparator `budgetedCount` counts the zero-budget account" | D5 |
| "Σ report actuals per type = Σ posted lines per type in the window" (independent SQL in the test) | a level or is_active filter in `loadWindowActuals` |
| "period=quarter is a 400 on report and export" | D12 |
| "a budget on an asset account is refused 400 and nothing is written" (via `budgets` route) | D13 |

Update existing pins: `tests/integration/budgets-report-year.int.test.ts:130,142-160`, which pin the old CSV
shape and zero rows. Rewrite those to the new shape. Do not delete the not-started and chosen-year
coverage. `tests/integration/budgets-report-fault.int.test.ts` must stay green unchanged.

---

## 6. Acceptance

1. On dev, for a company with the T12 fixture shape, the screen, CSV and MCP give the same per-account figures and the same Revenue / Expenses / Net profit (T12 green).
2. No "−100%" anywhere. An unbudgeted pct is "—" on screen and empty in the CSV.
3. Revenue over budget is favourable in colour and bar. Expense over budget is unfavourable. The colour comes from `varianceColor` only (`git grep -n "text-red-400\|text-teal-400" pages/accounting/reports/budget-vs-actual.tsx src/components/accounting/budgets/BudgetVsActualTable.tsx` finds no figure cell).
4. The page opens on Year to date. "This period" is the fiscal period. Budget and actual cover the same whole months. Posted-through is shown.
5. Delete asks first. The picker offers only active leaf revenue/expense accounts. The budget page totals are split by type.
6. BudgetForm inputs have visible borders in dark and light (screenshots).
7. The statement Budget column's variance = printed actual − budget on every line (unit + one dev check on the income statement).
8. `bun run ci` green; GitHub integration job green; blind `/review` + security review SHIP; Hein has read the diff.

## 7. Risks

- **Sign of `row.actual` on expense statement rows (D7).** If the income statement prints expenses negative, a naive `row.actual − budget` doubles the error. Verify in `incomeStatementRows.ts` first and pin it in a test.
- **MCP `totals` meaning changes.** It is a breaking semantic change for any saved prompt or client that reads `totals.actual`. Known consumers: Hein's own pilot. Call it out in the PR body and the tool description.
- **`ytd` now ends at the end of the month, not today.** Future-dated postings inside the current month now count. The posted-through line makes this visible. Hein may prefer "to last closed period"; that is a one-line change in `resolveBudgetWindow`.
- **Concurrent P1 PR** touches `budgetWindowService.ts` and `budget_month_amounts` readers. Whichever merges second rebases. Coordinate through the merge queue, one at a time (memory: merging interacting PRs).
- **Removing `total_*` from the report response** breaks any external caller of the JSON. A census found only the page and tests (`git grep total_budget`), so the risk is accepted.
- **Header-account budgets already stored** stay editable (2.6) and keep reporting. Nothing is deleted.
