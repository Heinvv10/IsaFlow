# K-033 / K-034 — fourth re-review, all new findings addressed

Review: `scratchpad/review-k033-round4.md` against `303e92e5`. R1-R6 confirmed resolved. Two
MEDIUM and three LOW are addressed here; R7/S5 (webhook line count) and M1 (dunning) stay open.

**S1 (MEDIUM) — the runbook under-counted what the migration refuses on.** The documented
pre-deploy query filtered on live statuses while the migration's gate counts every unattributed
row, so an operator could see zero, deploy, and have the migration abort. The runbook in `fix.md`
now runs exactly the gate's own count, lists the offending rows with their company, and carries the
`UPDATE` template to attribute one. The superseded query in `review-fixes-round3.md` is marked as
such. The gate itself is unchanged: refusing on a historical row costs an operator one UPDATE,
whereas letting one through is what R1 was.

**S2 (MEDIUM) — an unattributed charge was debited before the CHECK could reject it.** Migration
624's CHECK fires on the settle UPDATE, which happens after `chargeAuthorization` has taken the
money, so the constraint violation was caught and written as a retryable failure on a paid charge.
`runQueuedCharges` now excludes `subscription_id IS NULL` from the retry query, and
`warnUnattributedLiveCharges` logs the count each run, so such a row is skipped before Paystack is
called and someone is told it exists. The migration still guarantees none survive; this is the
runtime refusing to spend money it cannot record.

**S3** the resolver's claim compares `xmin::text`, the row version, instead of `updated_at::text`.
A timestamp renders through the session's `TimeZone` and `DateStyle` and comes back from the driver
at millisecond precision, so a CAS on one can silently stop matching — and the failure mode was
every stale charge reported unresolved forever, which is the N3 behaviour with no error. **S4**
`ResolveStaleResult` splits the old `unresolved` into `pending` (Paystack has no answer, or a
settlement landed mid-verify), `contended` (another run claimed it) and `errored` (the verify call
threw), so an integration going dark no longer looks like healthy contention in the cron log.
**S5** the webhook is 325 lines, still over the 300 cap it exceeded on master at 329.

**Mutation evidence** (`green-review-fixes-round5.log`): three mutations, one per code fix, each
takes exactly the matching test red — the retry-query exclusion, the row-version predicate, and the
collapsed counters. S1 is documentation, checked by reading the gate and the runbook side by side.
