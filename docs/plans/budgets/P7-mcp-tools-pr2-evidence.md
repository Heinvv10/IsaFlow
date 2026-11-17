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

## Review round 2

- **Every live import needs its dry run's plan_hash (MEDIUM).** A one-cell import that was a conflict was written live
  with no dry run, plan_hash or token, the conflict shown only after the write (the breaker's D1: a colleague's driver
  move to 50% replaced by an agent's typed override). Now `hashRequired` is always true for import_budget_workbook: the
  dry run is the preview, as in the app. D1 is permanent (`mcp-budget-excel-drivers.int`).
- **Free-form sheets (goal requirement).** An .xlsx WITH `_base` keeps the signature check and the 3-way diff; one with
  `_meta` but no `_base` stays refused as tampered; one with NEITHER is a free-form sheet (`budgetImportFreeform`, a
  service; the app's import route unchanged): its first sheet, a header row with an account code column ("Account
  code", "Code" or "Account", any case) in its first 20 rows, a column for every month of the year (YYYY-MM, a date,
  or a month name that names one year month: "Jan" in the 14-month year Jan 2026 - Feb 2027 is refused as ambiguous),
  at a cc1/cc2/bu grain one dimension column (two is refused: decision 14), Account name / Name / Description /
  Section / Total / FY total / PY actual / Notes ignored, anything else refused naming sheet, row and column; rows go
  through the import's own resolver (unknown, ambiguous, non-P&L, header rows refused per row). It is an explicit
  OVERWRITE of the version as it is: version_token REQUIRED and equal to the version's token now (dry run and live),
  the dry run's plan_hash required, the reply's `sheet: "free-form"` and `overwrite` saying it has no base, so any cell
  it names is set to the sheet's value even if a colleague changed it before the token was read. Size limits, the CPU
  slot and the xlsx bucket as for the template.
- **Blank cells on a free-form sheet KEEP the version's amount; the text "clear" (any case) clears the month.**
  Blank-means-clear on a hand-made sheet would wipe every month the person left empty; the template keeps its
  blank-clears rule because there a blank was downloaded as a blank, and the `_base` tells a cleared cell from one
  never filled.
- **LOWs.** (Reverted in round 3, measured below: the template offered every account for an inactive member that holds
  amounts in the version.) The row base's HMAC covers the year's
  month list, so a base cannot be read against a year of another shape. Round trips: a 14-month year at the CC1 grain
  and as the .xlsx; per-member budget_variance for every month at the CC1 grain (12- and 14-month years).
- **Accepted, documented (B2).** A row whose `base` is swapped for one from a newer read, its months kept from an older
  read, reverts the cells the newer read saw, with no conflict: it breaks the protocol (send each row with the base it
  was read with), and the dry run lists every such cell as a change. **The slot's per-owner limit** (2 places) is
  shared with the person's own UI session (one CpuSlot per process, owner = the user). **The JSON import takes no CPU
  slot**, by design, like set_budget_amounts: it builds and parses no spreadsheet.

## Review round 3

The breaker held the controls and found parsing traps that read the wrong data with no sign of it; all are free-form
only, and the app's template import is unchanged by them.
- **F1 (MEDIUM).** The free-form path read `wb.sheets[0]` even when hidden or very hidden (`normaliseXlsx` ignores
  visibility), so a stale hidden draft was imported. Now the first VISIBLE sheet is read and the reply names it
  (`sheet_name`). The template path finds its sheets by name (`readBudgetWorkbook`), so it had no such fault.
- **F2.** A sheet named `_Meta`, `_BASE` or `_meta ` (case or space variants) turned a template into a free-form sheet,
  where a blank keeps instead of clearing: such a workbook is refused. So is a free-form sheet whose header is the
  template's own (a Budget sheet copied out of a template): "download a fresh one".
- **F3.** The streaming reader gives a formula's cached value as a number whatever its type: TRUE read as 1.00, a
  date-formatted formula as its serial. The free-form reader takes the cell type from the sheet XML (`t="b"`, `t="e"`)
  and the number format from the cell (`readSheets`' optional `inspect`, which only the free-form reader passes), and
  refuses those cells per cell, as a plain date cell is refused. Nothing in `rawOf` / `amountOf` changed, so the UI's
  template import reads such cells as before (TRUE as 1.00 there; a template is IsaFlow's own sheet).
- **F4.** A free-form number with more than 2 decimals (beyond float noise, |v x 100 - round(v x 100)| < 1e-6) is refused
  per cell, "round it to cents in the sheet". The app's template import keeps rounding numbers to cents: a template's
  cells are formatted `#,##0.00`, so what a person sees there is the rounded amount; a free-form sheet's format is
  unknown, so it is not rounded for them.
- **F5.** A range merged across month columns (read from the sheet XML's mergeCells) refuses the sheet: only its first
  month would be read.
- **Rows.** Rows with no code, total rows (Total, Totals, Subtotal, Grand total, any case) and rows whose code is no
  account and which have no amounts (a heading) are skipped, and the dry run lists them with their sheet row and
  reason; a code that is no account WITH amounts reaches the resolver and is refused. A numeric code cell that lost a
  leading zero (400 where the chart has 0400) is refused per row ("format the code column as text"), ambiguous when the
  chart has both 400 and 0400.
- **Header search** is rows 1 to 20 OF THE SHEET (blank rows counted), in the code and the description.
- **Template rows from inactive members, measured.** Round 2 made an inactive member that holds amounts a row for every
  offered account. On a realistic fixture (125 offered accounts, 62 active CC1 members, 8 inactive members holding
  amounts on 3 accounts each) the round-1 rule gives 125 x 62 + 8 x 3 = 7 774 rows, under the 12-month cap of 8 333;
  the round-2 rule gives 125 x 70 = 8 750, refused. So templates that downloaded would have been refused: `templateRows`
  is back to the round-1 rule (an inactive member only where it holds amounts for that account), pinned by
  `budgetTemplateTool`'s measurement test. The import still accepts a row a person adds for another account.

## Review round 4: the free-form class closed

Three rounds of free-form traps (hidden sheets, rows and filters; codes skipped with money in their row; error codes;
merges; regex scanners beaten by single quotes, long tags or case; date formats outside a denylist; look-alike sheet
names) had one cause: the reader guessed. Round 4 replaces guessing with rules.
1. **Every money cell is accounted for.** Every non-empty cell under a month column belongs to an imported line or to
   a skipped total row (Total, Totals, Subtotal, Grand total, not an account). A row with any month filled and a
   blank, error (#N/A from a failed VLOOKUP) or unreadable code refuses the import with its sheet, row and column;
   skipping is only for rows whose month cells are all empty, and total rows. An error value in any consumed cell
   (code or month) refuses.
2. **No hidden or merged layout.** Any hidden row (AutoFilter-hidden included: Excel marks those rows hidden), a row
   of height 0, `sheetFormatPr zeroHeight`, a hidden or zero-width column, and any `mergeCell` in any form (lower-case,
   $-anchored, single-quoted) refuses the file. A code merged down rows (A2:A3) is one of these.
3. **Parsed, not scanned.** workbook.xml, its rels, styles, shared strings and the sheet are read by an XML parser:
   saxes, the one exceljs parses with (a transitive dependency through exceljs 4.4.0, NOT added to package.json),
   after the repo's own `checkXmlPart` (depth, attribute count, no DOCTYPE). Element and attribute names are compared
   by local name, case-folded; sheet state, cell type and boolean attributes case-folded (`state="Hidden"`,
   `hidden='1'`, `hidden="true"`); a tag of any length; anything the parser cannot read, a cell type it does not
   know, a cell out of its row, a style index the styles part does not define, refuses the file. Round 3's regex
   scanners, `readSheets`' inspect hook and `xlsxNormalise.workbookSheets` are deleted; `xlsxNormalise.openXlsxParts`
   gives the bounded part reads (every byte against the same limits as before).
4. **Number formats by allowlist.** A numeric money cell (value or formula result) is an amount only when its
   format is General or a plain number / currency / accounting one (`isPlainNumberFormat`): digit placeholders,
   digits, `,` `.` spaces, the R symbol (also `[$R-...]`), quoted or escaped literals, `_` / `*` padding, sections,
   colour codes and `@`, with at least one digit placeholder; built-in ids 0-8 and 37-44 only. Everything else is
   refused per cell: bbbb, aaa, ids 14, 27-36, 50-58, yyyy-mm, [h]:mm, %, E+, fractions, conditions, `[$-409]`,
   `@` alone. Header cells formatted as dates read as their date (the 1900 or 1904 system).
5. **Sheet names** are compared after NFKC, with format / zero-width characters (`\p{Cf}`) and spaces stripped, entities
   decoded (the parser does) and case folded: any sheet whose name so read starts with "_" and is not exactly `_meta`
   or `_base` refuses the file (`_Meta`, ` _base`, `_`+ZWSP+`meta`, a Cyrillic `е`, a fullwidth underscore, `_notes`).
   A name that decodes to exactly `_meta` through an entity goes to the template path, whose own lookup does not match
   it and refuses ("not an IsaFlow budget template").
6. **The sheet read is the one Excel opens on.** The first visible sheet must be `workbookView activeTab`; otherwise
   the file is refused. The reply names the sheet read (`sheet_name`).

The app's template path is unchanged: `budgetImportParse` is master's reader again (it differs only by the
`ImportLine` fields PR 2 added for the JSON grid and the free-form `keep`).

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

Review round 4: the raw-XML tests (`budgetFreeformRaw.test.ts`, every finding in the breaker's own form) and the
changed free-form tests were written first and run at `97c113cd98`: `Failed Tests 47` plus one file not loading.

Review round 3: the new and changed unit tests were written first and run at `d28d1228ee`: `Failed Tests 37` (the
service's new result shape and sheet-named messages, a hidden sheet read first, near-miss `_meta` names, the copied
template header, TRUE and date-formatted formulas, decimals, merges, skipped rows, leading zeros), and the template
measurement test 2 failed (8 750 rows refused).

Review round 2: the new and changed unit tests were written first and run at `4f96d26c60`: `Failed Tests 11` plus the
free-form service file (module missing): one-cell imports written without a plan_hash (the breaker's P1 among them),
the free-form tool path, a `_meta`-only file not refused as tampered, the inactive member's rows, and the row base
without its month list. The D1 and free-form integration suites were first run on the fix (green); Y1 to Y5 below are
the evidence that they fail on their guards' removal.

Review round 1: the new and changed unit tests were written first and run against the round-0 head (`6a7409dead`):
`Failed Tests 37` (the row base service missing, `encodeRowBase is not a function`, the JSON rows without bases, the
base-less workbook accepted, conflicts without members, the old bucket keys and order). The breaker reported its
B-int probe red at that head (the colleague's 999.00 reverted); its sequence is now `mcp-budget-excel.int`'s B-int
test, green here and red under mutant X1.

## Mutation table

Rerun at the review-round-4 head (`ce87e90cf7`; every fix committed first). Each guard was mutated in the production
code, the tests named ran, and the mutation was restored with `git apply -R` of its own diff (tree verified clean
after each; every log ends `[<id>] restored`). Unit = `vitest run <file>` with `DATABASE_URL` empty; int = the file
against a throwaway PostgreSQL 16 cluster built as `scripts/ci/integration/run.sh` builds its template (baseline +
this branch's migrations as non-superuser `postgres`), the suites running as `app_user` through the real registry.
Counts are the runs' own `Tests` lines (failed / total). Files: Grid = budgetImportToolGrid, Xlsx =
budgetImportToolXlsx, XB = budgetImportToolXlsxBase, FT = budgetImportToolFreeform, FS = budgetImportFreeform
(service), Raw = budgetFreeformRaw (raw-XML workbooks), Tpl = budgetTemplateTool, RB = budgetTemplateRowBase; int
excel / rows / eq / rt / ff / drv = mcp-budget-excel, -rows, -equivalence, -roundtrip + -roundtrip14, -freeform,
-drivers.

| # | Guard | Mutant | Result |
|---|---|---|---|
| X1 | JSON rows are diffed against their own base (round 1 HIGH) | the base map left empty | unit Grid 3/24; int excel 3/6 |
| X2 | JSON base required on every row | the requirement removed | unit Grid 1/24 |
| X2b | the base's HMAC | the signature comparison removed | unit RB + Grid 8/33 |
| X4 | holder slices (the import's own message pinned) | `assertHolderSlices` not called | unit Xlsx 1/17; int rows 1/5 |
| X5 | `_meta` signature over `_base` | the check removed | unit Xlsx 1/17 |
| X6 | file size refused before decoding | the bound removed | unit Xlsx 1/17 |
| X7 | JSON months exactly the year's | a missing month allowed | unit Grid 1/24 |
| X8 | at most `MAX_GRID_ROWS` | the bound removed | unit Grid 1/24 |
| X9 | all or nothing on refused rows | refused rows dropped | unit Xlsx + Grid 2/41; int rows 2/5 |
| X10 | xlsx reply fits one read | `XLSX_MAX_BASE64` removed | unit Tpl 1/15 |
| X11 | JSON template page fits 90 KB | `TEMPLATE_LIMIT_MAX` 50 → 80 | unit readLimitsSizeBudgets 2/11 |
| X12 / X12b | template buckets (xlsx / json) | rate limit skipped | unit Tpl 2/15 and 1/15 |
| X13 | import buckets (xlsx and json) | rate limit skipped | unit Xlsx + Grid 2/41 |
| X13c | the MCP's short slot wait | the default 10 s wait | unit Xlsx 1/17 |
| X14 / X14b | template cut as the token user (json / xlsx) | `viewerId` undefined | unit Tpl 1/15 each |
| X15 | plan_hash binds content | comparison removed | unit Xlsx 1/17; int excel 1/6 |
| X16 | unlisted accounts get PR 1's reason | the import's combined reason kept | unit Xlsx 1/17; int rows 1/5 |
| X18a / X18b | .xls refused by name / by magic bytes | each check removed alone | unit Xlsx 1/17 each |
| X19 | import xlsx work inside the CPU slot | run outside it | unit Xlsx 1/17 |
| X20 | the import saves exactly the preview's cells | a budgeted zero saved as 0.01 | int eq + rt 7/7 |
| X21 | 3-way diff (xlsx and JSON) | the base ignored | unit Grid 3/24; int excel 3/6 |
| X22 / X22b | a row's `account` / `account_id` must be its base's | each check removed | unit Grid 1/24 each |
| X23 | no dimension on a company grid (JSON) | the refusal removed | unit Grid 1/24 |
| X24 | a field no template row has is refused (decision 14 inexpressible) | the refusal removed | unit Grid 1/24; int rows 1/5 |
| X25 | one source per call | "both" allowed | unit Grid 1/24 |
| X26 / X27 | base64 alphabet / length `% 4` | each check removed | unit Xlsx 1/17 each |
| X28 | a conflict names its member | `dimension: null` | unit XB + Grid 2/26 |
| X29 | the owner-limit refusal | always the busy message | unit Xlsx + Tpl 2/32 |
| X30 | the account id preferred (a duplicate code resolves) | the line keeps only the code | unit Grid 1/24 |
| Y1 | every live import needs its dry run's plan_hash | `hashRequired: false` | unit Grid + Xlsx + FT 6/57; int drv 1/1 (D1) |
| Y2 | free-form: version_token required | the requirement removed | unit FT 1/16; int ff 1/2 |
| Y3 | free-form: refused unless the token is the version's now | the comparison removed | unit FS + FT 2/39; int ff 1/2 |
| Y4 | free-form: a blank cell keeps the amount | blank clears | unit FS + FT 4/39; int ff 2/2 |
| Y5 | free-form: "clear" clears | the word not recognised | unit FS + FT 2/39; int ff 1/2 |
| Y6 | free-form: one account-code column | two allowed | unit FS 1/23 |
| Y7 | free-form: an unknown column refused with sheet / row / column | ignored | unit FS + FT 2/39 |
| Y8 | free-form: a month name naming two year months refused | the first taken | unit FS 1/23 |
| Y9 | free-form: a month twice refused | allowed | unit FS 1/23 |
| Y10 | free-form: every year month needs a column | missing allowed | unit FS 1/23 |
| Y11 | free-form: no dimension column on a company import | allowed | unit FS 1/23 |
| Y12 | free-form: one dimension column (decision 14) | two allowed | unit FS 1/23 |
| Y13 | free-form: a dimension grain needs a dimension column | none allowed | unit FS 1/23 |
| Y14 | free-form: a value under no header refused | ignored | unit FS 1/23 |
| Y15 | an .xlsx with `_meta` but no `_base` refused as tampered | the refusal removed | unit XB 1/2; int excel 1/6 |
| Y16 | the template path only for an exact `_meta` / `_base` | `_meta` alone not a template | unit XB 1/2 |
| Y17 | the row base signs the year's month list | the list left out | unit RB 1/9 |
| Y19 | free-form: a month header outside the year refused | taken | unit FS 1/23 |
| Z1 | the first VISIBLE sheet is read | always the first sheet | unit Raw + FT 5/67 |
| Z3 | the template's own header refused on a free-form sheet | the check removed | unit FS + FT 2/39 |
| Z6 | more than 2 decimals refused (free-form) | rounded instead | unit FS 1/23 |
| Z9 | total rows skipped and listed | not skipped | unit FS + FT 2/39 |
| Z10 | rows with every month empty skipped and listed | not skipped | unit FS + FT 2/39 |
| Z11 | a numeric code that lost its leading zero refused | taken as typed | unit FS 1/23 |
| Z12 | the header in rows 1 to 20 of the sheet | any row | unit FS 1/23 |
| Z13 | template rows: an inactive member only where it holds amounts for the account | every account | unit Tpl 2/15 (the 7 774 / 8 750 measurement) |
| Z14 | the free-form row refusals reach the reply and refuse the import | dropped | unit FT + Raw 1/67 |
| W1 | rule 1: a filled month with a blank code refuses | skipped instead | unit FS + Raw 2/74 |
| W2 | rule 1: an error code (#N/A) refuses | read as no code | unit Raw 1/51 |
| W3 | rule 2: a hidden row (AutoFilter-hidden, hidden='1', "true", height 0) refuses | not detected | unit Raw 5/51 |
| W4 | rule 2: a hidden or zero-width column refuses | not detected | unit Raw 2/51 |
| W5 | rule 2: `zeroHeight` refuses | not detected | unit Raw 1/51 |
| W6 | rule 2: any merge in any form refuses | not detected | unit Raw + FT 4/67 |
| W7 / W7b | rule 2: the reader refuses what the sheet parser found (hidden / merged) | each refusal removed | unit Raw 8/51; Raw + FT 4/67 |
| W8a | rule 4: built-in ids outside 0-8, 37-44 refused | every built-in plain | unit Raw 6/51 |
| W8b | rule 4: only allowlisted characters in a custom code | any code with a digit placeholder | unit Raw 5/51 |
| W8c | rule 4: a custom code needs a digit placeholder | not required (`@` passes) | unit Raw 1/51 |
| W9 | rule 4: a non-plain number format refuses the cell | the format ignored | unit Raw + FT 16/67 |
| W10 | rule 3: a `t="b"` cell is not a number | read as 1 | unit Raw + FT 3/67 |
| W11 | rule 5: names after NFKC, `\p{Cf}` and space stripping | only case folded | unit Raw 2/51 |
| W12 | rule 5: any name starting with "_" that is not exactly `_meta` / `_base` | only the two squashed names | unit Raw 2/51 |
| W13 | rule 6: the sheet read is the one the workbook opens on | activeTab ignored | unit Raw 1/51 |
| W14 | rule 3: an unknown sheet state refuses | ignored | unit Raw 1/51 |
| W15 | rule 3: sheet state case-folded (`Hidden`, `VERYHIDDEN`) | case kept | unit Raw 2/51 |
| W16 | rule 3: element / attribute names case-folded | case kept | unit Raw 42/51 |
| W17 | rule 3: cell type case-folded | case kept | unit Raw 41/51 |
| W18 | rule 1: an error value in a month cell refuses the cell | read as empty | unit Raw 3/51 |
| W19 | a header formatted as a date reads as its month | read as the serial | unit Raw 1/51 |

Retired: X3 (Y1's stricter rule), X17 (Y15 / Y16), Y18 (reverted; Z13). Round 3's Z2 (near-miss names; W11 / W12
now), Z4 (XML-typed booleans; W10 / W17), Z5 (the date-format inspect hook; W8 / W9), Z7 (merges across months; W6 /
W7b, any merge) and Z8 (skip rows with no code: reversed by rule 1, W1) went with the regex reader round 4 deleted.

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
