# K-038 — fix

**Trigger.** `POST /api/admin/migration/sage-commit`. The mappers compute
`amountPaid = Total - AmountDue`, but `MappedARInvoice`/`MappedAPInvoice` declared no such
field and neither commit wrote it.

**Before / after.** A part-paid Sage invoice (R1,150 total, R650 settled) landed with
`amount_paid = 0`, `balance = 1150` (GENERATED) and `status = 'approved'`, overstating aging
and the customer/supplier balance. Now both commits carry the figure: `settledAtSource()`
clamps it to `[0, totalAmount]` so a Sage credit or overpayment cannot drive `balance`
negative; AR writes `amount_paid` in the INSERT, AP in the existing post-commit UPDATE; both
then call the canonical `recomputeInvoiceStatus` for `paid`/`partially_paid`, `paid_at` and
AP's `payment_matched`. The GL journal is unchanged — full invoice total, still balanced.

**Where the already-paid cash sits.** Not represented in the ledger, and this fix invents no
settlement journal. `CommitPayload.pulled` has NO opening-balance step (accounts, customers,
suppliers, AR, AP, bank transactions only); the paid cash arrives solely as
`bank_transactions` at `status='imported'` — unallocated, no GL leg. So the subledger is now
right and the control account is not. **R-001 stays open.**

**Files.** `src/modules/admin/services/sageMigrationTypes.ts`, `…/sageMigrationCommitService.ts`.

**Tests (9 passed, real Postgres).** Validator's RED
`tests/integration/k-038-sage-migration-discards-amount-paid.int.test.ts` (1) plus
`…/k-038-sage-migration-payment-balances-adjacent.int.test.ts` (8: AR fully paid / unpaid /
overpaid-clamped / second tenant untouched / re-run idempotent; AP part-paid with a balanced
full-total journal / fully paid / unpaid). Mutation check: reverting the two source files
takes 6 of 9 red. Full unit suite 9391 passed; `tsc --noEmit` and `eslint` exit 0 — `green.log`.

**Migration / rollback.** None. Code-only; revert the two files.

**Historical impact.** Every invoice already imported this way has `amount_paid = 0`. Sage's
`AmountDue` is stored nowhere in IsaFlow, so no query measures the error; an exact figure needs
a re-pull from Sage per company. Upper bound only (genuinely unpaid invoices look identical),
not run against production:
```sql
SELECT company_id, count(*) AS invoices, sum(total_amount) AS overstated_upper_bound
FROM customer_invoices WHERE amount_paid = 0 AND status = 'approved'
GROUP BY company_id ORDER BY 3 DESC;
```

**Limits.** Only the two Sage commit paths. No back-fill. `migrationApService.importAPInvoices`
(the CSV wizard) already handled `amountPaid` and is untouched.
