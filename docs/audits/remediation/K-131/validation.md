# K-131 — supplier statement joins the dead allocation table

**Claim.** `supplierStatementService.ts:130` joins a table no writer populates, so
allocations never appear.

**Corrected trigger.** The payment query is
`COALESCE(SUM(spa.amount_allocated), sp.total_amount) AS amount_allocated` over
`LEFT JOIN supplier_payment_allocations spa`. Migration 201's
`supplier_payment_allocations` is recorded by this repo's own module docs
(`src/modules/accounting/services/ap/.claude.md:46`) as holding zero rows in dev AND
production and being read by nothing; every AP service writes `payment_allocations`.
So the SUM is always NULL and the COALESCE always falls through to `sp.total_amount`.

That fallback is why the defect is currently invisible rather than absent, and the
correction to the claim matters: the numbers on today's statements are NOT wrong, and
an allocation recorded in the live table is simply ignored (verified — that assertion
passes). What the join actually is, is a live trap. One row written to the dead table
silently replaces the cash amount with the allocated one, on a report sent to
suppliers. This is the "a fix activates a dormant defect" shape.

**Disposition: confirmed (latent, not currently mis-stating).**

**Evidence.**
- `git show origin/master:src/modules/accounting/services/ap/supplierStatementService.ts:126-138`.
- `.../ap/.claude.md:46`, `.../ap/supplierAllocationLines.ts:14`,
  `.../core/paymentLock.ts:109` — three independent statements that the table is dead.
- Executed RED test: a single stray row of `amount_allocated = 1` against a
  `total_amount = 600` processed payment makes the statement report R1.

**Reachability.** The statement itself is reachable by every tenant. The trap needs a
writer to the dead table; `pages/api/accounting/supplier-allocations.ts` used to be
one, so a restore or a revert re-arms it.

**RED test.** `tests/integration/k130-k131-supplier-statement.int.test.ts`
(3 tests, 2 failed — one of the two is K-130; the "real allocation reaches the
statement" case passes today by coincidence of the fallback) — output in `red.log`.

**Proposed minimal fix.** Delete the join, the GROUP BY and the COALESCE, and select
`sp.total_amount AS amount_allocated`. Cash paid to the supplier is the right figure
for a statement, and it is what the code already returns. Three lines removed.

**Historical-data impact.** None. `SELECT COUNT(*) FROM supplier_payment_allocations`
is the check; it is 0 in dev and prod per the module docs (NOT re-run here —
production out of scope).

**Risks.** None. The fix removes a branch that has never executed.
