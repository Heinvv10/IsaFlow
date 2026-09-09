# K-033 / K-034 — fifth re-review, both findings addressed

Review: `scratchpad/review-k033-round5.md` against `0842d5c9`. S1-S4 confirmed resolved and S5
(the Paystack webhook at 325 lines) accepted as a logged follow-up. Two LOW addressed here.

**T1 — the resolver's claim only serialised runs reading the same snapshot.** Bumping `xmin` does
not take the row out of anyone's reach: a run starting moments later re-reads the new version,
claims it legitimately, and verifies the same charge in parallel. Migration 624 adds a
`verifying_at` column; the resolver's SELECT skips a charge claimed within the last ten minutes and
the claim UPDATE carries the same predicate, so the later run does not see the charge at all. The
window expires, so a run that dies mid-verify does not strand the charge.

**T2 — the unattributed-charge warning was blind to `submitted`.** That is the one unattributed
state where Paystack has already taken the money: the resolver picked such a row up every run and
`settleSubscriptionCharge` threw on 624's CHECK, counted as `errored` and reading like an
integration fault, while the warning designed to surface these rows reported zero. The warning now
counts `queued`, `submitted` and `failed`, and the resolver's SELECT carries the same
`subscription_id IS NOT NULL` filter `runQueuedCharges` has, so it stops re-verifying forever.

**Mutation evidence** (`green-review-fixes-round6.log`): removing the claim marker from both the
SELECT and the claim UPDATE takes the contention test red; each half alone does not, because either
one blocks the later run on its own — the two are belt and braces and the log records that
honestly. The warning's `submitted` state and the resolver's attribution filter each take the new
test red on their own.

**Follow-ups left open, by decision:** no dunning after three declines (M1, registered by the team
lead), and `pages/api/webhooks/paystack.ts` at 325 lines, down from 329 on master and under no CI
gate, to be tracked as its own item rather than refactored inside a billing change.
