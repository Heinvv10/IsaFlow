# K-048 — recurring journal generation has no idempotency, lock or due-date check

**Claim.** The template is read unlocked and the journal posted unconditionally, with no test that
`next_run_date` has arrived.

**Disposition: confirmed.**

## Evidence (baseline origin/master `0f16391e`)

`git show origin/master:src/modules/accounting/services/gl/recurringJournalService.ts`,
`generateJournalFromRecurring` (lines 77-108):

- `SELECT * FROM recurring_journals WHERE id = ... AND company_id = ...` — no `FOR UPDATE`.
- The only guard is `if (rj.status !== 'active') throw`. `next_run_date` is read solely to compute
  the next one; it is never compared to `CURRENT_DATE`.
- No idempotency key. `createJournalEntry` mints a fresh `JE-YYYY-NNNNN` per call, so a repeat
  collides with nothing.
- The advancing UPDATE at the end is `WHERE id = ${id}` with **no `company_id`** predicate,
  against the repo's multi-tenant rule.

## Reachability

`POST /api/accounting/recurring-journals-action` with `{action:'generate'}`, admin or any
`withWriteAccess` role. Nothing schedules this — it is operator-driven, which is exactly why an
operator can fire it early or twice.

## RED test

`tests/integration/k048-recurring-journal-no-due-date-no-lock.int.test.ts` — 2 failed, 0 passed
(`docs/audits/remediation/K-048/red.log`).

1. A template with `next_run_date` a year away posts a journal instead of refusing.
2. Two sequential calls post two journals (`expected 2 to be 1`) and advance the schedule twice.

The run log also shows both journals taking entry number `JE-2026-00001` — the known JE-numbering
collision, not part of this finding.

## Proposed minimal fix

In `generateJournalFromRecurring`:
1. `SELECT ... FOR UPDATE` (the route runs inside withAuth's transaction, so the lock holds).
2. Refuse when `next_run_date > CURRENT_DATE`, with the date in the message.
3. Add `AND company_id = ${companyId}` to the advancing UPDATE.
4. Post the journal dated at `next_run_date`, not `new Date()`, so the journal lands in the period
   it was scheduled for (same correction already made for depreciation).

## Historical-data impact

Duplicate or early recurring journals are indistinguishable from intended ones except by count.
Read-only census:

```sql
SELECT rj.id, rj.company_id, rj.template_name, rj.run_count,
       COUNT(je.id) AS posted_journals
FROM recurring_journals rj
LEFT JOIN gl_journal_entries je
  ON je.company_id = rj.company_id AND je.source = 'auto_recurring'
 AND je.description = COALESCE(rj.description, rj.template_name)
GROUP BY rj.id, rj.company_id, rj.template_name, rj.run_count
HAVING COUNT(je.id) <> rj.run_count OR COUNT(je.id) > 1;
```

Any template whose journals share an `entry_date` is a same-day double-post.

## Risks

Adding the due-date refusal turns a previously-succeeding operator action into an error. That is the
point, but it should carry the date in the message and an explicit "run it early" path if operators
rely on one.
