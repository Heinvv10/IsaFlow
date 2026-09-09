# K-033 / K-034 — third re-review, all new findings addressed

Review: `scratchpad/review-k033-round3.md` against `05e4c498`. N1-N4 and four of the five LOWs
confirmed resolved. One new HIGH, one MEDIUM and five LOW are addressed here; L-e/R7 (webhook line
count) and M1 (dunning) stay open by decision.

**R1 (HIGH) — a pre-624 charge and its replacement both settled, silently.** The duplicate guard
matched `subscription_id = <sub>`, which never matches a legacy NULL, so the cron queued a
replacement; the `COALESCE(subscription_id, nil)` index then put the two in different buckets and
both settled with no error. Two fixes, either of which closes it:

- Migration 624 no longer tolerates a NULL. It backfills through the charge's own mandate
  (mandate → company → that company's single subscription) and then **raises an exception** naming
  the first ten rows it could not attribute, so the deploy stops rather than proceeding into the
  hazard. A `subscription_charges_settled_has_subscription` CHECK makes a settled charge without a
  subscription impossible, and the unique index drops the COALESCE and keys on `subscription_id`
  directly — there is no NULL bucket left.
- The guard also matches `subscription_id IS NULL`, so a database running this code before the
  migration still refuses to queue a replacement.

Proved both ways: `migration-refusal.log` shows the migration refusing a company with two
subscriptions and one unattributed charge, then applying once that row is attributed by hand; and
an integration case queues a legacy NULL charge and asserts the cron creates nothing.

**R2 (MEDIUM) — the resolver overwrote a settlement that landed mid-verify.** The failure UPDATE is
now predicated on `status = 'submitted'`, like every other write on this branch. If the missing
webhook arrives during `verifyTransaction`, the write matches nothing and the run reports the
charge unresolved instead of erasing the settlement.

**R3** `settleSubscriptionCharge` will not resurrect a charge voided by a cancellation: the UPDATE
requires `status <> 'cancelled'` and logs a warning when it matches nothing. Money that arrives
against a voided debit is a refund case, not a period. **R4** the void predicate compares calendar
days anchored in UTC, `c.period_start >= (s.current_period_end AT TIME ZONE 'UTC')::date`, so it no
longer moves with the session timezone; the log shows the two forms disagreeing under
`Pacific/Auckland`. **R5** the resolver claims each charge with a status-and-`updated_at`
compare-and-swap before spending an HTTP round-trip, so two overlapping cron runs verify it once.
The claim compares `updated_at::text`, because pg hands back a millisecond-precision Date that
never matches the column's microseconds. **R6** the module doc's "no tests exist in this module"
line is replaced with what is actually covered, and what still is not.

**Mutation evidence** (`green-review-fixes-round4.log`): four mutations, one per code fix, each
takes exactly the matching test red. R4 is proved by the timezone comparison in the same log, R1's
migration half by `migration-refusal.log`.

**Deploy note:** 624 has changed twice since it was first applied. Any database that ran an earlier
copy needs its checksum conflict resolved (`scripts/migrations/resolve-checksum-conflicts.ts`)
before the new one applies. It has only ever run against the disposable fixture database here.
