# K-048 / K-049 fix — recurring journal: due date, idempotency, tenant, refusal-vs-failure

**Trigger.** `POST /api/accounting/recurring-journals-action` with `{action:'generate'}`. Operator-driven; nothing schedules it.

**Before.** `generateJournalFromRecurring` read the template with a plain SELECT, checked only `status='active'`, and posted. `next_run_date` was read solely to compute the next one, so a template scheduled a year out posted on demand. Nothing was keyed, so every repeat minted another posted journal and advanced the schedule again. The advancing UPDATE carried no `company_id`. The journal was dated `new Date()`. The route mapped every throw to 400, and `withAuth` COMMITs anything below 500 — so a refusal committed the half-written journal it said had failed.

**After.** Four guards, all before the first write: the run is due (`(NOW() AT TIME ZONE 'Africa/Johannesburg')::DATE`, not UTC `CURRENT_DATE`, which refuses a due run for the first two hours of the SAST day); the fiscal period for the run date exists and is open; the template's own lines balance and reference accounts that exist and are active; then the run is claimed with `UPDATE ... WHERE company_id AND status='active' AND next_run_date=<due>`. The template is read `FOR UPDATE` under a 5s `lock_timeout`, in its own savepoint — a 55P03 aborts the whole transaction, so catching it without one left an aborted tx answering the next statement with a bare 25P02, and `SET LOCAL` is transaction-scoped so leaving it set capped `postJournalEntry`'s own locks. Contention gets `RecurringJournalLockTimeoutError` and a 409, the one refusal worth retrying; every other refusal is 400; anything else is rethrown as a 500 so `withAuth` ROLLBACKs. The entry is dated at `next_run_date`.

**Request-only.** The function throws outside a request transaction. `withTransaction` joins the ALS client `withAuth` opened; outside one it takes its own pooled connection for the claim while `createJournalEntry` takes others that autocommit, so a posting failure would roll the claim back and leave an orphan draft entry committed in the GL — worse than the defect. A cron path needs a `tx` threaded through the posting services first.

**Files.** `src/modules/accounting/services/gl/recurringJournalService.ts` (223), `recurringJournalGuards.ts` (162, new), `pages/api/accounting/recurring-journals-action.ts` (71), the module `.claude.md` / `AGENTS.md`.

**Tests.** Real Postgres, 16 passed across four files: `k048-recurring-journal-no-due-date-no-lock.int.test.ts` (2, validator's RED), `k048-k049-recurring-journal-adjacent.int.test.ts` (12), `k049-recurring-journal-400-commits-draft.int.test.ts` (1, validator's RED), `k049-recurring-journal-post-write-failure.int.test.ts` (1, new). Adjacent cases: concurrent generation, wrong tenant, overdue run posting into its own period balanced 1000/1000, deactivated account, unbalanced template, deleted account, malformed action, end_date completion, contention, the SAST date boundary, and the outside-a-request refusal.

**Mutation.** Nine of ten reverts go RED (green.log). The claim predicate alone stays green: on the request path the row lock serialises the second caller so the due-date guard refuses it first. The claim remains as the second line of defence and is what would carry a caller that ever reached this without the lock.

**Migration.** None.

**Historical data.** Duplicate or early recurring journals are only visible by count. Read-only census (not run — production must not be queried from here):

```sql
SELECT rj.id, rj.company_id, rj.template_name, rj.run_count, COUNT(je.id) AS posted_journals
FROM recurring_journals rj
LEFT JOIN gl_journal_entries je
  ON je.company_id = rj.company_id AND je.source = 'auto_recurring'
 AND je.description = COALESCE(rj.description, rj.template_name)
GROUP BY rj.id, rj.company_id, rj.template_name, rj.run_count
HAVING COUNT(je.id) <> rj.run_count OR COUNT(je.id) > 1;
```

Journals of one template sharing an `entry_date` are same-day double-posts. Nothing is corrected automatically.

**Limits.** `advanceDate` overflows a month-end template (Jan 31 + 1 month = Mar 3, skipping February), which the claim now pins into the GL entry date; pre-existing, follow-up ticket, not fixed here. An operator who used `generate` to fire a template early now gets a 400 naming the due date; the remedy is in the message.
