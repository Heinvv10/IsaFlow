# K-015 / K-089 — response to the blind re-review of fdcf3522

All six new findings are addressed. Detail below; evidence in `green.log`.

## N1 (HIGH) — the unique index constrained five unrelated AP write paths, and collided across suppliers

Accepted in full, and the diagnosis is right: `computeFingerprint` folds a missing VAT number to
the literal `no-vat`, so the key collapsed to `no-vat|<invoice number>|<total>` and two different
VAT-less suppliers in one tenant collided. Migration 625 is rewritten to key on
`(company_id, supplier_id, duplicate_fingerprint)` with the same partial predicate, and the
INSERT's `ON CONFLICT` target matches it verbatim. `supplier_id` is `NOT NULL` on the table, and
`captureDeduplicationService.findDuplicate` already scopes its exact-match probe by `supplier_id`,
so per-supplier is the identity the rest of the system already means by "duplicate". That shrinks
the blast radius on the other five paths to a genuine same-supplier duplicate.

`createSupplierInvoice` now translates that 23505 into a named error saying which invoice
collided and what to do, rather than surfacing a bare constraint violation. The other four paths
(capture publish, the AI invoice pipeline, the Sage import, recurring transactions) are left to
the constraint: after the supplier scoping, a collision there is a real duplicate for the same
supplier, and converting each one is a change to four features this branch does not otherwise
touch.

Proved on the real database, not by reading: two VAT-less suppliers now hold the same invoice
number and amount, the same supplier twice is refused by the named constraint, and the ordinary
create path returns the named message. Reverting the index to `(company_id, fingerprint)` takes
the first of those red.

## N2 (MEDIUM) — nothing had checked production for the duplicates that abort the deploy

The `RAISE EXCEPTION` now lists the offending `company_id`s instead of counting groups, so the
deploy failure names the tenants to look at. **I did not run the query against production**: this
session is barred from touching the production database, read-only included. Hein or the deploy
operator should run this first, and it is repeated in `fix.md`:

```sql
SELECT company_id, supplier_id, duplicate_fingerprint, COUNT(*)
  FROM supplier_invoices
 WHERE duplicate_fingerprint IS NOT NULL AND deleted_at IS NULL
 GROUP BY 1, 2, 3
HAVING COUNT(*) > 1;
```

Empty result means 625 applies cleanly. Any rows mean the deploy aborts before the rsync, which is
safe but wastes the window.

## N3 (MEDIUM) — without 625 the step answered 200 while importing nothing

Correct, and the distinction between fail-closed data and a fail-closed response was the right
one to draw. The AP import now detects `42P10` on the first row and aborts the whole run with
"database migration 625 has not been applied. No invoices were imported." — so the route returns
an error naming the remedy instead of 200 with `imported: 0` and a raw Postgres message per row.
The guard is AP-only: the AR arbiter is `uq_customer_invoices_company_number`, which has existed
since long before this branch.

## N4 (LOW) — a missing clearing account failed once per part-paid row

The account is now resolved once, before the loop, and only when some row in the file is actually
part-paid. A company without it fails the step with a single message naming the role and the
remedy, and writes nothing. A file of unpaid invoices still imports for a company that has no
clearing account, which is the branch that must not regress.

## N5 (LOW) — index build lock, and the supposedly redundant 412 index

The lock is now called out in the migration header and in `fix.md`: `CREATE UNIQUE INDEX` cannot
run `CONCURRENTLY` inside a migration transaction, so it blocks writes to `supplier_invoices` for
the build and should run out of hours on a large tenant.

**I did not drop `idx_supplier_invoices_duplicate_fp`, and I think dropping it would be wrong.**
It is not a subset of the new index once `supplier_id` is in the key. More decisively,
`findDuplicate`'s probe carries no `deleted_at` predicate, so the planner cannot use an index
partial on `deleted_at IS NULL` to serve it. Dropping 412 would leave that query without an index.
The reasoning is recorded in the migration header.

## N6 (LOW) — errors accumulated across re-runs

`updateSession` now keeps the other steps' errors and replaces the errors of the step being
written, identified by the `steps_completed` key the caller sends and by the steps named in the
new error list. So a re-run reports each row once rather than again, the column does not grow
without bound, and a clean re-run clears what a failed attempt left behind — which a plain append
did not do either.

## The two registered items

Unchanged and still open, deliberately: the opening-balances step and the invoice import double
the AR and AP control accounts, and `customer_invoices.external_ref` has no reader. The reviewer
is right that the first outranks everything fixed here and belongs in the register as its own
finding with a decision owner. It is an operator-contract question about what the wizard asks for,
not a code fix, and it is recorded in `review-response.md` rather than chosen in this branch.
