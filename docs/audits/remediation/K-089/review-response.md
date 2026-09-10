# K-015 / K-089 — response to the blind review of 7f17996c + 4420634a

All 11 findings are addressed in the follow-up commit. Nothing was deferred.

## HIGH

**H1 — paid amounts left the control account disagreeing with the subledger.**
Accepted, including the point that the first commit is what made a dormant defect reachable.
Both services now post a second, balanced journal for the already-settled portion: AP
`DR payable / CR opening balance equity`, AR `DR opening balance equity / CR receivable`.
The contra is the opening-balance-equity clearing account, not bank: the payment happened
before the cutover and the bank's own opening balance already carries it; inventing a bank
movement would double the cash. The account is resolved lazily, inside the row, so a company
with no clearing account can still import unpaid invoices. The two control-account assertions
now expect the NET figure and are asserted equal to the invoice's own `balance`, so they read
as correctness rather than as a snapshot of the defect.

**H2 — `ON CONFLICT DO NOTHING` was inert on `supplier_invoices`.** Accepted. Migration 625 adds
`uq_supplier_invoices_company_fingerprint` on `(company_id, duplicate_fingerprint)`, partial on
`duplicate_fingerprint IS NOT NULL AND deleted_at IS NULL`, and the INSERT names that arbiter with
the identical predicate. The migration refuses to run with a named, actionable error if any tenant
already holds duplicate live fingerprints, rather than failing opaquely mid-deploy.
**Deploy ordering: migration 625 must be applied before this code ships.** With the index absent
the INSERT cannot infer its arbiter and every row fails — measured, see green.log.

## MEDIUM

**M1** `steps_completed` now merges (`||`) instead of replacing, so a step no longer erases the
flags of the steps before it. **M2** `errors` now appends and only when the array is non-empty, so
a clean run no longer writes `[]` over earlier steps' errors. Both are in `updateSession`, shared
by every wizard step. **M3** every skip now carries a reason: AR reports the colliding invoice
number, AP reports an already-imported bill. **M4** a row whose `subtotal + tax` does not equal
`totalAmount` is rejected before the INSERT with a message naming all three amounts, instead of
reaching `postJournalEntry` and dying as "Entry not balanced". **M5** `external_system` is now
written alongside `external_ref`, taken from the session's own `source_system`.

## LOW

**L1** a new test drives a failure that happens AFTER the INSERT has succeeded (a company with no
clearing account, importing a part-paid invoice) and asserts that neither the invoice row nor its
journal survives, while the following row still imports. **L2** both routes now validate the body
with a Zod schema per row: types, non-negative finite amounts, ISO dates, non-empty names, and a
UUID-shaped session id, with 11 unit tests. **L3** `amountPaid` is declared optional and
normalised once per row, so the three inconsistent readings are gone. **L4** accepted as
pre-existing and out of scope: `auto_migration` journals will show a list/count disagreement on
the JE screen because the count query excludes `source LIKE 'auto_%'` and the list query does not.
Not touched here; it affects every `auto_` source.

## Still open, deliberately

**The opening-balances step and the invoice import double the control accounts.** The reviewer is
right. The wizard's opening-balances step posts the source trial balance verbatim, and that trial
balance normally already contains the AR and AP control totals; importing the invoices then adds
them again. The settlement leg fixes the invoice import's own arithmetic but not this. The remedy
is a decision about what the wizard asks for — a trial balance excluding the control accounts, or
an import that posts only to a suspense account — and it changes the operator-facing contract of
a step this branch does not otherwise touch. Flagged for Hein rather than chosen here.

**AR references are stored but not displayed.** `customer_invoices.external_ref` still has no
reader: no route, service or page selects it, so an AR reference is visible only in the database,
while the AP equivalent shows through `supplier_invoices.reference`. Surfacing it is a UI change
outside this fix.
