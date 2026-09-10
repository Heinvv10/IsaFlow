# K-082 — IFRS 9 days past due is measured against a future instalment

**Claim.** `computeDaysPastDue` compares against the next due date, so DPD is always zero and every
exposure stays stage 1.

**Corrected trigger.** The defect is in the caller, not the function. `assessLoan` picks the
reference date as `schedule.find((r) => !r.skip && r.date >= asOfDate)` — the next instalment, on
or after the assessment date. That date is by construction not in the past, so
`computeDaysPastDue`'s `asOf <= scheduled` guard returns 0 on every call. `determineEclStage(0)`
returns stage 1, so every exposure is stage 1 and every loss allowance is the 12-month ECL,
regardless of how long the borrower has been in arrears. Stages 2 and 3 are unreachable through
this path.

Arrears run in the opposite direction: the reference date must be the OLDEST instalment that fell
due on or before the assessment date and remains unsettled, and the count runs from that date
forward to the assessment date. The payment branch of `computeDaysPastDue` is separately wrong —
it measures `paid − scheduled`, the lateness of the last payment received, rather than how long the
oldest unpaid instalment has been outstanding.

**Disposition: confirmed.**

**Evidence** (`git show origin/master:<path>`; unchanged since 5661d6f0):
- `src/modules/accounting/services/loans/loanComplianceService.ts:282` — the `>= asOfDate` find.
- `:111-128` `computeDaysPastDue`; `:116` the null-reference early return, `:125-127` the guard
  that makes a future reference date return 0.
- `:76-80` `determineEclStage` — 0 days is stage 1.
- `:284-292` the stage feeds `computeEclAmount`, so the loss allowance is understated too.
- The RED test shows `computeDaysPastDue` returns a correct 122 days when handed the right
  reference date, which isolates the defect to the caller's selection.

**Reachability.** `assessLoan` is the only producer of `loan_compliance_assessments` rows. Every
assessment ever recorded carries `days_past_due = 0` and `ifrs9_stage = 1` unless a posting exists
dated after the next instalment.

**Proposed minimal fix.** In `assessLoan`, select the oldest unsettled instalment on or before
`asOfDate` instead of the next one, and settle it against posted payments rather than assuming
each scheduled row was paid. In `computeDaysPastDue`, count from that date to `asOfDate` and drop
the `paid − scheduled` branch, which answers a different question. The stage thresholds at `:76-80`
are already correct.

**Historical-data impact.** Every row in `loan_compliance_assessments` understates DPD, stage and
ECL. Read-only impact query:

```sql
SELECT company_id, count(*) AS assessments,
       count(*) FILTER (WHERE ifrs9_stage = 1) AS stage_1,
       count(*) FILTER (WHERE days_past_due = 0) AS zero_dpd,
       max(assessment_date) AS latest
FROM loan_compliance_assessments
GROUP BY company_id;
```

If `zero_dpd` equals `assessments`, no assessment has ever detected arrears. Assessments are
append-only, so the correction is to re-run them after the fix rather than to edit rows. NOT run
against production.

**Risks.** Correcting this moves exposures into stages 2 and 3 and raises the loss allowance, which
changes reported profit. If any assessment has fed an issued AFS, the restatement is an accounting
decision. The fix also needs a real definition of "settled" for an instalment; `loan_gl_postings`
records a posting date but the service currently reads only `MAX(posting_date)`, which cannot tell
which instalments a payment covered.
