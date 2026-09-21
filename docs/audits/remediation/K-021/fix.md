# K-021 — a failed bank reversal no longer commits the subledger unwind

**Trigger.** `reverseReconciledTransaction` unwinds the payment (invoice `amount_paid` and status, payment cancelled, allocation rows DELETEd) and only then posts the contra. `resolveReversalDate` falls back to TODAY when the original period is closed and never checks today's period, so with today closed `postJournalEntry` throws after the unwind has written; the route answers 400 and `withAuth` COMMITs everything below 500.

**After.** (1) `assertReversalDatePostable` resolves the date the contra will carry and refuses before the first write when its period is closed or locked. `no_period` is deliberately NOT refused: `createJournalEntry` auto-creates the fiscal year, and refusing would 400 a reversal that used to succeed (blind review M1). (2) Unwind + contra + bank-line reset run inside one `withSavepoint('bank_reverse_reconciled')`, so a failure the pre-flight cannot see (an already-reversed original) rolls the whole group back. Successful reversals are unchanged. Every caller loops sequentially, so two savepoints of this name are never open at once.

**Files.** `src/modules/accounting/services/bank/bankAllocationService.ts`. Three existing unit tests had their `@/lib/neon` / journal-service mocks extended for `withSavepoint`, `resolveReversalDate`, `getPeriodStatusForDate`.

**Tests.** `tests/integration/k021-failed-reversal-commits-unwind.int.test.ts` (validator's RED, 1) + `tests/integration/k021-reversal-atomicity.int.test.ts` (6: savepoint rollback, successful reversal with a balanced contra agreeing with the reopened invoice, retry, wrong tenant, auto-create when no period covers today, pre-flight refusal message). 7 pass on the fixture DB. Mutation (`green.log`): refusing `no_period` reds the auto-create test, removing the pre-flight reds the message test, removing the savepoint reds the rollback test. `tsc --noEmit` clean; `bun run lint` 0 errors; bank + payment-void unit suites 221 and 25 passed. The FULL unit suite is not a stable number on this box — runs vary between 0 and 10 failures, all `Test timed out in 10000ms`, every named file green in isolation, and reproduced on a worktree without this change. Load flakiness; see `green.log`.

**Migration / rollback.** None; revert the commit.

**Historical impact.** Cancelled payments whose journal was never reversed. Read-only, NOT run on production:
```sql
SELECT cp.company_id, cp.id AS payment_id, cp.gl_journal_entry_id, cp.total_amount
FROM customer_payments cp
JOIN gl_journal_entries je ON je.id = cp.gl_journal_entry_id AND je.company_id = cp.company_id
LEFT JOIN gl_journal_entries rev ON rev.reversal_of_id = je.id AND rev.company_id = je.company_id
WHERE cp.status = 'cancelled' AND rev.id IS NULL AND je.reversed_at IS NULL;
-- same query against supplier_payments for the AP mirror
```
Each hit is cash still in the GL against an invoice the subledger reads as unpaid, with the allocation rows that explained it deleted.

**Review round (blind review of 74c6c32c: 0 HIGH, 1 MEDIUM, 7 LOW).** M1 fixed as above with a regression test. L1: the comment now records that the savepoint needs a request transaction and that `lockBankTransactionForUpdate` throws without one. L2: `paymentVoidService` shapes 2 and 3 now own a `withSavepoint('void_payment_unwind')` instead of relying on their single caller's; no behaviour changes today, so no new test — it is reachable only by adding a caller that catches. L3: both fixtures derive their closed period from today, so no February clock can overlap it. L5: the module `.claude.md` carries the new caller contract, mirror regenerated. L6: the refusal says "not open (closed or locked)". L7: the full-suite claim in `green.log` was wrong and is corrected there.

**Limits.** L4 not fixed: `bankAllocationService.ts` is 716 lines against the 300-line ceiling. Pre-existing, and extracting the reversal block would still leave ~600 lines, so it does not resolve the violation and is a refactor this change should not carry. `resolveReversalDate`'s unchecked today-fallback is untouched, so other direct callers of `reverseJournalEntry` still learn of a closed current period from `postJournalEntry`. Existing corrupted rows are not repaired.
