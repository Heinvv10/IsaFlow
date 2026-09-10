# K-145 — a non-CSV import that parses nothing must not report success

**Trigger.** A user picks the wrong file type on import, which the UI makes easy.
Reachable from both import routes and the MCP import tool.

**Before.** `parseStatement` returned `parseOfxStatement` / `parseQifStatement` /
`parseMt940Statement` directly; only the CSV arms went through
`requireTransactions`. All three of those parsers return
`{transactions: [], errors: []}` rather than throwing when the body is not what
they expect, so a file with rows in it reached
`bank-transactions-bulk-commit.ts` with no errors and was reported as a clean
import of zero rows — the exact failure `requireTransactions` was written to stop.

**After.** The three non-CSV arms go through the same guard. A file with data
rows that yields no transactions raises `StatementNotImportableError` (the type
the MCP tool treats as an actionable file problem rather than a system failure and
a refund). The guard stays one-sided: a header-only export of a quiet period still
succeeds. `requireTransactions`'s message no longer says "the columns a … statement
is expected to have", which read wrong for OFX; it now says nothing in the file was
readable as that format.

**Files.** `src/modules/accounting/services/bank/bankStatementParseService.ts`.

**Tests.** `tests/unit/bank/k145-non-csv-parse-guard.test.ts` — 6 passed,
including the CSV control, the empty-period export on all three types, and a real
OFX body with one STMTTRN still parsing. Mutation proof in `green.log`.

**Migration.** None.

**Historical-data impact.** No wrong rows written: the failure mode is nothing
imported. The damage is statements users believe are in. There is no
import-attempt log to census, so this is a support question rather than a query —
a bank account with a gap in imported dates around a known import attempt.

**Limits.** `hasDataRows` counts non-blank lines, which is a proxy. An unusual but
genuinely empty multi-line OFX/QIF/MT940 header would now be refused. The passing
"quiet period" test pins the single-line case only; worth trying one real bank
export of an empty period before this ships.
