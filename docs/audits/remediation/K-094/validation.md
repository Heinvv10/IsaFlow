# K-094 — XLSX export has no formula-injection escaping

**Claim.** Account names are written to ExcelJS cells without the escaping the CSV sibling
applies (`pages/api/accounting/income-statement-xlsx.ts:225`).

**Corrected trigger.** Applying the plan's agreed correction H10. CSV and XLSX are not the
same sink. A CSV field has no type: text beginning `=`, `+`, `-` or `@` becomes a formula when
the spreadsheet *parses* the file, which is why `csvCell()` exists. XLSX types every cell in
the file itself. ExcelJS writes a JavaScript string as a shared string (`<c t="s">`) and emits
a formula element (`<f>`) only for a formula-valued cell (`{ formula: ... }`). `addLineItem`
passes a plain array to `ws.addRow`, so the account name can never become a formula.

**Disposition: false-positive**, on a recorded reproduction rather than on agreement.

**Evidence (executed, not read).**
- `tests/unit/api/k094-xlsx-formula-injection.test.ts` — builds the row exactly as
  `addLineItem` does, writes a real `.xlsx` buffer, loads it back, and asserts the cell type.
  5 tests, 5 passed, for `=HYPERLINK(...)`, `@SUM(1+1)*cmd|...`, `+1+1`, `-1+1`: value
  preserved verbatim, `cell.type === ValueType.String`, `cell.formula === undefined`. The last
  case pins the discriminator — a genuine `{ formula: 'SUM(1,1)' }` cell in the same workbook
  *does* round-trip as a formula, so the assertion is not vacuous. `red.log` (green) here.
- Raw file inspection, `xlsx-xml.log` in this directory: `xl/worksheets/sheet1.xml` contains
  `<c r="C1" t="s"><v>2</v></c>` and no `<f` element; the payload sits in
  `xl/sharedStrings.xml` as `<si><t>=HYPERLINK(&quot;...&quot;,&quot;x&quot;)</t></si>`.
  Matches `inputs/comparison-exceljs-reproduction.json` (`formulaElementPresent: false`,
  `storedAsSharedString: true`), reproduced independently at exceljs 4.4.0.

**Reachability.** The route is reachable; the vulnerability is not. An account name beginning
`=` renders as literal text in Excel, LibreOffice and Sheets.

**Proposed minimal fix.** None. Escaping here would corrupt legitimate account names (a
chart of accounts may hold `-Suspense` or `+VAT adjustment`) to defend against a parse that
never happens. If a future export writes user text into a **CSV** it must use `csvCell`; that
rule already holds and this route is not a CSV route.

**Historical-data impact.** None.

**Risks.** The disposition is version-scoped: it holds for the pinned `exceljs ^4.4.0`. The
committed test fails if a future ExcelJS promotes `=`-prefixed strings, which is the intended
tripwire.
