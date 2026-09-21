# K-015 / K-089 — response to the blind re-review of 46fca787

All five findings addressed.

## R0 (MEDIUM) — the supersede filter deleted every other step's errors when a new error had no step key

Accepted, and the measurement is reproducible. `NOT (e->>'step' IN (… UNION SELECT n->>'step' …))`
puts a NULL in the list when an incoming error omits `step`; `x IN (…, NULL)` is NULL for every
non-matching row, `NOT NULL` is NULL, and the WHERE drops them all — the exact loss the expression
was written to prevent.

Rewritten as `NOT EXISTS` over the same two sources, which has no three-valued-logic hole: a NULL
on either side simply fails to match, so the row is kept. Verified against the reviewer's own case
on the fixture database — existing `[{"step":"suppliers","row":1}]` with new `[{"row":2}]` and no
`stepsCompleted` now returns both. There is a test for exactly that shape, and restoring the
negated IN takes it red.

## R1 (LOW) — three fingerprint writers still had no 23505 handler

The translation moved out of `createSupplierInvoice` into `rethrowDuplicateFingerprint` and
`insertNamingDuplicate`, next to `computeFingerprint` in `captureDeduplicationService`, and the
two exposed paths now use it: `recurringTransactionService` (a second execution of a template in
the same month rebuilds an identical fingerprint) and `sageImportService`. The wrapper only
replaces the message; the error is always rethrown, and the 23505 aborts the transaction either
way. The other two paths were already pre-empted by a duplicate check before the insert, as the
review notes, so they are left alone.

## R2 (LOW) — the AR insert had no missing-arbiter guard

Added, and the helper is now `rethrowIfConflictTargetMissing(err, missingIndex)` so each side
names its own index rather than hard-coding the AP one. The AR test drops
`uq_customer_invoices_company_number` inside the transaction and asserts the run aborts by name
with nothing written; removing the guard takes it red.

## R3 (LOW) — two nits on the settlement path

`resolveSettlementAccountId` now logs the original cause before raising the operator-facing
message, so a transient failure is no longer reported as a missing account. The
`&& settlementAccountId` truthiness guard is replaced by an explicit throw: the leg H1 exists to
guarantee now fails loudly instead of being silently skipped. It remains unreachable — the flag
is derived from the same array — so there is no test for it, by design.

## R4 (LOW) — the AR service was at 284 of 300 lines

`matchContact` and `diceCoefficient` moved to `migrationContactMatch.ts` (36 lines), which is
where they belonged: they are pure, do no tenant scoping of their own, and were already imported
by the AP service. `migrationImportService` is back to 270. The name is re-exported from the old
module so the AP service and the existing unit tests keep working unchanged.

## Still open, unchanged

The opening-balances step and the invoice import double the AR and AP control accounts — the
larger defect, registered for a decision owner rather than chosen here — and
`customer_invoices.external_ref` has no reader. Both in `review-response.md`.

The production pre-flight query for migration 625 is still owed by whoever runs the deploy. It has
not been run from this session, which does not touch the production database.
