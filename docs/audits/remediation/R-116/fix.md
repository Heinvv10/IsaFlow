# R-116 — the statements pages draw their figures as at the date they show

## Defect (on master)

Statements, Statement Run and Customer Statements each show an as-at date picker and send
`?as_at_date=` to `customer-statements`. The endpoint never read it (`asAtTodayStr()`), so a user who
picked month-end saw today's balances under the month-end label. The batch PDFs (Statement Run →
`generateStatementsBatch` → `customer-statement-detail`) printed the picked date as "as at" on
today's figures. The emailed statement (`customer-statements-send` → `fetchStatementData`) already
honoured the date, so the list, the PDF and the email for the same customer and date could disagree.

## Fix

- `resolveStatementAsAt` (`ar/customerStatementRules.ts`): if no date is sent, today's LOCAL date is
  used. A value that is not a real `YYYY-MM-DD` date, or a repeated parameter, gets a 400. The
  previous behaviour was either a Postgres cast 500 or a silent fallback to today.
- `customer-statements` and `customer-statement-detail` bound every document date, and ask the
  soft-delete question, at that date.
- The batch PDFs request the detail at the date they print.
- The customer drill-down (`customer-statements/[clientId]`) is opened from Customer Statements and
  from the AR ageing with `?as_at_date=`. It is drawn at that date, labelled "Full transaction
  history as at …" and printed at it. Its PDF used a UTC today before.
- The Statements page asks `ar-aging` for Overdue at the same date as the Balance beside it.
- The four pages (Statements, Statement Run, Customer Statements, AR ageing) default the picker to
  `fmtDate(new Date())`. They used `toISOString()`, which is UTC and named yesterday between 00:00 and
  02:00 SAST. That was harmless while the endpoint ignored the date, and it would have been live the
  moment the endpoint honoured it.
- `[clientId].tsx` was 334 lines. Its types and badge moved to
  `components/accounting/statements/customerStatementDetailParts.tsx`. Its PDF now reuses
  `fetchCompanyMeta` from `generateStatementsBatch` instead of a duplicate fetch with an empty
  catch. `fetchCompanyMeta` prefers the API's composed `address`, which includes `address_line2`.

A future as-at date is accepted, as the email path accepts it, and documents dated up to it are
counted.

## Evidence

- `red-master.log`: the new r116 suite ran against master's endpoints. 4 tests failed. The one that
  passed is "no as-at date means today".
- `green.log`: r116, r115, r112/r113, k053, r082 and r095 (6 files) all passed: 49 tests.
- Component tests (`tests/unit/components/customerStatementsAsAt.test.tsx`, 10 tests) cover the
  local-date defaults at 01:30 SAST, the drill-down links, the drill-down fetch, its label and its
  PDF, and the Overdue date. The batch unit tests cover the batch URL, `resolveStatementAsAt` and
  the company address.
- `mutations.log`: every mutation of a production line turned a test red:
  - endpoint: M1b–M6, plus M8 and M9 (soft-delete asked at today);
  - pages: P1–P10 and P10b;
  - batch: M10 (address).
- Browser, on the disposable fixture as the tenant's staff user:
  - `ui.log`: all three pages default to 2026-09-21. `R112 Statement Customer` shows R 1 300,00 as at
    today and R 800,00 as at 2026-08-31 (R 1 000 invoice less the applied R 200 note). The deposit
    customer, whose receipt is dated 2026-09-19, is absent at 2026-08-31.
  - `ui-overdue.log`: Overdue now shows the as-at date's figure.
  - `ui-drilldown.log` and `ui-aging.log`: clicking through from Customer Statements and from the
    AR ageing at 2026-08-31 lands on `?as_at_date=2026-08-31`, labelled "as at 2026/08/31", with
    two lines and a balance of R 800,00.
  - No page errors in any run.
- Blind review (Opus), 3 rounds, final verdict SHIP.
  - Round 1 (REQUEST_CHANGES: 3 MEDIUM, 3 LOW): the drill-down links and page dropped the date; the
    drill-down PDF used UTC; Overdue used today; there were no page-default tests and no soft-delete
    test; one long comment line.
  - Round 2 (SHIP: 1 MEDIUM, 2 LOW): the AR ageing link and its UTC default; the address change was
    untested; the PDF date was untested.
  - Round 3 (SHIP: 1 LOW): the test stubbed the global `URL` in place.
  - All were fixed.

## Not changed

- The AR ageing's buckets are gross. They don't net applied credit notes, so the ageing lists
  R 1 000 where the statement says R 800, and the Statements page's Overdue has the same basis.
  This was already recorded in `R-115/fix.md` and is not registered.
- `*.int.test.ts` suites skip without `DATABASE_URL`, as across the repo. On a CI host without a
  DB, only the unit and component tests guard this change.
