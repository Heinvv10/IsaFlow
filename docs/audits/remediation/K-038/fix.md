# K-038 — fix

**Trigger.** `POST /api/admin/migration/sage-commit`. The mappers compute
`amountPaid = Total - AmountDue`, but `MappedARInvoice`/`MappedAPInvoice` declared no such
field and neither commit wrote it.

**Before / after.** A part-paid Sage invoice (R1,150 total, R650 settled) landed with
`amount_paid = 0`, `balance = 1150` (GENERATED) and `status = 'approved'`, overstating aging,
statements and dunning. Now both commits carry the figure and call the canonical
`recomputeInvoiceStatus` for `paid`/`partially_paid`, `paid_at` and AP's `payment_matched`.
The GL journal is unchanged — full invoice total, still balanced, asserted on both paths.

`settledAtSource()` makes the figure safe for a GENERATED column: a non-finite value (Sage
documents without a numeric `AmountDue` give NaN, and neither the pull nor the commit route
validates the payload) or a negative one is REFUSED and imported as unpaid, because `numeric`
accepts NaN and one such row turns a company's whole sub-ledger sum into NaN. An overpayment
is clamped to the total. Every refusal and clamp is logged and returned in the new
`CommitSummary.warnings`, so a discarded customer credit is visible to the operator.
AP clamps against `created.totalAmount`, not the source total: `createSupplierInvoice`
re-derives its own total from a 2 dp tax rate, so a bill at a non-round blended rate (700 /
33.33) stores 733.32 and anchoring to Sage's 733.33 would store a −0.01 balance.

**R-001 — period close now FAILS on migrated companies, by design.** Before this commit
`arSubLedgerCheck`/`apSubLedgerCheck` passed only because both sides were equally wrong. Now:
part-paid invoices contribute `total − paid` while the GL control account still carries the
full total, and **fully-paid invoices drop out of the sub-ledger sum entirely** —
`arSubLedgerCheck.ts:36` filters to `('approved','sent','partially_paid','overdue')` and
`apSubLedgerCheck.ts:38` to `('approved','partially_paid')`. Both flip to `fail` past the R100
threshold, and `periodCloseReadinessService.ts:106` rolls that up to an overall `fail`.
Direction: GL AR/AP overstated and GL bank understated by exactly the settled amount, so net
assets are unaffected — only the two line items are misallocated. There is no in-repo remedy:
`CommitPayload.pulled` has no opening-balance step and the settled cash arrives only as
`bank_transactions` at `status='imported'` with no GL leg. The fix is an opening-balance step
in `CommitPayload` (or allocating those imported bank rows). **R-001 stays open.**

**Files.** `sageMigrationTypes.ts`, `sageMigrationCommitService.ts`, new
`sageMigrationOrchestrator.ts` (the orchestrator moved verbatim so both files clear the
300-line cap; `sage-commit.ts` and one unit test now import it from there).

**Tests (13 passed, real Postgres).** Validator's RED (1), `…-payment-balances-adjacent` (11:
AR fully paid / unpaid / overpaid-clamped-and-reported / non-finite refused with the company
sum still numeric / negative refused / second tenant untouched / re-run idempotent; AP
part-paid with a balanced full-total journal / non-round blended rate / fully paid / unpaid)
and `…-ar-journal-unmoved` (1, real `postCustomerInvoiceToGL`). Mutation-checked twice:
reverting the original change takes 6 of 9 red; disabling the non-finite guard, the negative
guard and the AP total anchor takes their 3 tests red. Full unit suite 9391 passed;
`tsc --noEmit`, `eslint` and `agent-docs:check` clean — `green.log`.

**Migration / rollback.** None. Code-only.

**Historical impact.** Every invoice already imported this way has `amount_paid = 0`. Sage's
`AmountDue` is stored nowhere in IsaFlow, so no query measures the error; an exact figure needs
a re-pull from Sage per company. The `invoice_number` dupe check makes the commit idempotent,
so **re-running the migration will NOT repair an already-migrated row** — the only repair paths
are manual `UPDATE … SET amount_paid` per invoice or deleting and re-importing. Upper bound
only (genuinely unpaid invoices look identical), not run against production:
```sql
SELECT company_id, count(*) AS invoices, sum(total_amount) AS overstated_upper_bound
FROM customer_invoices WHERE amount_paid = 0 AND status = 'approved'
GROUP BY company_id ORDER BY 3 DESC;
```

**Limits.** `paid_at` on a migrated settlement is the MIGRATION timestamp, not the real
settlement date — `recomputeInvoiceStatus` sets `COALESCE(paid_at, NOW())` and the Sage payload
carries no settlement date, so no better value exists; aging and statement surfaces that date
a settlement will be wrong for migrated rows. Only the two Sage commit paths are touched; no
back-fill. `migrationApService.importAPInvoices` (the CSV wizard) already handled `amountPaid`.
