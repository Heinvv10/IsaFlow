# K-033 / K-034 — second re-review, all new findings addressed

Review: `scratchpad/review-k033-followup.md` against `c624e4ae` + `b87cf80d`. It confirmed 11 of
the 13 earlier findings resolved; M1 stays open as a dunning decision and L4 (webhook line count)
stays open. One new HIGH, three MEDIUM and five LOW are addressed here.

**N1 (HIGH) — two subscriptions on one mandate were debited twice and the second debit recorded as
a failure.** The guard was widened to `company_id + subscription_id + period`, but the mandate is
per company and `ux_sub_charges_mandate_period_settled` allowed only one settled charge per
(mandate, period). Both cards were debited, the second settlement raised 23505 inside the try that
wraps the Paystack call, and the charge was written `failed` and retried — money taken, not
recorded. Migration 624 now replaces that index with
`ux_sub_charges_subscription_period_settled` on
`(mandate_id, COALESCE(subscription_id, '000…0'::uuid), period_start, period_end) WHERE status =
'settled'`, so uniqueness is per subscription and per period. Rows predating 624 collapse onto the
mandate through the COALESCE, keeping exactly the protection they had. The guard stays
subscription-scoped, and the two now agree.

**N2 (MEDIUM) — a debt for a period already granted was written off on cancellation.**
`voidChargesForCancellingSubscriptions` only voids charges whose `period_start` is at or after the
boundary the subscription has been granted to. A charge covering service the customer already had
is left to collect.

**N3 (MEDIUM) — a charge stuck in `submitted` deferred the close-out forever.** New
`src/modules/billing/services/subscriptionChargeVerify.ts`: after `STALE_SUBMITTED_HOURS` (24) with
no webhook, `resolveStaleSubmittedCharges` asks Paystack `verifyTransaction` what happened and
settles or fails the charge. The cron calls it first each run, before generation, so an unanswered
submission cannot block a period or a cancellation.

**N4 (MEDIUM) — the backfill skipped multi-subscription companies silently.** Migration 624 now
ends with a `DO` block that RAISEs a NOTICE counting the live charges it could not attribute. The
pre-deploy count to run and attribute by hand (superseded in round 4: the migration now refuses on
**every** unattributed row, whatever its status — see `review-fixes-round4.md` and the runbook in
`fix.md`):
```sql
SELECT count(*) FROM subscription_charges WHERE subscription_id IS NULL;
```
Unattributed charges advance no period and flag nothing, which is the safe failure, not a silent
wrong write.

**L-a** the stale Stitch paragraph in `src/modules/billing/.claude.md` is replaced: recurring
debits run through Paystack and that branch is live. **L-b** `GenerateResult` gains `voided`, so
cancelling a customer's pending debit is visible in the cron log. **L-c** four route-level cases in
`tests/unit/api/admin-subscription-cancel-at-period-end.test.ts` pin the PATCH contract the company
billing tab depends on. **L-d** decided rather than left accidental: `markPastDueIfExhausted` now
covers `trial` as well as `active`. The due query never bills a trial, so the only way one holds a
failed charge is an admin moving it to trial after the charge was raised — still an unpaid period.
**L-e** the webhook is 325 lines, still over the 300 cap it exceeded on master at 329; cutting it
under means refactoring branches this work does not touch.

**Still open, by decision:** M1 (no dunning after three declines — needs a product decision, the
team lead is registering it) and L4/L-e (webhook line count).

**Mutation evidence** (`green-review-fixes-round3.log`): seven mutations, one per fix, each takes
exactly the matching test red — the pre-624 index, the void period predicate, the stale resolver
(both the loop and the wait window), the voided count, and the trial status.
