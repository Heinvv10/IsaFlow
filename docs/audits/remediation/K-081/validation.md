# K-081 — the loan current-portion reclass is re-posted in full every month

**Claim.** The reclass is posted in full each period with no reversal of the prior one, compounding
the balance-sheet split.

**Corrected trigger.** `buildReclassificationInput` posts DR loan liability / CR current portion for
the whole `st_liability` on the schedule row for the period. `closeLoanPeriod` runs it once per
month, and nothing reverses or nets off the previous month's entry. After N closes the current
portion holds the sum of N monthly snapshots instead of the latest one.

The reclass restates a balance, not a transaction: after closing February the current-portion
account must hold February's twelve-month figure, and only the movement since January belongs in
the journal.

Severity is narrower than "the ledger is wrong". Both legs are liabilities, so the trial balance
still foots and total borrowings are unchanged. The damage is confined to the current /
non-current split on the balance sheet, where the non-current account eventually runs to a debit
balance. It is an AFS presentation error, and it grows with every close.

**Disposition: confirmed.**

**Evidence** (`git show origin/master:<path>`; unchanged since 5661d6f0):
- `src/modules/accounting/services/loans/loanPeriodCloseService.ts:54-66` — the full-amount entry,
  with no prior-period argument in the signature.
- `:159-186` — the per-loan loop; no query anywhere in the file reads a prior reclass, and no
  reversing entry is created.
- `:130-132` the period lock stops the SAME month being closed twice, which is why this is not a
  simple double-post: each month legitimately closes once and adds a fresh full-value entry.

**Reachability.** `pages/api/accounting/loan-periods/[yyyymm]/close.ts:33` → `closeLoanPeriod`.
Any company closing loan periods in two or more consecutive months with a non-zero `st_liability`.

**Proposed minimal fix.** Give `buildReclassificationInput` the amount already reclassified and
post the difference: when `target > prior`, DR liability / CR current portion for `target − prior`;
when `target < prior`, the reverse. Source `prior` from the previous period's reclass — either a
column on `loan_gl_postings` recording the reclassified balance per period, or the current balance
on the current-portion account for that loan. Emit no lines when the movement is zero, which the
`input.lines.length === 0` guard at `:181` already handles.

**Historical-data impact.** Every company that has closed two or more loan periods has an
overstated current portion and an understated non-current balance, by the sum of all but the latest
close. Read-only impact query:

```sql
SELECT l.company_id, l.id AS loan_id, count(*) AS closes_posted,
       min(p.posted_period) AS first_period, max(p.posted_period) AS last_period
FROM loan_gl_postings p
JOIN loans l ON l.id = p.loan_id AND l.company_id = p.company_id
GROUP BY l.company_id, l.id
HAVING count(*) > 1;
```

Correction is a single reclassifying journal per loan bringing the current-portion account back to
the latest period's `st_liability`. It touches presentation only and does not change any total.
NOT run against production.

**Risks.** If any affected period has been locked or reported on, the correcting journal changes
comparatives in an already-issued balance sheet. Restatement is an accounting decision. The fix
itself must also decide what `prior` means for the first close after deployment, or it will post a
spurious catch-up entry.
