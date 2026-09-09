# K-033 / K-034 — review findings, all 13 addressed

Review: `scratchpad/review-k033.md` against `8183457f` + `5ed01de1` (3 HIGH, 4 MEDIUM, 6 LOW).

## HIGH

**H1 — one settled charge advanced every subscription in the company.** `subscription_charges` had
no `subscription_id`, so the helper joined on `company_id` alone. Migration
`619_subscription_charges_subscription_id.sql` adds the column (FK to `subscriptions`, indexed) and
backfills only where the company has exactly one subscription, which is unambiguous.
`generateDueCharges` populates it on every new charge, and both period helpers now join
`s.id = c.subscription_id`. The duplicate-charge guard was keyed on company + period too, which
would have suppressed a legitimate charge for a company's second subscription; it is now
subscription-scoped as well. Charges predating 619 have a NULL `subscription_id` and move nothing —
deliberately inert rather than wrongly attributed.

**H2 — `markPastDueIfExhausted` flagged every active subscription in the company.** Same key, same
fix, plus the extra predicate the review asked for: the UPDATE only fires when the charge's
`period_end` is beyond the subscription's `current_period_end`, so a stale charge for a period the
subscription has already moved past cannot flag it.

**H3 — cancelling mid-flight took the money and granted nothing.** `generateDueCharges` now voids
`queued`/`failed` charges belonging to a subscription flagged `cancel_at_period_end` before the
close-out runs, so `runQueuedCharges` never sees them. `submitted` charges are left alone (Paystack
already has the request) and the close-out defers while any `queued`/`submitted` charge exists, so
the subscription stays active until the money settles or the charge fails.

## MEDIUM

**M1 — three declines stop billing forever, silently.** Confirmed, not fixed here: it needs a
dunning policy (suspend or notify after N days `past_due`), which is a product decision. Recorded in
both `fix.md` files and in `src/modules/billing/.claude.md` as a known terminal state.

**M2 — the flag could not be set from the UI.** `PatchBody` in
`pages/api/admin/billing/subscriptions/[id].ts` now accepts `cancel_at_period_end: z.literal(true)`
and routes it to `cancelSubscription(id, true)`. Only `true` is accepted: clearing a scheduled
cancellation is a reactivation and goes through `status`.

**M3 — any edit carrying `status: 'active'` silently un-cancelled.** The CASE now requires a real
transition (`AND status NOT IN ('active','trial')`), so an edit that restates the current status
leaves the flag alone. Both cases are tested.

**M4 — module doc stale.** `src/modules/billing/.claude.md` gains the `subscriptionPeriod.ts` row,
a corrected `subscriptionBillingService` description, the real charge states and failure reason, and
the subscription-keying rule. Mirrors regenerated; `bun run agent-docs:check` passes.

## LOW

**L1** `GenerateResult` gains `cancelled`, so a close-out is no longer reported as a skip. The cron
endpoint spreads the object into its log line, so no route change was needed.
**L2** Period boundaries are cast `::timestamp AT TIME ZONE 'UTC'`, so they no longer shift with the
database session's TimeZone.
**L3** The tautological unit case was replaced by one that asserts the new `cancelled` field is
reported separately from `skipped`; the close-out SQL itself is proved in the integration suite.
**L4** The `subscription_charge` branch moved into `settleSubscriptionCharge`, taking
`pages/api/webhooks/paystack.ts` from 332 to 325 lines. Still over the 300-line cap it was already
over at 329 on master; cutting it under would be a refactor of unrelated branches.
**L5** The attempt is now claimed with a compare-and-swap (`claimChargeAttempt`) predicated on the
status and `attempt_count` the run read, and the exhaustion check uses the RETURNed count, never a
pre-read one. Two runs holding the same snapshot: exactly one claims.
**L6** Noted, no change: the advisory lock serialises two whole-DB suites and hides nothing. Real
concurrency is now covered by the two tests above.

## Also found while fixing

`ALLOWED_STATUSES` in `billingService.ts` and the `status` enum on the PATCH route both accept
`'suspended'`, which the `subscriptions_status_check` constraint rejects — any admin setting that
status gets a 500. Pre-existing, untouched, not in this branch's scope.
