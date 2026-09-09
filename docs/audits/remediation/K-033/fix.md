# K-033 fix — the subscription period now moves only when the money arrives

**Trigger:** `generateDueCharges()` inserted the queued `subscription_charges` row and then
advanced `subscriptions.current_period_start/_end` in the same loop, before Paystack was called.
Once `attempt_count` reached `MAX_ATTEMPTS` (3) the charge dropped out of the retry query and
nothing touched the subscription, so a permanently declining card kept accruing unpaid periods on
a subscription that stayed `'active'`.

**Before:** queue charge → period advances → 3 declines → charge `failed`, subscription `active`
on an unpaid period; next cron generates another charge and advances again.
**After:** queue charge → period unchanged → settlement (cron optimistic-success path or the
Paystack webhook) moves the period onto the charge's own `period_start/period_end`; the last
failed attempt sets `status='past_due'`. A later settlement lifts `past_due` back to `active`.
The advance is guarded by `s.current_period_end < c.period_end`, so cron and webhook are
idempotent in either order, and the existing duplicate guard (keyed on the charge period) stops
the still-due subscription generating a second charge.

**Files**
- `src/modules/billing/services/subscriptionBillingService.ts` — removed the period UPDATE;
  selects `c.period_end`; calls the two helpers below.
- `src/modules/billing/services/subscriptionPeriod.ts` — new: `MAX_ATTEMPTS`,
  `advancePeriodForSettledCharge`, `markPastDueIfExhausted` (extracted so the webhook can advance
  a period without importing the cron, and to keep the service under the 300-line cap).
- `pages/api/webhooks/paystack.ts` — `subscription_charge` branch advances the period after settling.

**Tests:** `tests/integration/k-033-subscription-period-advances-before-settlement.int.test.ts`
— 6 passed against the disposable production schema, Paystack mocked. The validator's 2 RED
assertions plus 4 adjacent cases: settlement advances; double-settle (cron then webhook) does not
advance twice; settlement lifts `past_due`; a second tenant's subscription is untouched.
Full unit suite with `DATABASE_URL` unset: 784 files / 9321 tests passed, 0 failed.
Mutation check (`green.log`): restoring the premature advance → 3 red; dropping the `past_due`
call → 2 red; dropping the advance-on-settle call → 2 red; restored → 6 green.

**Migration:** none. **Rollback:** revert the commit; no data shape changes.

**Historical data:** companies whose period advanced on a charge that never settled hold a wrong
`current_period_end` and were never flagged. Read-only:
```sql
SELECT s.company_id, s.id AS subscription_id, s.status, s.current_period_end,
       c.period_start, c.period_end, c.status AS charge_status, c.attempt_count, c.amount_cents
FROM subscriptions s
JOIN subscription_charges c ON c.company_id = s.company_id
WHERE c.gateway = 'paystack' AND c.status IN ('queued','submitted','failed')
  AND s.current_period_end > c.period_start
ORDER BY c.period_start;
```
No backfill is shipped — correcting a live period is a billing decision, not a code fix.

**Limits:** the webhook call itself has no HTTP-level test; it is the same helper the two
idempotency tests exercise directly. `period_end` is a DATE, so the first advance snaps the
period boundary to midnight in the DB session timezone (stable thereafter).
`pages/api/webhooks/paystack.ts` was already 329 lines, over the 300-line cap; this change adds 3.

**Review round 2 (`review-fixes.md`):** the period and past_due writes are now keyed on
`subscription_charges.subscription_id` (migration 624) rather than `company_id`, which had let one
charge move every subscription a company owns. The attempt is claimed with a compare-and-swap
before it is spent. Period boundaries are cast through UTC. Known terminal state, unchanged: after
three declines no further charge is raised for that period and `past_due` gates nothing — dunning
is not implemented and needs a follow-up decision.

**Review round 3 (`review-fixes-round3.md`):** migration 624 also replaces
`ux_sub_charges_mandate_period_settled` with a per-subscription unique index — the widened
duplicate guard and the old per-mandate index disagreed, so a company with two subscriptions on one
mandate was debited twice and the second settlement was recorded as a failure. A charge stuck in
`submitted` is now verified against Paystack after 24 hours by
`resolveStaleSubmittedCharges`, which the cron runs first. Before deploying, count the charges the
backfill cannot attribute and set their `subscription_id` by hand:
```sql
SELECT count(*) FROM subscription_charges
WHERE subscription_id IS NULL AND status IN ('queued','submitted','failed');
```
