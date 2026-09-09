# K-071 fix — savepoint around the post-import auto-post sweep

**Trigger.** `importParsedTransactions` ran the auto-post sweep in a bare `try/catch` that logged
failures as "non-fatal". Inside a request there is no separate connection: `withAuth` holds the
transaction on the ALS-bound client and `withTransaction` puts the batch in a SAVEPOINT on that
same client. A SQL error in the swallowed block aborts the REQUEST transaction, the catch hides it,
the function returns a `batchId` with an empty error list, and the COMMIT that follows is executed
by Postgres as a ROLLBACK. The whole import is silently lost.

**Before / after.** Before: a failing sweep discarded the import and the caller was told it
succeeded. After: the sweep runs inside `withSavepoint('bank_import_autopost', …)`, so its failure
rolls back only its own work, the import survives, and the failure reaches the caller in `errors`
instead of living only in a log line.

**Files.** `src/modules/accounting/services/bank/bankImportService.ts` (savepoint +
`autoPostErrors`); `tests/unit/services/bank/bankImportService.bulk.test.ts` (`withSavepoint`
pass-through mock, 1 new test); `tests/integration/k071-bank-import-best-effort-savepoint.int.test.ts`
(1 test); `tests/integration/k071-bank-import-autopost-adjacent.int.test.ts` (3 adjacent tests —
reported failure, a second company imported in the same request transaction, clean import when the
sweep succeeds).

**Tests.** 4 integration tests on the real PostgreSQL fixture, 1 new unit test, full unit suite
9439 passed. Mutation proof in `green.log`: removing the savepoint turns all 4 red.

**Migration / rollback.** None. Rollback is a straight revert of the service change.

**Historical-data impact.** No corrupt rows: the failure mode was total loss, not a partial write,
so affected imports left nothing behind and are invisible in the data. Detection is a log grep, not
SQL — `journalctl -u isaflow --since '30 days ago' | grep 'auto-post sweep failed after parsed
import'` — then check each logged `batchId` against `bank_import_batches`; one that appears in the
log but not the table is a lost import.

**Limits.** The savepoint changes today's accidental all-or-nothing outcome: a sweep failure now
leaves the transactions imported but unposted, which is what the new error message says.

---

## Round 2 — blind-review finding LOW-3

`withSavepoint` rethrows after marking the context when its own `ROLLBACK TO SAVEPOINT`
fails, and the sweep's catch swallowed that too — the request transaction is genuinely
aborted in that case, so a warning row would have handed back the clean-looking import
this fix exists to remove. The catch now calls `assertTxUsable()` first, which rethrows
naming the original cause. Test:
`tests/integration/k071-bank-import-autopost-adjacent.int.test.ts` — the sweep releases
its own savepoint before throwing, so the rollback really fails; deleting the
`assertTxUsable()` call turns it red. The other five findings in that review are
K-074's; their dispositions are in `../K-074/fix.md`.

---

## Round 3

No K-071 findings in the round-3 review. The import-side code is unchanged since
`4c857048`; the four findings were all K-074's and their dispositions are in
`../K-074/fix.md`.

---

## Round 4 — every finding of `review-k071-r3.md` (0 HIGH · 3 MEDIUM · 3 LOW)

Two are K-071's (LOW-1, LOW-3); the rest belong to K-074's arm and are cross-referenced
here because the review covered both in one pass. Full dispositions for M1–M3 and LOW-2
are in `../K-074/fix.md`; evidence for all six is in `green.log` under ROUND 4.

| Finding | Disposition |
|---|---|
| MEDIUM-1 — pre-write refusals answered 500 | **Fixed.** Lock timeout → 409 with the retry wording, `BankAllocationRefusal` → 400; everything after the first write keeps its 500. The false comment is rewritten. Proved with two interleaved pool clients on the real fixture, not from reading the code. |
| MEDIUM-2 — any failure of the validator became a 400 | **Fixed.** `SupplierPaymentRefusal` is thrown for a refusal and nothing else; anything else is re-thrown to the route's 500 branch. |
| MEDIUM-3 — the "no journal" assertion could never fail | **Fixed.** Replaced with an AP-line count taken before and after; a probe confirmed the count moves when a journal really is posted. |
| LOW-1 — module doc over the 50-line limit | **Fixed.** `src/modules/accounting/services/bank/.claude.md` is 44 lines, down from 86 — and one rule the compaction had dropped (`getCashBalance`'s `{ exclusive: true }` opening-balance semantics, and why the option exists rather than the caller subtracting a day) is restored. Every other rule in the 86-line version was checked against the 44-line one, bullet by bullet: the losses are PRD tags, file extensions, consumer lists and evidence pointers, not rules. |
| LOW-2 — two copies of the over-payment threshold | **Fixed.** `buildLine` now carries a comment naming the outer guard, why the outer one must fire first (a 4xx after a write COMMITs), and that both move together. |
| LOW-3 — fixed savepoint name | **Fixed.** `bank_import_autopost_${seq}`, the `with_tx_${seq}` idiom `neon.ts` already uses. A duplicate SAVEPOINT name shadows rather than errors, so the adjacent test now asserts two imports in one request open two distinct names — and the test that destroys the savepoint captures the live name instead of hardcoding one, which is how it had silently stopped destroying anything. |

**Tests added this round.** `tests/unit/api/bankMatchConfirmRefusalStatus.test.ts` (4 — 409, 400,
the surviving 500, and classification by `code` across a module realm);
`tests/unit/services/bank/confirmSupplierMatch.test.ts` (+2 — an infrastructure failure is
re-thrown, a refusal raised deeper is still a refusal);
`tests/integration/k074-bank-match-confirm-adjacent.int.test.ts` (+1 — two real clients, the
holder keeps the row's `FOR UPDATE` while the route runs);
`tests/integration/k071-bank-import-autopost-adjacent.int.test.ts` (savepoint-name uniqueness).

**Migration.** None, this round or any other.

**Historical-data impact.** None added. The status-code changes alter what a caller is TOLD;
no path that wrote before now writes, and no path that wrote now refuses. The 4xx branches are
safe only because nothing was written — asserted directly (`committed === true` with the row
still `imported` and no `supplier_payments`), not argued.

---

## Round 5 (blind review `review-k071-r4.md`: 0 HIGH, 2 MEDIUM, 4 LOW)

Every finding is dispositioned below; evidence is in `green.log` under ROUND 5.

| Finding | Disposition |
|---|---|
| MEDIUM-1 — the customer branch is the unfixed mirror of the supplier HIGH | **Fixed, not documented away.** `src/modules/accounting/services/bank/confirmCustomerMatch.ts` routes the arm through `confirmReceiptMatch`, so the settlement writes `customer_payments` + `customer_payment_allocations` and `amount_paid` moves RELATIVELY in SQL. Proved on the fixture: `unwindBankAllocationApplication` now reports `invoicesReopened: 1` and returns `amount_paid` to 0 with `paid_at` NULL. Mutation-proved by restoring the old pair (allocate + absolute UPDATE) — 4 of the 10 integration cases go red, including the reversal one. |
| MEDIUM-2 — the doc compaction dropped rules and `fix.md` said it did not | **Fixed; the round-4 claim was wrong and is withdrawn.** All seven named rules are back, compressed into the existing bullets: attachment ordering (no `company_id` on that table), LIVE batch counts, WHY `getBankTransactionStatus` exists, `findBankTransactionAllocationStates` reading BOTH columns, `recordAllocationBatchLines` / `getAllocationBatchLines`, cancel's `dry_run` + posted-adjustment block, `bankTxRefCandidateQuery` exported UNRUN. Plus the three smaller drops: `bankGlAccountBelongsToCompany`, `reversalOfId`, `deactivatedWithBalance`. |
| LOW-1 — 44 lines met by count, not by content | **Partly disputed, with the measurement.** The premise is wrong: at `abf06bc6b` the longest bullet was **830 chars**, not >1,000, and the file was **14,185 bytes** against the 86-line version's **52,636** — a 73% reduction, not "comparable". The underlying point is fair, so after ADDING the seven rules back the longest bullet is 893 chars (45 lines, 16.4 KB). Not trimmed further: cutting prose to hit a character target is what dropped the rules in the first place. |
| LOW-2 — the "deeper in the plan" unit test tested nothing | **Fixed.** `validateBankSupplierPayment` now runs `planSupplierAllocationLines` FOR REAL (only its DB read is stubbed) against a cancelled bill, so `buildLine` is what throws. Mutation-proved: reverting that one refusal to a bare `Error` takes the test red. |
| LOW-3 — `apiResponse.conflict` exists and was not used | **Fixed.** `apiResponse.conflict(res, err.message)`; the now-unused `ErrorCode` import is gone. |
| LOW-4 — `splitAllocateTransaction` kept bare `Error`s | **Fixed.** Both of its pre-write refusals throw `BankAllocationRefusal`, like `allocateTransaction`'s. `BankAllocationRefusal extends Error`, and its only caller (`bank-transactions-action`) does not classify by type, so no caller behaviour changes. |

**Tests this round.** `tests/integration/k074-bank-match-confirm-customer.int.test.ts` (10, real
DB — settlement + balanced journal, reversal round-trip, partial, over-receipt refused, foreign
tenant, cancelled, fully paid, already-allocated line, 409 with two interleaved clients, response
names the document); `tests/unit/services/bank/confirmCustomerMatch.test.ts` (8);
`bankMatchConfirmRefusalStatus.test.ts` +1 (409 raised through the customer service).

**Migration.** None.

**Historical-data impact.** The customer defect is PRE-EXISTING and its rows are already in
production — `bankAllocationUnwind.ts:43-46` records 40 invoices where dated settlement exceeds
`amount_paid` by R124,960.37. This change stops new ones; it corrects nothing already written.
Read-only impact SQL (production, never run from here):

```sql
-- Customer invoices settled by a bank match with no allocation row behind them.
SELECT ci.id, ci.invoice_number, ci.amount_paid, ci.status
FROM customer_invoices ci
WHERE ci.company_id = $1 AND COALESCE(ci.amount_paid,0) > 0
  AND NOT EXISTS (SELECT 1 FROM customer_payment_allocations cpa WHERE cpa.invoice_id = ci.id);
```
