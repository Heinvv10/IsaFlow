# K-021 — a failed bank reversal no longer commits the subledger unwind

**Trigger.** `reverseReconciledTransaction` unwinds the payment (invoice `amount_paid` and status, payment cancelled, allocation rows DELETEd) and only then posts the contra. `resolveReversalDate` falls back to TODAY when the original period is closed and never checks today's period, so with today closed `postJournalEntry` throws after the unwind has written; the route answers 400 and `withAuth` COMMITs everything below 500.

**After.** (1) `assertReversalDatePostable` resolves the date the contra will carry and refuses before the first write when its period is closed or absent. (2) Unwind + contra + bank-line reset run inside one `withSavepoint('bank_reverse_reconciled')`, so a failure the pre-flight cannot see (an already-reversed original) rolls the whole group back. Successful reversals are unchanged. Every caller loops sequentially, so two savepoints of this name are never open at once.

**Files.** `src/modules/accounting/services/bank/bankAllocationService.ts`. Three existing unit tests had their `@/lib/neon` / journal-service mocks extended for `withSavepoint`, `resolveReversalDate`, `getPeriodStatusForDate`.

**Tests.** `tests/integration/k021-failed-reversal-commits-unwind.int.test.ts` (validator's RED, 1) + `tests/integration/k021-reversal-atomicity.int.test.ts` (5: savepoint rollback, successful reversal with a balanced contra agreeing with the reopened invoice, retry, wrong tenant, pre-flight refusal message). 6 pass on the fixture DB; unit suite 9320 passed / 234 skipped via `bun run test:unit`; `tsc --noEmit` clean; `bun run lint` 0 errors. Under `bunx vitest run` 10 tests across 5 files fail, an identical set on unmodified origin/master and green in isolation: pre-existing suite-isolation flakiness, see `green.log`. Mutation (`green.log`): pre-flight removed reds the message test, savepoint removed reds the rollback test, both removed reds three including the original RED.

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

**Limits.** `resolveReversalDate`'s unchecked today-fallback is untouched, so other direct callers of `reverseJournalEntry` (`paymentVoidService`, the MCP journal tools) still learn of a closed current period from `postJournalEntry`. Only the bank path is guarded. Existing corrupted rows are not repaired.
