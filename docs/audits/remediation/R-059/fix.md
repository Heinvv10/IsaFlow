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
