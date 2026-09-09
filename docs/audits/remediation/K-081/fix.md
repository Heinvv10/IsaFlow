# K-081 — fix: the loan reclass posts the movement, not the whole balance

**Trigger.** `closeLoanPeriod` handed `buildReclassificationInput` the schedule row's whole
`st_liability` every month and nothing reversed the prior month, so after N closes the
current-portion account held the sum of N snapshots.

**Before / after.** Before, February posted its full twelve-month figure on top of January's.
After, the journal carries only `stLiability − priorStLiability`, reversed in direction when the
current portion falls and empty when it is unchanged; the account ends each period at that
period's figure. Both legs are liabilities, so no total moves — only the current / non-current
split. `prior` is this loan's `st_liability` in the most recent locked period before the target
month, restricted to locks taken on or after the loan was created.

**Files.** `src/modules/accounting/services/loans/loanPeriodCloseService.ts`.

**Tests.** `tests/unit/services/loans/loanPeriodClose-k081-reclass-compounds.test.ts` — 5 passed.
`tests/integration/k081-loan-reclass-movement.int.test.ts` — 4 passed on real PostgreSQL: three
consecutive closes, every journal asserted balanced, second tenant untouched.

**Mutation proof.** Reverting `movement` to the full `snapshot.stLiability` gave unit 4 failed /
1 passed and integration 2 failed / 2 passed. Restored.

**Migration.** None.

**Historical-data impact.** Every company that closed two or more periods carries an overstated
current portion and understated non-current balance, by the sum of all but the latest close. The
fix corrects future closes only. Read-only detection, NOT run against production:

```sql
SELECT l.company_id, l.id AS loan_id, count(*) AS closes_posted,
       min(p.posted_period) AS first_period, max(p.posted_period) AS last_period
FROM loan_gl_postings p JOIN loans l ON l.id = p.loan_id AND l.company_id = p.company_id
GROUP BY l.company_id, l.id HAVING count(*) > 1;
```

Correction is one reclassifying journal per loan back to the latest `st_liability`. Restating an
issued balance sheet is an accounting decision.

**Limits.** `prior` comes from the schedule, not from what was posted. A schedule recomputed
between two closes moves the earlier figure with it. Recording the reclassified balance per period
would need a new column, which this defect did not require.
