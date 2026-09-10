# K-145 — OFX, QIF and MT940 imports bypass the empty-parse guard

**Claim.** "A parse returning nothing reports a clean import of zero rows instead of an error."

**Disposition: confirmed** (exactly as claimed).

**Evidence.**
- `parseStatement` (`src/modules/accounting/services/bank/bankStatementParseService.ts:58-60`,
  origin/master) returns `parseOfxStatement` / `parseQifStatement` / `parseMt940Statement` directly.
  Only the CSV arms below (lines 65-70) are wrapped in `requireTransactions`, the guard written for
  exactly this failure ("naming the wrong bank produced a clean 'imported 0 transactions'", lines
  76-100).
- All three non-CSV parsers return `{transactions: [], errors: []}` rather than throwing when the
  body is not what they expect: `bankOfxParser.ts:98-107` (a non-empty body that contains no
  `STMTTRN` yields no transactions AND no errors), `bankQifParser.ts:156`, `bankMt940Parser.ts:130`.
- Downstream, `pages/api/accounting/bank-transactions-bulk-commit.ts:147` only refuses when
  `errors.length > 0`, so zero transactions with zero errors proceeds to a successful response.
- RED: `tests/unit/bank/k145-non-csv-parse-guard.test.ts` — 3 failed, 2 passed. The two passing tests
  are the constraints on the fix: the CSV control still refuses, and a header-only "quiet period"
  export must still succeed on all three types. Log: `red.log`.

**Reachability.** Both import routes (`bank-transactions-bulk-preview.ts:113`,
`bank-transactions-bulk-commit.ts:136`) and the MCP tool path
(`bankStatementImportService.ts:169`). The trigger is a user picking the wrong file type, which the
UI makes easy.

**Proposed minimal fix.** Route the three non-CSV arms through the same guard:
`if (fileType === 'ofx') return requireTransactions(parseOfxStatement(csvContent), 'ofx', csvContent);`
and likewise for qif/mt940. `hasDataRows` counts non-blank lines, which is a reasonable proxy for all
three formats — an OFX/QIF/MT940 file with real content always has many lines — but the message
built in `requireTransactions` says "the columns a <format> statement is expected to have", which
reads wrong for OFX. Adjust the wording per format, or make it generic.

**Historical-data impact.** No wrong rows written: the failure mode is nothing imported. The damage
is statements users believe are in. Read-only smell test — bank accounts with a gap in imported
dates around a known import attempt; there is no import-attempt log to census directly, so this is a
support question rather than a query.

**Risks.** One-sided as written: an unusual but genuinely empty multi-line OFX header would now be
refused. The passing "quiet period" test pins the single-line case only; if a real empty OFX export
carries several header lines it would be rejected. Worth testing against one real bank export before
shipping.
