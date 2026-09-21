# K-053 round 7 — the census, redone from the tables

## Why the round-6 census was wrong

It enumerated `git grep deleted_at -- src pages` — 131 lines / 50 files, a count the
reviewer confirmed exact for its stated scope. But a search **for the predicate** cannot
find the code **missing the predicate**. Every surface that never had a soft-delete filter
was outside it by construction, and those are exactly the ones this branch newly breaks:
the delete now reverses the approval journal, so the control account nets to zero at the
reversal date while a surface with no predicate carries the document for ever.

## How this census was built

From the tables, not the predicate:

```
git grep -l -E 'FROM customer_invoices|JOIN customer_invoices|FROM supplier_invoices|JOIN supplier_invoices' -- src pages
```

**137 files.** Each was then classified by whether its query AGGREGATES across documents to
produce a reported AR/AP figure, or lists documents with a balance as at a date. That is the
population that has to tie to the control account; everything else acts on one document, or
lists candidates for an action, and reports no figure.

## In scope and FIXED (24 queries across 17 files)

| Surface | Legs | As-at |
|---|---|---|
| `pages/api/accounting/reports-ar-aging.ts` | rows + bucket aggregate | `as_at_date` |
| `pages/api/accounting/reports-ap-aging.ts` | rows + bucket aggregate | `as_at_date` |
| `pages/api/accounting/supplier-statement-detail.ts` | rows + totals aggregate | `as_at_date` |
| `pages/api/accounting/customer-statement-detail.ts` | rows + totals aggregate | today |
| `pages/api/accounting/customer-statements.ts` | balances summary | today |
| `pages/api/accounting/dashboard-stats.ts` | AR total, AP total | today |
| `pages/api/accounting/reports/sales-by-customer.ts` | outstanding by customer | `to` |
| `pages/api/accounting/reports/purchases-by-supplier.ts` | outstanding by supplier | `to` |
| `pages/api/portal/chat.ts` | outstanding, overdue, open count | today |
| `reports/kpiDashboardService.ts` | AR open/overdue, AP open/overdue | today |
| `reports/kpiChartsService.ts` | AR ageing chart, AP ageing chart | today |
| `reports/consolidatedReportingService.ts` | group AR, group AP | today (row-tenant) |
| `reports/cashFlowForecastDataService.ts` | AR/AP due, AR/AP horizon | today |
| `reports/disclosureNoteGenerators.ts` | receivables note, payables note | fiscal `end` |
| `afs/noteGenerators/notes6to10.ts` | trade receivables note | fiscal `end` |
| `afs/noteGenerators/notes16to20.ts` | trade payables note | fiscal `end` |
| `ar/debtorsManagerService.ts` | summary, detail, overdue, stats, rate | today |
| `ar/portalService.ts` | invoice list, statement | today / `asOfDate` |
| `capture/supplierStatementReconService.ts` | our balance vs the supplier's | today |
| `capture/supplierStatementReconDb.ts` | invoices matched to the statement | `periodEnd` |
| `bureau/bureauClientMetricsService.ts` | client AR, client AP | today |
| `gl/integrityChecks/documentChecks.ts` | null-due-date exposure, no-revenue-leg | `ctx.asAt` |

`shared/softDeleteLedgerPresence.ts` gains two things the above need: `asAtTodayStr()` (a
figure with no as-at parameter is a figure as at today, and must ask the question at today —
NOT undated, because a document deleted before this change has a journal that was never
reversed and the GL still carries it), and `documentInLedgerAsAtFragmentForRowTenant`, which
scopes the chain to the invoice row's own `company_id` for the one query that spans tenants.

## In scope by table, OUT of scope by what it reports — with the reason

- **`reconciliation/unpostedDocumentService.ts` and `reconciliation/settlementFlagService.ts`**
  — the AR/AP sub-ledger-vs-control DECOMPOSITION. Its GL half reads only the lines of the
  document's own journal (`jl.journal_entry_id = ci.gl_journal_entry_id`), never the reversal,
  which is a separate entry. Both halves therefore still carry a deleted document and the
  decomposition nets to nothing — the right answer, since the aggregate it decomposes
  (`apSubledgerService` vs the control account, both already dated) is itself zero. Dating
  only the sub-ledger half MANUFACTURES a shortfall the size of the whole document; this was
  built, it failed exactly that way against the real database, and it was reverted. Moving
  the GL half with it means walking the reversal chain there too — a separate change.
  Pinned by `k053-figure-surfaces-tie-to-gl.int.test.ts` ("no shortfall on either date").
- **Allocation and matching candidate lists** (`ar/customerAutoAllocate`, `ap/supplierAllocationLines`,
  `ar/receiptAllocationLines`, `ar/receiptMatchService`, `ar/customerPaymentAllocationService`,
  `bank/bankMatchDbQueries`, `core/contraSettlementService`) — they pick a document to act on
  and report no figure. A separate guard already refuses to allocate to a deleted document.
- **Single-document reads and workflow queues** (`ar/writeOffService`, `ar/disputeService`,
  `ap/supplierInvoiceQueryService`, `bureau/bureauWorkAggregatorService`,
  `core/emailNotificationService`, `core/paymentGatewayPortalService`) — one row by id, or a
  to-do list counted by document, not a balance.
- **`reports/customReportFieldDefs.ts`** — composes `FROM`/`WHERE` strings for a user-defined
  report builder. Threading the predicate through that composition is a separate change.
- **`gl/integrityChecks/vatChecks.ts:testRecordsInProduction`** — measures money attached to
  obviously test-named records. Not a control-account tie.
- **`core/migrationValidationService.ts`** — reads `balance_due`, a column that does not exist
  on either invoice table (42703 at runtime). Pre-existing and unrelated to this item;
  recorded, not fixed.
- **`ar/dunningService`, `ar/dunningCronService`, `pages/api/accounting/smart-reminder.ts`** —
  chase decisions, deliberately undated; round 6's ruling stands and only the comment changed.

## Not fixed, found by this census (recorded, not this item)

- `ar/portalService.ts` selects `customer_invoices.total` and `customer_payments.amount` /
  `.reference`. Confirmed against `information_schema` on the fixture database: none of the
  three exists (both tables carry `total_amount`). Both portal endpoints throw 42703 today.
  The dated predicate was added anyway so the query is correct once the columns are; that is
  why no test exercises them.
- `reports-ar-aging` / `reports-ap-aging` are not point-in-time reports in any other respect:
  they bound nothing by `invoice_date <= as-at` and read the CURRENT `amount_paid` rather
  than rewinding it the way `arAgingService` does. For a document raised before the as-at
  date with no settlement after it — the case this item is about — they agree; for anything
  else the two AR ageings still differ. Separate defect, separate item.
