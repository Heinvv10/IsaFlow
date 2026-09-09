# K-035 fix — failed Paystack webhooks are no longer discarded on retry

**Trigger.** `pages/api/webhooks/paystack.ts` ran outside any transaction, so the
`paystack_webhook_events` INSERT and every write inside `processEvent` auto-committed
individually. A throw returned 500 with `processed = false`; Paystack's byte-identical
redelivery matched the committed `body_sha256` row and was acked `200 {duplicate:true}`
without processing. The `paystack_payment_requests` UPDATE had also committed, so its
`AND status <> 'completed'` guard blocked any manual replay too.

**Before / after.**
- Before: first delivery 500, event row `processed=false` and payment request `completed`;
  redelivery `200 {duplicate:true}`, never processed. Event lost.
- After: the event row is still written on the pool (forensics survive a rollback), but the
  short-circuit fires only when `processed = TRUE`, read under `SELECT … FOR UPDATE` inside
  the transaction so two concurrent redeliveries serialise instead of both processing.
  A later success clears any stale `processing_error`. `processEvent` plus the `processed` stamp
  run in ONE transaction on an ALS-bound client, so a throw rolls back the payment-request
  status and every handler write. The redelivery reprocesses; once the cause clears it
  succeeds and is stamped processed. The INSERT is now `ON CONFLICT (body_sha256) DO NOTHING
  RETURNING`, so two concurrent redeliveries cannot both insert.

**Files.**
- `pages/api/webhooks/paystack.ts` — dedupe predicate, ON CONFLICT insert, new
  `processEventInTransaction`.
- `src/lib/neon.ts` — added `getDbPool()` (production-named accessor for the same pool
  `getPoolForTests()` returns); no behaviour change.

**Tests.** `tests/integration/k-035-webhook-redelivery-discarded.int.test.ts` — 6 passed
against the disposable production schema (was 2 failed / 1 passed). New cases: redelivery
after the cause is cleared, rollback of the mandate write, duplicate ack after a successful
delivery. No provider call is made; this route never contacts Paystack.

**Mutation check.** Reverting the handler to `origin/master` turns 3 of the 6 red again.

**Migration / rollback.** None. Revert is a plain revert of the two files.

**Historical-data impact.** Events acked and dropped before this fix stay dropped; they must
be replayed from `payload` by hand.
```sql
SELECT id, event_type, reference, received_at, left(processing_error, 160) AS err
FROM paystack_webhook_events
WHERE processed = false
ORDER BY received_at DESC;
```
Reconcile each against `paystack_payment_requests.status` for the same reference.

**Limits.** No automatic re-drive of already-dropped events. Reprocessing correctness still
depends on each branch's own guard; the transaction is what makes those guards hold.


**Review remediation.** See `../K-036/review-fixes.md` for the blind review's findings across
both defects and what each one changed. From K-035's side: the dedupe check moved inside the
transaction behind a row lock (M1), `processing_error` is cleared on success (L1), and
`withPublicRouteTransaction` now destroys a connection whose ROLLBACK failed (M2) and refuses
to nest inside a request transaction (L2), proved by
`tests/integration/public-route-tx.int.test.ts` (4 passed).
