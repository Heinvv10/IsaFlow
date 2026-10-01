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
- drawn from CUSTOMERS outward: every live customer of this company (`deleted_at IS NULL`) with any
  statement activity gets a row, including one with only a receipt or credit note (a deposit, a
  credit balance). An invoice-first list never showed those.

The response adds `total_credits`. Customer Statements, Statement Run and the CSV export show a
Credits column, so every row adds up (Invoiced − Paid − Credits = Balance). The Statements page
already showed only Balance and Overdue.

## Behaviour changes a user will see

- **Credit-balance customers are listed**, with a negative balance. Statement Run (`balance >= minBalance`,
  default 0) and the Statements page (`balance > 0` for auto-selection and the default view) now
  leave out customers whose credit notes cover their invoices. On master those were listed as owing
  and auto-selected for bulk email.
- **No row for debt that has no statement.** That covers an invoice whose customer is soft-deleted,
  missing, or belongs to another company. Master listed those; an orphan got a row with no name. The
  statement endpoints already refuse them, and the AR ageing still carries the debt. This list no
  longer does.
- **The Statements page's Overdue column** still comes from the AR ageing buckets, not from this list.
  A row can therefore show an Overdue figure that doesn't reconcile to its now-net Balance. This is a
  display inconsistency on that page, not a change to either figure.

## Evidence

- `red-master.log`: the first 4 tests on master's endpoint — 4 failed.
- Blind review r1 (APPROVED, 1 MEDIUM, 6 LOW; all addressed):
  - The MEDIUM: an invoice-first list never showed a customer with only receipts. The list is now
    drawn from customers, and the test covers a deposit-only customer and a paid customer whose only
    invoice is post-dated.
  - The LOWs added fixtures for partly applied notes, invoices carrying only `customer_id`, another
    company's receipt/note/customer, and a supplier-type note, plus a non-empty-list guard.
  - The test user now belongs to BOTH companies. Row-level security on `app_user` would otherwise hide
    company B's rows and mask the list's own company predicates. Measured: those three mutations
    survived until the user was made a member of both companies.
- `green.log` (at 8ab208878, with the credit-note-only customer): r115 (5) + r112 + r095 + r082 +
  k053 ×2 — 6 files, 56 tests passed.
- `mutations.log`: 14 mutations (M9–M11 re-run once the user belonged to both companies; M14, the
  credit-note-only arm of the activity predicate, added after review round 2).
  Each fails its own test and the "every listed balance is the balance of the statement it opens"
  parity test.
- Browser (`ui.log`, `r115-customer-statements.png`, `r115-statement-run.png`): dev server on the
  disposable fixture, as the tenant's staff user. Both pages list `R112 Statement Customer` as
  Invoiced R 2 500,00 · Paid R 1 000,00 · Credits R 200,00 · Balance R 1 300,00, which equals its
  balance shown on both statement screens in the R-112 browser run (`../R-112/ui.log`,
  `../R-112/ui-round2.log`). This log records only the list tables; parity with the email for every
  listed row is proven by the integration test. The soft-deleted customer (invoice R 250) is not
  listed. No page errors.

- Browser round 2 (`ui-round2.log`, `r115-customer-statements-r2.png`), after the list moved to a
  customer-first query: `R112 Deposit Customer` (a R 500 receipt, no invoice) is listed as
  Invoiced R 0,00 · Paid R 500,00 · Credits R 0,00 · Balance -R 500,00; the statement customer is
  unchanged at R 1 300,00; no page errors.

## Not changed

The list ignores the `as_at_date` its pages send and is always as at today, as it was on master.
It agrees with the detail screen and the batch PDFs, which are also as at today. That is a separate
defect, registered as R-116.
