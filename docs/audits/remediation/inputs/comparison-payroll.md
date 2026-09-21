# Payroll/report comparison

Compared local Claude HTML and detail Markdown with the 54-finding audit, against committed source SHA `5661d6f0f5f2212705151e95455a3f681ddf840e`. This comparison is source/schema verification; it does not claim production reproduction or independent verification of current SARS rules.

## Requested claim validation

- **C7: incorrect sequential failure mechanism; related to F09.** `payrollLoanService.ts:398–410` selects active loans and unpaid schedules; `:446–464` marks the schedule paid and reduces the balance. `listActiveLoansForRun` at `:529–533` then excludes that schedule. `payrollRunService.ts:156–191` applies eligible deductions and deletes/replaces run lines. Recalculating therefore **omits the repayment while retaining its previous loan-balance reduction**, as F09 says; it does not ordinarily decrement twice as C7 claims. A concurrent race is a different scenario and does not establish the stated reopen/recalculate claim.
- **H1: valid additional finding, absent from our 54.** `payrollJournalBuilder.ts:121` subtracts ETI from labour debit, but `:195–200` credits full PAYE, UIF, SDL and net pay; `:213–216` blocks the resulting imbalance. `payrollJournalParts.ts` preserves that reduced labour total. Positive ETI above the rounding tolerance causes approval posting to fail. The approved-without-journal consequence is also credible: approval updates status before posting; `pages/api/payroll/runs/[id]/approve.ts:34–36` converts the thrown error into HTTP400, and `src/lib/auth/withAuth.ts:234–236` **commits** responses below500. The enclosing transaction does not rescue this path. Avoid saying literally every positive ETI value because the builder permits a one-cent tolerance.
- **H2: statutory assertion not established by this comparison.** `etiEngine.ts:66–67` does return zero at/below the configured floor; `taxTables.ts:51` supplies2000. Internal tests cover higher remuneration, age/UIF exclusions and tapering, but do not establish the alleged50% low-remuneration rule. Treat the legal/formula conclusion as requiring authoritative tax-year evidence. It is independent of F45: our owner-cash finding compares against the application's own PAYE floor in `emp201Service.ts:173` and does not depend on H2 being correct.
- **H4: valid additional finding.** `pages/api/accounting/reports/sales-by-customer.ts:24–40` joins customers using only `ci.client_id`. Migration000 defines `customer_id`, and migration211:89 adds nullable `client_id`. Legacy invoices with only `customer_id` disappear. The proper internal contract elsewhere is `COALESCE(ci.client_id, ci.customer_id)`.
- **H25: valid additional source/schema finding.** `creditNotePdfBuilder.ts:33` references nonexistent `credit_notes.customer_id`; `:44–51` additionally queries nonexistent `credit_note_items` in a caught branch. `portalService.ts:111,145` reads invoice `total` instead of `total_amount`; `:152–157` reads payment `reference`, `amount`, `customer_id` and status `posted` whereas migration202 defines `bank_reference`, `total_amount`, `client_id` and draft/confirmed/reconciled/cancelled statuses. `pages/api/portal/invoices.ts` actually invokes the faulty invoice service. No later relevant column additions were found. These are committed-schema failures, not a claim of observed live500s.
- **H36: false positive for a database with committed migrations applied.** The direct insert at `assetDepreciationPosting.ts:112–121` omits `fiscal_period_id`, but migration501 `resolve_je_fiscal_period()` at `:27–34` fills it from the company's covering period. Its BEFORE INSERT trigger is installed at `:40–44`, including direct posted inserts. Missing covering periods remain a separate conditional data issue. The generic claim that omission makes depreciation invisible overlooks this migration.

## Mapping and genuine differences

| Our finding | Claude coverage | Difference |
|---|---|---|
| F09 loan recalculate | C7 | Same area, but C7's sequential double-decrement mechanism is wrong; F09 explains dropped deductions. |
| F10 invented SDL salary | Absent | EMP201 remuneration comments concern different calculations. |
| F11 rate override column mismatch | C2 | Overlap; F11 additionally establishes new INSERT failure from legacy NOT NULL user_id/rate, not merely ignored override values. Our isolated PostgreSQL test reproduced23502 and stale legacy read. |
| F15 CaseWare metadata download | Absent | Generated package content discarded by route. |
| F16 Word AFS pre-export checks | Absent | DOCX bypasses PDF gate without explicit draft marking. |
| F17 AFS cover year end | Absent | EMP501 leap-day finding is a different output/path. |
| F42 annual exports include unapproved runs | Absent | IRP5/EMP501 route-level status filtering. |
| F43 leading-zero identity export | Absent | Formatter converts the fixed-width ID through Number. Our committed-source executable reproduction demonstrated the truncation. |
| F44 time tracking filters | GL/core medium: “Time-entry listing ignores its filters” | Listing overlaps; F44 also traces summary filters ignored by timeTrackingReportService.ts:40–80. |
| F45 excess ETI owner cash | Absent | Different from H2: ETI offsets salaries/UIF in affordability rather than being capped against PAYE. |
| F46 unrelated bureau client link | C20 | Substantive duplicate. |
| F47 once-off payroll recurrence | Absent | Batch assignment effective_to remains NULL; later runs ignore is_recurring. |
| F48 AFS face balances | Absent | Partial payments omitted from receivable/payable note amounts. |
| F49 AFS aging not-yet-due | Absent | Aging buckets exclude future due dates even though gross includes the invoices. |
| F50 cookie override RLS | Absent | Independent of C2/F11 column mismatch; cookie claims lack company_id required by policy395. Our isolated PostgreSQL reproduction established0 versus1 visible row. |

Thus this domain contributes **12 findings absent as substantive defects** (F10,F15,F16,F17,F42,F43,F45,F47,F48,F49,F50 plus F09's corrected mechanism), with F09 best labelled correction of C7 rather than a wholly new area. There are **11 entirely absent IDs**, two clear overlaps (F11,F46), one partial overlap (F44), and one corrected overlap (F09).

## Coverage wording

Claude's clean list includes “Bureau cross-company gating” even though its own C20 confirms arbitrary company linking. It also says migrations500–615 were clean/reviewed, yet H36 misses the migration501 resolver. These are concrete internal contradictions or overbroad assurances.

The clean statement about “IRP5, UIF and EMP501 support services” is narrower than route coverage: the report explicitly lists payroll IRP5/year-end route families and payroll UI as **not reached, unaudited, not clean**. F42 should therefore be presented as added route coverage, not a contradiction of a claim that those routes passed. F43 does challenge the broad support-service assurance because the defect is in easyFileExportService itself. AFS mapping signs being clean does not mean its note generators or export delivery were reviewed; F15–17/F48–49 fill those gaps. Portal token scoping can be sound while H25's SQL contract is broken.
