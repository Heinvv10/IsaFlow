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
