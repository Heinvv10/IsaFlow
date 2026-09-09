# K-034 fix — a subscription cancelled at period end is not renewed

**Trigger:** `cancelSubscription(id, atPeriodEnd=true)` sets only
`subscriptions.cancel_at_period_end` and leaves `status='active'`. `generateDueCharges()` filtered
on `s.status IN ('active','past_due')` alone, so at period end the cancelled customer was debited
for another period, and nothing anywhere ever moved such a subscription to `'cancelled'`.

**Before:** flag set → period ends → new charge raised → period rolls forward → repeats forever.
**After:** the due query excludes `cancel_at_period_end = true`, so no charge is raised; after the
generation loop a set-based UPDATE closes out every flagged subscription whose period has ended
(`status='cancelled'`, `cancelled_at` stamped, counted under `skipped`). A flagged subscription
whose paid period is still running is left alone until that period ends.
`updateSubscription()` clears `cancel_at_period_end` when the status is set back to `active` or
`trial`, so reactivating a subscription does not leave the cron primed to cancel it again.

**Files**
- `src/modules/billing/services/subscriptionBillingService.ts` — due-query filter + close-out UPDATE.
- `src/modules/admin/services/billingService.ts` — `updateSubscription` resets the flag on reactivation.
- `tests/integration/subscription-cron.lock.ts` — new: advisory lock the two cron suites hold, so
  they do not consume each other's fixtures when vitest runs the files in parallel.

**Tests:** `tests/integration/k-034-cancel-at-period-end-ignored.int.test.ts` — 8 passed against
the disposable production schema, Paystack mocked. The validator's 3 assertions plus: the cron
closes the subscription out; a flagged subscription mid-period is untouched (date boundary);
another tenant with no flag is still billed; reactivation clears the flag; editing an unrelated
field does not. Both cron suites together: 14 passed.
`tests/unit/services/billing/subscriptionBillingService.test.ts` — 9 passed; its scripted `sql`
call sequences were updated for the close-out statement, plus one new case asserting a closed-out
subscription is counted under `skipped`.
Full unit suite with `DATABASE_URL` unset: 784 files / 9321 tests passed, 0 failed.
Mutation check (`green.log`): dropping the due-query filter, the close-out UPDATE, or the
reactivation reset each takes exactly one test red; restored → 8 green.

**Migration:** none. **Rollback:** revert the commit; no data shape changes.

**Historical data:** every charge raised after the flag was set is an over-collection, and those
subscriptions are still `'active'`. Read-only:
```sql
SELECT s.company_id, s.id AS subscription_id, s.status, s.updated_at AS flagged_at,
       c.id AS charge_id, c.period_start, c.period_end, c.amount_cents, c.status AS charge_status,
       c.settled_at
FROM subscriptions s
JOIN subscription_charges c ON c.company_id = s.company_id
WHERE COALESCE(s.cancel_at_period_end, false) = true
  AND c.created_at >= s.updated_at
ORDER BY c.created_at;
```
No refund or backfill is shipped — reversing a settled debit is a billing decision.

**Limits:** the close-out only covers `status IN ('active','past_due')`; a flagged `trial` or
`paused` subscription is neither charged nor closed, which matches the pre-existing due query.
The first commit on this branch (K-033) is what stops the period advancing for these rows.

**Review round 2 (`../K-033/review-fixes.md`):** a charge already queued for a subscription flagged
to cancel is now voided before the close-out, and the close-out defers while a charge is in flight
at Paystack — without that, cancelling mid-renewal took the money and granted no period. The
admin PATCH route now accepts `cancel_at_period_end`, which the only UI offering the option was
sending into a `.strict()` schema that rejected it, so this path was unreachable in production.
Clearing the flag now requires a real transition into `active`/`trial`, not an edit that restates
the current status.
