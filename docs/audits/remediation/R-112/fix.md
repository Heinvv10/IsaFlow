# R-112 + R-113 — in-app customer statements state the emailed balance

Both registered from R-095 round 3 (`docs/audits/remediation/R-095/fix.md`,
`r095-measure-screens.log`). The emailed statement (`statementEmailService.fetchStatementData`)
is the reference; the portal already is it.

## Defects (on master)

- **R-112** `customer-statement-detail` (Customer Statements detail screen, batch PDFs):
  a receipt was credited at `COALESCE(SUM(allocated), total)`, so a partly allocated
  receipt lost its unallocated remainder (R1,000 received, R600 allocated → balance 900
  for a true 500).
- **R-113** `customer-statement` (customers/statement screen, its PDF and HTML print):
  the same receipt rule; credit notes at `status = 'approved'` only (applied and partly
  applied notes vanished); a one-year default window with no opening balance (older debt
  dropped out: −400 for a true 600).

## Fix

`src/modules/accounting/services/ar/customerStatementRules.ts` holds the SQL twins of the
email's row rules: receipts at `total_amount` for `confirmed`/`reconciled`, live credit
notes (`approved`, `partially_applied`, `applied`) at `CREDIT_NOTE_STATEMENT_VALUE`
(twin of `creditNoteAppliedAmount`). Both endpoints use them.

- `customer-statement`: everything before `fromDate` is carried in by
  `customerBalanceBroughtForward` (same rules, soft-delete asked at `toDate`, strictly
  `< fromDate`) as an `opening_balance` line whose figure sits in the debit (or credit)
  column, plus `summary.openingBalance`. Window bounds are local dates, validated
  (`resolveStatementWindow`: not a real date, or from > to → 400). Running and closing
  balances in decimal (`RunningBalance`), as the email.
- `customer-statement-detail`: every document date bounded by today (the email as at
  today leaves post-dated documents out), soft-deleted customer → 404, decimal balances.
- Renderers: the opening balance is a card/box on the screen, the HTML print and the PDF,
  so the summaries foot; the page footer adds it to the column totals; the transaction
  count excludes it. The statement preview moved to
  `src/components/accounting/statements/CustomerStatementPreview.tsx` (page was 444 lines).

## Evidence

- `red-master.log`: the 5 original tests on master's endpoints — 5 failed.
- `green.log`: r112 + r095 + r082 + k053 ×2 — 5 files, 46 tests passed (round 0).
- Round 1 (blind review: 1 HIGH, 5 MEDIUM, 7 LOW — all fixed): the file has 10 tests;
  `mutations.log` — 12 mutations of the new guards, each turns exactly its own test red.
- Round 2 (blind review of the fixes: 2 MEDIUM, 3 LOW — all fixed). The detail endpoint's
  new 404 for a soft-deleted customer reached two callers that never checked `res.ok`
  (the balances list still shows such a customer): the batch export rendered the error
  envelope as an empty R0.00 statement, and the detail page showed "no transactions".
  The batch now skips and names the customer to the statement run; the page shows the
  error. The default window start is a year before `toDate`, not before today.
  `tests/unit/accounting/customerStatementBatchAndWindow.test.ts` (3 tests); reverting
  either fix turns one red.
- `green-round2.log`: r112 (10) + r095 + r082 + k053 ×2 — 5 files, 51 tests passed;
  `green-unit.log`: the round-2 unit file, 3 passed.
- Round 3 (SHIP; 3 LOW fixed): the statement run clears a stale message and says how
  many statements it generated when it skips someone.
- Round 4 (SHIP; 1 pre-existing LOW fixed): a selected id missing from the list is named
  in `skipped`, not silently dropped from the count (unit test 4/4; removing the push
  turns it red).
- Browser round 2 (`ui-round2.log`, `r112-deleted-detail.png`): the detail page for a
  soft-deleted customer shows "Client … not found", not an empty statement; the live
  customer's cards read Invoiced R 2 500,00 · Paid R 1 000,00 · Credits R 200,00 ·
  Balance R 1 300,00; no page errors.
- Browser (`ui.log`, `r112-statement.png`, `r112-detail.png`): dev server on the branch
  against the disposable fixture, headless Chromium as the tenant's staff user. Customer
  with an old invoice 1,000, an old applied note (300, 200 applied), a new invoice 1,500
  and a receipt 1,000 (600 allocated); email balance 1,300. Statement screen: Opening
  R 800,00 · Invoiced R 1 500,00 · Paid R 1 000,00 · Credits R 0,00 · Balance R 1 300,00;
  brought-forward row, footer 2 300 / 1 000 / 1 300; "2 transactions"; no page errors.
  Detail screen (`r112-detail.png`; the card values are read from the screenshot, the
  log records the rows): Balance Outstanding R 1 300,00, running balance ends R 1 300,00.

## Residual

- The balances LIST (`pages/api/accounting/customer-statements.ts`) ignores credit notes
  entirely, so its balance column still overstates by every live note. Not in scope;
  registered as R-115.
