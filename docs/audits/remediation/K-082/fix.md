# K-082 — fix: days past due measured from the oldest unsettled instalment

**Trigger.** `assessLoan` picked the reference instalment with
`schedule.find((r) => !r.skip && r.date >= asOfDate)` — the NEXT instalment, never in the past. The
`asOf <= scheduled` guard therefore returned 0 on every call, `determineEclStage(0)` returned
stage 1, and stages 2 and 3 were unreachable.

**Before / after.** The reference date is now the OLDEST non-skipped instalment that fell due on or
before `asOfDate` and has no receipt, and the count runs from there to `asOfDate`. The
`paid − scheduled` branch, which measured the lateness of the last payment received, is gone. Stage
thresholds are untouched.

**Settlement comes only from `loan_payments`.** That table is the receipt subledger, UNIQUE on
`(company_id, loan_id, period_number)`.

**Files.** `loanComplianceService.ts`, new `loanArrearsService.ts`.

**Tests.** `tests/unit/services/loans/loanCompliance-k082-dpd-future-instalment.test.ts` —
11 passed. `tests/integration/k082-loan-arrears-staging.int.test.ts` — 5 passed on real
PostgreSQL, including a tenant whose period journals are all posted and who has paid nothing.

**Mutation proof.** Restoring the `>= asOfDate` find: unit 5 failed, integration 2 failed.
Reinstating the `loan_gl_postings` fallback as settlement evidence (H1): unit 1 failed,
integration 2 failed.

**Migration.** None.

## Review dispositions

**H1 — fixed, and further than the review proposed.** `loan_gl_postings` is written only by
`postPeriodJournals`, which posts the CONTRACTUAL instalment journal whether or not cash arrived,
dated to the schedule. The review proposed falling back to it when a loan has no `loan_payments`
rows. That fallback reinstates the defect for exactly the case H1 describes: a company posting its
journals on time for a borrower who pays nothing has no receipts, hits the fallback, and reads as
current. There is no fallback. A loan with no receipts captured measures arrears from its oldest
due instalment, which is the honest reading of the data and the conservative direction for a loss
allowance, and the assessment records a `notes` line saying the basis was an absent subledger. Both
the `notes` behaviour and the posted-not-paid tenant are covered by tests.

The review is also right that `K-082/fix.md` and the module docs previously claimed no
instalment-level subledger existed. That was wrong and is corrected here and in `.claude.md`.

**Historical-data impact.** Every assessment ever written understates DPD, stage and ECL. The table
is append-only, so the correction is to re-run assessments after deploy. Re-running will move
exposures into stages 2 and 3 and raise the loss allowance, which changes reported profit.
Expect loans whose receipts were never captured in `loan_payments` to appear in arrears; the
`notes` column marks those, and the remedy is to record the payments. Read-only detection, NOT run
against production:

```sql
SELECT company_id, count(*) AS assessments,
       count(*) FILTER (WHERE days_past_due = 0) AS zero_dpd
FROM loan_compliance_assessments GROUP BY company_id;

SELECT l.company_id, count(*) AS loans_without_receipts
FROM loans l WHERE NOT EXISTS (SELECT 1 FROM loan_payments p
  WHERE p.company_id = l.company_id AND p.loan_id = l.id)
GROUP BY 1;
```

**Limits.** Settlement is per instalment period, so a part-payment recorded against a period
settles that period in full. `loan_payments` has no partial-settlement concept to read.
