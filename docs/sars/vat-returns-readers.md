# `vat_returns` readers (wave 6 VR, §0a.12)

Census: `git grep -l vat_returns -- src pages` at `27b74d2bc8` (master after #1481), code files only. Classes:

- **filed-record**: answers "has this VAT period been returned?" or shows the return's figures. VR moves it onto the
  lifecycle through `vatPeriodFilings` (filed, else finalised, version; `vat_returns` only for a period no version covers).
- **settlement**: reads or writes the settlement record itself (the clearing journal and its row). Stays on `vat_returns`.
- **display**: shows the `vat_returns` row beside the lifecycle, or only names the table in a comment or a text.
- **schema-list**: lists the table name for a schema tool. No query of its rows.

| File | Line(s) | Class | What it does | VR change |
|---|---|---|---|---|
| `src/modules/accounting/services/reports/vatReconciliationService.ts` | 163 | filed-record | month's "submitted return" figures beside GL and invoices | reads `vatPeriodFilings` |
| `src/modules/accounting/services/reports/vatReconciliationService.ts` | 380 | filed-record | returns submitted per year (multi-year summary) | reads `vatPeriodFilings` |
| `src/modules/accounting/services/gl/closeReadinessChecks/vatReviewedCheck.ts` | 21 | filed-record | period-close "VAT reviewed" check | reads `vatPeriodFilings` |
| `src/modules/accounting/services/workbench/monthEndLedgerCards.ts` | 85 | filed-record | month-end "VAT Readiness" card | reads `vatPeriodFilings` |
| `src/modules/bureau/services/bureauVatSignal.ts` | 60 | filed-record | bureau "VAT return due" signal (many companies) | reads `vatPeriodFilings` |
| `src/modules/accounting/services/reports/vatSubmissionService.ts` | 221, 327, 359, 365 | settlement | `submitVATReturn` (idempotency, insert), `listVATReturns` | settles against the live version (`settlementBasis`: 409 without one, lock released, overlapping settlement, already settled, ledger drift); a top-up after an amend; writes `return_version_id` |
| `src/modules/accounting/services/core/companyVatProfileService.ts` | 85 | settlement | filing footprint: every record of any kind that pins the VAT category | unchanged: a settlement row is a footprint whatever its version |
| `src/modules/accounting/services/returns/vatReturnRecord.ts` | 16 | display | the `vat_returns` row beside a VAT201 version, with a mismatch flag | adds the linked version number (versions drawer: "VAT settlement, posted against vN") |
| `src/modules/accounting/services/returns/finaliseReturn.ts` | 21 | display | comment | none |
| `src/modules/accounting/services/returns/returnDrift.ts` | 3 | display | comment | none |
| `src/modules/accounting/services/returns/returnVersionTypes.ts` | 69 | display | comment | none |
| `pages/api/accounting/sars/returns/[form]/finalise.ts` | 32 | display | comment | none |
| `pages/api/accounting/sars/returns/[form]/versions.ts` | 4 | display | comment | none |
| `src/components/accounting/sars/returns/ReturnLifecycleBar.tsx` | 4 | display | comment | none |
| `src/lib/mcp/tools/vatReports.ts` | 41, 93 | display | tool descriptions | line 41 reworded to the new source |
| `src/modules/bureau/services/complianceCalendarEngine.ts` | 107 | display | comment | none |
| `src/modules/accounting/services/core/nlQueryFkPairs.ts` | 93 | schema-list | FK pair list | none (`tax_return_versions` is not an NL-query table) |
| `src/modules/accounting/services/core/nlQueryValidationService.ts` | 64 | schema-list | allowed tables | none |

Dev (`isaflow_dev`, read-only 2026-11-16): 18 `vat_returns` rows in 2 companies, none with a VAT201 version for its
period (live or any status), so the 999g backfill links 0 rows there.
