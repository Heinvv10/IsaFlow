# MCP budget tools, PR 2 of 3 (the Excel tools): evidence

Branch `feat/mcp-budget-tools-excel-20261117`, stacked on PR 1 (#1513). Tools and the service changes are described
in `src/lib/mcp/.claude.md` ("Budget Excel tools") and `src/modules/accounting/services/budgets/.claude.md` ("PR 2").
No migration: the snapshot table's `tool` column (999l) takes `import_budget_workbook` as it is.

## Choices made inside the brief

- **Template form.** Measured 2026-11-17 (`buildBudgetTemplate`, 12 months, company grain, amounts repeating so the
  zip compresses well): 50 rows 15.6 KB (20.8 KB base64), 200 rows 31.7 KB (42.2 KB), 400 rows 52.8 KB (70.4 KB),
  600 rows 73.8 KB (98.4 KB). So a base64 workbook fits one 90 KB read only up to a few hundred rows, and real amounts
  compress worse. JSON is the default and is paged (50 / 80 rows; the widest 14-month row with a dimension is about
  1 KB); `format: "xlsx"` answers the workbook when its base64 is at most 85 000 characters and otherwise refuses,
  pointing at json or fewer members. An xlsx is not chunked: exceljs stamps creation times, so two builds are two
  files and chunks of different builds would not join.
- **JSON grid import.** The grid carries no `_base`, so the import cannot tell a cell the agent left alone from one
  a colleague has since changed. It therefore needs the template's `version_token` and is refused when the version
  moved (`ImportSource.base = 'current'`): the version itself is then the downloaded state, and the 3-way diff equals
  the 2-way one, with no `possibleRevert`. The .xlsx keeps the app's 3-way semantics exactly.
- **All or nothing.** The app's preview leaves error rows out and commits the rest; the tool refuses the whole
  import while any row is refused (PR 1's rule for every amount write). The dry run lists every refused row.
- **Per-row reasons.** The import's resolver words an account it cannot find as "not a revenue or expense account you
  can budget (unknown, or inactive without a budget)". The tool replaces that, for those rows only, with PR 1's
  `explainMissingAccounts` reason (unknown / not an income-statement account / header / inactive / outside a holder's
  slices): one chart read. Every other reason is the import's own.
- **CPU slot and rate buckets.** The xlsx paths take `BUDGET_SPREADSHEET_SLOT` and charge the routes' own buckets
  (`budget-template:<user>`, `budget-import:<user>`, 60 per 15 minutes each, shared with the app). The JSON paths build
  and parse no spreadsheet and take neither.

## TDD

The three unit files were written first and run red before any tool existed (2026-11-17):

```
Error: Cannot find package '@/lib/mcp/tools/budgetImportTool' imported from .../tests/unit/mcp/budgetImportToolGrid.test.ts
Error: Cannot find package '@/lib/mcp/tools/budgetImportTool' imported from .../tests/unit/mcp/budgetImportToolXlsx.test.ts
Error: Cannot find package '@/lib/mcp/tools/budgetTemplateTool' imported from .../tests/unit/mcp/budgetTemplateTool.test.ts
 Test Files  3 failed (3)
      Tests  no tests
```

That red only proves the modules were missing; the table below is the evidence that each test fails on its own
guard's removal.

## Mutation table

Each guard was mutated in the production code with every fix committed first (head `f1990d6321`), the tests named
ran, and the mutation was restored with `git apply -R` of its own diff (tree verified clean after each; every log
ends `[<id>] restored`). Unit = `vitest run <file>` with `DATABASE_URL` empty; int = the integration file against a
throwaway PostgreSQL 16 cluster built as `scripts/ci/integration/run.sh` builds its template (baseline + this branch's
migrations as non-superuser `postgres`), the suites running as `app_user` through the real registry. Counts are the
runs' own `Tests` lines.

| # | Guard | Mutant | Tests run | Result |
|---|---|---|---|---|
| X1 | JSON grid: refused unless the version is what the grid was read from (`diffImportLines`, base `'current'`) | the token comparison disabled | unit budgetImportToolGrid; int mcp-budget-excel | unit 1 failed / 13; int 1 failed / 7 |
| X2 | JSON grid: `version_token` required | the requirement removed | unit budgetImportToolGrid | 1 failed / 13 |
| X3 | plan_hash required for more than one changed cell | `hashRequired: false` | unit budgetImportToolXlsx | 1 failed / 13 |
| X4 | holder slices (the preview's own check, app message pinned) | `assertHolderSlices` not called | unit budgetImportToolXlsx; int mcp-budget-excel | unit 1 failed / 13; int 1 failed / 7 (the grid save's own holder check still refused, with its message; the test pins the import's) |
| X5 | `_meta` signature over `_base` | signature check removed | unit budgetImportToolXlsx | 1 failed / 13 (forged signature accepted) |
| X6 | file size refused before decoding (MCP body) | `MAX_WORKBOOK_BASE64` check removed | unit budgetImportToolXlsx | 1 failed / 13 |
| X7 | JSON row: months exactly the year's | a missing month allowed | unit budgetImportToolGrid | 1 failed / 13 |
| X8 | JSON rows at most `MAX_GRID_ROWS` | the bound removed | unit budgetImportToolGrid | 1 failed / 13 |
| X9 | all or nothing: every refused row refuses the import | refused rows dropped (`errors.slice(0, 0)`) | unit Xlsx + Grid; int mcp-budget-excel | unit 2 failed / 26; int 1 failed / 7 |
| X10 | xlsx reply fits one read (`XLSX_MAX_BASE64`) | the cap removed | unit budgetTemplateTool | 1 failed / 12 |
| X11 | JSON template page fits 90 KB | `TEMPLATE_LIMIT_MAX` 80 → 150 | unit readLimitsSizeBudgets | 2 failed / 11 |
| X12 | template xlsx: the route's rate bucket | rate limit skipped | unit budgetTemplateTool | 2 failed / 12 |
| X13 | import xlsx: the preview's rate bucket | rate limit skipped | unit budgetImportToolXlsx | 1 failed / 13 |
| X14 | JSON template cut as the token user (holder slices) | `viewerId` undefined | unit budgetTemplateTool | 1 failed / 12 |
| X14b | xlsx template cut as the token user | `viewerId` undefined | unit budgetTemplateTool | 1 failed / 12 |
| X15 | plan_hash binds content (PR 1's comparison, for the import) | comparison removed | unit budgetImportToolXlsx; int mcp-budget-excel | unit 1 failed / 13; int 1 failed / 7 (one transaction: the token cannot move, only the hash catches it) |
| X16 | unlisted accounts get PR 1's precise reason | the import's combined reason kept | unit Xlsx + Grid; int mcp-budget-excel | unit 2 failed / 26; int 1 failed / 7 |
| X18 | old .xls refused | the check removed | unit budgetImportToolXlsx | 1 failed / 13 |
| X19 | import xlsx parse takes the CPU slot | parsed outside the slot | unit budgetImportToolXlsx | 1 failed / 13 |
| X20 | the import saves exactly the preview's cells | a budgeted zero saved as 0.01 | int mcp-budget-excel-equivalence + -roundtrip | 3 failed / 3 |
| X21 | xlsx 3-way: a cell left as downloaded keeps a colleague's later save | `_base` ignored (diffed against the version now) | int mcp-budget-excel | 1 failed / 7 |
| X23 | JSON: no dimension on a company grid | the refusal removed | unit budgetImportToolGrid | 1 failed / 13 |
| X24 | JSON: a field no template row has is refused (so decision 14 cannot be expressed) | the refusal removed | int mcp-budget-excel | 1 failed / 7 |
| X25 | one source per call (file or rows) | "both" allowed | unit budgetImportToolGrid | 1 failed / 13 |

PR 1's own guards that the import reuses unchanged (`MAX_SAVE_CELLS`, the dry run inside a rolled-back savepoint,
the snapshot, decision 4 in the grid save, the stale token, the role fence) keep their PR 1 mutation rows; this PR's
tests cover them for the import (`MAX_SAVE_CELLS` refused dry run and live, unit; decision 4 per row, the stale
version_token, the viewer fence, restore after an import, int).

## Equivalence (`tests/integration/mcp-budget-excel-equivalence.int.test.ts`)

Three versions holding the same amounts get the same edit (a changed amount, a cleared month, a budgeted zero, a new
cell on an account holding none): through the app as the owner (GET budget-grid/template, the edit in ExcelJS, POST
budget-grid/import-preview, POST budget-grid/save with the preview's cells and token), through import_budget_workbook
with the same edit of get_budget_template's .xlsx, and with the same edit of its JSON grid. Asserted equal: every
`budget_month_amounts` row (account, dimensions, month, amount, amount_source, created_by) and every `audit_log` row
of the version (action, entity type, user, email, entity_ref, changes with all metadata, ip, user agent, session).
Ignored: ids, timestamps and the version itself (the versions are inserted directly, so the save is their only audit
row). MCP-only rows by design: `mcp_tool_calls`, `budget_write_snapshots`.

## Round-trip gate (`tests/integration/mcp-budget-excel-roundtrip.int.test.ts`)

For the JSON grid and for the .xlsx: get_budget_template → every row and month filled with distinct amounts (one
budgeted zero) → import_budget_workbook dry run (nothing written) → live with its plan_hash → get_budget equals the
filled grid to the cent; the re-read template's months and FY totals equal it; budget_variance with the version for
the year equals each account's FY sum, and for each month each account's month; its revenue / expense / net profit
budget equal the template's section totals (turnover + other income; cost of sales + operating + other expenses; net
profit), per year and per month.

## Accepted limits

- An xlsx template over 85 000 base64 characters (a few hundred rows) is answered only as JSON, or in parts by members.
- The JSON grid import is refused after any save to the version since the template was read (no `_base` to diff
  against); the agent reads a fresh template. The .xlsx import keeps the app's 3-way behaviour.
- The CPU slot is taken inside the request transaction (the MCP has no outer wrapper as the routes do), so a waiting
  import or template holds its pool connection for up to 10 s; at most 4 wait.
- Agent xlsx traffic shares the person's template / import rate buckets (60 per 15 minutes each).
- PR 1's limit carries over: plan_hash binds the planned cells, not a driver's recomputed dependents.
