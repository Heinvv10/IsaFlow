# K-095 — fix: a missing gateway secret is an outage, not a discount

**Trigger.** `POST /api/billing/flows/purchase` gated its unpaid fallback on
`Boolean(process.env.PAYSTACK_SECRET_KEY)` alone. With the key absent — unset, rotated out,
or missing from a deploy — any authenticated user of a `payg` company could call the route
and have the bundle credited to `flow_wallet` with a `purchase` row in `flow_ledger`, 201,
no payment taken.

**Before → after.** Before: no key → credit immediately. After: no key → 503
`SERVICE_UNAVAILABLE` and an error log, unless `ALLOW_UNPAID_FLOW_PURCHASE=true` **and**
`NODE_ENV !== 'production'`, in which case the admin-recorded fallback runs exactly as it did.
Local dev and pilot deployments keep working by setting the flag; production cannot opt in.

**Files.** `pages/api/billing/flows/purchase.ts` (new `unpaidFallbackAllowed()`, refusal
branch, doc comment).

**Tests.** `tests/integration/k095-flow-purchase-fails-open-without-paystack.int.test.ts`
(1) and `tests/integration/k095-flow-purchase-fallback-gate.int.test.ts` (3) — real fixture
DB, real route. 4 passed. Adjacent cases: production overrides the flag; a malformed flag
value (`'1'`) is not an opt-in; a refusal leaves a second tenant's wallet untouched.
Mutation: reverting the production file takes all 4 red. See `green.log`.

**Migration / rollback.** None. Rollback is reverting the one file; the only operational
step is setting `ALLOW_UNPAID_FLOW_PURCHASE=true` on any non-production deployment that runs
without Paystack, otherwise flow purchases there start returning 503.

**Historical-data impact.** Wallets credited through this branch were never paid for. The
route reuses `payment_method = 'admin_recorded'`, so this query cannot separate a genuine
admin EFT top-up from a self-served free one — it bounds the exposure, it does not prove it.
Read-only, not executed here:

```sql
SELECT fp.company_id, COUNT(*) AS unpaid_purchases,
       SUM(fp.flows) AS flows_credited, SUM(fp.price_cents)/100.0 AS rand_not_collected
FROM   flow_purchases fp
WHERE  fp.status = 'succeeded'
  AND  fp.payment_method = 'admin_recorded'
  AND  fp.auto_triggered = false
GROUP  BY fp.company_id
ORDER  BY rand_not_collected DESC;
```

**Limits.** The fallback still writes `payment_method = 'admin_recorded'`. Giving it its own
value would make future rows separable, but it changes a stored enum-like value that reports
and the admin UI read, so it is left for a deliberate change. Whether production ever ran
without the key is a deployment question I did not inspect.
