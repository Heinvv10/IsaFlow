# Budgets: next-level planning & tracking — plan

**Date:** 2026-10-26 · **Status:** Draft for Hein's approval · **Base:** origin/master (migration head 946)

## 1. Goal

Turn budgets from a per-account form into a spreadsheet-grade, versioned, dimension-aware
planning and tracking tool that beats Xero / QBO / Sage SA, and wins on what only an
in-ledger tool can do: drill-down to source, payroll-driven headcount, and budget checks at
the moment a supplier invoice or PO is approved.

**Strongest argument against:** Fathom / Spotlight / Syft already do modelling well and
connect to Sage SA. We must not compete on modelling depth (3-way, scenarios) before the
in-ledger advantages ship. Phases are ordered for that reason.

## 2. Rulings (grill, 2026-10-26)

| # | Ruling |
|---|--------|
| R1 | Schema carries **versions** (Original / Reforecast / Scenario; Draft → Approved → Locked) and nullable **CC1, CC2, BU** keys on every budget amount from the start. Company totals are roll-ups. |
| R2 | MVP user = **one finance user** builds the whole budget. Budget-holder workspaces, submit/approve per dimension = Phase 5. |
| R3 | Plan the **whole** product (all phases); build MVP first. |
| R4 | Validate on **ISAFlow Demo in prod** (after-hours deploys, Hein-approved), plus dev. |

## 3. What exists today (origin/master)

- `budget_month_amounts` (mig 944): company × GL account × month. No version, dimension, status, lock.
- `accounting_budgets`: per-account-per-year header for `notes`; `period_amounts`, `annual_amount`,
  `total_amount`, `status`, `budget_name` are dead.
- UI `/accounting/budgets`: one account at a time via `BudgetForm`; even spread only; copy-to-next-year
  (no uplift, no "from actuals"); read-only month matrix. Old flat-card style; month inputs
  borderless in dark mode (seen in prod).
- `/accounting/reports/budget-vs-actual`: flat account table, inline drill-down, CSV.
- Budget also surfaces in: statement Budget comparator (disabled when a CC/BU filter is set),
  presentation `BudgetBulletRow`, MCP `budget_variance`. Pack budget fetched but never rendered;
  `comparison_mode` on management-pack config stored but unread.

### Defects confirmed (prod, ISAFlow Demo, 26 Oct, current period)

| ID | Defect | Evidence |
|----|--------|----------|
| D1 | BvA total adds revenue + expense (Actual R1.35m, Variance +R710k) — meaningless | prod screenshot; `reports-budget-vs-actual.ts:97-99` |
| D2 | Revenue with no budget shows red **−100%** (sentinel) | prod screenshot; `budgetVsActualLines.ts:70-77` |
| D3 | CSV export: `variance = budget − actual` for all types (revenue backwards), `ga.level = 3` filter, `||` vs `??`, keeps zero rows — disagrees with screen | `budget-vs-actual-export.ts:74-96` |
| D4 | Progress bar uses expense logic for revenue | `budget-vs-actual.tsx:192,219` |
| D5 | Deliberate zero budget treated as "unbudgeted" | `budgetVarianceService.ts:124-125` |
| D6 | MCP description says variance_pct 0 when unbudgeted; code returns −100 | `src/lib/mcp/tools/budgetVariance.ts` |
| D7 | Statement Budget column's variance uses GL aggregate, not the row's printed actual | `comparators.ts:98` |
| D8 | Page default period "Current" vs API default `ytd`; "Current" = calendar MTD, not open fiscal period | `budget-vs-actual.tsx`, `budgetWindowService.ts` |
| D9 | Delete has no confirmation; account picker shows inactive/header accounts | `budgets/index.tsx:67-77` |

## 4. Competitive position (summary)

Ledgers (Xero, QBO, Sage SA, Zoho) all lack: roll-up dimension budgets, actuals+remaining
projection, approval/locking, driver lines, overspend checks, balance-sheet/cash budgets, and
flexible layouts/date ranges. SMEs buy Fathom/Spotlight/Float/ApprovalMax to fill these.
Matrix and sources: Appendix A.

## 5. Phases

Each phase is independently shippable. MVP = P0–P3.

### P0 — Correctness on the current model (1 PR, small)
Fix D1–D9. BvA gets Revenue / Expense / **Net profit** sections; unbudgeted variance % = `null`
rendered "—"; export reuses `budgetVsActualLines` (one source of truth); colours via
`ibcs.varianceColor`. Tests: export parity test (same fixture → identical numbers screen vs CSV).

### P1 — Schema: versions + dimensions (1 PR, migration — needs Hein's confirmation)
- `budget_versions`: `id, company_id, fiscal_year, name, kind (original|reforecast|scenario),
  status (draft|approved|locked), based_on_version_id, is_primary, approved_by/at, locked_by/at,
  created_by/at, updated_at`. One `is_primary` per company+year (partial unique index).
- `budget_month_amounts` += `version_id NOT NULL`, `cc1_id`, `cc2_id`, `bu_id` (nullable FKs,
  company-checked by the existing trigger pattern). Unique key → `(company_id, version_id,
  gl_account_id, cc1_id, cc2_id, bu_id, month) NULLS NOT DISTINCT` (PG15+: verify prod version).
- Migration converts every existing company-year into an "Original" primary version, status
  `approved` (they are in use), with count+sum parity check that fails the migration on mismatch.
- **Lock enforced in the DB**: trigger refuses INSERT/UPDATE/DELETE on amounts whose version is
  `locked` (app code cannot bypass; tested as app_user).
- Status transitions + every bulk write recorded in the audit log (`entity='budget'` already
  exists as a filter with no writer).
- Readers (BvA, comparator, MCP, packs) read the **primary** version unless one is named.
- Dead columns on `accounting_budgets` left in place this phase; drop in a later cleanup PR.

### P2 — Budget workspace (the planning grid)
Route `/accounting/budgets` rebuilt on the statement look (StatementGrid styling, sticky header
+ first column, density toggle, dark/light tokens).
- **Layout:** rows grouped by statement section (Turnover, Cost of sales, Other income,
  Operating expenses) with live subtotals (Gross profit, Net profit); columns = fiscal months,
  FY total, prior-year actual, Δ vs PY; sparkline of PY actuals per row.
- **Editing:** Excel keyboard model (arrows/Enter/Tab, type-to-overwrite, F2, Esc), multi-cell
  select, Ctrl+C/V to/from Excel (TSV), fill right/down, undo/redo, dirty-cell highlight,
  one batched save (optimistic concurrency on version `updated_at`; 409 → reload prompt).
- **Row actions:** set FY total and spread (even / PY seasonality / step +x% per month);
  copy PY actuals; clear.
- **Dimension pivot:** view = Company (roll-up, read-only) | by CC1 | CC2 | BU; edit at the
  chosen grain. Roll-up computed, never stored.
- **Create wizard / empty state:** Start from PY actuals +x% · Copy another version +x% ·
  Blank · Import Excel. Rounding option (R1/R100/R1000).
- **Versions bar:** switcher, New reforecast, Approve, Lock/Unlock (owner/admin), compare two
  versions (Δ column).
- **Excel round-trip:** download template (version, grain), upload → validation + diff preview
  (changed cells highlighted) → commit. No line cap.
- File-size rule: grid split into hooks (`useBudgetGrid`, `useGridKeyboard`, `useGridClipboard`)
  + presentational components, each < 300 lines.

### P3 — Tracking (budget vs actual, rebuilt)
- `/accounting/reports/budget-vs-actual` on StatementGrid with statement sections and subtotals.
- Columns: Actual, Budget, Var R, Var %, and **Projected FY = actuals to date + remaining budget**,
  vs FY budget. Periods: month, quarter, YTD, FY, any custom range. Version picker (default
  primary), dimension filters CC1/CC2/BU.
- Favourable/unfavourable by account type via `ibcs.varianceColor` only; "—" for unbudgeted.
- Drill: variance cell → GL lines (existing `AccountDrillDown`) → source document.
- Visuals: profit waterfall (budget NP → actual NP, `ProfitWaterfall`), variance heatmap
  (account × month), bullet chart per cost centre (`BudgetBulletRow`).
- Wire the rest: statement Budget comparator honours version + dimension filters (remove the
  disable; fix D7 so variance uses the row's own actual); management packs render the budget
  column and honour `comparison_mode`; MCP `budget_variance` gains `version`, `cc1/cc2/bu`.
- Excel + CSV export from the same row model.

### P4 — Drivers & forecasting
- Driver lines: % of another line (COGS = 38% of revenue), growth % m/m, R per head where
  headcount comes from **payroll** (active employees + planned hires per month). Drivers stored
  on the line; amounts recomputed on change; manual override flag per cell.
- Reforecast: "New reforecast from actuals" = closed months take actuals, open months keep budget
  (or drivers). Optional auto-roll after period close (rolling forecast).

### P5 — Controls & collaboration
- Overspend alerts: threshold % per account/CC; in-app + email digest to owners.
- **Budget check at supplier-invoice and PO approval** (`supplierInvoiceWorkflowService`):
  show remaining budget for the line's account+dimension; per-company policy warn / require
  override reason / block.
- Variance commentary per account × month, carried into management packs (reuse `commentary`).
- Budget-holder workspaces: per-dimension permissions, submit → review → approve per slice,
  deadlines and reminders.

### P6 — Balance sheet & cash (3-way) + scenarios
Debtor/creditor days, VAT and PAYE timing, capex, loans → budgeted balance sheet and cash
flow; scenario compare (base/best/worst). Only after P5 proves usage.

## 6. Task DAG

```
P0 ──────────────────────────────┐
P1 (migration) ──► P2 grid ──► P2 wizard/import ─┐
          └──────► P3 BvA ──► P3 comparator/packs/MCP ──► P4 ──► P5 ──► P6
```
P0 and P1 can run in parallel (different files). P2 and P3 can run in parallel after P1.

## 7. Validation gates (per PR)

- `bun run ci` green; GitHub integration job green (migration runs as non-superuser).
- Blind `/review`; **adversarial review** on P1 (migration, lock trigger, RLS) and P5 (approval gate).
- Invariants (automated, integration tests):
  1. BvA Actual for any range/dimension = income-statement figure for the same range/dimension.
  2. Company roll-up = Σ dimension lines, per account per month.
  3. Excel export → import of the same file = zero diff.
  4. Locked version refuses writes as app_user (DB-level, not just API).
  5. P1 migration: per-company count and sum parity before/after.
- Mutation check: break each invariant in production code, watch the test go red.
- UI: browser proof in dark **and** light on ISAFlow Demo (dev, then prod), 1280px and 390px.
- Golden path spec: create budget from PY actuals +10% → edit via paste → approve → BvA shows
  it with correct signs.
- Deploys: merge queue (`mq-isa add`), prod deploy after hours with Hein's approval per deploy.

## 8. Acceptance (MVP done = P0–P3 live)

On ISAFlow Demo in prod, a finance user can, in under 30 minutes and without a form per account:
build FY2028 by cost centre from PY actuals +x% with seasonality, paste a column from Excel,
approve and lock it, then see BvA with correct signs, net profit, projected FY, drill to source,
and the same figures in the income statement Budget column and management pack.

## 9. Not building (MVP)

Driver lines, alerts, invoice/PO budget checks, budget holders, 3-way, scenarios, group
consolidation (all later phases). No separate forecasting app; everything lives in the ledger.

## 10. Open items to confirm before P1

- Prod Postgres version supports `NULLS NOT DISTINCT` (PG15+); else use COALESCE-sentinel index.
- Who may Approve / Lock (owner+admin proposed).
- Demo company needs prior-year actuals across ≥12 months for the seasonality spread to show well.

## Appendix A — Competitor matrix (research 2026-10-26)

Y = yes, P = partial, N = no, ? = unverified. Sage SA cells LOW confidence (vendor site 403).

| Capability | Xero | QBO | Sage SA | Zoho | Fathom/Spotlight | Jirav/Cube |
|---|---|---|---|---|---|---|
| Versions/scenarios | P | P | ? | P | Y | Y |
| Dimension budgets that roll up | P (no roll-up) | P | ? | P (1 tag) | Y | Y |
| Driver lines | N | N | N | N | Y | Y |
| Spread methods | P | P | P | P | Y | Y |
| Copy actuals/prior +uplift | Y | Y | Y | Y | Y | Y |
| Excel round-trip | Y (500-line cap) | Y | ? | P | Y | Y |
| Approval & lock | N | N | N | N | P | Y |
| Actuals + remaining forecast | N | P | N | N | Y | Y |
| Fav/unfav variance colouring | P | P | P | Y | Y | Y |
| Balance-sheet / cash budgets | N | P | N | P | Y | Y |
| Overspend alerts | N | N | N | N | P | P |
| Variance commentary | N | N | N | N | Y | Y |

Sources: Xero ideas board (actuals+remaining, BS budgets, layout), Calxa (tracking budgets),
Xero Budget Consolidator app, Intuit help + community (class budgets), Insightful Accountant
(QBO BS budgets), Sage Community ZA (custom-date variance disabled), Zoho help, ApprovalMax
Budget Checking, Fathom, Spotlight, Jirav, Cube vendor pages.
