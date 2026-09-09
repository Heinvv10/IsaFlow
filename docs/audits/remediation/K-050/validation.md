# K-050 — close readiness compares a current sub-ledger to an as-at GL

**Claim.** The GL side is point-in-time but the sub-ledger side uses current status and outstanding,
so later payments create phantom variances.

**Disposition: confirmed.**

## Evidence (baseline origin/master `0f16391e`)

`git show origin/master:src/modules/accounting/services/gl/closeReadinessChecks/arSubLedgerCheck.ts`:

- GL side (lines 45-56): `AND je.entry_date <= ${period.endDate}::date` — bounded as at period end.
- Sub-ledger side (lines 33-40): `ci.status IN ('approved','sent','partially_paid','overdue')` and
  `SUM(ci.total_amount - COALESCE(ci.amount_paid, 0))`. Both columns are CURRENT values. Only
  `ci.invoice_date <= endDate` is as-at.

An invoice raised inside the period and settled after it therefore leaves the sub-ledger sum
entirely (its status becomes `paid`) while its GL debit is still inside the as-at window and the
settling credit is not.

`apSubLedgerCheck.ts:34-56` has the identical shape (`si.status`, `si.balance` current;
`je.entry_date <= endDate` as-at), so the same defect applies to AP.

## Reachability

`periodCloseReadinessService` runs both checks for any period, including closed historical ones —
which is precisely when the sub-ledger has moved on. `SUB_LEDGER_FAIL_THRESHOLD = 100`, so any
settlement above R100 escalates the item to `fail`.

## RED test

`tests/integration/k050-close-readiness-as-at-subledger.int.test.ts` — 1 failed
(`expected 'fail' to be 'pass'`). Invoice R1,000 dated 2026-03-15, receipt dated 2026-04-15;
close readiness for the March period reports a R1,000 variance where both sides are R1,000.

## Proposed minimal fix

Rewind the sub-ledger side to the same instant the GL side uses, with the helper that already
exists for this: `src/modules/accounting/services/shared/agingRewind.ts` (`rewindAmount`,
`effectivePaidExpr`), built for exactly this problem on the aging reports. In both checks:

- select on `invoice_date <= endDate` only (drop the current-`status` predicate, which is a proxy
  for "still outstanding today");
- replace `COALESCE(amount_paid,0)` with the rewound effective paid amount as at `endDate`.

## Historical-data impact

No stored data is wrong. The output of every close-readiness run over a past period is wrong, in one
direction: it overstates the AR/AP variance by the settlement that happened after period end. Any
close blocked or re-opened on that reading was blocked on a phantom. Read-only check of how much is
at stake for one company and period end:

```sql
SELECT COALESCE(SUM(ci.total_amount - COALESCE(ci.amount_paid,0)),0) AS current_view,
       COALESCE(SUM(ci.total_amount),0)                              AS gross_at_date
FROM customer_invoices ci
WHERE ci.company_id = $1 AND ci.invoice_date <= $2::date AND ci.status = 'paid';
```

## Risks

`agingRewind` is documented as anchored, not rebuilt: it may understate a past balance where
settlement carries no dated trail. Using it here converts a systematic overstatement of the variance
into a possible small understatement. That is the right trade for a readiness check, but the check's
message should say the sub-ledger side is rewound.
