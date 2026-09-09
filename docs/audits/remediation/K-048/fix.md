# K-048 fix — recurring journal generation: due date, idempotency, tenant, lock

**Trigger.** `POST /api/accounting/recurring-journals-action` with `{action:'generate'}`. Operator-driven; nothing schedules it.

**Before.** `generateJournalFromRecurring` read the template with a plain SELECT, checked only `status='active'`, and posted. `next_run_date` was read solely to compute the next one, so a template scheduled a year out posted on demand. Nothing was keyed, so every repeat minted another posted journal and advanced the schedule another interval. The advancing UPDATE carried no `company_id`. The journal was dated `new Date()`, not the run date.

**After.** In order, all before the first write: refuse when `next_run_date > CURRENT_DATE` (naming the date); refuse a closed or absent fiscal period for that date; then claim the run with `UPDATE ... WHERE company_id = $c AND status = 'active' AND next_run_date = <due> RETURNING id` — 0 rows means another caller took it, so the caller is told the run is already generated. Claim and posting share one `withTransaction`, so a posting failure un-advances the schedule instead of skipping the period. The entry is dated at `next_run_date`. The template SELECT takes `FOR UPDATE` under a 5s `lock_timeout` when a request transaction is in flight.

**Honest limit.** The lock is *not* what makes this idempotent — the claim UPDATE is, and it is atomic with or without a request transaction. Removing `FOR UPDATE` leaves every test green (recorded in green.log). The lock only converts a lost claim into a block on the real request path. Outside a request transaction (a script), `createJournalEntry` writes on pool connections rather than the `withTransaction` client, so the claim/post atomicity holds only inside `withAuth`.

**Files.** `src/modules/accounting/services/gl/recurringJournalService.ts` (248 lines, under the ceiling).

**Tests.** `tests/integration/k048-recurring-journal-no-due-date-no-lock.int.test.ts` (2, validator's RED) and `tests/integration/k048-k049-recurring-journal-adjacent.int.test.ts` (7): two concurrent generations yield exactly one journal and one `run_count`; another tenant is refused and does not advance the template; an overdue run posts into its scheduled period, balanced 1000/1000; the last run before `end_date` completes the template and a further generate is refused. Real Postgres, 10 passed across the three files.

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

**Behaviour change.** An operator who used `generate` to fire a template early now gets a 400 naming the due date. The remedy is in the message: move the next run date.
