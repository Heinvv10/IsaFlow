# K-095 — Flow bundles credited free when the Paystack key is unset

**Claim.** The purchase path fails open and credits the bundle without taking payment
(`pages/api/billing/flows/purchase.ts:37`).

**Corrected trigger.** `paystackConfigured()` is `Boolean(process.env.PAYSTACK_SECRET_KEY)`
and nothing else. When it is false the handler runs `startBundlePurchase(..., { paymentMethod:
'admin_recorded' })` immediately followed by `completeBundlePurchase(...)`, which credits
`flow_wallet` and writes a `purchase` row to `flow_ledger`, then returns 201. The branch is
not gated on `NODE_ENV`, on an admin role, or on a per-tenant flag, and the purchase it leaves
behind is indistinguishable from a genuine admin-recorded top-up. The failure is silent in
both directions: no error is raised and the balance goes up.

**Disposition: confirmed** (env-conditional: exploitable exactly while the key is unset).

**Evidence.**
- `git show origin/master:pages/api/billing/flows/purchase.ts` lines 36–67.
- Executed: `tests/integration/k095-flow-purchase-fails-open-without-paystack.int.test.ts`.
  It seeds a PAYG plan, an active subscription and a 500-flow / R499.00 bundle, deletes
  `PAYSTACK_SECRET_KEY`, and drives the real route. 1 test, 1 failed: wallet balance
  `expected 500 to be 0`. `red.log` in this directory.

**Reachability.** `POST /api/billing/flows/purchase`, `withAuth` + `withCsrf`. Any
authenticated user of a company on the `payg` plan — no admin role required. Whether it is
live in production depends on the deployed environment, which I did not inspect: production
was out of scope for this validation, so treat the severity as conditional on that check.

**Proposed minimal fix.** Fail closed instead of open. In `purchase.ts`, replace the
`if (!paystackConfigured())` branch with a hard refusal unless the fallback is explicitly
enabled and the environment is not production, e.g.
`if (!paystackConfigured()) { if (process.env.NODE_ENV === 'production' || process.env.ALLOW_UNPAID_FLOW_PURCHASE !== 'true') return apiResponse.serviceUnavailable(res, 'Payments are not configured'); ... }`.
A missing gateway secret is an outage, not a discount.

**Historical-data impact.** Any wallet credited through this branch was never paid for. Rows
are identifiable: `flow_purchases.payment_method = 'admin_recorded'` with
`auto_triggered = false` and no matching `paystack_payment_requests` row. Read-only:

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

That query cannot separate a genuine admin-recorded EFT top-up from a self-served free one —
the route reuses the same `payment_method`. Distinguishing them needs the admin's own record,
which is a second reason to give the fallback its own method value in the fix.

**Risks.** Closing the branch breaks any deployment that legitimately runs without Paystack
(local dev, a pilot tenant). The env flag above keeps that working while making it a
deliberate act.
