# K-083 — fix: a loan period posts its journals once

**Trigger.** `postPeriodJournals` validated the loan, schedule row, NCA flag and period lock and
then posted unconditionally. It never looked for an existing posting, took no row lock, and
`loan_gl_postings` carried no key over (company_id, loan_id, period). A retry after a client
timeout, or a second period-close over a range already closed, doubled the interest expense and
the loan-liability movement.

**Before / after.** Before, two sequential calls for period 1 produced JE-2026-00001 and
JE-2026-00002 and debited interest expense twice. After, the loan row is taken `FOR UPDATE`, which
serialises two concurrent posts, and a `loan_gl_postings` lookup on
`company_id + loan_id + period AND reversal_of IS NULL` refuses the repeat by name. Rows carrying
`reversal_of` are excluded so a legitimate re-post after a reversal still works.

**Files.** `src/modules/accounting/services/loans/loanGlPostingService.ts`,
`scripts/migrations/sql/644_loan_gl_postings_period_once.sql`.

**Tests.** `tests/integration/k083-loan-period-journal-idempotency.int.test.ts` — 4 passed on real
PostgreSQL: the sequential repeat, a second tenant free to post the same period, a reversal row not
blocking a re-post, and two concurrent posts on separate pool clients of which exactly one wins.
`tests/unit/services/loans/loanGlPostingService.test.ts` gained the extra mocked query — 12 passed.

**Mutation proof.** Removing the service lookup gave 1 failed / 3 passed: the exclusion constraint
still keeps the ledger right, but the caller sees an opaque 23P01 instead of the named refusal, and
the test asserts the message. Restored.

**Migration.** `644_loan_gl_postings_period_once.sql`, applied to the fixture database. It is
NOT a plain unique index: `loan_gl_postings` holds one row per journal LINE, so it is a btree_gist
EXCLUDE constraint allowing any number of rows for a period as long as they share one
`journal_entry_id`. Prefix 629 from the register collides with an unmerged forensic branch, hence
644. The migration refuses to install while duplicates exist and names them. Rollback:
`ALTER TABLE loan_gl_postings DROP CONSTRAINT loan_gl_postings_one_journal_per_period;`.

**Historical-data impact.** Any loan period posted twice carries doubled interest expense and a
doubled liability movement. Read-only detection, NOT run against production:

```sql
SELECT company_id, loan_id, period, COUNT(DISTINCT journal_entry_id) AS journals
  FROM loan_gl_postings WHERE reversal_of IS NULL
 GROUP BY 1,2,3 HAVING COUNT(DISTINCT journal_entry_id) > 1;
```

The extra journals must be reversed before the migration will apply.

**Limits.** With the constraint dropped the four tests still pass, because `FOR UPDATE` plus the
lookup already serialises the paths that go through this service. The constraint is a structural
backstop for any future writer that does not take the lock, not something a test can distinguish.
