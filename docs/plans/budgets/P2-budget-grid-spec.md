# P2: budget workspace (planning grid, create wizard, Excel round-trip, versions bar)

**Date:** 2026-10-26 · **Parent:** `docs/plans/2026-10-26-budgets-next-level.md` §5 P2 · **Contract:** `docs/plans/budgets/00-shared-contract.md` (obeyed exactly; canonical names are P1's)
**Depends on:** P1 merged (versions + dimension keys + lock trigger + audit writer + every `budget-versions/**` route). PR-D also needs P0 merged (it replaces the page P0 fixes). **Runs in parallel with:** P3. Precondition checks: contract "Preconditions".
**Goal file:** `.claude/handoffs/2026-10-26-budgets-P2-budget-grid-goal.md`

Paths: every path below was checked with `git ls-files | grep -F` on `origin/master` 49d139b5e. **NEW** marks a file this phase creates. **P1** marks a file P1 creates (names from `P1-schema-versions-spec.md` §6); the P2 session checks it at start (§3).

**Strongest argument against:** a home-grown spreadsheet grid is a lot of interaction code (keyboard, selection, clipboard, undo) that a library would give us for free. It is the part of this product most likely to feel "almost Excel" and annoy users. **Answer:** no grid library is in `package.json`. The ones that do this well (AG Grid, Handsontable) are either commercial-licensed for these features or large. Our needs are narrow (one numeric block, fixed columns, no formulas). All the interaction logic is put in framework-free reducers with table-driven tests, so "almost Excel" becomes a list of failing cases rather than a feeling.

---

## 1. Outcome

`/accounting/budgets` becomes a statement-styled planning grid. A finance user can:

1. Open a fiscal year and see every revenue and expense account in statement order, with live Gross profit, Operating profit and Net profit.
2. Create a version from PY actuals +x%, from another version +x%, blank, or from Excel.
3. Edit like Excel: keyboard, range select, paste from Excel, fill, undo. Save everything in one batch.
4. Spread a row's FY total evenly, by PY seasonality, or by step growth, with R1/R100/R1000 rounding.
5. Budget an account at company level or by CC1, CC2 or BU, and see the company roll-up read-only.
6. Download an Excel template, fill it, upload it, review a diff, and commit.
7. Approve, lock and unlock versions under the role rules, and compare two versions.

## 2. Product decisions applied (from the contract; not re-asked)

| # | How P2 applies it |
|---|---|
| 1 | Approve and Lock buttons render for `owner`/`admin` only; Unlock for `owner` only, with a mandatory reason dialog. The server is authoritative (P1's `POST /api/accounting/budget-versions/[id]/status` → `transitionVersion` role checks), and the UI gating is cosmetic only. |
| 2 | Approved versions stay editable. The status chip reads "Approved, edits are audited", and every batch save writes one audit row. Locked versions make the grid read-only (`aria-readonly`). A write that reaches a locked version gets a 409 `BUDGET_VERSION_LOCKED` (P1's `mapBudgetDbError`: SQLSTATE `BV001`), never a 500. |
| 3 | Converted "Original" versions open like any other approved primary version. |
| 4 | **One grain per account per version.** The grid edits only at the account's grain. Other views show it read-only with a reason. Changing grain is an explicit row action that clears the old grain in the same batch (deletes before upserts). The DB still enforces it (P1), and a constraint violation is mapped to a 400 with the account named. |
| 5 | `spread.ts` rounds to the chosen unit (R1 default, R100, R1000). The residue lands on the **last** month. The same pure function is used by the wizard (server) and the row actions (client). |
| 6 | Prod validation happens only in ISAFlow Demo, through the UI. The golden spec also runs in prod post-deploy verify against Demo (`scripts/verify-deploy.sh`), so it obeys the contract's golden-spec write rule: a **non-primary `scenario`** version named `GP-<runId>`, prechecks before any write, stale-`GP-%` sweep, delete in `afterAll`/`finally` (§14 E2E). |

## 3. P1 dependency (check at session start; build only the gaps)

The session runs the contract's precondition checks first, then reads P1's `budgets/.claude.md` and maps each need below to the shipped name (census table into the PR-A body). **P2 builds none of these.** A missing row is a precondition failure: STOP and report (contract ownership table: P1 owns every version route).

| Need | P1 name (P1 spec §3, §6) |
|---|---|
| `budget_versions` + amount keys `version_id, cc1_id, cc2_id, bu_id` | P1 migration |
| Lock trigger with a distinguishable error | `budget_month_amounts_refuse_locked()`, SQLSTATE `BV001` → `BudgetVersionError('BUDGET_VERSION_LOCKED', 409)` via `mapBudgetDbError` |
| Grain enforcement (decision 4) | `budget_month_amounts_one_grain` exclusion, SQLSTATE `23P01` → `BUDGET_GRAIN_CONFLICT` (400) |
| Unique cell key for upserts | `ON CONFLICT ON CONSTRAINT budget_month_amounts_one_per_cell` |
| Version service: list, get, create, copy (same FY), set primary, delete | `budgets/budgetVersions.ts` (`listVersions`, `getVersion`, `createVersion`, `copyVersion`, `setPrimary`, `deleteVersion`); routes `budget-versions/index.ts` (GET/POST), `[id]/index.ts` (GET/DELETE), `[id]/copy.ts`, `[id]/primary.ts` |
| Status transitions approve/lock/unlock(reason), bumping `updated_at`, audit row written by the DB trigger | `budgets/budgetVersionStatus.ts` `transitionVersion`; route `budget-versions/[id]/status.ts` (owner-only unlock checked there; `withRole` is not widened) |
| Version pre-lock before amount writes (upgrade-deadlock rule) | `budgets/budgetVersionScope.ts` `lockVersionForWrite` under `withRowLockBudget` |
| Delete rule | not primary, not locked; draft: any writer; approved: owner/admin |
| Audit writer for entity `'budget'` | `logAuditOrThrow` (`src/modules/accounting/services/core/auditTrailService.ts`) |

P2 never writes migrations. If P2 finds it needs schema, it STOPs (Confirmation gate).

## 4. Module shape

### 4.1 Pure, framework-free (no React, no DOM, no `@/lib/neon`). PR-A.

Directory `src/modules/accounting/services/budgets/grid/` NEW. The server reuses `spread.ts` and `subtotals.ts`, which is why this lives under `services/` and not under `components/`.

| File (NEW) | Exports | ≤ lines |
|---|---|---|
| `cents.ts` | `toCents(n)`, `fromCents(c)`, `roundToUnit(cents, unit: 1\|100\|1000)` (rand units, half away from zero, integer cents only, no float sums) | 60 |
| `spread.ts` | `spreadEven(totalCents, n, unit)`, `spreadSeasonal(totalCents, pyCents[], unit)`, `spreadStep(totalCents, n, growthPct, unit)`, `uplift(pyCents[], pct, unit)`, each returning `{ok:true, months} \| {ok:false, reason}` | 150 |
| `cellKey.ts` | `CellKey` = `${glAccountId}\|${cc1\|''}\|${cc2\|''}\|${bu\|''}\|${YYYY-MM}`, `parseKey`, `grainOf(cell)` | 60 |
| `selection.ts` | `Pos {r,c}`, `Range`, `normalise`, `extend`, `clampToEditable(range, editable)`, `cellsIn(range)`, `nextFocusable(pos, dir, rows)` (skips section/subtotal rows) | 150 |
| `keyboard.ts` | `gridReducer(state, action) → {state, effects[]}`, the §5 table as code. Effects: `commit`, `clear`, `copy`, `paste`, `fillDown`, `fillRight`, `undo`, `redo`, `save`, `announce` | 260 |
| `pasteParse.ts` | `parseClipboard(text) → { rows: (ParsedNumber)[][], errors }`, `parseAmount(text) → cents \| null \| Error` (rules in §5.4) | 200 |
| `tsv.ts` | `toTsv(matrix)` (raw `1234.50`, no separators, blank for unbudgeted) | 50 |
| `fill.ts` | `fillDown`, `fillRight`, `pasteInto(anchor, matrix, selection, editable)` → `{writes, skipped}` | 150 |
| `undo.ts` | `UndoStack` (entries `{key, before, after}[]`, limit 100, redo cleared by a new entry) | 90 |
| `subtotals.ts` | `BAND_ORDER`, `foldBands(rows, valueOf)` → turnover, costOfSales, grossProfit, otherIncome, operatingExpenses, operatingProfit, otherExpenses, netProfit, per month and FY | 120 |
| `pivot.ts` | `resolveView(cells, grains, view:{kind:'company'} \| {kind:'cc1'\|'cc2'\|'bu', memberId})` → per account `{values[], editable, readReason?}`; company view = Σ every dim row of the account (roll-up, computed) | 200 |
| `diff.ts` | `diffCells(base, incoming, mode:'import')` (blank = clear, 0 = zero, absent row = untouched), `rebaseDirty(original, fresh, dirty)` → `{applied, conflicts}` for the 409 flow | 180 |
| `.claude.md` NEW | caller contract and rules (≥4 files) | 50 |

### 4.2 Server (P1's directory `src/modules/accounting/services/budgets/`). PR-B.

| File | Role |
|---|---|
| `gridReadModel.ts` NEW | Loads version + year months (`gl/fiscalYearRegistry`) + accounts + bands + dimensions + cells + grains. Accounts = active, postable revenue/expense accounts, plus any account holding amounts in this version (inactive ones flagged). Band via `revenueBand`/`expenseBand` from `src/modules/accounting/services/gl/accountClassification.ts`. A header is any account that another account (active or not) names as `parent_account_id`: the `leafAccountOptions` rule in `src/lib/chartAccountOptions.ts`. D9 requires excluding them. |
| `priorActuals.ts` NEW | (Contract ownership: if P3 PR-A's `budgets/tracking/trackingActualRead.ts` is on master, build on it; otherwise P3 PR-B later makes this delegate to it.) PY actual per account × calendar month (**the same calendar month one year earlier**, so a 14-month transition year maps correctly) × optional dimension (`gl_journal_lines.cc1_id/cc2_id/bu_id`, mig 285). Posted entries only, natural sign (revenue Cr−Dr, expense Dr−Cr). Must agree with `trendRowsService.getMonthlyMovements` for company grain (a parity test). |
| `gridSave.ts` NEW | `saveCells(companyId, userId, {versionId, expectedUpdatedAt, cells})` (§7.2). The only batch writer for the grid; P4 later adds a `recomputeDependents` call inside it. |
| `seedVersion.ts` NEW | Wizard: create the version (P1 `createVersion`) and the amounts in one tx (§8). Same-FY copy at 0% uplift uses P1 `copyVersion`. |
| `budgetTemplateXlsx.ts` NEW | exceljs workbook builder (§9.1) |
| `budgetImportParse.ts` NEW | Upload → rows, through `normaliseXlsx` + the streaming reader. Pattern of `src/lib/xlsxToCsv.ts`; `XLSX_LIMITS` reused. |
| `budgetImportDiff.ts` NEW | Validates against the read model; `diffCells` produces the preview |
| `.claude.md` | P1's file. P2 appends its section, then runs `bun run agent-docs:generate`. |

### 4.3 API routes (NEW, PR-B). All `withAuth(withErrorHandler(withCsrf(withWriteAccess(handler))))` for writes, as in `pages/api/accounting/budgets.ts`. GETs use `withAuth(withErrorHandler(...))`.

| Route | Method | Purpose |
|---|---|---|
| `pages/api/accounting/budget-grid/index.ts` | GET | Read model: `?version_id=` or `?fiscal_year=` (primary, else newest). `&cells_only=1` returns the compare-version fetch. |
| `pages/api/accounting/budget-grid/prior-actuals.ts` | GET | `?fiscal_year=&grain=company\|cc1\|cc2\|bu`, fetched lazily per view |
| `pages/api/accounting/budget-grid/save.ts` | POST | Batch save (§7.2). `bodyParser.sizeLimit: '10mb'`. |
| `pages/api/accounting/budget-grid/seed.ts` | POST | Wizard create (§8) |
| `pages/api/accounting/budget-grid/template.ts` | GET | `.xlsx` template `?version_id=&grain=` |
| `pages/api/accounting/budget-grid/import-preview.ts` | POST | multipart (`formidable`, 10 MB; pattern of `pages/api/accounting/migration-parse.ts`) → preview. **Writes nothing.** |

Import **commit** reuses `save.ts`, sending the preview's cells and the preview's `updatedAt` token. There is one write path. Version create/status/copy/primary/delete go to P1's `budget-versions/**` routes; P2 adds none.

### 4.4 UI (PR-C), directory `src/components/accounting/budgets/workspace/` NEW

| File (NEW) | Role | ≤ lines |
|---|---|---|
| `BudgetWorkspace.tsx` | Page body: loads, wires the bar, toolbar, grid and save bar | 220 |
| `budgetWorkspaceClient.ts` | Response types + fetchers (`apiFetch` + `assertOk`/`apiJson`; `apiFetch` resolves on 4xx) | 150 |
| `gridStore.ts` | External store (`useSyncExternalStore`): `values: Map<CellKey, cents\|null>`, `original`, `dirty`, `undo`. Per-row subscription so one edit re-renders one row plus the subtotals. | 200 |
| `useBudgetGrid.ts` | Load / view change / save / 409 handling | 220 |
| `useGridKeyboard.ts` | DOM key events → `gridReducer` → effects | 180 |
| `useGridClipboard.ts` | `copy`/`cut`/`paste` events (ClipboardEvent `text/plain`), no clipboard-permission API | 120 |
| `useUnsavedGuard.ts` | `beforeunload` + Next `routeChangeStart` guard while dirty | 60 |
| `VersionsBar.tsx` | Switcher, status chip, New reforecast, Approve, Lock, Unlock, Set primary, Compare, Delete (§10) | 220 |
| `VersionStatusDialogs.tsx` | Confirm approve/lock; unlock reason (required, 1–500 chars trimmed, P1's rule); delete confirm (fixes D9's no-confirm pattern) | 200 |
| `GridToolbar.tsx` | View (Company / CC1 / CC2 / BU) + member picker, rounding unit, density (`useDensity` + `DensityToggle` from `src/components/accounting/reportControls/`), Export / Import, show PY / Δ columns | 180 |
| `BudgetGrid.tsx` | `<table role="grid">`, sticky head + first column (`STICKY_HEAD`, `STICKY_FIRST_HEAD`, `STICKY_FIRST_CELL` from `src/components/accounting/statement/stickyTable.ts`), section `<tbody>`s | 220 |
| `BudgetGridRow.tsx` | `memo` line row: label, month cells, FY total, PY, Δ vs PY, `Sparkline` (`src/components/accounting/statement/Sparkline.tsx`), row-actions trigger | 200 |
| `BudgetSubtotalRow.tsx` | Band subtotal + GP/OP/NP rows, styled with StatementRowView's `KIND_CLASS` values (copied as constants; StatementRowView is not reused because it renders `StatementRow`, which has no months) | 100 |
| `BudgetCellEditor.tsx` | Absolutely positioned `<input inputMode="decimal">` in the active cell | 100 |
| `RowActionsMenu.tsx` + `SpreadDialog.tsx` | Spread even / PY seasonality / step growth, copy PY actuals, clear row, change grain | 120 + 200 |
| `SaveBar.tsx` + `StaleVersionDialog.tsx` | Dirty count, Save (Ctrl+S), Discard; the 409 flow (§7.3) | 120 + 160 |
| `MobileCellSheet.tsx` | Bottom sheet single-cell editor for coarse pointers / <768px (§12) | 150 |
| `CreateWizard.tsx`, `WizardSourceStep.tsx`, `WizardOptionsStep.tsx` | §8 | 200 each |
| `ImportDialog.tsx`, `ImportDiffPreview.tsx` | §9.2 | 200 each |
| `WorkspaceEmptyState.tsx` | No version for FY → wizard CTA; no accounts → link to chart of accounts | 80 |
| `.claude.md` NEW | contract, rules, recent changes | 50 |

Page: `pages/accounting/budgets/workspace.tsx` NEW (PR-C, unlinked). Then PR-D makes `pages/accounting/budgets/index.tsx` render `BudgetWorkspace` and deletes `src/components/accounting/budgets/BudgetForm.tsx`, along with the tests that only covered it. `src/components/accounting/budgets/budgetClient.ts`'s `monthLabel`/`yearRangeLabel` are reused. Nav: `src/components/accounting/navSections/accounting.ts:73` and `accountants.ts:76` already point at `/accounting/budgets`, so PR-D changes no nav entry. `/accounting/budgets/workspace` redirects to `/accounting/budgets` after PR-D. `activeTab.ts:144` already matches the prefix.

**"Render, never compute" note:** `src/components/accounting/statement/.claude.md` forbids arithmetic in the statement renderer. The budget grid is a separate editor, not a `StatementGrid`, and it must compute live subtotals as you type. The arithmetic stays in `subtotals.ts` (pure, tested for parity with `aggregateFigures`). The components only print.

## 5. Interaction spec (each row is a `keyboard.test.ts` / `selection.test.ts` case)

### 5.1 Model
- **Focusable cells:** line rows × (month columns + FY total column). Section, subtotal, GP/OP/NP rows are skipped by vertical navigation but readable (`aria-readonly`). Label, PY and Δ columns are not focusable.
- **Editable** = version not locked ∧ user may write (`withWriteAccess` roles) ∧ the account's grain matches the current view (§11). Read-only cells take focus, and typing on one announces the reason ("Locked version", "Budgeted by CC1, switch view to edit", "Company roll-up").
- **Modes:** `nav` | `edit`. State: `{focus, anchor, mode, draft, editOrigin:'type'|'f2'|'dblclick'}`.

### 5.2 Keys
| Key (nav) | Result |
|---|---|
| ←↑→↓ | Move focus 1 (vertical skips non-line rows); collapse the selection to focus |
| Shift+arrow | Extend selection from anchor |
| Ctrl/⌘+arrow | Jump to first/last focusable in that direction |
| Home / End | First / last month column of the row; Ctrl+Home/End = first/last line row |
| PageUp/PageDown | ±20 line rows |
| Tab / Shift+Tab | Right / left; at the row edge, stop (no wrap, so focus never leaves the grid unexpectedly); Tab from the last column exits the grid to the save bar |
| Enter / Shift+Enter | Down / up (Excel) |
| Printable `0-9 - . ( R` | Enter `edit` with draft = that char (**overwrite**) |
| F2, double-click | Enter `edit` with the current raw value, caret at end |
| Delete / Backspace | Clear every editable cell in the selection (value → `null` = not budgeted); one undo entry |
| Ctrl+C / Ctrl+X | Copy the selection as TSV; cut = copy + clear |
| Ctrl+V | Paste (§5.3) |
| Ctrl+D / Ctrl+R | Fill down / right from the selection's top row / left column |
| Ctrl+Z / Ctrl+Y / Ctrl+Shift+Z | Undo / redo |
| Ctrl+A | Select every editable cell in the current view |
| Ctrl+S | Save (preventDefault) |
| Esc | Collapse the selection |

| Key (edit) | Result |
|---|---|
| Enter / Shift+Enter / Tab / Shift+Tab | Commit, then move as in nav |
| Esc | Cancel the draft, back to nav, value unchanged |
| ←/→ | Move the caret (do **not** leave the cell; the F2 behaviour applies to both origins, a deliberate simplification) |
| blur (click elsewhere) | Commit |

Typing in the **FY total** cell and committing spreads evenly with the toolbar rounding unit (one undo entry for the whole row). Other spreads are row actions.

**Mouse:** click = focus; Shift+click = extend; drag = range; double-click = edit. A fill handle (drag-to-fill) is **not in P2**; Ctrl+D/R cover it.

### 5.3 Paste
- Clipboard 1×1 and a selection of >1 cell: fill every editable cell in the selection.
- Otherwise: paste the block with its top-left at the selection's top-left, clipped to the grid. Read-only targets are skipped and counted.
- The whole paste is one undo entry. A live region announces "Pasted 12 cells; 2 skipped (read-only); 1 not a number (left unchanged)". The invalid cells are listed in a dismissible notice with row/month.

### 5.4 `parseAmount` rules (table-driven tests)
- Trim spaces and NBSP. Strip a leading `R`/`ZAR`. `(x)` or a leading `-`/`−` (U+2212) means negative. A trailing `-` is accepted (Excel export of some locales).
- Both `,` and `.` present: the **last** one is the decimal separator, and the other is thousands.
- Only `,` present: if every comma is followed by exactly 3 digits **and** there is more than one group, or the number has a leading group of 1–3 digits, it is thousands (`1,234` → 1234, `12,345,678`). Otherwise it is a decimal (`1,5` → 1.5, `1234,50` → 1234.50).
- Spaces between digit groups are thousands (`1 234 567,89`).
- `""` → `null` (clear). `"-"` alone (an Excel zero in accounting format) → 0. `#N/A` / text → error.
- Result rounded half away from zero to cents (`round2` semantics of `src/modules/accounting/services/core/budgetMonths.ts`). |value| < 10¹³ (NUMERIC(15,2)), otherwise error.

### 5.5 Undo
Each user action is one entry: commit, paste, fill, clear, a row action, a grain change, or an import apply. Undo restores `before` for every key in the entry, and redo re-applies it. Limit 100 entries. A save does **not** clear the stack; undo after a save makes the cells dirty again. A reload, version switch or view switch clears it, and a dirty grid confirms first.

### 5.6 Dirty state
- A dirty cell is one where the value differs from `original`. Committing it back to the original value un-dirties it.
- Dirty cells get the `--ff-dirty-bg` token NEW (light/dark defined in `styles/globals.css` beside `--ff-fav`), plus a 2px left inset marker. The marker also tells colour-blind users and readers of the print view which cells are dirty.
- The save bar shows "N unsaved changes · Save · Discard". `useUnsavedGuard` blocks navigation while dirty.

## 6. Layout

### 6.1 Columns
1. Account (sticky first column: code + name; inactive badge; grain badge e.g. `CC1`).
2. One column per fiscal month (`year.monthKeys`, 1–15). Header `Mar 26`, with the full month name in `aria-label`.
3. FY total (bold).
4. PY actual (FY), muted.
5. Δ vs PY: R and % (`formatPct`). Coloured fav/unfav via `varianceColor` from `src/components/accounting/charts/ibcs.ts` with the `useChartPalette()` palette. Polarity: revenue up = favourable, expense up = unfavourable. PY = 0 gives "—", not a %.
6. PY trend: `Sparkline` of the 12 PY months.
7. Optional: **Δ vs <compare version>** (FY), once a compare version is picked.
8. Row actions (⋯).

Density toggle: `owner` hides PY trend and Δ%; `accountant` shows all and shows cents.

### 6.2 Rows
These are bands in the reconciling order of `src/modules/accounting/services/reports/statementRows/incomeStatementRows.ts`:
- Turnover
- Cost of sales
- **Gross profit**
- Other income
- Operating expenses
- **Operating profit**
- Other expenses
- **Net profit** (grand: double rule)

Each band has a section head row, line rows sorted by account code, and a "Total <band>" row. All subtotals are live per month and FY.

### 6.3 Money and look
- Figures use `formatStatementFigure` / `formatPct` from `src/lib/format/money.ts` (brackets, en dash for zero), with tabular numerals and the `--ff-fig-font` style as in StatementRowView.
- **A not-budgeted cell renders empty; a budgeted zero renders "–"** (D5: a deliberate zero is not "unbudgeted").
- Colours come only from `--ff-*` tokens (`styles/globals.css` `:root` / `.dark`). Fav/unfav colour comes only through `varianceColor`.

### 6.4 States
| State | UI |
|---|---|
| Loading | Skeleton: header + 8 shimmer rows (no layout shift); the bar is disabled |
| Load failed | Error panel with a message from `apiErrorMessage` + Retry (keeps the FY select usable, as the current page does) |
| No version for FY | `WorkspaceEmptyState`: "No budget for FY2028 yet", with buttons for the 4 wizard sources |
| Version exists, no amounts | Grid with every account empty + a hint to paste from Excel or use row actions |
| No revenue/expense accounts | Link to the chart of accounts |
| Locked | Lock chip + reason tooltip (locked by/at); grid read-only; Save hidden |
| Saving | Save button spinner; grid stays editable, and edits made during the save stay dirty because the save sends a snapshot |
| Save failed (non-409) | Inline error in the save bar; dirty state kept |
| 409 | §7.3 |

## 7. Save and concurrency

### 7.1 Token
The token is `budget_versions.updated_at`, sent as **text** (`updated_at::text`, microsecond precision). A JS `Date` drops microseconds and would 409 every save. The read model returns `updatedAt` as that text. P1 bumps `updated_at` on every transition and every pre-lock (`accounting_updated_at` trigger + `lockVersionForWrite`).

### 7.2 `POST /api/accounting/budget-grid/save`
Request:
```json
{ "versionId": "uuid", "expectedUpdatedAt": "2026-10-26 18:01:02.123456+00",
  "cells": [{ "glAccountId": "uuid", "cc1Id": null, "cc2Id": null, "buId": null, "month": "2027-03", "amount": 1234.5 | null }] }
```
`amount: null` means delete the row (not budgeted). Server steps, all in the `withAuth` tx:
1. Validate the shape (zod). Validate months ⊂ version FY months. Validate amounts are finite, |x| < 10¹³, and rounded to cents. No duplicate keys. Allow up to 200 000 cells: a safety bound, not a product cap (250 accounts × 15 months × 40 members = 150k).
2. Run `UPDATE budget_versions SET updated_at = clock_timestamp() WHERE id = $v AND company_id = $c AND updated_at = $expected::timestamptz AND status <> 'locked' RETURNING updated_at::text`, inside `withRowLockBudget`. This is P1's `lockVersionForWrite` pre-lock (upgrade-deadlock rule, P1 spec §3.5) plus the `updated_at` CAS; it takes the row lock first, so concurrent saves serialise. If 0 rows: re-read. Not found / other company → 404. Locked → 409 `BUDGET_VERSION_LOCKED`. Otherwise → 409 `BUDGET_VERSION_STALE` `{currentUpdatedAt, updatedBy?, status}`.
3. Check that the account ids and dimension ids belong to `company_id` (one query each via `unnest`; the existing company-check trigger is the backstop). Revenue/expense accounts only.
4. `DELETE` the null-amount keys, then upsert the rest with `INSERT … SELECT FROM unnest(...) ON CONFLICT ON CONSTRAINT budget_month_amounts_one_per_cell DO UPDATE`. Deletes run first so a grain change in one batch passes decision 4.
5. Map DB errors only through P1's `mapBudgetDbError` (`BV001` → 409 `BUDGET_VERSION_LOCKED`, `23P01` on `budget_month_amounts_one_grain` → 400 `BUDGET_GRAIN_CONFLICT` naming the account). Any other DB error is rethrown (500, rolled back).
6. `logAuditOrThrow` once: entity `'budget'`, entity id = version id, details `{upserts, deletes, sumBefore, sumAfter, versionStatus}`.
7. Respond `{updatedAt, saved: n, deleted: m}`.

An empty batch → 400 "Nothing to save" (no token bump).

### 7.3 409 dialog (`StaleVersionDialog`)
The dialog says "This budget was changed (by X at T / was approved / was locked) since you opened it. Your N unsaved changes are kept." Three actions:
- **Reload and re-apply mine.** Fetch fresh, then `rebaseDirty`. A cell where fresh ≠ the original I edited from is a **conflict**: it is highlighted, and my value is applied but listed. The user then saves with the new token.
- **Discard mine and reload.**
- **Download my changes (.xlsx)**, built client-side from the dirty cells using the template format.

When the version is locked, "re-apply" is replaced by "Copy into a new draft version". That is the wizard's copy source plus the dirty overlay, applied as an import.

## 8. Create wizard (`POST /api/accounting/budget-grid/seed`)

The wizard is a modal with 3 steps, also used by "New reforecast".

1. **Version:** FY (registry years), name, kind (`original` if this is the FY's first version, else `reforecast`/`scenario`), "Make primary" (owner/admin only).
2. **Source:**
   - PY actuals +x%
   - Copy version (any FY; the same FY maps month-for-month, another FY maps by month position as `copyBudgets` does today) +x%
   - Blank
   - Import Excel: creates the version blank, then opens §9.2
3. **Options:**
   - Grain for the seed: company, or by CC1/CC2/BU, using PY actuals at that grain. PY rows with a NULL dimension under a dimension grain are put in an **"Unassigned"** prompt: either keep them at company level for those accounts, or drop them. Decision 4 forbids mixing grains per account, so this is [agent decides the exact UX].
   - Rounding R1/R100/R1000.
   - Include accounts with no PY activity (default off).

   The preview shows Turnover / GP / NP for FY, PY and the new version before Create.

Request: `{fiscalYear, name, kind, makePrimary, source: {type:'py_actuals', upliftPct, grain} | {type:'version', versionId, upliftPct} | {type:'blank'}, roundingUnit}`.

The server creates the version and inserts the amounts in one tx, computing amounts with the **same** `uplift`/`spreadEven` functions. It writes an audit row and responds with `{versionId, updatedAt, cells: n}`. The version starts as `draft`. Uplift rule (decision 5):
- target = roundToUnit(Σ PY × (1+x)).
- Months 1…n−1 = roundToUnit(PY_m × (1+x)).
- Last month = target − Σ(others).

Negative PY months (credits on an expense) are kept as they are. x ranges from −100% to +1000%.

## 9. Excel round-trip

Library: **exceljs ^4.4.0**, already in `package.json` and used by `pages/api/accounting/gl-import-template.ts`, `src/lib/xlsxToCsv.ts` and `src/modules/accounting/services/reports/incomeStatementDimensionSheet.ts`. No new dependency.

### 9.1 Template (`GET …/template?version_id=&grain=company|cc1|cc2|bu`)
- Sheet `Budget`, frozen panes, number format `#,##0.00`.
- Columns: Section | Account code | Account name | [Dimension code | Dimension name] | one column per month (header text `YYYY-MM`, not a date, so locales cannot reformat it) | FY total (a formula, ignored on import) | PY actual (info, ignored).
- At a dimension grain there is one row per account × member, but only for accounts at that grain or with no amounts yet.
- **A blank cell means not budgeted; 0 means budgeted zero.**
- Sheet `_meta` (hidden, protected): `versionId, fiscalYear, grain, updatedAt, templateVersion=1`. An "Instructions" sheet carries the blank-vs-0 and absent-rows rules.

### 9.2 Import (`POST …/import-preview`, multipart `file`, `versionId`)
- The parse goes through `normaliseXlsx` + the streaming reader. A formula cell takes its cached `result`.
- Validation:
  - `_meta.versionId` mismatch: refuse, with "Pick that version or re-download".
  - `fiscalYear` mismatch: refuse.
  - Month headers must equal the FY months exactly.
  - Unknown account/dimension code: error row.
  - An account at another grain in this version (decision 4): error row with a hint.
  - A duplicate row key: error.
  - A non-numeric cell: error.
  - Header/inactive account: warning.
- **Rows absent from the file are untouched.** No business line cap. The `XLSX_LIMITS` safety bounds apply (50 000 rows, 100 columns, 80 MB inflated).
- Response: `{updatedAt (token at preview), changes:[{key, before, after}], counts:{added, changed, cleared, unchanged}, errors:[{row, column, message}], warnings, totals:{before, after} by band}`.
- `ImportDiffPreview` shows a list grouped by account plus a highlighted mini-grid, then Commit. Commit is disabled while `errors.length > 0`, with an "import valid rows only" checkbox. Commit sends those cells to `save` with the preview token, so an edit made between preview and commit gives a 409 and the user re-runs the preview.
- **Invariant 3:** export → import of the same file gives 0 changes.

## 10. Versions bar

The bar holds:
- A select listing every version of the FY: name · kind · status chip · ★ primary.
- "New reforecast", which opens the wizard with source = copy of the current version.
- Approve (draft→approved).
- Lock (approved→locked).
- Unlock (locked→approved, with a reason).
- Set primary.
- Compare with ▾, which adds the Δ column and fetches `cells_only`.
- Delete (draft/approved, not primary, not locked).

| Button | Rendered when | Server gate |
|---|---|---|
| Approve | status=draft ∧ role ∈ {owner, admin} | P1 `[id]/status.ts` (`transitionVersion`) |
| Lock | status=approved ∧ role ∈ {owner, admin} | P1 `[id]/status.ts` |
| Unlock | status=locked ∧ role = owner | P1 `[id]/status.ts`: owner check; reason 1–500 chars; audited by the DB trigger |
| Set primary | not primary ∧ role ∈ {owner, admin} | P1 `[id]/primary.ts` |
| Delete | ¬locked ∧ ¬primary ∧ (status=draft ∧ write role, or status=approved ∧ role ∈ {owner, admin}) | P1 `[id]/index.ts` DELETE (`deleteVersion`) |
| Save / editing | ¬locked ∧ role has write access | `withWriteAccess` + lock trigger |

Role comes from `useCompany().companyRole` (`src/contexts/CompanyContext.tsx`). Every transition requires a clean grid ("Save or discard N changes first") and reloads the version afterwards (new token).

## 11. Dimension pivot (decision 4 UX)

The toolbar view is **Company** | **By CC1** | **By CC2** | **By BU**. A dimension view adds a member picker. The grid always shows **one account per row**, so the row count stays at the account count and performance is bounded (§13).

| Account grain in version | Company view | By CC1, member M |
|---|---|---|
| none (no amounts) | editable (company grain) | editable (becomes CC1 grain on first write) |
| company | editable | read-only "Budgeted at company level". Row action: **Budget by CC1…** |
| cc1 | read-only roll-up Σ members, "Roll-up of CC1, switch view to edit" | editable for M |
| cc2 / bu | read-only roll-up | read-only "Budgeted by CC2" |
| mixed / multi-dim (written outside P2) | read-only roll-up | read-only "Edit via Excel". Multi-dim edit is not in P2. |

**Budget by CC1… / Budget at company level…** opens a confirm dialog: "This clears R x across n months at the current grain. You then enter amounts per cost centre." It offers an optional "distribute by PY share across members" [agent decides whether it ships in P2]. Applying it is one batch: deletes for the old grain + inserts for the new. A first write at a new grain into an account with no amounts needs no confirmation.

The member picker shows each member's NP for the FY, so the user can see where the money sits. **Invariant 2 (company roll-up = Σ dimension lines)** is tested in `pivot.test.ts` and in `budget-grid-read.int.test.ts`.

## 12. Accessibility, theme, responsive

- **ARIA:**
  - `table role="grid"` with `aria-rowcount`/`aria-colcount`. Rows carry `aria-rowindex`. Month headers are `columnheader`, and the account cell is `rowheader`.
  - Cells are `gridcell` with `aria-selected` and `aria-readonly`.
  - Subtotal rows are `aria-readonly` with `aria-label="Gross profit, Mar 2026, R …"`.
  - **Roving tabindex:** only the focused cell has `tabIndex=0`.
  - The editor input has `aria-label="<account> <month> budget"`. `aria-live="polite"` announces paste, fill, save and errors.
  - Dialogs trap focus and return it to the triggering cell. After a save, focus stays put. Axe runs on the workspace in the golden spec's a11y block (report-only in prod verify, as `A11Y_GATE=report`).
- **Theme:** only `--ff-*` tokens. New tokens `--ff-dirty-bg`, `--ff-conflict-bg`, `--ff-cell-selected-bg`, `--ff-cell-focus-ring` go in `styles/globals.css` under `:root` and `.dark`. The editor input must have a visible border in dark (the current defect: borderless month inputs). Browser proof in dark and light.
- **1280px:** full grid. 12 months + 4 columns scroll horizontally with the **page** (stickyTable rule: no nested scroll container).
- **390px / coarse pointer — decided: read + single-cell edit.**
  - Tapping a cell opens `MobileCellSheet`, with the amount input (`inputMode="decimal"`), the month and account named, Save cell / Next month, and row actions (spread).
  - There is no range selection, clipboard, or fill.
  - The sticky column shows the code + a truncated name; the PY trend and Δ% are hidden.
  - The versions bar collapses into a menu; Approve/Lock remain available.
  - **Why:** pasting a range from Excel on a phone is not a real workflow. Range selection with touch fights page scrolling. The finance user builds budgets on a desktop, and a phone needs only checks and quick fixes. Batch save still applies (the sheet edits mark cells dirty; the save bar is sticky at the bottom).

## 13. Performance

**Target:** 250 accounts × 15 months in one view (3 750 editable cells + subtotals) on the dev box, at `uptime` load < 25:
- Initial render ≤ 500 ms scripting.
- Commit-one-cell to paint p95 ≤ 16 ms.
- Paste 250×12 ≤ 150 ms.
- Save of 3 750 cells ≤ 1.5 s server time.

**No virtualisation library, and no windowing.** The page is the scroll container (stickyTable rule), which makes JS windowing fragile. The pivot keeps rows at one per account, so the cell count is bounded. Instead:
- An external store with per-row subscriptions, plus `memo` rows. One edit re-renders one row + the subtotal rows.
- `content-visibility: auto` + `contain-intrinsic-size` on each section `<tbody>`.
- Cents are kept as integers, and the subtotals refold only the bands touched.

Gates:
- A deterministic render-count test (React `Profiler`) is a CI gate.
- The timings are a Playwright perf spec in `tests/e2e/budget-workspace-perf.spec.ts` NEW. It reports only, not a gate (CI red under box load).

If the perf spec misses targets by more than 2×, row windowing is reconsidered (risk R5).

## 14. Tests (by name, with the mutation each must catch)

Unit, `tests/unit/services/budgets/grid/` NEW (vitest, pure):

| Test | Asserts | Mutation that must turn it red |
|---|---|---|
| `spread.test.ts` | even/seasonal/step/uplift × R1/R100/R1000: Σ = target exactly (cents); residue only on the last month; all other months multiples of the unit; seasonality refuses PY Σ=0 or mixed-sign with a reason | residue put on the first month; `Math.round` on floats instead of cents; missing residue (Σ≠target) |
| `cents.test.ts` | half away from zero, negatives, 1.005 → 1.01 | half-even rounding |
| `pasteParse.test.ts` | every §5.4 row (≥30 cases: CRLF, trailing newline, quotes, NBSP, `R 1 234,50`, `(1,234.50)`, `1,234`, `1,5`, U+2212, `-`, `#N/A`) | comma always thousands; a trailing newline adds an empty row |
| `tsv.test.ts` | `parseClipboard(toTsv(m)) = m` incl. negatives and blanks | blank serialised as `0` |
| `keyboard.test.ts` | every §5.2 row as a reducer case | Enter moves right; Esc commits; type-to-overwrite appends |
| `selection.test.ts` | skip non-line rows; clamp; shift-extend from anchor | vertical move lands on a subtotal row |
| `fill.test.ts` | 1×1 paste fills range; block paste clipped; read-only skipped and counted | read-only cell overwritten |
| `undo.test.ts` | one entry per action; redo cleared; limit 100; save keeps stack | paste recorded as n entries |
| `subtotals.test.ts` | GP/OP/NP per month; **parity**: same fixture through `aggregateFigures` (`gl/accountClassification.ts`) gives equal figures | GP includes other income |
| `pivot.test.ts` | §11 table; **invariant 2** roll-up = Σ dims | cc1-grain account editable in Company view |
| `diff.test.ts` | blank=clear, 0=zero, absent=untouched; **invariant 3** export→import = ∅; `rebaseDirty` conflicts | blank treated as 0 |

Component, `tests/unit/components/budgets/workspace/` NEW (happy-dom):

| Test | Asserts | Mutation |
|---|---|---|
| `BudgetGrid.dom.test.tsx` | grid roles, roving tabindex, `aria-readonly` on locked/roll-up, dirty marker | `tabIndex=0` on every cell |
| `BudgetGridRenderCount.dom.test.tsx` | committing one cell renders exactly 1 line row + its band subtotal + GP/OP/NP rows | store subscription at grid level |
| `VersionsBar.dom.test.tsx` | §10 matrix: role × status → buttons | Unlock shown to admin |
| `StaleVersionDialog.dom.test.tsx` | 409 keeps dirty cells; re-apply flags conflicts; locked → copy-to-draft | discard on 409 |
| `ImportDiffPreview.dom.test.tsx` | commit disabled with errors; counts | commit enabled with errors |
| `BudgetWorkspaceStates.dom.test.tsx` | loading / error+retry / empty / locked states | `failed` rendered as empty state |

Integration, `tests/integration/` NEW (real PG, CI clusters):

| Test | Asserts | Mutation |
|---|---|---|
| `budget-grid-save.int.test.ts` | upsert+delete; foreign version → 404; foreign account/dim → 400, no write; audit row; stale → 409, nothing written; **two concurrent saves with one token → exactly one 200, one 409**; locked → 409 (trigger mapped), nothing written; viewer → 403; grain switch in one batch OK; grain violation → 400 | drop `AND updated_at = $expected`; drop the company check; map trigger error to 500 |
| `budget-grid-read.int.test.ts` | read model; primary default; header/inactive excluded unless holding amounts; roll-up; tenant isolation | drop `company_id` from the cells query |
| `budget-grid-prior-actuals.int.test.ts` | calendar-month −12 mapping incl. a 14-month FY; dimension grain; posted only; parity with `getMonthlyMovements` at company grain | position mapping instead of calendar; drafts included |
| `budget-grid-seed.int.test.ts` | PY +10% R1000: totals = roundToUnit(PY×1.1); copy version +5%; dim grain; draft status; one tx (a fault injected after the version insert leaves no version) | non-transactional create |
| `budget-grid-import.int.test.ts` | template → import = 0 changes; unknown code; wrong month header; meta mismatch; formula result; 5 000-row file accepted; zip-bomb refused | blank parsed as 0; month header matched by position |

E2E, `tests/e2e/golden-paths/<letter>-budget-workspace.spec.ts` NEW (`<letter>` = next free golden letter at commit time; `u` is taken by `u-list-filter-dates.spec.ts`, so `v` on 2026-10-26; use the `isaflow-golden-paths` skill). It runs in prod post-deploy verify, so it obeys the contract's golden-spec write rule. Steps:
1. Precheck through the API, **before** creating anything: the Demo company's chosen FY has PY actuals, and the session role is owner/admin (needed to delete an approved version). If not, `test.skip` with a reason. Then sweep stale unlocked non-primary `GP-%` versions.
2. Wizard → PY actuals +10%, R1000, scenario `GP-<runId>`, not primary.
3. Assert one account's FY = roundToUnit(PY×1.1).
4. Focus Mar of account X and dispatch a `paste` ClipboardEvent with a 12-row TSV column copied from an Excel export (headless-safe, no clipboard permission).
5. Assert the 12 cells are dirty and GP/NP updated.
6. Ctrl+S.
7. Approve.
8. Reload.
9. Assert the status is Approved and the pasted values persist.
10. `afterAll` (and a `finally` around the steps) deletes the version through P1's DELETE route, by the id it created, after asserting it is non-primary and named `GP-…`. It never locks the version (a locked version cannot be deleted). It leaves no version on prod Demo; the approve's audit row stays.

The a11y check is report-only in verify-deploy. Screenshots are taken in dark + light at 1280 and 390.

PR-D also updates `tests/e2e/fiscal-year-end-change.spec.ts:97-114` (it drives the old `BudgetForm`), `tests/e2e/navigation.spec.ts` and `tests/e2e/full-audit.spec.ts` as needed. It retires `tests/unit/components/budgetFormValidation.test.tsx`, `budgetsPageMonths.test.tsx`, `budgetsPageRace.test.tsx` and the budget cases in `d2ErrorEnvelopeG1a*.test.tsx`, each replaced by an equivalent workspace test that is named in the PR body (the race test → a stale-response test on FY switch in `BudgetWorkspaceStates.dom.test.tsx`).

## 15. Task DAG (each with `verify:`)

```
T0 census P1 ─► T1 cents+spread ─► T2 pasteParse+tsv ─► T3 selection+keyboard ─► T4 fill+undo ─► T5 subtotals+pivot+diff ─► [PR-A]
T0 ─► T6 readModel+priorActuals ─► T7 save(409) ─► T8 seed ─► T9 template+import ─► [PR-B]
PR-A + PR-B ─► T10 store+grid+row ─► T11 keyboard/clipboard hooks ─► T12 save bar+409 ─► T13 row actions ─► T14 pivot UI ─► T15 versions bar ─► T16 wizard ─► T17 import UI ─► T18 mobile ─► T19 golden+perf ─► [PR-C]
PR-C ─► T20 cutover index.tsx, delete BudgetForm, retire/replace tests, update e2e ─► [PR-D]
```

| Task | verify: |
|---|---|
| T0 | Contract precondition checks pass; census table written into PR-A body: each §3 need → the P1 name shipped. STOP if any row is missing. |
| T1–T5 | `./node_modules/.bin/vitest run tests/unit/services/budgets/grid` (not npx: it may run a cached vitest) green. Each §14 mutation applied in turn goes red, then is reverted (log in `/home/hein/.cache/redchk/budgets-p2/`). |
| T6 | `budget-grid-read` + `prior-actuals` int tests green on `CI_INTEGRATION=1`; parity with `getMonthlyMovements` |
| T7 | `budget-grid-save` int green incl. the concurrent-save race (run 5×, 5/5) |
| T8 | `budget-grid-seed` int green; fault-injection leaves no version |
| T9 | `budget-grid-import` int green; export→import = 0 changes |
| T10–T15 | component tests green; render-count gate green; browser (dev, :3200) dark+light 1280 screenshot of the grid with live NP |
| T16–T17 | wizard + import walked in the browser on dev with screenshots; diff preview highlights changed cells |
| T18 | 390px screenshot: single-cell sheet edit saves |
| T19 | `bun run test:e2e:golden -- <letter>-budget-workspace` green on dev twice; leaves no `GP-` version behind (SQL count on isaflow_dev = 0); a run killed mid-way is cleaned up by the next run's sweep |
| T20 | `bun run ci` green; old page tests replaced (names in PR body); `fiscal-year-end-change.spec.ts` green |
| every PR | `bun run ci` green, GitHub integration job green, blind `/review` + security review SHIP, every H/M/L fixed |

## 16. PR split and trust boundary

| PR | Content | Lines (est.) | Gate |
|---|---|---|---|
| **PR-A** `feat/budgets-p2a-grid-model` | §4.1 pure modules + unit tests | ~1 500 incl. tests | **Greenfield**, not customer-facing, no data, fully test-verifiable. All five boundary conditions hold → may be queued (`mq-isa add`) after blind `/review` + security review without Hein reading it. |
| **PR-B** `feat/budgets-p2b-grid-api` | §4.2–4.3 services + routes + int tests | ~1 800 | New files, but they **write tenant budget data in production**, enforce role gates, and parse uploads (a security surface). Condition 3 is uncertain → fails closed → **Hein reads the diff.** Adversarial breaker on save/409/import. |
| **PR-C** `feat/budgets-p2c-workspace-ui` | §4.4 UI at `/accounting/budgets/workspace` (not linked in nav), golden + perf spec, tokens in `globals.css` | ~3 000 | New page, but client-visible and it edits `styles/globals.css` (an existing file) → **Hein reads** (a skim; the UI was proven in the browser). |
| **PR-D** `feat/budgets-p2d-cutover` | `pages/accounting/budgets/index.tsx` → workspace, delete `BudgetForm.tsx`, redirect `/workspace`, retire/replace old tests, update 3 e2e specs; old `budgets.ts`/`budgets-action.ts` routes removed only if a census shows no caller (else kept and mentioned) | ~400 | **Modifies a production path → Hein reads the diff.** |

No PR contains a migration. A production deploy is never run by the session.

## 17. Acceptance

On dev and then ISAFlow Demo (prod, after an approved after-hours deploy, via the UI only), a finance user does all of the following, with dark+light screenshots at 1280 and 390:
1. Opens `/accounting/budgets` and sees statement bands with live GP/OP/NP, FY total, PY, Δ vs PY and a sparkline.
2. Creates FY from PY actuals +10% at R1000.
3. Pastes a 12-month column from Excel; undoes and redoes it.
4. Spreads one row by PY seasonality.
5. Switches to By CC1, budgets one account per cost centre, and sees the Company view roll it up read-only.
6. Downloads the template, edits 3 cells, uploads, sees exactly 3 changes, commits.
7. Approves; a second tab's stale save gets the 409 dialog and re-applies cleanly.
8. Locks (as admin), confirms the grid is read-only, unlocks with a reason (as owner), and finds both in the audit log under `budget`.

## 18. Risks

| # | Risk | Mitigation |
|---|---|---|
| R1 | P1's names/errors differ from this spec | T0 census against P1's `.claude.md`; STOP on any missing piece (P2 builds none of P1's) |
| R2 | The golden spec runs in prod post-deploy verify and a red result auto-rolls back | Contract golden-spec write rule: precheck data + role before writes, `skip` with reason, non-primary scenario, stale sweep, delete in `afterAll`/`finally`, a11y report-only |
| R3 | `updated_at` precision → a false 409 on every save | Text token; an int test saves twice in a row with the returned token |
| R4 | Paste locale ambiguity (`1,234`) | Explicit §5.4 rules + the notice listing what was parsed; the TSV we produce ourselves is unambiguous |
| R5 | Perf misses at large dims | Pivot bounds rows; render-count gate; windowing only if the perf spec misses by >2× |
| R6 | Replacing the page breaks hidden callers (old tests, e2e, `d2ErrorEnvelope*`) | PR-D census + replacement tests named in the PR body |
| R7 | The PY-actuals definition disagrees with P3's BvA actuals | Contract ownership: one SQL in the end (`trackingActualRead.ts`), whichever lands first; both parity tests stay |
| R8 | A multi-dimension grain (e.g. CC1+BU) is allowed by the DB but not editable in the grid | Shown read-only with "edit via Excel"; the template supports a single dimension only in P2. Open question for Hein. |

## 19. Open questions (non-blocking; defaults in brackets)

> **Resolved 2026-10-26:** Hein accepted the defaults — see `docs/plans/budgets/00-shared-contract.md` decisions 11–17. Build them; do not re-ask.

1. Multi-dimension grain (CC1 × BU on one account): needed in MVP? [No, P2 is single-dimension only]
2. On wizard seed by dimension, untagged PY actuals: keep those accounts at company level, or drop them? [Prompt per seed, default keep at company level]
3. "Distribute by PY share" when changing grain: in P2 or later? [P2 if ≤1 day, else P4]
