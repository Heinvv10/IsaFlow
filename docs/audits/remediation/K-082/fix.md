# K-082 — fix: days past due measured from the oldest unsettled instalment

**Trigger.** `assessLoan` picked the reference instalment with
`schedule.find((r) => !r.skip && r.date >= asOfDate)` — the NEXT instalment, which is never in the
past. `computeDaysPastDue`'s `asOf <= scheduled` guard therefore returned 0 on every call,
`determineEclStage(0)` returned stage 1, and stages 2 and 3 were unreachable.

**Before / after.** Before, every `loan_compliance_assessments` row recorded 0 days past due and
stage 1 whatever the arrears. After, the reference date is the OLDEST non-skipped instalment that
fell due on or before `asOfDate` and is not covered by a posted payment, and the count runs from
that date forward to `asOfDate`. `computeDaysPastDue` no longer measures `paid − scheduled`, the
lateness of the last payment received, which answers a different question and reported 0 for a
borrower who had simply stopped paying. The stage thresholds were already correct and are
unchanged; a borrower 122 days in arrears now stages 3 and carries the lifetime ECL.

**Files.** `src/modules/accounting/services/loans/loanComplianceService.ts`.

**Tests.** `tests/unit/services/loans/loanCompliance-k082-dpd-future-instalment.test.ts` —
8 passed, covering a paid-up loan staying at stage 1, skipped instalments ignored, and a loan with
no payment ever posted. `tests/integration/k082-loan-arrears-staging.int.test.ts` — 3 passed on
real PostgreSQL, including a paid-up borrower in a second tenant.

**Mutation proof.** Restoring the `>= asOfDate` find gave unit 5 failed / 3 passed and integration
2 failed / 1 passed. Restored.

**Migration.** None.

**Historical-data impact.** Every assessment ever written understates DPD, stage and ECL.
Read-only detection, NOT run against production:

```sql
SELECT company_id, count(*) AS assessments,
       count(*) FILTER (WHERE ifrs9_stage = 1) AS stage_1,
       count(*) FILTER (WHERE days_past_due = 0) AS zero_dpd,
       max(assessment_date) AS latest
FROM loan_compliance_assessments GROUP BY company_id;
```

`zero_dpd = assessments` means no assessment ever detected arrears. The table is append-only, so
the correction is to re-run assessments after deploy, not to edit rows. Moving exposures into
stages 2 and 3 raises the loss allowance and changes reported profit.

**Limits.** An instalment counts as settled when a payment posted on or after its due date, which
is the best `loan_gl_postings` supports — it records posting dates, not which instalments a payment
covered. A part-payment therefore settles every instalment up to its date. Allocating payments to
instalments needs a subledger this module does not have.
