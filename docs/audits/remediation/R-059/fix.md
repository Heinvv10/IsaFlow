# R-059: ageing report routes ignore `as_at_date` (HIGH), round 1

Branch `fix/audit-r059-aging-report-point-in-time`, cut from master `ad1fe6937` (#413).

## Trigger

`GET /api/accounting/reports-ar-aging` and `reports-ap-aging` are the endpoints behind
`pages/accounting/reports/ar-aging.tsx` and `ap-aging.tsx`. Both accept `?as_at_date=` and
bound it only into `days_overdue`. The population and the balance were taken from today:

- no `invoice_date <= as-at` bound, so documents raised after the date were included;
- the balance came from today's `amount_paid` (AR) or `si.balance` (AP, a STORED GENERATED
  column `total_amount - amount_paid`), so settlement made after the date was already netted off;
- `status NOT IN ('paid', …)`, so an invoice settled after the date disappeared completely.

`arAgingService` / `apAgingService` do all three correctly through `shared/agingRewind`. At
today's date the two agree, and every earlier fixture measured at today.

## Why the routes do not delegate to the services

The services return `AgingBucket[]`, which is grouped **by entity**. The routes return **one row
per invoice** (number, dates, total, paid, balance, days overdue, bucket), use SQL
`LIMIT/OFFSET` pagination, and build a bucket summary over the full population. That summary is
what the two UI pages render. Neither service exposes per-invoice rows for the whole company,
so delegating would change the response contract of both pages. Instead each route now uses the
**same shared code** the services use: `rewindAmount` + `effectivePaidExpr` from
`services/shared/agingRewind`, and the same population bound (`COALESCE(invoice_date,
created_at::date)` for AR, `invoice_date` for AP) and status set (`NOT IN ('draft',
'cancelled')`). The rewind arithmetic now exists in one place, so it can't drift. The
population predicate still appears in both route and service, and the route==service test pins
that the copies match.

## Before / after (fixture, measured)

`tests/integration/k053-aging-route-vs-service-rewind.int.test.ts`: book D (deleted) 1150,
S 2300 with 800 paid after the as-at date, L 500 raised after it:

| as-at | service | route before | route after |
|---|---|---|---|
| today −90 | 3450 | 3150 (gap **−R300** = LATE − PAID) | **3450** |
| today | 2000 | 2000 | 2000 |

The same gap existed on AP. `r059-aging-route-point-in-time.int.test.ts` (S 1000 with 400 paid
at −50; P 500 fully paid at −40, status `paid`; both raised −100 and due −90):

| as-at | expected (route = service) | buckets | pre-fix route |
|---|---|---|---|
| −120 (before invoice) | 0 | none | 600 |
| −70 (between) | 1500 | 1-30: 1500 | 600 |
| −30 (after payments) | 600 | 31-60: 600 | 600 |
| today | 600 | 61-90: 600 | 600 |

Both AR and AP were asserted, as figures and as buckets, route AND service.

**Today's report is unchanged** in the common case. The TODAY cases and the
"route equals `SUM(total_amount - amount_paid)` over open documents" test both still pass with
the pre-fix route restored (mutations M1/M2 below). At today the rewind window `(as-at, today]`
is empty and the date bound is always true.

**One intentional change at today:** a document with `status = 'paid'` that still carries a
balance (`total_amount - amount_paid > 0`, which means the data is inconsistent). The service has
always aged it and the route dropped it. The route now ages it, so both agree (test: R800 on each
side with a 300/100 `paid` row). Hein should know that such rows exist on production. The SQL below counts them.

## Also fixed: the same defect class in the practice module

`practiceReportsService.getWipAging` (`/api/accounting/practice/reports/wip-aging?asOfDate=`)
and `getRevenuePipeline.totalApproved` had the same shape on `time_entries`: `asOfDate` fed only
the bucket arithmetic, and the population was `status='approved' AND billed_at IS NULL`, which is
today's snapshot. Both now bound `approved_at::DATE <= asOf` and count an entry billed since the
date (`status IN ('approved','billed') AND (billed_at IS NULL OR billed_at::DATE > asOf)`).
`markTimeEntriesBilled` sets `billed_at = NOW()`, so that transition has a date and can be rewound.

**Not datable, left out on purpose:** `pages/api/accounting/time-entries-invoice.ts` sets
`status='invoiced'` and leaves `billed_at` NULL. An entry invoiced through that path after the
as-of date can't be recovered, so past WIP is understated rather than billed work being reported
as unbilled. The AR/AP rewind errs in the same direction. Fixture W1/W2/W3/W4: 0 / 1400 / 1000 /
1250 at −120 / −70 / −30 / today. Pre-fix it was 1250 at every date.

## Census of ageing / as-at surfaces

Enumerated from the tables (`customer_invoices`, `supplier_invoices`, `time_entries`), from the
consumers of `getARAging`/`getAPAging`/`getARSubledger`, and from every route under `pages/api`
that names `as_at`/`asAt`/`asOf`/`aging`. Directories walked: `pages/api/**`,
`src/modules/accounting/services/{ar,ap,reports,reconciliation,workbench,practice,shared}`,
`src/lib/mcp/tools`.

| Surface | Path to the figure | Disposition |
|---|---|---|
| `reports-ar-aging.ts` | own SQL | **FIXED** (this item) |
| `reports-ap-aging.ts` | own SQL | **FIXED** (this item) |
| `practice/reports/wip-aging.ts` | `getWipAging` | **FIXED** (same class, `time_entries`) |
| `getRevenuePipeline.totalApproved` | own SQL | **FIXED** (same population as WIP) |
| `getRevenuePipeline.totalInvoicedLast30d` | own SQL | **OPEN → R-072**: `billed_at >= asOf − 30d` has no upper bound, so billing after the as-of date counts (fixture: 400 at an as-of before the billing). Adding the bound moves today's figure when `billed_at` is future-dated, so it is registered, not folded in |
| `ar-aging.ts`, `ar-aging-export.ts` | `getARAging` / `getARAgingDetail` | exempt: delegates |
| `ap-aging.ts`, `ap-aging-export.ts` | `getAPAging` / `getAPAgingDetail` | exempt: delegates |
| MCP `aged_debtors` / `aged_creditors` (`reportsAging.ts`) | services | exempt: delegates |
| `monthEndWorkbenchService` | services at `periodEnd` | exempt: delegates |
| `supplier-statement-balances.ts` / `supplierStatementBalancesService` | `getAPAging` | exempt: delegates |
| `reconciliation/agedReportTotal.ts` | services | exempt: delegates |
| `reports/agingReportService.ts` | `getARSubledger`/`getAPSubledger` → `effectivePaidExpr` + `rewindAmount` + date bound | exempt: shared rewind (read `arSubledgerService.ts:61-91`) |
| `reports-supplier-ledger.ts` | invoices and payments as dated events, each bounded by `dateFrom/dateTo` | exempt: running balance built from dated events and never reads `amount_paid` |
| `customer-statement.ts`, `customer-statement-detail.ts` | dated events, `from/to` | exempt: same reason |
| `supplier-statement-detail.ts`, `supplierStatementService` | dated events, each `<= as_at_date` | exempt: `amount_paid` is SELECTed at line 59 but never read (dead column, left as is) |
| `customer-statements.ts` | no as-at parameter (today) | exempt: live figure only |
| `debtorsManagerService`, `dashboard-*`, dunning | `asAtTodayStr()` only | exempt: no as-at parameter |

**A remaining difference that is not a point-in-time defect.** On AR, the service moves open
disputed amounts (`customer_invoice_disputes.status='open'`) out of the age buckets into a
`disputed` field, so the service's bucket total is the route total minus open disputes. The route
shows the full outstanding balance. That is a presentation choice, not an as-at defect, and it
applies at today too. Changing it would change today's report. **Decision for Hein:** should the
`reports-*-aging` pages show disputes separately? It is not fixed here.

## Tests

- `tests/integration/r059-aging-route-point-in-time.int.test.ts`: 13 tests (AR+AP × 4 dates,
  row-level rewind, today-equals-direct-SQL, and the paid-with-balance change).
- `tests/integration/r059-wip-aging-as-of.int.test.ts`: 5 tests.
- `tests/integration/k053-aging-route-vs-service-rewind.int.test.ts`: **assertions changed on an
  already-merged K-053 file**. That file pinned the R-059 gap as a non-zero measurement and said
  in its own header: "When it is fixed the deltas below become zero and this file goes red on the
  two assertions that name it — which is the point." It did go red. The changes are: the route's
  earlier-date total `DELETED + (SETTLED − PAID) + LATE` → `DELETED + SETTLED` (equal to the
  service), route before−today `DELETED` → `DELETED + PAID − LATE` (equal to the service's), and
  the gap `LATE − PAID` → `0`. K-053's own claim still holds: D is carried at the earlier date and
  dropped at today by the route and the service alike. Its reversal is still in the fixture, and
  the service assertions were not touched.

## Mutations (file copies, restored with `cmp` verification)

| # | Mutation | Result |
|---|---|---|
| M1 | pre-fix `reports-ar-aging.ts` | 4 red (before, between, rows, paid-with-balance). AR after/today stay green, which shows today is unchanged |
| M2 | pre-fix `reports-ap-aging.ts` | 4 red (same pattern) |
| M3 | pre-fix `practiceReportsService.ts` | 4 red. Today stays green |
| M4 | AR: drop only the `invoice_date <= as-at` bound | 1 red (before) |
| M5 | AP: put `'paid'` back in the status filter | 3 red |
| M6 | AP: empty rewind window (`todayStr: asAtStr`) | 2 red (between, rows) |
| M7 | WIP: drop only the `billed_at` rewind | 2 red |
| M8 | WIP: drop only the `approved_at` bound | 3 red |

## Historical impact: production NOT measured

It isn't possible to count how many past-dated ageing reports a user ran and read. Nothing
records the as-at dates people requested beyond request logs. **What to re-run:** any AR or AP
age analysis on the Reports pages with an as-at date in the past, plus any WIP ageing with a past
`asOfDate`. That especially covers exports or printouts kept for a month-end, an audit file or a
bank covenant. The month-end workbench, the `*-aging-export` downloads and MCP
`aged_debtors`/`aged_creditors` were already correct (they delegate to the services).

Read-only SQL for Hein, to run by hand. It sizes the one intentional change at today and the
datable settlement that past-dated route reports wrongly netted:

```sql
-- 1. status='paid' documents that still carry a balance (route now ages them at today too)
SELECT 'AR' AS side, company_id, COUNT(*), SUM(total_amount - COALESCE(amount_paid,0))
FROM customer_invoices
WHERE status = 'paid' AND deleted_at IS NULL AND total_amount - COALESCE(amount_paid,0) > 0
GROUP BY company_id
UNION ALL
SELECT 'AP', company_id, COUNT(*), SUM(total_amount - COALESCE(amount_paid,0))
FROM supplier_invoices
WHERE status = 'paid' AND deleted_at IS NULL AND total_amount - COALESCE(amount_paid,0) > 0
GROUP BY company_id;

-- 2. For a given past as-at (e.g. last month-end), the AR settlement the old route
--    netted off although it happened after that date. Replace the date literal.
SELECT ci.company_id, COUNT(DISTINCT ci.id) AS invoices, SUM(cpa.amount_allocated) AS understated_by
FROM customer_invoices ci
JOIN customer_payment_allocations cpa ON cpa.invoice_id = ci.id
JOIN customer_payments cp ON cp.id = cpa.payment_id AND cp.company_id = ci.company_id
WHERE cp.status NOT IN ('draft','cancelled')
  AND cp.payment_date > DATE '2026-08-31' AND cp.payment_date <= CURRENT_DATE
  AND ci.invoice_date <= DATE '2026-08-31'
GROUP BY ci.company_id;
```

## Gates

See the report for the pasted final lines of `env -u DATABASE_URL bun run ci` and the
integration run.

---

# Round 2 (review `review-r059-r1.md`: 1 HIGH, 3 MEDIUM, 2 LOW)

Every figure below was measured on the integration fixtures, and every "before" figure by restoring
the pre-branch file (`git show ad1fe6937:<path>`, or `d7ada60f5` for round 1) and re-running the test.

## HIGH-1: the year-end receivables/payables notes. FIXED, with two twins the review did not name

The census by consumer (below) found four year-end notes, not two:
- disclosure note 3 `noteReceivables` and note 4 `notePayables` (`reports/disclosureNoteGenerators.ts`), and
- AFS note 10 `generateNote10TradeReceivables` (`afs/noteGenerators/notes6to10.ts`) and note 16
  `generateNote16TradePayables` (`notes16to20.ts`).

The AFS pair was worse than the disclosure pair: `SUM(total_amount)`, so it netted no settlement at
all. They were missed twice because the arithmetic has no `amount_paid` to search for (census failure
mode 5). The review's own candidate list omits `notes16to20.ts` for the same reason.

All four now call `reports/agedBucketTotals.getAgedBucketTotals(companyId, side, yearEnd)`. It sums
`getARAging`/`getAPAging` and adds nothing of its own, following the `reconciliation/agedReportTotal`
pattern, so no third copy of the rewind exists. `gross` adds back the open disputes, which the AR
service holds outside its buckets. The dispute is still a receivable, and `gross` is what the
`reports-ar-aging` route totals.

**The age tables change shape, deliberately.** The old tables started "Current" at 0-29 days OVERDUE.
A document not yet due at the year end sat in no column while the Total counted it, so the row did
not foot. They now print the ageing's own five buckets (Current/30/60/90/120+), then Disputed when
there is any, then a Total equal to `gross`.

Fixture `r059-year-end-notes-agree-with-ageing` (FYE = the last day of the month two months back):
AR X 700 is paid on FYE+3, Y 300 is 40 days overdue with an open dispute of 100, D is a 200 draft and
L 50 is raised after the FYE. AP has the same shape at 400/150/80/50.

| | ageing route at FYE | before | after |
|---|---|---|---|
| disclosure note 3 / AFS note 10 | 1000 | **500** (Y and the draft; X gone) | 1000; Current 700, 60 days 200, Disputed 100 |
| disclosure note 4 / AFS note 16 | 550 | **230** | 550; Current 400, 60 days 150 |

The K-053 AFS test (`k053-afs-notes-tie-to-gl`) still ties all four notes to the GL at both year ends.

## MEDIUM-2: the "agrees with the ageing at that date" comments. MADE TRUE, measured first

These are period-activity reports: only documents raised in [from, to]. So they can never equal the
ageing's total, and no fix can make that literal claim true. The measure that is coherent with what
K-053 already did is "as at `to`": the soft-delete leg was dated to `to` while paid and outstanding
stayed at today, and that hybrid was the defect. The alternative, "collection status today", would
have meant un-dating the K-053 leg as well. So received and outstanding are now rewound to `to` with
the aged report's own rewind, and every comment now says exactly that: "the ageing at `to`
restricted to these documents, not the ageing's total".

- `sales-by-customer` and `purchases-by-supplier` also counted drafts (`status != 'cancelled'`).
  Drafts are now excluded, as the ageing and the two services already did. **This changes today's
  totals** wherever a company has drafts in the period: a draft is not a sale. Measured on the
  fixture: 1200 → 1000.
- `purchases-by-supplier` defaulted `from`/`to` through `toISOString()`. `to` is now the date the
  rewind runs to, so it uses `fmtDate`: between 00:00 and 02:00 SAST, `toISOString()` names yesterday.

Fixture `r059-period-reports-as-at-period-end`: S 1000 raised in the period and paid after `to`, plus
a 200 draft.

| | to = END (before) | to = END (after) | to = today (after) |
|---|---|---|---|
| sales-by-customer / purchases-by-supplier | total 1200, paid 1000, outstanding 200 | 1000 / 0 / 1000 = the ageing at END | 1000 / 1000 / 0 |
| getCustomerReport / getSupplierReport (four routes) | 1000 / 1000 / 0 | 1000 / 0 / 1000 = the ageing at END | 1000 / 1000 / 0 |

## MEDIUM-3 and MEDIUM-4: WIP. FIXED, in one predicate

`practice/wipAsOf.wipInForceAsOf` is now the one population that `getWipAging` and
`getRevenuePipeline.totalApproved` both use.

- **Entry.** WIP starts at `approved_at`. An `approved` entry with no `approved_at` (the
  `approveEntries` path) counts from `LEAST(entry_date, today)`: it cannot have been approved before
  the work was done, and the cap keeps a future-dated work entry in today's figure. No data backfill.
  `approveEntries` now stamps `approved_at = NOW()`, so the undated population stops growing.
- **Exits, each rewound:**
  - `billed` by `billed_at`;
  - `invoiced` by the linked invoice's `COALESCE(invoice_date, created_at::date)`. That is the date
    the AR ageing admits the invoice from, so an entry is never in WIP and AR on the same day, and
    never in neither. `created_at` would double-count a backdated invoice;
  - `not_billable` by `written_off_at`.
- **An exit that cannot be dated counts as always having happened.** That covers an `invoice_id` that
  does not resolve to an invoice of this company (markAsInvoiced takes it from the body; there is no
  FK). An entry that has left and has no `approved_at` is never counted, because
  time-entries-invoice.ts also invoices drafts and submitted entries.
- **Today is unchanged by construction.** An exited entry counts only at a date strictly before today,
  so at today the population is exactly `status='approved' AND billed_at IS NULL`. This is written as
  its own conjunct, not `LEAST(exit, today)`, because LEAST ignores NULL and would make an undated
  exit count at every past date.

Fixture `r059-wip-aging-as-of` has W1–W10, with the entry states set out in the file header.

| as of | before (round 1) | after |
|---|---|---|
| −120 | 0 | 0 |
| INV (approval day) | 1400 | 1940 |
| BILL (billing day) | 1000 | 1690 |
| IVD (invoice day) | 1000 | 1490 |
| WO (write-off day) | 1000 | 1190 |
| today | **1250** (round-1 regression: W7 and W10 dropped) | **1415** |

1415 at today is the pre-branch figure: with the pre-branch `practiceReportsService.ts` restored, the
today case passes and the other nine fail. The review's case (W5 300 written off and W6 200 invoiced
after 07-02) is W5/W6 here, and both are now in WIP before their exit. **Still pre-existing, not
changed:** an undated-approval entry is in the total but in no age bucket, because the buckets age
from `approved_at`. Moving it into a bucket would change today's buckets.

## LOW-5: the tests could not fail on the rows query or on boundary days. FIXED

- `r059-aging-route-point-in-time` now asserts the route's **rows** (count and Σ balance_due) at
  every date. It adds the invoice day itself (1500, current, 2 rows) and S's payment day itself
  (1100, 31-60, 2 rows). It now has 17 tests, up from 13.
- The WIP test asserts the approval, billing, invoice and write-off days themselves.
- `r059-aging-route-equals-service-every-day` (4 tests), adapted from the reviewer's probe: route ==
  service (total and buckets) and route rows == route summary on EVERY day from −105 to today, AR
  and AP. The fixture covers a payment, an applied credit note, a write-off and a credit note
  cancelled since, and the true balance is asserted on each day that changes it. The cancellation
  day itself (R-074) and a cancelled payment (agingRewind limitation 1) are deliberately not
  truth-asserted. Mutations, all red: SW1 AR route rewind window emptied (1/4), SW2 AR rows back on
  today's amount_paid (1/4), SW3 AP summary counting a bill raised after the as-at date (2/4).

## LOW-6: K-050 and supplierStatementReconService

- **K-050 (`arSubLedgerCheck`/`apSubLedgerCheck`).** Still live on this branch. **Not fixed here:** it
  is being fixed on its own unmerged branch `fix/audit-k050-close-readiness-as-at` (548bf39e2, worktree
  `.worktrees/fix-K-050`), which rewrites the same two files. Fixing it here would create a merge
  conflict between two fixes of the same lines.
- **`capture/supplierStatementReconService.createReconciliation`: FIXED.** Our side of the variance is
  now `getAPAgingDetail(company, supplier, statementDate)`. The supplier's closing balance is struck
  at the statement date, so comparing it with today's balance made every payment since the statement
  date an unexplainable variance. The old query also counted drafts. The default statement date
  moved from `toISOString()` to `asAtTodayStr()`, because it is now an as-at date. Fixture
  `r059-statement-recon-as-at-statement-date`: before 800 (variance 200), after 1000 (variance 0).

## Census by consumer (round 2)

**How it was enumerated.**
- By TABLE, not by predicate: every file under `src/` and `pages/` (all of `pages/api/**`,
  `src/modules/**` including admin/bureau/analytics/onboarding, and `src/lib/**` including the MCP
  tools) that names `customer_invoices`/`supplier_invoices` (192 files) or `time_entries` (22 files).
- Then by ARITHMETIC: the 107 files that form an outstanding-shaped figure (`amount_paid`, `balance`,
  `balance_due`, `'paid'`, an open-status set, `outstanding`). Separately, the 85 table files without
  any of those tokens were searched for `SUM(total_amount)` aggregates, which is how the AFS notes
  spelled it. Seven hits, none an outstanding balance: document-validation, recurringInvoiceService,
  captureDeduplication, expectationEngine, evidenceGraph, supplierStatementReconDb (a document list)
  and bureauWorkAggregator (bills awaiting approval, today).
- Then by DATE PARAMETER: `asAt/as_at/asOf/end/endDate/periodEnd/dateTo/to/statementDate`, read at
  each site.
- `scripts/` was searched for as-at balance reads. The only hit is `ap-backfill-supplier-payments.ts`,
  which reads unapplied payments (see below).

**Paths followed through intermediaries:**
- generateDisclosureNotes → notes 3/4;
- the AFS note engine index → notes 10/16;
- getCustomerReport/getSupplierReport → reports-customer, customer-report-export, reports-supplier and
  supplier-report-export;
- runIntegrityChecks → MCP `integrity_checks` (`as_at`) → invoicesNullDueDate and
  testRecordsInProduction;
- getWipAging/getRevenuePipeline → the practice routes;
- approveEntries → time-entries-action;
- createReconciliation → supplier-statements POST;
- MCP `wip_report` → getWipByClient.

| Surface | Disposition |
|---|---|
| `reports-ar-aging.ts`, `reports-ap-aging.ts` | FIXED r1; rows and boundary days pinned r2 |
| disclosure notes 3/4, AFS notes 10/16 | **FIXED r2** (HIGH-1) |
| sales-by-customer, purchases-by-supplier, getCustomerReport, getSupplierReport | **FIXED r2** (MEDIUM-2) |
| getWipAging, getRevenuePipeline.totalApproved, approveEntries | **FIXED r2** (MEDIUM-3/4) |
| `gl/integrityChecks/documentChecks.invoicesNullDueDate` | **FIXED r2**, found by this census. The MCP `as_at` read today's amount_paid over the open-status set: a past date missed an invoice settled since. Before: 0 / R0; after: 1 / R1000 (`r059-integrity-checks-as-at`) |
| `gl/integrityChecks/vatChecks.testRecordsInProduction` | **FIXED r2**, found by this census. "Its balance is in the aging", yet it summed today's amount_paid over every document, drafts, cancelled and deleted included. Before: 280 at both dates (the drafts); after: 1400 at the past date, 0 today. **Changes today** where a test-named record has drafts |
| `capture/supplierStatementReconService` | **FIXED r2** (LOW-6) |
| `getRevenuePipeline.totalInvoicedLast30d` | OPEN → R-072 (r1, unchanged) |
| `gl/closeReadinessChecks/{ar,ap}SubLedgerCheck` | OPEN → **K-050**, on its own branch (see LOW-6) |
| `ar-aging(-export)`, `ap-aging(-export)`, MCP aged_debtors/aged_creditors, `monthEndWorkbenchService`, `supplierStatementBalancesService`, `reconciliation/agedReportTotal`, `reports/agingReportService` | exempt: delegate to the services or the shared rewind |
| `reconciliation/unpostedDocumentService`, `reconciliation/settlementFlagService`, `ar/arSubledgerService`, `ap/apSubledgerService` | exempt: shared rewind (`rewindAmount` at their own as-at) |
| `customerLedgerService`, `statementEmailService` (MCP customer_statement), `portalService.getClientStatement`, `supplierStatementService`, `supplier-statement-detail`, `reports-supplier-ledger`, `customer-statement(-detail)` | exempt: running balance from dated events, each bounded by the date; never reads amount_paid for the balance |
| `ar/unappliedReceiptService`, `ap/unappliedPaymentService` (MCP, backfill script) | exempt: unapplied CASH, not an invoice balance. An allocation counts at its payment's date, the same convention agingRewind uses |
| `debtorsManagerService`, `dashboard-stats`, `customer-statements`, `portal/chat`, `kpiDashboardService`, `kpiChartsService`, `cashFlowForecastDataService`, `consolidatedReportingService`, `bureauClientMetricsService`, `bureauWorkAggregatorService` | exempt: today only (`asAtTodayStr()`/`fmtDate(now)`), no as-at parameter |
| `practiceWipService.getWipByClient` (MCP wip_report) | exempt: live WIP to bill from. `dateFrom/dateTo` filter the WORK date, not an as-at |
| `customReportFieldDefs` balance field | exempt: a document attribute with no as-at parameter; user filters select documents |
| the remaining table files (writers, locks, PDF builders, importers, VAT box queries, MCP writers) | exempt: not an outstanding balance at a date |

## Mutations (round 2): file copies, each restore verified with `cmp`, tree md5-checked after

All 30 turned red (failing/total in the target file):

| # | Mutation | Red |
|---|---|---|
| MA/MB/MC | disclosure 3/4, AFS 10, AFS 16 restored pre-branch | 2/5, 1/5, 1/5 |
| MS | `gross` without disputed | 2/5 |
| MD/MF/MG | sales-by-customer, purchases-by-supplier, transactionReportingService pre-branch | 2/8 each |
| MT | sales-by-customer: drafts back in | 2/8 |
| MU/MV | sales-by-customer / getCustomerReport rewound to today instead of `to` (argument check) | 1/8 each |
| MR1 | practiceReportsService round 1 | 9/10 |
| MH | undated approval dropped (the MEDIUM-3 regression) | 6/10 |
| MO | work-date cap at today dropped | 2/10 |
| MI | exit "strictly before today" conjunct dropped | 2/10 |
| MJ / MJ2 | invoiced exit undatable / dated by `created_at` | 8/10, 4/10 |
| MK | write-off exit dropped | 5/10 |
| ML (M13) | exit `>` to `>=` | 3/10 |
| MM (M14) / MM2 | approval `<=` to `<` (approved / exited branch) | 3/10, 1/10 |
| MN | approveEntries without `approved_at` | 1/10 |
| M9/M10 | ROWS query only: `invoice_date` bound dropped (AR/AP) | 1/17 each |
| M11/M12 | ROWS query only: `<=` to `<` (AR/AP) | 1/17 each |
| MP/MW | recon pre-branch / measured at today | 1/1 each |
| MQ / MR / MY | null-due-date pre-branch / test-records pre-branch / test-records drafts back in | 1/4, 2/4, 2/4 |

## Not changed, stated

- **R-074** (`agingRewind.creditsCancelled` compares a timestamptz with midnight UTC) is registered
  separately. Nothing here depends on it being fixed.
- `invoicesNullDueDate`'s finding text still says an undated invoice "is absent from aged debtors".
  Since #303 the ageing ages such an invoice from `invoice_date`. The figure is now right; the
  sentence is stale and belongs to that check's owner.
- `practiceReportsService.ts` was already over the 300-line cap (362 at d7ada60f5). This round moved
  the predicate out and leaves it at 351.

## Historical impact: production NOT measured

Re-run: any AFS or disclosure-note pack for a year end that had settlement after it; any
sales/purchase or customer/supplier report for a past period; any supplier statement reconciliation
struck at a past statement date. That last figure is STORED on `supplier_statement_reconciliations`:
existing rows keep their old `isaflow_balance` until they are re-created. SQL for Hein to size the
stored reconciliations:

```sql
SELECT company_id, COUNT(*) AS recons, MIN(statement_date), MAX(statement_date)
FROM supplier_statement_reconciliations
WHERE statement_date < created_at::date
GROUP BY company_id;
```

---

# Round 3 — the five round-2 LOWs

## LOW-1: the notes' Disputed column read TODAY's disputes. FIXED at the service.

`getOpenDisputeTotals` (`ar/disputeService.ts`) took no date and filtered
`status = 'open'`, so the new Disputed column in disclosure notes 3/4 and AFS
notes 10/16 stated the year end's receivables against today's disputes: one
raised after the FYE moved money out of an age bucket in a statutory note, and
one open at the FYE but resolved since was missing from it.

It now takes an optional `asAtDate` and answers "was this dispute open then?":
`raised_at <= asAt AND (status = 'open' OR (resolved_at IS NOT NULL AND
resolved_at > asAt))`. Both columns are `TIMESTAMPTZ` and the as-at is a SAST
calendar date, so each is taken through `AT TIME ZONE 'Africa/Johannesburg'`
first — a bare `::date` in the UTC session names the previous day for anything
struck in the first two hours of the SAST day. This is deliberately NOT the
comparison `agingRewind.creditsCancelled` makes (R-074); it is the one R-074
will move to, and it is not made worse here.

A closed dispute with no `resolved_at` cannot be dated and is excluded, exactly
as the undated read excluded it. Every transition in `disputeResolution.ts`
sets the column, so such a row can only predate that code; the effect is that
its amount sits in an age bucket rather than the Disputed column, and `gross` —
what the note totals and what ties to the GL — is identical either way.

Fixed at the class, not the named site: both `arAgingService` call sites (list
and detail) and `arSubledgerService` now pass their own as-at. Omitting the
argument reproduces the old behaviour exactly, and at `asAt = today` the rewind
and `status = 'open'` select the same rows.

**Fixture corrected.** `r059-year-end-notes-agree-with-ageing` pinned the
year-end figure only by accident: its one dispute was raised ~40 days AFTER the
FYE with `raised_at` defaulting to `now()`, so "Disputed 100" was today's
number that happened to match. Invoice Y now carries two disputes — R 100
raised FYE−30 and resolved today, O 200 raised today and still open (only one
may be `open` per invoice, mig 428). The correct year-end row is Disputed 100 /
60 days 200; the undated read gives the mirror image, 200 / 100. `gross` is
1000 either way, so only the age row can catch it — which is the point.

## LOW-2: the `wipAsOf.ts` claim was false. COMMENT CORRECTED; the gap is registered, not fixed.

The header said an entry is "never WIP and AR on the same day, nor neither".
The second half is wrong on the main path: `time-entries-invoice.ts:97` always
creates the invoice as `'draft'`, and the ageing excludes drafts, so from the
invoice date until someone approves it the work is in neither report.

**Is that the right accounting?** No — it is a defect, and it is not this
item's. Work that has been delivered and invoiced is an asset of the practice
on the invoice date; a draft invoice is not a receivable, but the underlying
work has not stopped being worth something because the invoice has not been
approved yet. The honest exit date for WIP is the date the invoice LEAVES
draft, not its `invoice_date`. Two things follow, and both put it out of scope
here: (a) it changes TODAY's WIP figure, which R-059 is under an explicit
constraint not to move, and (b) the exit would need the approval date, which
`customer_invoices` does not store — it needs a column or the GL journal's
date. Registered for the orchestrator: **R-id TBA — "an entry invoiced to a
draft invoice is in neither WIP nor AR"**. The comment now states the gap and
that it exists at today exactly as at a past date, so the rewind did not
introduce it.

## LOW-3: the soft-delete legs in `testRecordsInProduction` were unpinned. TESTS ADDED.

Deleting either `documentInLedgerAsAtFragment` line from `vatChecks.ts` left
`r059-integrity-checks-as-at` green, because the fixture had no deleted
document — and those subqueries have no `deleted_at` test of any other kind, so
the mutation admits every soft-deleted document at every date.

The fixture now carries a soft-deleted AR invoice of 500 and AP bill of 300,
each with a posted approval journal dated −100 and a posted reversal dated −95:
an EVEN chain at both as_at dates, so the document is out of the ledger and
must count nowhere. Both mutations now go red (below).

## LOW-4: `sales-by-item` disagreed with the sibling it claimed to match. DRAFTS EXCLUDED.

The comment said "dated exactly as sales-by-customer over the same range" while
the predicate stayed `ci.status != 'cancelled'`, so it counted drafts and
sales-by-customer did not — the two reports differed by every draft in the
range.

Made consistent by excluding drafts, which is the correct side of the choice
and the reason is now in the query: **a draft invoice is not a sale.** It is
not issued to anyone, it posts nothing to the GL, and its lines are still being
edited. It is the same rule the ageing, sales-by-customer, purchases-by-supplier
and both transaction reports apply. This CHANGES today's figure for any tenant
carrying drafts — the report was overstating revenue by them.

## LOW-5: the four pages fed a UTC date and did not label the columns. FIXED.

`sales-by-customer.tsx`, `purchases-by-supplier.tsx`, `customer-reports.tsx`
and `supplier-reports.tsx` all built their default `to` / `period_end` with
`toISOString().split('T')[0]`, which converts to UTC first — so on this UTC+2
host the default report rewound a day between 00:00 and 02:00 SAST and a
receipt banked today dropped out of "Received". The route-side `fmtDate`
default never ran, because the pages always send the parameter.

They use `fmtDate` now — the existing helper, the one `ar-aging.tsx` and
`ap-aging.tsx` already use for this. No new helper was written.

The four column heads that changed meaning are labelled with the date they are
stated at: "Received at <to>" / "Paid at <to>" / "Outstanding at <to>" /
"Balance at <to>".

## Round 3 tests

| File | What it pins |
|---|---|
| `tests/unit/components/reports/periodReportPagesAsAtDate.test.tsx` (NEW, 9 tests) | All four pages ask for the LOCAL day and label both settlement columns with it. Fake-clocked to 00:30 local; the first test asserts the PREMISE — that on this host UTC names the previous day — so the assertion is not decorative |
| `r059-year-end-notes-agree-with-ageing` (+1 test, fixture corrected) | Disputed at the FYE is 100 and today is 200, in both directions |
| `r059-integrity-checks-as-at` (+1 test, fixture extended) | A soft-deleted test-named document counts at no as_at, AR and AP separately |
| `r059-period-reports-as-at-period-end` (+2 tests, fixture extended) | sales-by-item's revenue equals sales-by-customer's at a past period end and today |

## Round 3 mutations (file copies, each restored and `cmp`-verified)

| # | Mutation | Red |
|---|---|---|
| R1 | `getOpenDisputeTotals` back to undated `status = 'open'` | year-end notes FAIL |
| R2 | `arAgingService` drops the `asAtStr` argument (argument check, not callee) | year-end notes FAIL |
| R3 | `vatChecks` AR `documentInLedgerAsAtFragment` deleted | integrity checks FAIL |
| R4 | `vatChecks` AP `documentInLedgerAsAtFragment` deleted | integrity checks FAIL |
| R5 | `sales-by-item` back to `status != 'cancelled'` | period reports FAIL |
| R6 | `sales-by-customer.tsx` `to` back to `toISOString()` | 2 component tests FAIL |
| R7 | `customer-reports.tsx` "Paid at {periodEnd}" back to "Paid" | 1 component test FAIL |

## Round 3 gates

`env -u DATABASE_URL bun run ci`: `[ci] all checks passed`, `CI_EXIT=0`.

Integration on the fixture, `--no-file-parallelism`: the 7 fixture-DB `r059-*`
files, 7 passed. Against **isaflow_dev**: `aging-point-in-time` and
`ar-ap-aging-undated`, 2 files / 29 tests passed.

## Round 3 — the browser check, and what it did and did not prove

Asked for: load at least one of the four pages in a browser against
`isaflow_dev`. **Not completed. Stated plainly rather than claimed.**

What ran: a dev server for this worktree on :3207 against `isaflow_dev`
(never `isaflow`), a GoTrue session minted for `reporting-qa@isaflow.dev` via
`generateLink` + `verifyMagicLink`, and the page fetched with that session —
**HTTP 200**, and `/api/accounting/reports/sales-by-customer?from=2020-01-01&to=2026-09-10`
returned real rows for the Brightsphere tenant (Blitz Fibre 38 invoices,
R4,882,672.50 sales / R1,690,848.50 received / R3,191,824 outstanding).

Why it stops short of proof: 200 is not content proof, and these pages render
the table client-side behind the company context, so the SSR HTML carries
neither the date input nor the column heads. Driving a real browser needed the
minted session cookie set on the page, and **the permission classifier refused
that action**. I did not attempt to work around it: I did not set a password on
the dev account, and I did not inject the token by another route.

What stands in its place: `periodReportPagesAsAtDate.test.tsx` renders all four
real page components in happy-dom, reads the URL each one actually requests and
queries the real `columnheader` roles — and both halves go red under mutation
(R6, R7). That is rendered-DOM evidence, not a source-text assertion, but it is
not a browser and is not claimed as one.

## Round 3 — not done, stated

- The WIP/AR gap of LOW-2 is documented and registered, not closed (above).
- **R-074** and **K-050** remain out of scope, unchanged.
- `practiceReportsService.ts` is still 351 lines, over the 300 cap, as round 2 stated.

---

# Round 4 — meeting current master

Both round-3 findings were about how this branch lands on `origin/master`
`e5d6d1f6e`, not about round-3 logic. Merge commit: `origin/master` merged in,
four conflicts resolved by hand.

## MEDIUM-1: `NULL NOT IN (...)` is NULL — this branch re-introduced the under-reporting K-091 had just fixed

`customer_invoices.status` and `supplier_invoices.status` are **nullable**.
`NULL NOT IN ('draft','cancelled')` evaluates to NULL, not TRUE, so a
`WHERE ... AND <that>` **silently drops every null-status invoice**. K-091
landed `COALESCE(ci.status,'') <> 'cancelled'` on `sales-by-customer` for
exactly this, commenting it as "the same under-reporting this report was fixed
for" — and round 3 wrote the NULL-unsafe form next door in a file that does not
conflict, so it would have merged with nobody resolving it.

**Census by the arithmetic, not the spelling.** I enumerated every
`status`-comparison line this branch WROTE (diff of `ad1fe6937..HEAD`, filtered
to invoice aliases), then widened to whatever the branch's own pinned
invariants force to move with it.

**CORRECTED IN ROUND 5 (r4 LOW-2): the count is 16 occurrences across 10 files,
not fifteen — 10 written by this branch and 6 pre-existing (arAgingService x2,
apAgingService x2, transactionReportingService x2). Round 5 adds the two
subledger services, taking it to 18 across 12 files.** All now
`COALESCE(<alias>.status, '') NOT IN ('draft', 'cancelled')`:

| File | Sites | Written by this branch? |
|---|---|---|
| `reports/sales-by-item.ts` | 1 | yes (r3) — the named finding |
| `reports/purchases-by-supplier.ts` | 1 | yes (r2) |
| `reports/sales-by-customer.ts` | 1 | yes (r2), resolved in the merge |
| `reports-ar-aging.ts` | 2 | yes (r1) |
| `reports-ap-aging.ts` | 2 | yes (r1) |
| `gl/integrityChecks/documentChecks.ts` | 1 | yes (r2) |
| `gl/integrityChecks/vatChecks.ts` | 2 | yes (r2) |
| `ar/arAgingService.ts` | 2 | **no — moved to keep an invariant** |
| `ap/apAgingService.ts` | 2 | **no — same** |
| `reports/transactionReportingService.ts` | 2 | **no — same** |

**Why five pre-existing sites moved** (three files; the subledger pair joined
them in round 5)**.** Fixing only the branch-written half
would have BROKEN two things this branch itself pins:

- `r059-aging-route-equals-service-every-day` and
  `k053-aging-route-vs-service-rewind` assert route == service. A NULL-safe
  route beside a NULL-unsafe service disagrees on precisely a null-status row.
- `r059-period-reports-as-at-period-end` asserts `sales-by-customer` ==
  `getCustomerReport` (and the AP pair). Same argument.
- `vatChecks.testRecordsInProduction` says "its balance is in the aging" and
  `documentChecks.invoicesNullDueDate` quantifies what the ageing understates.
  Both must select the ageing's population or the claim is false.

So the NULL-safe set is the smallest one under which every claim this branch
makes stays true. `arSubledgerService` / `apSubledgerService` carry the same
NULL-unsafe form and are **NOT** changed: they are a different surface, the
branch never touched their predicates, and they are pinned against the GL by
the k053 suite — moving them belongs to a K-091 follow-up, not here. **Stated,
not fixed.**

**Behaviour change, deliberate:** a null-status invoice now appears in the
ageing, in both ageing routes, in the four period reports and in the two
integrity checks, at every date including today. It is a real debt — not a
draft, not cancelled. `isaflow_dev` has **0** such rows on both tables, so this
is latent there; **production NOT measured**, SQL for Hein:

```sql
SELECT 'AR' side, COUNT(*) FILTER (WHERE status IS NULL) AS null_status,
       COALESCE(SUM(total_amount) FILTER (WHERE status IS NULL),0) AS value
FROM customer_invoices WHERE deleted_at IS NULL
UNION ALL SELECT 'AP', COUNT(*) FILTER (WHERE status IS NULL),
       COALESCE(SUM(total_amount) FILTER (WHERE status IS NULL),0)
FROM supplier_invoices WHERE deleted_at IS NULL;
```

**One trap hit and fixed in passing:** the first version of these comments
contained a backtick (`` `NULL NOT IN (...)` ``) INSIDE a `sql` template. That
ends the template literal — the file no longer parses. It is the exact hazard
the brief names; the comments carry no backticks now.

## MEDIUM-2: the four merge conflicts, hunk by hunk

All four come from K-091/K-093 landing after this branch's base `ad1fe6937`.
For each: what master wanted, what the branch wanted, what the resolution keeps.

**1. `pages/api/accounting/reports/sales-by-customer.ts` — two hunks. The one that matters.**

- *Master wanted:* `COALESCE(SUM(COALESCE(ci.amount_paid,0)))` for
  received/outstanding; `LEFT JOIN customers c ON c.id = COALESCE(ci.client_id,
  ci.customer_id) AND c.company_id = ci.company_id`; `GROUP BY
  COALESCE(ci.client_id, ci.customer_id)`; `COALESCE(ci.status,'') <>
  'cancelled'`.
- *Branch wanted:* `effectivePaidExpr` over a `rewindAmount` LATERAL — the
  point-in-time reconstruction; `INNER JOIN customers c ON c.id = ci.client_id`;
  `GROUP BY ci.client_id`; `ci.status NOT IN ('draft','cancelled')`.
- *Resolution keeps:* the branch's rewind (master's `amount_paid` snapshot IS
  the R-059 defect, back on master — taking it reverts round 2's headline fix),
  and master's join, scoping and grouping (K-093: the inner join on `client_id`
  alone DROPPED every invoice carrying only `customer_id`). Status takes
  master's NULL-safety AND the branch's draft exclusion:
  `COALESCE(ci.status,'') NOT IN ('draft','cancelled')`.
- *Measured:* putting master's whole file back makes **4 tests red** —
  `total 1200/paid 1000` where the branch expects `1300/0`. Restored and
  `cmp`-verified.
- *Draft decision re-confirmed post-merge:* master counts drafts here, which
  inverts round 3's "make sales-by-item match sales-by-customer" premise. The
  resolution takes **R-059's side on both files** — a draft invoice is not a
  sale — so the two siblings agree again after the merge.

**2–4. `disclosureNoteGenerators.ts`, `notes6to10.ts`, `notes16to20.ts` — one import hunk each.**

- *Master wanted:* the K-091 subtype vocabulary at that spot — `CASH_SUBTYPES`,
  `rawSubtypesFor`, and in `notes16to20` the `TAX_EXPENSE_SUBTYPES` /
  `OTHER_INCOME_SUBTYPES` / `NON_OPERATING_EXPENSE_SUBTYPES` imports plus the
  `DEFERRED_TAX_SUBTYPE` / `CURRENT_TAX_SUBTYPES` split for note 17.
- *Branch wanted:* `agedBucketTable` / `getAgedBucketTotals`, replacing the
  hand-rolled year-end queries in notes 3, 4, 10 and 16.
- *Resolution keeps:* both, plus DROPS the now-dead
  `documentInLedgerAsAtFragment` import in each — the branch deleted the only
  query using it, and an unused import fails `bun run ci`'s lint. The intent is
  not lost: `getARAging`/`getAPAging` apply that same fragment themselves.
- *Verified master lost nothing:* `git diff ad1fe6937..origin/master` touches
  **no line** of `noteReceivables`, `notePayables`, `generateNote10…` or
  `generateNote16…`, and K-091's note-17 arithmetic (`SUM(gjl.debit -
  gjl.credit)` with the current/deferred split) is present in the merged file.
  Each merged file differs from master only by the branch's own replacement.

## Round 4 tests

| File | Added |
|---|---|
| `r059-period-reports-as-at-period-end` | N, a real unpaid invoice of 300 with `status` NULL, on each side, with an AR line so sales-by-item sees it. Every figure moves 1000→1300 / 0→300; plus a premise test asserting the rows really are NULL and that Postgres really answers NULL to the bare comparison |
| `r059-aging-route-point-in-time` | a null-status invoice of 300 per side, seeded and removed in its own test: route AND service both age it, at today (900) and at a past date (1800) |
| `r059-integrity-checks-as-at` | a null-status AR invoice of 700 (no due date) and AP bill of 250 — both checks count them at both dates |

## Round 4 mutations (`sed` in place, restored from file copies, each `cmp`-verified)

Every one of the 12 NULL-safety sites is pinned independently, and the merge
resolution itself is pinned:

| # | Mutation | Red |
|---|---|---|
| S1 | `sales-by-item` COALESCE dropped | period reports FAIL |
| S2 | `sales-by-customer` COALESCE dropped | period reports FAIL |
| S3 | `purchases-by-supplier` COALESCE dropped | period reports FAIL |
| S4 / S5 | `transactionReportingService` AR / AP COALESCE dropped | period reports FAIL (each) |
| S6 / S7 | `arAgingService` / `apAgingService` COALESCE dropped | ageing route FAIL (each) |
| S8 / S9 | `reports-ar-aging` / `reports-ap-aging` route COALESCE dropped | ageing route FAIL (each) |
| S10 | `documentChecks` COALESCE dropped | integrity checks FAIL |
| S11 / S12 | `vatChecks` AR / AP COALESCE dropped | integrity checks FAIL (each) |
| M-M | `sales-by-customer.ts` replaced with master's whole file (a naive resolution) | period reports **4 red** |

## Round 4 — not done, stated

- `arSubledgerService` / `apSubledgerService` keep the NULL-unsafe form
  (above). A K-091 follow-up, not R-059's.
- The browser check is still not done. Two agents have now failed it for
  different reasons — this one's session cookie injection was refused by the
  permission classifier, the reviewer's only reachable browser is a remote
  Windows host that cannot see this box's dev server. The rendered-DOM suite
  stands in its place, with its stated limit: `AppLayout` and `next/link` are
  mocked, so it does not prove the page mounts under the real company context.
- R-074, R-078 and K-050 remain out of scope, untouched.

---

# Round 5 — the two siblings the branch asserted agreement with

## MEDIUM-1: the subledger kept the NULL-unsafe predicate while the ageing went NULL-safe. FIXED — the predicates, not the doc comment.

Round 4 left `arSubledgerService.ts` and `apSubledgerService.ts` on the bare
`status NOT IN ('draft','cancelled')` and called it a K-091 follow-up. That was
wrong, for a reason round 4 had in front of it: `arSubledgerService.ts:15-17`
states the invariant as the file's own design rule —

> "The population is master's aging population exactly, and deliberately so:
> `reconcile_subledger` reports the aged total beside the subledger total, and
> two populations would make that comparison meaningless."

— and round 4's own change broke it on exactly a null-status document. The
review measured the consequence: ageing 3,108.33 against subledger 2,108.33 on
one null-status R1,000 invoice, with the R1,000 landing in
`reconcilingItemBuilders`'s residual `aged_unexplained_difference`. That
residual is the figure `reconcileSubledger`'s own tool description promises is
zero when the decomposition is complete, so the round-4 state made
`reconcile_subledger` INVENT a difference out of a spelling — strictly worse
than the defect being corrected.

The choice offered was "fix the predicates or correct the doc". The predicates
are correct and the doc is right about why, so both subledger predicates are
now `COALESCE(<alias>.status, '') NOT IN ('draft', 'cancelled')`. The header
needs no change: it now describes what the code does again.

**Pinned by a new file**, `r059-subledger-population-equals-ageing.int.test.ts`:
R 1000 with a real status and N 700 with `status` NULL, on each side, unpaid,
raised before the as-at. It asserts the ageing total and `subledgerTotal` are
both 1700 at a past date and today — and that the DOCUMENT SETS are identical,
because a total can agree by luck and a set cannot.

## MEDIUM-2: `getCustomerReport` was not K-093-scoped while claiming equality with `sales-by-customer`. FIXED, and the fixture that hid it fixed too.

`transactionReportingService.ts` joined `ci.client_id = c.id`. The merge
correctly kept master's `COALESCE(ci.client_id, ci.customer_id)` on
`sales-by-customer` (K-093: both columns exist and an invoice may carry only
`customer_id`), and round 4 then wrote a comment claiming the two are "asserted
equal by r059-period-reports-as-at-period-end". They were not: measured 2,608.33
against 2,108.33 on one `customer_id`-only invoice.

The join is now `COALESCE(ci.client_id, ci.customer_id) = c.id`.

**The test could not have caught it**, which is the more important half: the
fixture set BOTH ids to the same customer on every row — the shape that makes an
assertion decorative. It now seeds **K**, a real invoice of 400 with
`client_id` NULL and `customer_id` set, plus a line so `sales-by-item` sees it.
Both AR surfaces read 1700 where the two AP surfaces read 1300, and a premise
test asserts K really is one-sided.

**The mirror row cannot be seeded, and that is the schema, not an omission.**
`customer_invoices.customer_id` is `NOT NULL` (asserted in the test against
`information_schema`), so "client_id only" is unrepresentable. Suppliers carry
one key, so there is nothing to mirror on AP at all.

**One difference deliberately NOT closed, and the comment now says so.**
`getCustomerReport` reads `FROM customers`, so an invoice pointing at no
customer row has no line in it, while `sales-by-customer` gives that invoice its
own "Unknown customer (id)" row. The two therefore still differ on an invoice
with a dangling customer reference. That is a data defect neither report
creates, and closing it means changing which report is the sales-by-customer
shape — out of R-059's scope. The equality claim in the comment is now qualified
to "over invoices whose customer row exists".

## LOW-1: treating a NULL status as issued debt is a JUDGEMENT. Stated.

`status` is nullable on both invoice tables **and carries `DEFAULT 'draft'`**.
So a NULL is not "no information": it is a value someone wrote explicitly over a
default that means draft. Reading it as issued debt is a convention, not a fact
the schema settles.

**The convention this branch adopts, and why.** A NULL status is treated as a
document that is neither a draft nor cancelled, i.e. as outstanding. Reasons, in
order of weight:

1. **Consistency with the precedent already on master.** K-091 landed
   `COALESCE(ci.status,'') <> 'cancelled'` on `sales-by-customer` — `''` is not
   `'draft'`, so master already counts nulls as real. Choosing differently here
   would put two conventions in one report family, which is the failure this
   whole round is about.
2. A row that reaches NULL has had its default overwritten. `'draft'` is what
   you get by omitting the column; NULL is what you get by naming it.
3. It is the conservative direction for a receivable: over-stating what is owed
   is visible and gets investigated, under-stating it is silent — which is
   exactly how R-059 and K-091 were both missed.

**The alternative reading, stated fairly.** `COALESCE(status, 'draft')` would
exclude these rows, on the argument that the schema's declared meaning for an
unset status is `draft`. If such a row is genuinely an unissued draft it has
posted no GL journal, so counting it INFLATES the ageing against the control
account instead of reconciling to it — the opposite of what R-059 is for. That
is a real cost, and it is why this is worth a decision rather than an
inheritance.

**Nothing decides it but the data, and the data is not measured.**
`isaflow_dev` has **0** null-status rows on both ledgers (0/3188 AR, 0/1215 AP),
so the convention is latent there and no test can settle it. **Production NOT
measured — not queried, per the standing rule.** For Hein, before merge:

```sql
SELECT 'AR' AS side,
       COUNT(*) FILTER (WHERE status IS NULL) AS null_status,
       COALESCE(SUM(total_amount) FILTER (WHERE status IS NULL), 0) AS value,
       COUNT(*) FILTER (WHERE status IS NULL AND gl_journal_entry_id IS NOT NULL) AS posted_to_gl
FROM customer_invoices WHERE deleted_at IS NULL
UNION ALL
SELECT 'AP',
       COUNT(*) FILTER (WHERE status IS NULL),
       COALESCE(SUM(total_amount) FILTER (WHERE status IS NULL), 0),
       COUNT(*) FILTER (WHERE status IS NULL AND gl_journal_entry_id IS NOT NULL)
FROM supplier_invoices WHERE deleted_at IS NULL;
```

`posted_to_gl` is the column that answers it: a null-status document with an
approval journal is issued debt and belongs in the ageing; one with none is an
unissued draft and does not. **If the count is non-zero, choose
`COALESCE(status,'')` or `COALESCE(status,'draft')` explicitly** — and apply the
same choice to all 18 sites, master's `sales-by-customer` line included.

## LOW-2: the census count. CORRECTED.

Round 4's prose said "Fifteen sites … the other five". The correct figure is
**16 occurrences across 10 files** — 10 written by this branch, 6 pre-existing
(`arAgingService` x2, `apAgingService` x2, `transactionReportingService` x2).
Round 5's two subledger predicates take it to **18 across 12 files**. The
round-4 section is corrected in place rather than left standing beside this one.
Every one of the 18 is mutation-pinned, so this was accuracy of the record, not
coverage.

## Round 5 tests and mutations

| Test | Pins |
|---|---|
| `r059-subledger-population-equals-ageing` (NEW, 7 tests) | ageing total == `subledgerTotal` == 1700 on AR and AP, at a past date and today, with identical document sets |
| `r059-period-reports-as-at-period-end` (K seeded, +1 test) | `sales-by-customer` == `getCustomerReport` == `sales-by-item` on a `customer_id`-only invoice |

| # | Mutation | Red |
|---|---|---|
| T1 | `getCustomerReport` join back to `ci.client_id = c.id` | period reports FAIL |
| T2 | `arSubledgerService` COALESCE dropped | subledger population FAIL |
| T3 | `apSubledgerService` COALESCE dropped | subledger population FAIL |

Each restored from a file copy and `cmp`-verified; both files green again after.

## Round 5 — one green gate that was not green

The first `bun run ci` of this round came back **`[ci] unit-tests FAIL`, exit 1**,
on `tests/unit/mcp/w2/subledgerSnapshot.test.ts`: a SOURCE-TEXT assertion pinning
the subledger query's old spelling, `ci.status NOT IN ('draft','cancelled')`.
The MEDIUM-1 fix changed the text it was matching. Updated to the COALESCE form,
with a comment saying why the population is the wider one and that the real
proof is by outcome in the new integration file. Reported because the round's own
change broke a test the branch relies on, and a report that says "all green"
without pasting the step lines would have hidden it.

Swept for siblings of that spelling in `tests/`. Three remain, all correctly
untouched: `unpostedDocuments.test.ts:144` pins `unpostedDocumentService`, which
this branch does not change; `subledgerTiesToAging.integration.test.ts:57` and
`reconcileSubledger.integration.test.ts:42` use the phrase only to CHOOSE which
companies to sample, not to compute an expected figure — rewriting them would
change the sample, not fix anything.

## Round 5 — not done, stated

- The dangling-customer difference between `getCustomerReport` and
  `sales-by-customer` (above) — documented in the code, not closed.
- The NULL-status convention is a decision awaiting one production count (LOW-1).
- The browser check remains not done; the rendered-DOM suite stands, with
  `AppLayout` and `next/link` mocked.
- R-074, R-078 and K-050 remain out of scope, untouched.
