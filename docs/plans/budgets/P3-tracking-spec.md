# P3 — Tracking: Budget vs Actual rebuilt (spec)

**Parent:** `docs/plans/2026-10-26-budgets-next-level.md` §5 P3 · **Contract:** `docs/plans/budgets/00-shared-contract.md` (obeyed exactly; canonical names from it)
**Depends on:** P0 merged (D1–D9 fixed, shared BvA row model) and P1 merged (`budget_versions`, dims on `budget_month_amounts`, `services/budgets/` home). **Base:** `origin/master`.
**Goal file:** `.claude/handoffs/2026-10-26-budgets-P3-tracking-goal.md`

Paths marked **NEW** do not exist on `origin/master` (checked with `git ls-files | grep -F` on 2026-10-26). Every other path does, except the P0/P1 names below, which exist once the precondition holds.

**P0/P1 names this spec uses** (from `P0-correctness-spec.md` §2–§3 and `P1-schema-versions-spec.md` §3, §6; confirm against the merged code at T0):
- P0: `BudgetVsActualLine` in `reports/budgetVsActualLines.ts` with `account_id`, `budgeted`, `variance` (favourably signed), `movement` (actual − budget), `variance_pct`, `movement_pct`, `favourable`; `reports/budgetVsActualSections.ts` `buildBudgetVsActualSections`; `reports/budgetWindowActuals.ts` `loadWindowActuals` (the actuals SQL P3 supersedes); `reports/budgetVsActualCsv.ts`; `src/components/accounting/budgets/BudgetVsActualTable.tsx`; `getBudgetVariance` returning `{lines, rows, unbudgeted, sections, totals (= NP), …}`; D7 fixed in `applyBudgetComparator` (`row.actual`); period rules in `budgetWindowService.ts`.
- P1: `budget_versions`; `budget_month_amounts.version_id/cc1_id/cc2_id/bu_id/dim_grain`; `budgets/budgetVersionScope.ts` (`primaryVersionScope`, `namedVersionScope`); `budgets/budgetVersions.ts` (`listVersions`, `getVersion`); `budgets/budgetVersionTypes.ts` (`BudgetVersion`, `BudgetVersionError`); routes `pages/api/accounting/budget-versions/**`; `loadWindowBudgets(companyId, start, end, versionId?)`.
- Ownership (contract table): P0 owns D1–D14, D7 and the MCP D5/D6/D11 changes; P3 never re-fixes them. P3 owns the single actuals SQL (`trackingActualRead.ts`) and retires P0's `budgetWindowActuals.ts`, `budgetVsActualCsv.ts`, `BudgetVsActualTable.tsx` and the two old BvA routes.

**Strongest argument against:** the statement grid, comparator, packs and MCP each read `getBudgetVariance` today. Putting a second engine beside it gives four surfaces two ways to compute "budget". This spec makes `getBudgetVariance` a facade over the new engine (PR-C), so there is one reader. That turns the facade parity test into the riskiest test in the phase.

---

## 1. Outcome

`/accounting/reports/budget-vs-actual` renders through `StatementGrid` with the income-statement bands. Columns:

- **Actual · Budget · Var R · Var %**
- **Projected FY · FY budget · Proj. var R**

Controls:

- **Period:** Month | Quarter | YTD | FY | Custom (month-granular)
- **Version:** default primary
- **Dimensions:** CC1 / CC2 / BU

Visuals:

- Profit bridge from budget NP to actual NP.
- Account × month variance heatmap.
- Bullet per cost centre.

Drill path: variance cell → GL lines → source document. CSV and Excel export come from the same row model.

The engine also feeds the rest:

- The statement Budget comparator honours version and dims (the dims disable is removed).
- Management and board packs print a budget column and honour `comparison_mode`.
- MCP `budget_variance` gains `version_id`, `cc1_id`, `cc2_id`, `bu_id`. It stays backward compatible.

**Invariant 1 (the phase's acceptance test):** BvA Actual for any window and dimension filter equals the income-statement figure for the same window and filter, per account and per band, to the cent.

## 2. Semantics

### 2.1 Signs and colours

- **`Var R = actual − budget`** (movement sign, P0's `movement`) on every human-facing surface, colour by polarity — the contract's "Variance sign" ruling. Every `StatementGrid` surface prints the movement sign (`statementRows/comparators.ts` header, exception 1), and P0's page and CSV already print `movement`, so moving BvA onto the grid changes no printed sign. Favourable is a separate boolean: income `variance ≥ 0`, expense `variance ≤ 0`, totals and NP `≥ 0`. It is rendered only through `ibcs.varianceColor` (charts) and the grid's existing `favColour` path, which reads `Comparison.favourable`.
- **MCP keeps its favourably signed `variance`** (revenue `actual − budget`, expense `budget − actual`) for backward compatibility, and also carries P0's `movement` and `favourable`. Its description says so (P0 wrote it). The facade test pins both.
- **`Var % = variance / |budget| × 100`** (`baseComparison`). It is `undefined` when the budget is 0 and renders "—".
- **"Unbudgeted" ≠ "budgeted at zero"** (D5). An account is *budgeted* in a window when at least one `budget_month_amounts` row exists for it in the selected version, inside the window's months, at an included grain (§2.4).
  - Unbudgeted: Budget, Var R and Var % render "—", with no bar and no colour. This is carried as `Comparison.absent: true` (**NEW** additive field on `statementModel.ts`).
  - Budgeted at zero: prints `0`, the variance is the actual, and Var % is "—".
- **Bands** come from the income statement: Turnover, Cost of Sales, Gross Profit, Other Income, Operating Expenses, Operating Profit, Other Expenses, Net Profit (`incomeStatementRows.ts` order; `gl/accountClassification` `revenueBand`/`expenseBand`).
  - A band's budget is Σ the budgets of its account lines (unbudgeted = 0).
  - Band and NP budget figures are computed **in the engine**, not in the adapter, so the `statementRows/` "copy, never derive" contract holds.
  - A notice states "N accounts carry actuals but no budget: R x". That amount sits inside the band variance, because the budget for it is effectively zero.

### 2.2 Period windows

Budgets are calendar-month amounts (mig 944, `budgetPeriodWindow.ts`). A window therefore always starts on the 1st of a month and ends on a month end — **for actuals too, including the in-progress month** (P0's whole-month rule, spec P0 §2.2: budget and actuals cover the same whole months; the page shows "Actuals posted through …" instead of cutting the window at today).

| `period` | Window | Params |
|---|---|---|
| `month` | 1st → month end | `month=YYYY-MM` (default: month holding today) |
| `quarter` | 3-month blocks counted **from the FY start** | `fiscal_year`, `quarter=1..5` |
| `ytd` | FY start → end of the month holding today, capped at FY end (P0's rule) | `fiscal_year` (default: FY holding today) |
| `fy` | FY start → FY end | `fiscal_year` |
| `custom` | `from` month 1st → `to` month end | `from=YYYY-MM&to=YYYY-MM`. Day-level dates are refused with a 400: a budget month cannot be split without inventing a number. |

- **Short and long years.** A financial year is 1–15 months (`FiscalYearRecord.months`; transition years).
  - Quarter n covers months `3(n−1)+1 .. min(3n, months)`.
  - A **14-month year has Q1–Q4 of 3 months and Q5 of 2 months**, labelled "Q5 (2 months)". A 15-month year has Q5 of 3 months. A 7-month year has Q1 and Q2 of 3 months and Q3 of 1 month.
  - A quarter number past the year's end is refused with a 400.
  - Nothing assumes 12 months.
- **Fiscal year source.** The FY always comes from `gl/fiscalYearRegistry` (`getFiscalYear`, `fiscalYearForDate`), never from `financial_year_start`. A year that has not started yields an empty window (`notStarted`), as `budgetWindowService.resolveBudgetWindow` does today.
- **In-progress month.** The response carries `inProgress: { month, postedThrough }` (`postedThrough` = P0's `posted_through`). The page then says "October is in progress; actuals posted through 26 Oct".
- **Windows spanning financial years** (custom, or a quarter is never cross-FY). Each month's budget comes from the version of the FY that holds that month.
  - With no `version_id`, that is each FY's primary.
  - With an explicit `version_id`, every window month must lie in that version's FY, else 400 "version X is FY2027; the window reaches FY2028".
  - The version picker is disabled on a cross-FY window, with that sentence as its reason.

### 2.3 Projection (Projected FY, FY budget)

The projection is per account line. The FY used is **the financial year holding the window's end** (FY\*).

```
cutoff       = min(window end, last day of the month BEFORE the month holding today)
               (an in-progress or future month uses budget, not partial actuals)
               clamped to [FY*.start − 1 day, FY*.end]
actualToDate = actual(FY*.start .. cutoff)                     -- same reader as the Actual column
remaining    = Σ budget(version, months of FY* strictly after cutoff's month)
projectedFY  = actualToDate + remaining
fyBudget     = Σ budget(version, all months of FY*)            -- 14 months in a 14-month year
projVar      = projectedFY − fyBudget                          -- movement sign; favourable by polarity
```

- **Why the cutoff is the last complete month.** Taking October's part-month actuals plus budget from Nov drops the rest of October's budget, which biases the projection low. Pro-rating a budget month invents a figure. So an in-progress month contributes its **budget**, not its partial actual. The column header says this: "Projected FY = actuals to 30 Sep + budget Oct–Apr". The months come from the response, never hard-coded.
- **Unbudgeted account:** `projectedFY = actualToDate`, and `fyBudget` and `projVar` are absent ("—").
- **FY\* not started:** the projection is all budget. **FY\* ended:** the projection equals the FY actual.
- Band and NP projections are Σ over lines, computed in the engine. NP is computed from bands exactly like the actual NP.
- The projection uses the **same version** as the Budget column. Across FYs it uses FY\*'s version as defined in §2.2.

### 2.4 Dimensions: filter and budget roll-up

**Actuals.** A filter `F = {cc1?, cc2?, bu?}` (explicit levels, ANDed) selects `gl_journal_lines` with `jl.cc1_id = F.cc1`, `jl.cc2_id = F.cc2`, `jl.bu_id = F.bu`. Untagged lines fall outside any filter that names that dimension.

- These are **explicit levels**. They differ from the statement pages' existing `cost_centre_id` filter, which matches `cc1_id OR cc2_id` (`incomeStatementService.ts:60`, `dimensionPnlService.ts` header).
- The comparator (PR-C) also accepts `cost_centre_id` with exactly that either-level meaning. That way the income-statement page's Budget column filters the budget the same way the page filters its actuals.

**Budget.** Each budget row `b` (one grain per account per version: contract decision 4) has *effective* dimensions:

- `eff.cc1 = b.cc1_id ?? deriveFnoId(b.cc2_id)`. CC2 rolls up to its FNO by the same parent walk postings use: `gl/dimensions/dimensionDerivation.ts` `deriveFnoId`/`loadCostCentreChains`. If P1 stores the derived `cc1_id` on CC2-grain rows, this is just `b.cc1_id`; the engine still asserts agreement.
- `eff.cc2 = b.cc2_id`, `eff.bu = b.bu_id`.

For a filter `F`, every budget row is exactly one of:

| Class | Rule | Shown as |
|---|---|---|
| **included** | for every dimension d named in F: `eff.d = F.d` | in Budget, variance, projection |
| **coarser** (unallocated) | for some d named in F: `eff.d IS NULL`, and no named d conflicts | **not** in the Budget column. Reported per account as `unallocatedBudget` and in a footer: "R x of budget on these accounts is set at company level (or above this filter) and is not split. View unfiltered →". **Never apportioned.** A pro-rata split is a number nobody set. |
| **other** | some named d has `eff.d ≠ F.d` | excluded |

How this plays out:

- **No filter:** every row is included. The company roll-up is Σ every grain, which is invariant 2. The one-grain rule makes that sum free of double counting.
- **CC1 = A while budget was set by CC2:** each CC2 under FNO A is *included* through `eff.cc1`. A CC2 under another FNO is *other*. A CC2 with no FNO chain has `eff.cc1` NULL and is *coarser*.
- **CC2 = B while budget was set at CC1 = A:** *coarser*, because B's share of A's budget is unknown.
- **Company-level budget (all NULL) under any filter:** *coarser*, so it lands in unallocated, never in the column.
- **Comparator `cost_centre_id = X` (either-level):** included when `eff.cc1 = X OR eff.cc2 = X`. Coarser when both are NULL.
- **Account with coarser budget only:** Budget renders "—" (absent) with a marker "budget set above this filter". Var % "—". Projection uses actuals only, and `fyBudget` is absent.
- **Bullet per cost centre (no filter, grouped by CC1 or CC2):** one bar per member that has a budget or actuals. An **Untagged / company-level** bar carries the actuals with no member plus the company-level budget, the same rule as `dimensionPnlService`'s UNTAGGED column. The bars therefore partition the company total.

### 2.5 Versions

- `version_id` absent: each FY's primary version (contract: "Readers use the primary").
- Present: it must belong to `companyId`, else 404 (IDOR test). Any status may be read, draft included. The response names `{id, name, kind, status}`, and the header shows "Reforecast 1 · draft".
- The picker lists the FY\*'s versions from P1's `listVersions(companyId, fiscalYear)` (route `GET /api/accounting/budget-versions?fiscalYear=`), with primary first.
- An FY with no version: the Budget column is absent on every row, with the notice "No budget for FY2028". It is never shown as zeros.

### 2.6 Drill

The Var R cell and the account label expand `AccountDrillDown` (existing) for the account, window and filter. The drill's period net must equal the line's Actual.

- **Additive props** (PR-B): `cc1Id`/`cc2Id` on `AccountDrillDown`, and `cc1_id`/`cc2_id` on `pages/api/accounting/reports-account-transactions.ts` (explicit levels, ANDed with the existing `cost_centre_id`/`business_unit_id`, which keep their meaning).
- **Each transaction row links to its source document.** Use the existing journal-source link convention if one exists. Census `src/components/accounting/gl/*` and the account-detail page first. If none exists, add **NEW** `src/lib/journalSourceHref.ts` mapping `gl_journal_entries.source` + `source_document_id`/`source_id` to the document route.

### 2.7 Visuals

All are pure option builders plus thin components (`charts/.claude.md`). Every tooltip and label goes through `escapeHtml`. Fav/unfav colour comes from `varianceColor` only.

- **Profit bridge:** `ProfitWaterfall` (existing). Steps come from **NEW** `budgetBridgeSteps(report)`:
  - Budget NP (subtotal)
  - then Δ Turnover, Δ COS, Δ Other income, Δ Opex, Δ Other expenses, each signed as **effect on profit** (income `+Δ`, expense `−Δ`) with `display` = the ledger-signed Δ per the `WaterfallStep` header
  - then Actual NP (subtotal)

  The steps foot exactly: `budgetNP + Σ effects = actualNP`. Integrity is asserted in the builder test.
- **Heatmap:** **NEW** `charts/varianceHeatmapOption.ts` + `VarianceHeatmap.tsx`.
  - Rows are accounts: top 15 by |window variance|, with "show all".
  - Columns are the window's months. A cell is the month's `actual − budget`.
  - Cell colour is `varianceColor(favourable)`, with opacity proportional to |v| / max|v|. No `visualMap` colour ramp, because a ramp would issue green and red outside `varianceColor`.
  - Absent-budget cells are hatched with `roleStyle('forecast')`'s decal and are not coloured.
  - Below `NARROW_WIDTH`, account labels truncate with the full name in the tooltip.
- **Bullet per cost centre:** `BudgetBulletRow` (existing, unchanged) fed with per-member lines mapped to P0's `BudgetVsActualLine` (`account_name` = member label, `variance` favourably signed, as `bulletOption` expects; `movement`, `budgeted`, `favourable` filled). The mapping lives in **NEW** `services/budgets/tracking/trackingByMember.ts`.

### 2.8 Export

**NEW** route `pages/api/accounting/budget-tracking-export.ts?format=csv|xlsx&<same params>`. It calls the same engine and the same `toBudgetTrackingRows` adapter the page renders, then serialises rows. It skips `NON_FIGURE_KINDS` (section rows) exactly as the grid does.

- **Columns:** Code, Account, Band, Actual, Budget, Var R, Var %, Favourable (Y/N/blank), Projected FY, FY budget, Proj. var R, Unallocated budget.
- **Header lines** (CSV leading rows, XLSX sheet header): company, window, version, dimension filter, projection cutoff.
- CSV goes through `src/lib/csv.ts` `csvVal` (formula-injection safe). XLSX uses `exceljs`, as `income-statement-xlsx.ts` does.
- Absent → empty cell, never 0.

## 3. Module shape

```
src/modules/accounting/services/budgets/tracking/          NEW (under P1's budgets/ home)
  .claude.md                 purpose, caller contract, §2 rules, recent changes (≥4 files rule)
  trackingTypes.ts           TrackingFilter, TrackingWindow, TrackingLine, TrackingBand, BudgetTrackingReport
  trackingWindow.ts          resolveTrackingWindow(companyId, params, now) → window + FY* + months + inProgress (pure core + registry read)
  trackingProjection.ts      pure: cutoff, projectedFY, fyBudget per line (§2.3)
  trackingDimRollup.ts       pure: classifyBudgetRow(eff dims, filter) → included|coarser|other (§2.4)
  trackingBudgetRead.ts      SQL: budget per account × month × (eff) grain for version(s) + window months, company-scoped
  trackingActualRead.ts      SQL: actual per account × month for window + filter (posted, excl. year-end source)
  trackingBands.ts           pure: lines → bands, subtotals, NP, favourable, unbudgeted notice
  budgetTrackingService.ts   buildBudgetTrackingReport(companyId, params) — orchestrates; sequential queries (one pg client under withAuth, see packFigureSet.ts)
  trackingByMember.ts        per-CC1/CC2/BU members incl. Untagged (bullets)
  budgetBridgeSteps.ts       pure: report → WaterfallStep[]
src/modules/accounting/services/reports/statementRows/budgetTrackingRows.ts   NEW  copy-only adapter → StatementRow[]
pages/api/accounting/reports-budget-tracking.ts            NEW  GET, JSON
pages/api/accounting/budget-tracking-export.ts             NEW  GET, csv|xlsx
src/components/accounting/charts/varianceHeatmapOption.ts  NEW
src/components/accounting/charts/VarianceHeatmap.tsx       NEW
src/components/accounting/budgets/tracking/                NEW  BudgetTrackingControls.tsx, BudgetTrackingVisuals.tsx, useBudgetTracking.ts, BudgetTrackingNotices.tsx
pages/accounting/reports/budget-vs-actual.tsx              REWRITTEN (existing path, ≤300 lines)
```

**One actuals reader** (contract ownership: P3 owns it; P4/P5/P6 read actuals only through it). `trackingActualRead` generalises P0's `loadWindowActuals` (per-month, dimension filter) and, from PR-C, is the only actuals SQL: `getBudgetVariance`'s facade stops calling `budgetWindowActuals.ts`, which is deleted, and P0's `git grep credit_less_debit` census then names `trackingActualRead.ts` only. If P2's `budgets/priorActuals.ts` is on master, PR-B (not the greenfield PR-A) makes it delegate here (parity tests kept). It reads posted lines per account × month, using the same predicates as `incomeStatementService.fetchIncomeStatementRows`:

- `status='posted'`
- `source IS DISTINCT FROM YEAR_END_JOURNAL_SOURCE`
- revenue and expense only
- `entry_date` inside the window

Window, band and projection actuals are sums of its months. Invariant 1 compares that reader with the income statement.

**`getBudgetVariance` becomes a facade** (PR-C). Its signature gains an optional 4th argument `{ versionId?, cc1Id?, cc2Id?, buId?, costCentreId? }`. It delegates to `budgetTrackingService` and maps the result to the unchanged P0 `BudgetVarianceResult` shape (`lines`, `rows`, `unbudgeted`, `sections`, `totals` = NP, …). With no options its output is **deep-equal** to the P0+P1 output on master for the same ledger (facade parity test). Its four consumers (comparator, MCP, `packFigureSet.ts`, `apiRoutes.ts` type) keep compiling unchanged.

**`statementModel.ts` additive fields** (PR-B; every other surface's output stays identical):

- `Comparison.absent?: true`
- `StatementRow.projection?: { projected: number; fyBudget?: number; variance?: number; favourable?: boolean; absent?: true }`
- `StatementColumns.projection: boolean` (default false in `comparativeOnlyColumns` and `DENSITY_COLUMNS`)

`StatementGrid`/`StatementRowView` render the three projection cells only when `columns.projection` is set.

## 4. API contracts

### `GET /api/accounting/reports-budget-tracking` (NEW)

`withAuth(withErrorHandler(handler))`. It is read-only like the income statement, so no `withWriteAccess`; the old route had it (see open question Q1). It applies `checkReportRateLimit(companyId, 'reports-budget-tracking')`.

Query: zod-validated.

```
period=month|quarter|ytd|fy|custom (default ytd)
month=YYYY-MM | fiscal_year=<label> [&quarter=1..5] | from=YYYY-MM&to=YYYY-MM
version_id=uuid?  cc1_id=uuid?  cc2_id=uuid?  bu_id=uuid?
```

Errors:

- 400: malformed values, a quarter past the year, `from > to`, a custom range wider than 24 months, a version FY mismatch.
- 404: a `fiscal_year` label, `version_id` or dimension id that is unknown **for this company**.

Response (`apiResponse.success`):

```ts
{
  window: { period, startDate, endDate, months: string[], fiscalYear: number, inProgress: { month: string; actualsTo: string } | null, notStarted: boolean },
  version: { id, name, kind, status, isPrimary } | null,       // null = FY has no version
  versionsByFy?: Record<number, {id,name}>,                    // cross-FY window only
  filter: { cc1?: Member, cc2?: Member, bu?: Member },          // Member = {id, code, name}
  projection: { fiscalYear, cutoff: string, actualMonths: string[], budgetMonths: string[] },
  lines: TrackingLine[],   // {accountId, accountCode, accountName, accountType, band, actual, budget|null, variance|null, variancePct|null, favourable|null, monthly: {month, actual, budget|null}[], projected, fyBudget|null, projVariance|null, unallocatedBudget}
  bands: TrackingBand[],   // same figure fields, per band + gross/operating/net totals
  notices: { unbudgetedCount, unbudgetedActual, unallocatedBudget, noVersion: boolean },
  members?: TrackingMember[],   // only when group_by=cc1|cc2|bu is passed (bullets)
  years: ReportYearOption[]     // selector, from budgetReportYear.reportYearOptions
}
```

Money is a number in rands, rounded to 2 decimals in the engine (`round2`). `null` means absent, never 0.

### `GET /api/accounting/budget-tracking-export` (NEW)

The same query plus `format=csv|xlsx`. It returns `text/csv` or the xlsx MIME type with a `Content-Disposition` filename `budget-vs-actual-<start>-<end>.<ext>`.

### `GET /api/accounting/reports-budget-comparator` (existing, PR-C)

It gains optional `version_id`, `cost_centre_id` (either-level), `cc1_id`, `cc2_id`, `bu_id` and `business_unit_id` (an alias of `bu_id`, which is the income-statement page's name).

- Response shape unchanged, plus `version` and `unallocatedBudget`.
- `useStatementComparators` passes the page's filter.
- `useStatementComparatorState` stops forcing `budget: false` when a dimension is selected. **Trend stays gated**: `trendRowsService` is still company-wide.
- `ComparatorNotices` gains the unallocated sentence.

### MCP `budget_variance` (existing, PR-F)

`inputSchema` gains optional `version_id`, `cc1_id`, `cc2_id`, `bu_id` (uuid, `guardCastableArgs`). `additionalProperties: false` is kept.

- Output adds `version` and `dimension_filter`. Under a filter it also adds `unallocated_budget` and coarser exclusions as `excludedRows` reason `budget_above_filter`.
- With none of the new args, the output is byte-identical to the pre-change tool (test), and `figureBasis` stays `budget.actual.v1`.
- The description adds the dimension rules in §2.4 and the version default to P0's corrected wording (D6 is P0's).
- `flowMetering.ts` entry unchanged.

### Packs (PR-D, PR-E)

- **Board pack.** `buildPackFigureSet` gains `opts { versionId? }`, with the primary as default. `packStatementRows.ts` `columnsFor` adds `'budget','variance'` when `set.budget !== null`, so the existing `PackTableColumnKey`s are finally used.
  - Every budget figure carries provenance `source: 'budgetVariance.<code>.budget'`. Band budgets come from the engine's band figures, so the integrity gate's "do not sum a table's lines into its subtotal" rule holds.
  - `assertPackIntegrity` must pass. If it needs a new identity (band budget = engine band), add it with a mutation test.
- **Management pack.** `managementPackGeneratorService.ts` reads `config.comparisonMode`:
  - `prior_month` keeps today's behaviour.
  - `prior_year` uses the same month a year earlier.
  - `budget` adds the BvA band table.
  - `all_three` adds all of them.

  The `income_vs_budget` and `budget_variance` sections (enabled in `managementPackConfigService.ts`, currently `default:` → empty blocks) render tables from `buildBudgetTrackingReport` for the pack month: the band table, and the top 10 lines by |variance|. A company with no version renders the sentence "No budget for FY…", not an empty table.

## 5. Task DAG

Each task names its check (`verify:`). Tasks inside one PR follow TDD: the named test is written first, run red, then made green.

```
T0 precondition ─► T1 window ─► T2 dims ─► T3 reads ─► T4 bands+projection ─► T5 service ─► T6 API+export ─► T7 charts ──► PR-A
                                                                                    │
                                     T8 statementModel/grid + T9 page + T10 drill ◄──┘ ─► PR-B
                                     T11 facade + comparator + dims un-gate ───────────► PR-C ─► T12 packs(board) PR-E
                                                                                          ├─► T13 mgmt pack PR-D
                                                                                          └─► T14 MCP PR-F
T15 golden path + prod-validation request (after PR-B + PR-C merged)
```

- **T0 Precondition.** P0 and P1 are merged on `origin/master` (contract "Preconditions"). Confirm the P0/P1 names at the top of this spec against the merged code and record any drift in the PR-A body. Confirm D7 is fixed in `comparators.ts` (`row.actual`, not `line.actual_amount`); if not, P0 is not merged — stop.
  - verify: `git ls-tree -r --name-only origin/master | grep -F -e src/modules/accounting/services/reports/budgetVsActualSections.ts -e src/modules/accounting/services/budgets/budgetVersionScope.ts` lists both; `git grep -q "CREATE TABLE IF NOT EXISTS budget_versions" origin/master -- scripts/migrations/sql`; `git show origin/master:src/modules/accounting/services/reports/statementRows/comparators.ts | grep -c line.actual_amount` = 0.
- **T1 `trackingWindow`.**
  - verify: `trackingWindow.test.ts` green, and red under its mutations (§6).
- **T2 `trackingDimRollup`** plus the effective-CC1 derivation.
  - verify: `trackingDimRollup.test.ts`.
- **T3 Reads** (`trackingBudgetRead`, `trackingActualRead`).
  - verify: `budget-tracking-is-invariant.int.test.ts` and `budget-tracking-rollup.int.test.ts` green on the `isaflow_schema_fixture` route (`CI_INTEGRATION=1`).
- **T4 `trackingBands` + `trackingProjection`.**
  - verify: `trackingBands.test.ts`, `trackingProjection.test.ts`, `budget-tracking-projection.int.test.ts`.
- **T5 `budgetTrackingService` + `trackingByMember` + `budgetBridgeSteps`.**
  - verify: `budgetBridgeSteps.test.ts`; `budget-tracking-tenancy.int.test.ts`.
- **T6 API + export routes, plus the `budgetTrackingRows` adapter.**
  - verify: `reportsBudgetTracking.test.ts`, `budgetTrackingExport.test.ts`, `budgetTrackingRows.test.ts`.
- **T7 Heatmap builder + component.**
  - verify: `varianceHeatmapOption.test.ts`, `varianceHeatmapLegibility.test.ts` (painted).
- **T8 `statementModel` additive fields + grid projection cells.**
  - verify: `budgetTrackingGridColumns.test.tsx`, plus the existing statement-surface tests unchanged and green (`comparators.test.ts`, `CostCentreComparatorGate.test.tsx`, IS/BS page tests).
- **T9 BvA page rewrite.**
  - verify: `budgetVsActualTrackingPage.test.tsx`; the tests updated for the route change (§6 list); a browser check of dark and light at 1280 and 390 on dev.
- **T10 Drill props + `reports-account-transactions` cc1/cc2 + source link.**
  - verify: `budget-tracking-drill.int.test.ts`.
- **T11 Facade + comparator params + un-gate budget.**
  - verify: `budget-variance-facade-parity.int.test.ts`, `budget-comparator-dims.int.test.ts`, the updated `useStatementComparators.test.tsx` and `CostCentreComparatorGate.test.tsx`, and the D7 case in `comparators.test.ts`.
- **T12 Board pack budget column.**
  - verify: `packFigureSet.test.ts` (extended), **NEW** `packStatementBudgetColumns.test.ts`, the pack integrity suites green, and the PDF text layer containing the Budget header (`tests/unit/print/packTextLayer.test.ts` pattern).
- **T13 Management pack `comparison_mode` + budget sections.**
  - verify: **NEW** `managementPackComparisonMode.test.ts`.
- **T14 MCP params.**
  - verify: the extended `budgetVarianceTool.test.ts`; `budget-variance-mcp-dims.int.test.ts`.
- **T15 Golden path.**
  - verify: `tests/e2e/golden-paths/<letter>-budget-tracking.spec.ts` green on dev, with screenshots; with `GOLDEN_SKIP_A11Y=1`, `bunx playwright test --config playwright-golden.config.ts --list` does not list it.

## 6. Tests and the mutation each catches

"Mutation" is the production-code change the executing session applies, watches go red, and reverts (commit first, or `cp` a backup; never `git checkout` over the fix).

### Unit (`tests/unit/services/budgets/tracking/` NEW unless noted)

| Test | Asserts | Mutation → red |
|---|---|---|
| `trackingWindow.test.ts` | Month, quarter, YTD, FY and custom windows for 12-, 14- and 7-month years (14 → Q5 = 2 months). The in-progress month runs to its month end and is flagged `inProgress`. A quarter past the year is a 400. A custom day-level date is a 400. A cross-FY custom window carries both FYs. | `quarter` built as `months/4`; FY end compared with `<`; `inProgress` dropped |
| `trackingProjection.test.ts` | The cutoff rule (window wholly past vs window reaching the in-progress or a future month). `projected = actualToDate + Σ budget after the cutoff month`. Unbudgeted → `fyBudget` null. A 14-month FY sums 14 months. Not-started and ended FY. | The cutoff month's budget is also counted (double count); the window actual is used instead of the FY-to-date actual; FY months capped at 12 |
| `trackingDimRollup.test.ts` | Every class in the §2.4 table, including CC2 → FNO derivation, a CC2 with no chain, either-level `costCentreId`, and the company level under each filter. | NULL treated as a wildcard (company budget leaks into the CC1 view); derivation removed; either-level applied to the explicit `cc1` |
| `trackingBands.test.ts` | Band and NP budget and actual; favourable by polarity; unbudgeted vs zero budget (D5); `variancePct` null on zero; no revenue + expense total (D1). | Grand total = Σ all lines (D1); `favourable = variance >= 0` for expenses; a `budget === 0` row treated as unbudgeted |
| `budgetBridgeSteps.test.ts` | Steps foot `budgetNP + Σ = actualNP` exactly; the expense effect is negated; the colour comes from `varianceColor`. | Expense delta sign flipped |
| `tests/unit/services/reports/statementRows/budgetTrackingRows.test.ts` | Copies only. `absent` comes through; subtotal rows carry the engine's band figures. | The adapter sums lines into a subtotal (a fixture with a sentinel band ≠ Σ lines goes red) |
| `tests/unit/services/reports/statementRows/comparators.test.ts` (existing ONE file, extended) | `absent` comparator; version/dimension-filtered budget (P0's D7 case stays as is). | `absent` dropped for an unbudgeted row |
| `tests/unit/services/reports/charts/varianceHeatmapOption.test.ts` | Every cell colour ∈ {palette.fav, palette.unfav} or the decal; an account name `<img src=x onerror=1>` is escaped in the tooltip. | `escapeHtml` removed; a literal `#16a34a` used |
| `tests/unit/services/reports/charts/varianceHeatmapLegibility.test.ts` | ECharts SSR → SVG, y-axis labels painted whole inside the clip rect at 1280 and 390 (pattern: `packChartAxisLegibility.test.ts`, `packWaterfallLegibility.test.ts`; memory "chart label fixes need pixel tests"). Seeded names, 3 seeds. | `NARROW_WIDTH` truncation removed |
| `tests/unit/api/reportsBudgetTracking.test.ts` | zod 400s; company taken from `req`, never from the query; the rate limit is honoured. | Validation for `quarter` dropped |
| `tests/unit/api/budgetTrackingExport.test.ts` | CSV and XLSX figures === JSON route figures for the same fixture (every cell); absent → empty; `csvVal` applied (`=cmd` name). | The export computes `budget − actual` itself (old D3 bug) |
| `tests/unit/components/budgetTrackingGridColumns.test.tsx` | Projection cells only when `columns.projection`; IS and BS output unchanged (snapshot of row HTML). | `projection` defaulted on |
| `tests/unit/components/budgetVsActualTrackingPage.test.tsx` | Controls → query string (period, version, dims); notices; the version picker is disabled cross-FY. | `version_id` not forwarded |
| `tests/unit/components/charts/useStatementComparators.test.tsx`, `CostCentreComparatorGate.test.tsx` (existing, updated) | The budget fetch carries the filter and version; budget is no longer gated; trend is still gated. | `budget: false` gate restored; trend un-gated |
| `tests/unit/mcp/budgetVarianceTool.test.ts` (existing, extended) | No new args → output deep-equals a recorded baseline; the new args are passed through; a bad uuid is refused before SQL. | A new arg defaulted into the service call when absent |
| `tests/unit/services/packs/packFigureSet.test.ts` (extended), `packStatementBudgetColumns.test.ts` NEW | Budget/variance columns appear only with `set.budget`; provenance per figure; integrity passes. | The band budget is summed from lines in the page |
| `tests/unit/services/afs/managementPackComparisonMode.test.ts` NEW | Each `comparisonMode` value → the expected columns and sections; no version → the sentence. | `comparisonMode` ignored (today's behaviour) |

### Integration (real PG, `tests/integration/`, NEW)

| Test | Asserts | Mutation → red |
|---|---|---|
| `budget-tracking-is-invariant.int.test.ts` | **Invariant 1.** The seeded 14-month FY ledger has lines tagged cc1, cc2 (with derived cc1), bu and untagged, plus a draft journal, a year-end close journal and a line with `cc2_id` = a cc1-type centre (legacy cross-tag). For windows {every month, Q1–Q5, YTD, FY, 3 customs incl. cross-FY} × filters {none, cc1, cc2, bu, cc1+bu, cc2+bu}: per-account and per-band actual = `getIncomeStatement` (none, bu) / `fetchDimensionAccountRows` member column (cc filters, `groupBy` = that level, `filter.businessUnitId` for +bu), to the cent. | `YEAR_END_JOURNAL_SOURCE` exclusion removed; `cc1` filter written as `cc1_id OR cc2_id`; `entry_date < end` |
| `budget-tracking-rollup.int.test.ts` | **Invariant 2:** company roll-up = Σ grains per account per month. CC1 view = cc1-grain + cc2-grain under that FNO; company level → `unallocatedBudget`. A non-primary version is read only when `version_id` is passed. | `version_id` predicate dropped; `bm.cc1_id IS NULL` rows included under a filter |
| `budget-tracking-projection.int.test.ts` | Projection on a real 14-month FY mid-year and across the in-progress month. | The cutoff uses `windowEnd` unclamped |
| `budget-tracking-tenancy.int.test.ts` | Company B's `version_id` / cc ids / bu id from company A → 404, with no B figure in the body. `app_user` under forced RLS. | `company_id` removed from the version lookup |
| `budget-tracking-drill.int.test.ts` | Σ `reports-account-transactions` (cc1_id/cc2_id/bu_id) = the BvA actual cell, for each filter. | The new `cc1_id` param ignored by the route |
| `budget-comparator-dims.int.test.ts` | The comparator's budget under `cost_centre_id` (either level) and `version_id` = engine; D7 on the IS page fixture. | Either-level matching dropped |
| `budget-variance-facade-parity.int.test.ts` | `getBudgetVariance(c, s, e)` with no options deep-equals the **pre-facade** (P0 + P1) result. The test carries the old SQL as its oracle, verbatim from the merge-base's `reports/budgetWindowActuals.ts` (`loadWindowActuals`) and `budgetWindowService.ts` (`loadWindowBudgets` with the primary scope). | Facade drops a budgeted zero/zero row (P0 keep-rule) |
| `budget-variance-mcp-dims.int.test.ts` | The MCP tool with dims/version against the real ledger = engine. | `bu_id` not forwarded |

Each integration file states its fixture route (`isaflow_schema_fixture` vs `isaflow_test`) by the guard it calls (CLAUDE.md integration step). There are no `skipIf(!LIVE)` guards.

### Existing tests that must change with the route swap (PR-B)

`tests/unit/components/budgetVsActualRange.test.tsx`, `budgetVsActualDrillOnce.test.tsx`, `d2CensusG3a.test.tsx`, `d2R3a2ReportLoads.test.tsx`, `tests/unit/api/balanceQueryGuards.test.ts`, `tests/e2e/full-audit.spec.ts`.

- They are updated to the new routes, not deleted.
- The old routes `pages/api/accounting/reports-budget-vs-actual.ts` and `budget-vs-actual-export.ts` are deleted in PR-B, but only if a census (`grep -rn` across `src pages tests scripts docs`) finds no other consumer. Otherwise they become thin wrappers.

### E2E

`tests/e2e/golden-paths/<next free letter>-budget-tracking.spec.ts` (NEW; follow the `isaflow-golden-paths` skill) is read-only but asserts seeded figures, so it is **dev-only**: add its file name to the `testIgnore` regex in `playwright-golden.config.ts` (contract golden-spec rule; it must never run in prod verify against Demo). It runs on dev against a seeded company:

1. Open BvA YTD and see the bands and NP.
2. Switch the version and see the header change.
3. Filter CC1 and see the unallocated footer.
4. Expand a line, open a GL row, and land on its source document.
5. Export CSV and check the totals equal the screen.

Screenshots: dark and light, 1280 and 390.

## 7. PR split and gates

| PR | Content | Existing paths touched | Gate |
|---|---|---|---|
| **A — tracking engine** | T1–T7: `services/budgets/tracking/*`, `statementRows/budgetTrackingRows.ts`, the 2 new routes, the heatmap, all their tests | none | Greenfield. All 5 trust-boundary conditions apply: all gates green, blind `/review`, security review. It may be `mq-isa add`ed without Hein reading the diff. **Exception:** if PR-A needs any edit to an existing file (e.g. `statementModel.ts` for `absent`), move that edit to PR-B. |
| **B — BvA cut-over** | T8–T10: page rewrite, `statementModel`/`StatementGrid`/`StatementRowView` additive fields, drill props, `reports-account-transactions` cc1/cc2, source link, old-route removal plus P0's `BudgetVsActualTable.tsx` and `budgetVsActualCsv.ts` once nothing imports them, test updates | yes | **Hein reads the diff** before `mq-isa add` |
| **C — comparator + facade** | T11: `getBudgetVariance` facade (deletes P0's `budgetWindowActuals.ts`), comparator params, `useStatementComparatorState` un-gate, `ComparatorNotices`, `PresentSlide`/`present/[pack].tsx` passing version | yes | Hein diff-read |
| **D — management pack** | T13 | yes | Hein diff-read |
| **E — board pack budget column** | T12 | yes (integrity gates) | Hein diff-read, plus an adversarial reviewer (pack figures are client-visible) |
| **F — MCP** | T14 | yes | Hein diff-read |

- Order: A → B, and A → C. C → D, E, F (any order, one at a time per memory "merging interacting PRs").
- No migration is expected in P3. If one turns out to be needed (e.g. an index on `budget_month_amounts(company_id, version_id, month)` that P1 did not create), **stop for Hein's OK** (contract).
- Every PR has `bun run ci` green, the GitHub integration job green, and a blind `/review` plus a security review on the final head. Every H/M/L finding is fixed.

## 8. Acceptance (P3 done)

1. Invariants 1 and 2 are green in CI and red under their mutations, with log paths in the PR bodies.
2. On dev, with the seeded company, and on **ISAFlow Demo in prod** after a Hein-approved after-hours deploy (contract R4, decision 6):
   - BvA shows bands, NP, correct signs, "—" for unbudgeted, and a Projected FY whose header names its cutoff.
   - Version switch, the CC1/CC2/BU filters with the unallocated footer, and the drill to the source document all work.
   - The CSV and XLSX totals equal the screen.
   - The income statement's Budget column under a cost-centre filter shows the same budget figure as BvA for that account and filter.
   - A management pack with `comparison_mode = budget` prints the budget table.
   - The board pack prints a Budget column.
   - MCP `budget_variance` with `cc1_id` returns the engine's figures.
3. Browser proof: dark and light, 1280 and 390, for the BvA page and the IS page with Budget on under a filter. Screenshots are committed under `docs/evidence/budgets/P3/` (NEW).
4. `bun run agent-docs:generate` has been run. `.claude.md` is updated for `budgets/tracking/` (NEW), `statementRows/` (the new adapter; the "copy, never derive" list is unchanged because the engine derives), `reportControls/` (the budget is no longer company-wide only), `charts/` (heatmap) and `packs/figures/`.

## 9. Risks

- **The facade changes four consumers at once** (PR-C). Mitigation: the deep-equal parity test against the old SQL oracle, and PR-C contains nothing else.
- **Legacy cross-tags** (`cc2_id` holding a cc1-type centre, or the reverse) make explicit-level and either-level filters differ. The invariant fixture seeds one deliberately. Before ruling, run a dev census (read-only) of `jl.cc1_id`/`cc2_id` vs `cost_centres.cc_type` and record it in the PR body. The prod census is Hein's call.
- **CC2-grain budgets whose CC2 has no FNO chain** land in "coarser" under a CC1 filter and can surprise users. The footer names them. P2's editor should warn at write time (note for P2).
- **Board pack integrity gate.** A new column touches `packLocatedFigures` and the statement identities. This is the most likely place for review rounds to spiral. After two rounds with comparable finding counts, stop and offer simplify / harden / revert (memory).
- **Calendar-month assumption.** Budgets are calendar months. A registry year that does not start on the 1st would break the windows. Assert it in `trackingWindow` (throw a typed error) rather than silently shifting.
- **Performance.** Account × month × grain over 15 months, plus a parent-chain walk. Load the chains once per request (`loadCostCentreChains` with all CC2 ids). Run queries sequentially under `withAuth`'s single client.
- **Heatmap labels on 390px.** Covered by the painted test, not by a rule-restating test.

## 10. Open questions for Hein (defaults in bold; the executing session builds the default)

> **Resolved 2026-10-26:** Hein accepted the defaults — see `docs/plans/budgets/00-shared-contract.md` decisions 11–17. Build them; do not re-ask.

- **Q1** The old BvA routes required `withWriteAccess` on a GET. The new route is read-only like the income statement, so **viewer roles can open BvA**. Override?
- **Q2** The projection cutoff is **the last complete month; the in-progress month uses its budget**. Alternative: the last *closed fiscal period* (period-close status).
