# R-115 — the customer balances list states each statement's balance

Registered during R-112/R-113 and fixed on the same branch at Hein's request.

## Defect (on master)

`pages/api/accounting/customer-statements.ts` is the list behind Statements, Statement Run and
Customer Statements. It listed each customer's balance as invoices minus confirmed/reconciled receipts
and never read `credit_notes`. Every customer holding a live credit note was listed too high by it.
Other differences from the statement the row opens: documents dated after today were counted, and a
soft-deleted customer was listed although it has no statement. Staff choose whom to chase and whom to
send statements to from this list, and Statement Run filters on its balance (`balance >= minBalance`,
`balance > 0`).

## Fix

The list applies the statement rules from `ar/customerStatementRules.ts`:
- receipts at `total_amount` for `SETTLING_RECEIPT_STATUSES`;
- live credit notes (`LIVE_CREDIT_NOTE_STATUSES`) at `CREDIT_NOTE_STATEMENT_VALUE`;
- every document dated on or before today;
- an inner join to a live customer (`deleted_at IS NULL`), in the same company.

The response adds `total_credits`. Customer Statements, Statement Run and the CSV export show a
Credits column, so every row adds up (Invoiced − Paid − Credits = Balance). The Statements page
already showed only Balance and Overdue.

## Evidence

- `red-master.log`: the 4 tests on master's endpoint — 4 failed.
- `green.log`: r115 + r112 + r095 + r082 + k053 ×2 — 6 files, 55 tests passed.
- `mutations.log`: 7 mutations. Each one fails its own test and the "every listed balance is the
  balance of the statement it opens" parity test.
- Browser (`ui.log`, `r115-customer-statements.png`, `r115-statement-run.png`): dev server on the
  disposable fixture, as the tenant's staff user. Both pages list `R112 Statement Customer` as
  Invoiced R 2 500,00 · Paid R 1 000,00 · Credits R 200,00 · Balance R 1 300,00, which equals its
  emailed statement and both statement screens. The soft-deleted customer (invoice R 250) is not
  listed. No page errors.

## Not changed

The list ignores the `as_at_date` its pages send and is always as at today, as it was on master.
It agrees with the detail screen and the batch PDFs, which are also as at today. That is a separate
defect, registered as R-116.
