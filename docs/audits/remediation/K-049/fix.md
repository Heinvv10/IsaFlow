# K-049 fix — the recurring-journal route no longer commits what it calls a failure

**Trigger.** Any `generate` on a template whose covering fiscal period is closed — and, as a class, any failure raised after the handler's first write.

**Before.** `pages/api/accounting/recurring-journals-action.ts` wrapped the whole switch in one `try/catch` ending in `apiResponse.badRequestFromError`. `withAuth` ROLLBACKs only when `res.statusCode >= 500`, so a 400 COMMITted whatever the handler had written. `createJournalEntry` INSERTs the entry and its lines; `postJournalEntry` then raised `ClosedFiscalPeriodError`. The caller was told the action failed and a draft `source='auto_recurring'` journal stayed in the books.

**After.** Two independent changes.

1. The service exports `RecurringJournalRequestError` and raises it for the caller faults: not found, not active, not due, closed or absent period, lock timeout. The route answers only that class with a 400 (logged at warn). Everything else is rethrown to `withErrorHandler`, which answers 500, so `withAuth` rolls the request back. This closes the class for all four actions, not just `generate`.
2. `generateJournalFromRecurring` resolves the period with `getPeriodStatusForDate` before any write, matching `validateBankSupplierPayment` and `confirmReceiptMatch`. A closed period is now a 400 with the remedy in it and nothing written, rather than a logged 500 after a write. `no_period` and `closed` get different messages because the remedies differ.

Belt and braces: the claim and both writes run inside one `withTransaction`, so a late failure rolls back even where the route answers 4xx.

**Files.** `pages/api/accounting/recurring-journals-action.ts`, `src/modules/accounting/services/gl/recurringJournalService.ts`.

**Tests.** `tests/integration/k049-recurring-journal-400-commits-draft.int.test.ts` (validator's RED, 1) and `tests/integration/k048-k049-recurring-journal-adjacent.int.test.ts`: a closed period is exactly 400 with no entry and `run_count` unmoved; a fault raised *after* the write (a deactivated GL account, `InactiveAccountError` inside `postJournalEntry`) answers 500 with no entry, no lines and the claim rolled back; a malformed body still answers 400 and writes nothing. Real Postgres, 10 passed across the three files.

**Migration.** None.

**Historical data.** Orphan drafts, read-only census (not run against production):

```sql
SELECT company_id, id, entry_number, entry_date, created_at
FROM gl_journal_entries
WHERE source = 'auto_recurring' AND status = 'draft'
ORDER BY company_id, entry_date;
```

Drafts do not reach the trial balance, so no reported figure is wrong. They are clutter a later bulk-post could turn into real postings. Nothing is deleted automatically.

**Also changed by this, and worth recording:** the class split moved `pause`, `resume` and `cancel` from 400 to **404** for an unknown or cross-tenant id, not just `generate` — `updateRecurringJournalStatus` raises `RecurringJournalNotFoundError`. That is the right answer (no correction of the body makes those succeed) and the page surfaces the message either way, but it is a status-code change on three actions the K-048 note discussed only for `generate`.

**A contended `entry_number` answers 409, not 500** (round-4 MEDIUM 2). Same doctrine as the lock timeout: the request was valid and succeeds on retry, so it must not be told the system broke. Nothing is committed on that 4xx — the action's `withTransaction` savepoint is rolled back by the 23505 before the route answers. See `K-048/fix.md`.

**Limit.** Only this route is changed. The same `badRequestFromError`-around-the-whole-handler shape exists elsewhere and is out of scope here.
