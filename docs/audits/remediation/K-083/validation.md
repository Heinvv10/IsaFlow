# K-083 — Loan `postPeriodJournals` has no idempotency guard

**Claim.** Re-running a period posts the interest and capital journals again.

**Corrected trigger.** Accurate as written. `postPeriodJournals`
(loanGlPostingService.ts:146-207 on origin/master `31fc2f10`; file unchanged since the audited
`5661d6f0`) validates loan, schedule row, NCA flag and period lock, then posts unconditionally.
It never queries `loan_gl_postings` for an existing (company_id, loan_id, period), takes no row
lock, and the table carries no unique key over that triple — only `loan_gl_postings_pkey(id)`,
`loan_gl_postings_company_loan_idx(company_id, loan_id)` and
`loan_gl_postings_period_idx(company_id, posted_period)` (verified in the fixture schema).

**Disposition: confirmed.**

**Evidence.** RED integration test on real PostgreSQL: two sequential calls for period 1 of the
same loan produced JE-2026-00001 and JE-2026-00002, and interest expense account 8100 was debited
R2 000,00 against a schedule interest of R1 000,00. Log: `red.log`.

**Reachability.** `POST /api/accounting/loans/[id]/gl-postings` (gl-postings.ts:31) and the
period-close run (`period-close.ts:99`), both `withAuth` + write access. A retry after a client
timeout, or a second period-close over a range already closed, is enough.

**RED test.** `tests/integration/k083-loan-period-journal-idempotency.int.test.ts` — 1 failed / 1.

**Proposed minimal fix.** In `postPeriodJournals`, before `createJournalEntry`, SELECT
`loan_gl_postings` for `company_id + loan_id + period AND reversal_of IS NULL` and throw
(or return the existing `journal_entry_id`) when a row exists. Back it with a partial unique
index on `(company_id, loan_id, period) WHERE reversal_of IS NULL` in a new migration so two
concurrent requests cannot both pass the SELECT. Both changes are needed: the SELECT alone loses
the race, the index alone gives an opaque 23505.

**Historical-data impact.** Any loan whose period was posted twice carries doubled interest
expense and a doubled movement on the loan liability. Read-only detection (run against the target
database by the operator, NOT run here):
```sql
SELECT company_id, loan_id, period, COUNT(DISTINCT journal_entry_id) AS journals
  FROM loan_gl_postings WHERE reversal_of IS NULL
 GROUP BY 1,2,3 HAVING COUNT(DISTINCT journal_entry_id) > 1;
```

**Risks.** Reversals legitimately create a second `loan_gl_postings` set; the guard must exclude
rows carrying `reversal_of`, or re-posting after a reversal becomes impossible.
