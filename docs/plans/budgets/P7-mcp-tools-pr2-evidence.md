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
- **JSON grid import (review round 1, HIGH).** The first cut required the template's `version_token` and diffed
  against the version as it was, but pages read at different tokens (or rows sent with a later import's reply token)
  passed that check and reverted a colleague's save. Now each JSON row carries a signed `base`
  (`budgetTemplateSignature.encodeRowBase`: its months as read, HMAC with the `_meta` key, labelled `row-base:v1`,
  over the version id, financial year, grain, account id and member id): the JSON grid's `_base`. The import requires
  it on every row, refuses an altered or foreign one whole, takes the row's account and member from it, and runs the
  same 3-way diff the .xlsx does. `version_token` is optional for both forms and checked on the live call. JSON
  pages shrank to 40 / 50 rows: the widest row is ~1.35 KB with its base (80 rows measured 112 210 bytes).
- **No `_base`, no import (review round 1, MEDIUM).** The app previews a base-less .xlsx against the version as it is
  (every change `possibleRevert`); there `_meta`'s signature covers nothing, so a forged or replayed file overwrote
  later saves with no conflict. The tool refuses such a workbook; no MCP path can produce `possibleRevert` now (the
  reply would carry `possible_revert` if one ever did).
- **All or nothing.** The app's preview leaves error rows out and commits the rest; the tool refuses the whole
  import while any row is refused (PR 1's rule for every amount write). The dry run lists every refused row.
- **Per-row reasons.** The import's resolver words an account it cannot find as "not a revenue or expense account you
  can budget (unknown, or inactive without a budget)". The tool replaces that, for those rows only, with PR 1's
  `explainMissingAccounts` reason (unknown / not an income-statement account / header / inactive / outside a holder's
  slices): one chart read. Every other reason is the import's own.
- **CPU slot and rate buckets (review round 1).** The xlsx paths take `BUDGET_SPREADSHEET_SLOT` first (an MCP wait of
  2 s, `MCP_SLOT_WAIT_MS`: the slot is held inside the request transaction), then their own bucket
  (`mcp-budget-template-xlsx` / `mcp-budget-import-xlsx`, 60 per 15 minutes per user), then read the model: the routes'
  order. The JSON paths have buckets of their own (`mcp-budget-template-json` 600, `mcp-budget-import-json` 240 per
  15 minutes). None is an app bucket, so an agent cannot lock its person out of the grid.

**Decision 14** (budgets programme): a budget amount carries at most one dimension (`budget_month_amounts_one_dimension`).
A template row names one dimension (its grain's member), and a JSON row with any other field (`cc2` on a cc1 grid,
say) is refused whole, so the import cannot express a second one; the grid save and the constraint stay behind it.

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

Review round 1: the new and changed unit tests were written first and run against the round-0 head (`6a7409dead`):
`Failed Tests 37` (the row base service missing, `encodeRowBase is not a function`, the JSON rows without bases, the
base-less workbook accepted, conflicts without members, the old bucket keys and order). The breaker reported its
B-int probe red at that head (the colleague's 999.00 reverted); its sequence is now `mcp-budget-excel.int`'s B-int
test, green here and red under mutant X1.

## Mutation table

Rerun at the review-round-1 head (`c2f3ce98fc`; every fix committed first). Each guard was mutated in the production
code, the tests named ran, and the mutation was restored with `git apply -R` of its own diff (tree verified clean
after each; every log ends `[<id>] restored`). Unit = `vitest run <file>` with `DATABASE_URL` empty; int = the file
against a throwaway PostgreSQL 16 cluster built as `scripts/ci/integration/run.sh` builds its template (baseline +
this branch's migrations as non-superuser `postgres`), the suites running as `app_user` through the real registry.
Counts are the runs' own `Tests` lines (failed / total). Files: Grid = budgetImportToolGrid, Xlsx =
budgetImportToolXlsx, XB = budgetImportToolXlsxBase, Tpl = budgetTemplateTool, RB = budgetTemplateRowBase; int
excel / rows / eq / rt = mcp-budget-excel, -rows, -equivalence, -roundtrip + -roundtrip14.

| # | Guard | Mutant | Result |
|---|---|---|---|
| X1 | JSON rows are diffed against their own base (the HIGH) | the base map left empty | unit Grid 2/23; int excel 3/6 (B-int, the reply-token sequence, replay/restore) |
| X2 | JSON base required on every row | the requirement removed | unit Grid 1/23 |
| X2b | the base's HMAC | the signature comparison removed | unit RB + Grid 8/32 |
| X3 | plan_hash required for more than one changed cell | `hashRequired: false` | unit Xlsx 1/16 |
| X4 | holder slices (the import's own message pinned) | `assertHolderSlices` not called | unit Xlsx 1/16; int rows 1/5 |
| X5 | `_meta` signature over `_base` | the check removed | unit Xlsx 1/16 |
| X6 | file size refused before decoding | the bound removed | unit Xlsx 1/16 |
| X7 | JSON months exactly the year's | a missing month allowed | unit Grid 1/23 |
| X8 | at most `MAX_GRID_ROWS` | the bound removed | unit Grid 1/23 |
| X9 | all or nothing on refused rows | refused rows dropped | unit Xlsx + Grid 2/39; int rows 2/5 (per-row reasons, decision 4) |
| X10 | xlsx reply fits one read | `XLSX_MAX_BASE64` removed | unit Tpl 1/13 |
| X11 | JSON template page fits 90 KB | `TEMPLATE_LIMIT_MAX` 50 → 80 | unit readLimitsSizeBudgets 2/11 |
| X12 / X12b | template buckets (xlsx / json) | rate limit skipped | unit Tpl 2/13 and 1/13 |
| X13 | import buckets (xlsx and json) | rate limit skipped | unit Xlsx + Grid 2/39 |
| X13c | the MCP's short slot wait | the default 10 s wait | unit Xlsx 1/16 |
| X14 / X14b | template cut as the token user (json / xlsx) | `viewerId` undefined | unit Tpl 1/13 each |
| X15 | plan_hash binds content | comparison removed | unit Xlsx 1/16; int excel 1/6 (one transaction: only the hash catches it) |
| X16 | unlisted accounts get PR 1's reason | the import's combined reason kept | unit Xlsx 1/16; int rows 1/5 |
| X17 | an .xlsx without `_base` refused (the MEDIUM) | the refusal removed | unit XB 1/2; int excel 1/6 |
| X18a / X18b | .xls refused by name / by magic bytes 0xd0 0xcf | each check removed alone | unit Xlsx 1/16 each |
| X19 | import xlsx work inside the CPU slot | run outside it | unit Xlsx 1/16 |
| X20 | the import saves exactly the preview's cells | a budgeted zero saved as 0.01 | int eq + rt 5/5 |
| X21 | 3-way diff (xlsx and JSON) | the base ignored (diffed against the version now) | unit Grid 2/23; int excel 3/6 |
| X22 / X22b | a row's `account` / `account_id` must be its base's | each check removed | unit Grid 1/23 each |
| X23 | no dimension on a company grid | the refusal removed | unit Grid 1/23 |
| X24 | a field no template row has is refused (decision 14 inexpressible) | the refusal removed | unit Grid 1/23; int rows 1/5 |
| X25 | one source per call | "both" allowed | unit Grid 1/23 |
| X26 | base64 alphabet | the regex removed | unit Xlsx 1/16 |
| X27 | base64 length `% 4` | the check removed | unit Xlsx 1/16 |
| X28 | a conflict names its member | `dimension: null` | unit XB + Grid 2/25 |
| X29 | the owner-limit refusal | always the busy message | unit Xlsx + Tpl 2/29 |
| X30 | the account id preferred (a duplicate code resolves) | the line keeps only the code | unit Grid 1/23 |

Round 0's X1 (the JSON `version_token` equality) and X2 (`version_token` required) guarded the design the HIGH replaced;
their tests went with it. X17 and X22 were unused numbers in round 0; they now name the two new guards.

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

## Round-trip gate (`mcp-budget-excel-roundtrip` and `-roundtrip14`)

get_budget_template → every row and month filled with distinct amounts (negative ones every third month, a budgeted
zero) → import_budget_workbook dry run → live with its plan_hash → get_budget equals the filled grid to the cent; the
re-read template's FY totals equal it; budget_variance on the version equals each account's FY sum and, called once
per month, each account's month; its revenue / expense / net profit budget equal the template's section totals
(turnover + other income; cost of sales + operating + other expenses; net profit), per year and per month. Run for:
- company grain as the JSON grid and as the .xlsx, with a header holding its own amounts (a legacy budget, decision 18);
- a CC1 grain of two members per account (JSON), tied per member through budget_variance's `cc1_id` filter;
- a 14-month year (FY2027 = January 2026 to February 2027 after a change of year end), revenue, other income, cost of
  sales, expenses and an own-amount header, all 14 months, end to end (the breaker's R1 / R2 probes, made permanent).

## Accepted limits

- An xlsx template over 85 000 base64 characters (a few hundred rows) is answered only as JSON, or in parts by members.
- A JSON row cannot be added: every row needs the base its template read gave it (read the account's template row).
- A row base read before an account was renamed fails its `account` code check if the old code is sent; sending the
  row without `account` (or with its id) imports it.
- The CPU slot is taken inside the request transaction (the MCP has no outer wrapper as the routes do), so a waiting
  import or template holds its pool connection for up to 2 s; at most 4 wait.
- Driver-recomputed cells changed between the read and the import are kept by the same 3-way rule (the cell's base is
  what the row was read with); there is no driver-specific int test.
- PR 1's limit carries over: plan_hash binds the planned cells, not a driver's recomputed dependents.
